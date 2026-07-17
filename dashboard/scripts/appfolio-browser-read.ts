#!/usr/bin/env node
/**
 * AppFolio browser read automation — read-only UI lookups via agent-browser.
 *
 * Usage:
 *   npx tsx scripts/appfolio-browser-read.ts check-session
 *   npx tsx scripts/appfolio-browser-read.ts login
 *   npx tsx scripts/appfolio-browser-read.ts lookup-tenant "John Smith"
 *   npx tsx scripts/appfolio-browser-read.ts lookup-unit "123 Main St Apt 1"
 *   npx tsx scripts/appfolio-browser-read.ts read-work-order "8014"
 *   npx tsx scripts/appfolio-browser-read.ts batch-work-orders "8014" "7994" "8015"
 *
 * Session: persistent, keyed to 'appfolio-ops'. Established once by attended login;
 * subsequent runs restore automatically without human input.
 *
 * Login guardrail: one attempt only. On any MFA/CAPTCHA/challenge page, exits with
 * code 2 and prints a human-action-required message. Never retries login.
 *
 * All output is JSON to stdout; errors to stderr.
 */

import { createHash } from 'node:crypto';
import { execSync, execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

const SESSION_NAME = 'appfolio-ops';
const APPFOLIO_URL = process.env.APPFOLIO_WEB_URL ?? '';
const APPFOLIO_USER = process.env.APPFOLIO_WEB_USERNAME ?? '';
const APPFOLIO_PASS = process.env.APPFOLIO_WEB_PASSWORD ?? '';

const MAX_CONSECUTIVE_FAILURES = 3; // pause after this many consecutive login failures
const BASE_BACKOFF_HOURS = 4;       // backoff doubles each failure: 4h, 8h, 16h

const FAILURE_STATE_PATH = resolve(process.cwd(), '.appfolio-selfheal-state.json');

interface FailureState {
  consecutiveFailures: number;
  lastFailureAt: string | null;
  backoffUntil: string | null;
  paused: boolean;
}

function readFailureState(): FailureState {
  try {
    return JSON.parse(readFileSync(FAILURE_STATE_PATH, 'utf-8')) as FailureState;
  } catch {
    return { consecutiveFailures: 0, lastFailureAt: null, backoffUntil: null, paused: false };
  }
}

function writeFailureState(state: FailureState): void {
  try { writeFileSync(FAILURE_STATE_PATH, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

if (!APPFOLIO_URL || !APPFOLIO_USER || !APPFOLIO_PASS) {
  console.error(JSON.stringify({ error: 'Missing APPFOLIO_WEB_URL / APPFOLIO_WEB_USERNAME / APPFOLIO_WEB_PASSWORD in secrets.env' }));
  process.exit(1);
}

function ab(...args: string[]): string {
  return execSync(
    `agent-browser --session ${SESSION_NAME} --restore ${args.join(' ')}`,
    { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

// Non-destructive variant: restores session state for reading but never auto-saves on close.
// Use for check-session so a redirect to the OAuth page cannot clobber the known-good cookies.
function abReadOnly(...args: string[]): string {
  return execSync(
    `agent-browser --session ${SESSION_NAME} --restore --restore-save never ${args.join(' ')}`,
    { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
  ).trim();
}

// Uses execFileSync so the JS script is passed as a proper argv entry, not shell-interpreted.
// This avoids semicolons, quotes, and special chars in the eval body breaking the shell.
function abEval(script: string): { ok: boolean; output: string } {
  try {
    const output = execFileSync(
      'agent-browser',
      ['--session', SESSION_NAME, '--restore', 'eval', script],
      { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
    return { ok: true, output };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: e.stdout ?? e.stderr ?? e.message ?? String(err) };
  }
}

function abSafe(...args: string[]): { ok: boolean; output: string } {
  try {
    const output = ab(...args);
    return { ok: true, output };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return { ok: false, output: e.stdout ?? e.stderr ?? e.message ?? String(err) };
  }
}

/**
 * Check if the current session is authenticated by navigating to AppFolio
 * and seeing if we land on a dashboard (not login page).
 */
async function checkSession(): Promise<{ authenticated: boolean; url: string; title: string }> {
  // Use abReadOnly (--restore-save never) so a redirect to the OAuth page cannot
  // auto-save unauthenticated state over the known-good session cookies.
  const safe = (...args: string[]) => { try { return { ok: true, output: abReadOnly(...args) }; } catch (e: unknown) { const err = e as { stdout?: string; stderr?: string; message?: string }; return { ok: false, output: err.stdout ?? err.stderr ?? err.message ?? String(e) }; } };

  const result = safe('open', APPFOLIO_URL, '--json');
  if (!result.ok) {
    abReadOnly('close');
    return { authenticated: false, url: APPFOLIO_URL, title: 'error opening page' };
  }

  const pageInfo = safe('get', 'url');
  const titleInfo = safe('get', 'title');
  const url = pageInfo.output;
  const title = titleInfo.output;

  // AppFolio uses OAuth — redirected to SSO provider means not authenticated.
  // Authenticated state: URL is on paseoproperties.appfolio.com, NOT on account.appfolio.com auth page.
  const onAuthPage = /account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(url);
  abReadOnly('close');
  return { authenticated: !onAuthPage, url, title };
}

/**
 * Attempt one login. Stops immediately if MFA/CAPTCHA is detected.
 * Returns { success, reason }.
 */
async function login(): Promise<{ success: boolean; reason: string }> {
  ab('open', APPFOLIO_URL);

  const snap = abSafe('snapshot', '-i', '--json');
  if (!snap.ok) {
    ab('close');
    return { success: false, reason: 'snapshot failed after open' };
  }

  // Check if we're already authenticated (not on SSO/OAuth page)
  const currentUrl = abSafe('get', 'url').output;
  const onAuthPage = /account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl);
  if (!onAuthPage) {
    ab('close');
    return { success: true, reason: 'already authenticated' };
  }

  // Fill email
  const emailFilled = abSafe('fill-by-label', 'Email', APPFOLIO_USER);
  if (!emailFilled.ok) {
    // Try by placeholder
    abSafe('fill-by-placeholder', 'Email', APPFOLIO_USER);
  }

  // Fill password
  const passFilled = abSafe('fill-by-label', 'Password', APPFOLIO_PASS);
  if (!passFilled.ok) {
    abSafe('fill-by-placeholder', 'Password', APPFOLIO_PASS);
  }

  // Submit
  abSafe('press', 'Enter');
  abSafe('wait', '--load', 'networkidle');

  const postLoginUrl = abSafe('get', 'url').output;
  const postLoginTitle = abSafe('get', 'title').output.toLowerCase();

  // Detect MFA / CAPTCHA / challenge pages — stop immediately (one-attempt guardrail)
  const challengeIndicators = [
    /two.factor/i, /2fa/i, /verification/i, /captcha/i,
    /verify.*identity/i, /security.*check/i, /confirm.*phone/i,
    /enter.*code/i, /authentication.*required/i,
  ];
  const isChallenged = challengeIndicators.some(re => re.test(postLoginTitle) || re.test(postLoginUrl));

  if (isChallenged) {
    ab('screenshot', '/tmp/appfolio-mfa-challenge.png');
    ab('close');
    return {
      success: false,
      reason: 'MFA/CAPTCHA challenge detected — human attended login required. Screenshot saved to /tmp/appfolio-mfa-challenge.png. Do NOT retry automatically.',
    };
  }

  // Still on auth page = wrong credentials or lockout
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(postLoginUrl)) {
    ab('close');
    return { success: false, reason: 'Login failed — still on auth page after submit (wrong credentials or lockout)' };
  }

  // Wait for Keycloak to finish writing persistent SSO cookies before saving.
  // Saving immediately captures only session-only cookies (race confirmed 2026-07-12).
  await new Promise(r => setTimeout(r, 5000));
  ab('close', '--save');
  return { success: true, reason: 'login successful' };
}

/**
 * Lookup a tenant by name. Navigates to AppFolio tenant search.
 * Returns structured JSON with matching tenants.
 */
async function lookupTenant(query: string): Promise<object> {
  // Ensure we have a session
  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first (requires attended human session).' };
  }

  // Navigate to tenant search
  const searchUrl = `${APPFOLIO_URL}/tenants?search=${encodeURIComponent(query)}`;
  const opened = abSafe('--restore', 'open', searchUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };

  abSafe('wait', '--load', 'networkidle');

  // Extract table data via eval
  const tableData = abSafe('eval', `
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    JSON.stringify(rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      return cells.map(c => c.innerText.trim());
    }).filter(r => r.length > 0).slice(0, 20));
  `);

  ab('close');

  if (!tableData.ok || !tableData.output) {
    return { query, results: [], message: 'No table data found on page' };
  }

  let rows: string[][] = [];
  try { rows = JSON.parse(tableData.output); } catch { /* empty */ }

  return { query, results: rows, count: rows.length };
}

/**
 * Lookup a unit by address or unit identifier.
 */
async function lookupUnit(query: string): Promise<object> {
  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  const searchUrl = `${APPFOLIO_URL}/units?search=${encodeURIComponent(query)}`;
  abSafe('--restore', 'open', searchUrl);
  abSafe('wait', '--load', 'networkidle');

  const tableData = abSafe('eval', `
    const rows = Array.from(document.querySelectorAll('table tbody tr'));
    JSON.stringify(rows.map(row => {
      const cells = Array.from(row.querySelectorAll('td'));
      return cells.map(c => c.innerText.trim());
    }).filter(r => r.length > 0).slice(0, 20));
  `);

  ab('close');

  let rows: string[][] = [];
  try { rows = JSON.parse(tableData.output ?? '[]'); } catch { /* empty */ }
  return { query, results: rows, count: rows.length };
}

/**
 * Assign a vendor to a work order via the AppFolio edit form.
 *
 * Safe by default: --execute flag is required for real submission.
 * Dry-run (default) validates CSRF + idempotency preflight and prints the PATCH without submitting.
 *
 * Params:
 *   srId             — AppFolio service_request ID (numeric digits only)
 *   woId             — AppFolio work_order ID (numeric digits only)
 *   appfolioVendorId — Vendor's AppFolio numeric ID (contacts.appfolio_vendor_id, digits only).
 *                      party field = v_{appfolioVendorId} — confirmed from live WO edit-form
 *                      inspection (party="v_1089" for Murray, Patrick / vendor 1089).
 *   live             — if true, submits the PATCH (requires explicit --execute flag at CLI)
 */
function computeApprovalHash(srId: string, woId: string, vendorId: string, dispatch: { emailLink: boolean; textLink: boolean; requireAccept: boolean }, woStatus: string, currentParty: string): string {
  const payload = JSON.stringify({ srId, woId, vendorId, emailLink: dispatch.emailLink, textLink: dispatch.textLink, requireAccept: dispatch.requireAccept, woStatus, currentParty });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function assignVendor(
  srId: string,
  woId: string,
  appfolioVendorId: string,
  live: boolean,
  dispatch: { emailLink: boolean; textLink: boolean; requireAccept: boolean } = { emailLink: false, textLink: false, requireAccept: false },
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  // [fix-1] Validate all IDs are numeric before use in paths or eval scripts
  if (!/^\d+$/.test(srId) || !/^\d+$/.test(woId) || !/^\d+$/.test(appfolioVendorId)) {
    return { error: 'invalid_ids', message: 'srId, woId, and appfolioVendorId must be numeric digits only' };
  }

  const partyValue = `v_${appfolioVendorId}`;

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  const woUrl = `${APPFOLIO_URL}/maintenance/service_requests/${srId}/work_orders/${woId}`;

  const opened = abSafe('open', woUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  const currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Status precondition: gate on WO status, not Assign button presence.
  // Assign reappears on Completed/Canceled/Ready-to-Bill as a silent re-assign.
  const statusResult = abEval(`(document.querySelector(".js-status-label")||{}).textContent||""`);
  let woStatus = '';
  try {
    let sv = statusResult.output;
    if (sv.startsWith('"') && sv.endsWith('"')) sv = JSON.parse(sv) as string;
    woStatus = sv.trim();
  } catch { /* stays empty, triggers fail-closed below */ }

  if (!woStatus) {
    ab('close');
    return { error: 'status_unreadable', message: 'Could not read WO status from .js-status-label — fail closed.' };
  }
  if (/^(Completed|Completed No Need to Bill|Canceled|Cancelled|Ready to Bill|Ready-to-Bill|Closed)$/i.test(woStatus)) {
    ab('close');
    return { error: 'terminal_status', wo_status: woStatus, message: `WO is "${woStatus}" — assign-vendor blocked. The Assign button may still appear but this would be a silent re-assign.` };
  }

  // Extract CSRF token (execFileSync — no shell interpretation)
  const csrfResult = abEval(`var m=document.querySelector("meta[name=csrf-token]");m?m.getAttribute("content"):""`);
  let csrfToken = '';
  try {
    let ct = csrfResult.output;
    if (ct.startsWith('"') && ct.endsWith('"')) ct = JSON.parse(ct) as string;
    csrfToken = ct.trim();
  } catch { /* stays empty, triggers error below */ }
  if (!csrfToken) {
    ab('close');
    return { error: 'no_csrf_token', message: 'Could not extract CSRF token from page meta tag' };
  }

  // [fix-2] Enforce CSRF functional check — block if GraphQL returns non-200.
  // srId/woId/appfolioVendorId are digits-only (validated above) — safe to interpolate.
  // csrfToken: AppFolio tokens are base64url (A-Z a-z 0-9 _ - =), no shell-special chars.
  const csrfCheckScript = `fetch("/graphql",{method:"POST",headers:{"Content-Type":"application/json","X-CSRF-Token":"${csrfToken}"},body:JSON.stringify({query:"{workOrderSmartMaintenanceDetails(workOrderId:\\"${woId}\\"){id}}"})}).then(function(r){return JSON.stringify({status:r.status});})`;
  const csrfCheckResult = abEval(csrfCheckScript);
  let csrfStatus = 0;
  try {
    let inner = csrfCheckResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    csrfStatus = (JSON.parse(inner) as { status?: number }).status ?? 0;
  } catch { /* stays 0, triggers error below */ }
  if (csrfStatus !== 200) {
    ab('close');
    return { error: 'csrf_check_failed', message: `CSRF functional check returned status ${csrfStatus || 'unknown'}, expected 200`, raw: csrfCheckResult.output };
  }

  // [fix-3] Idempotency preflight — read current party before posting
  // Fetch the edit form and extract the current party value
  // [fix-3] Idempotency preflight — fail-closed.
  // Script returns {ok, party} on success or {error} on any failure including non-ok HTTP,
  // missing selector, or DOM parse failure. Null party is an error, not unassigned.
  // srId/woId are digits-only (validated above); csrfToken is base64url — safe to interpolate.
  const editPath = `/maintenance/service_requests/${srId}/work_orders/${woId}/edit`;
  const currentPartyScript = `fetch("${editPath}",{headers:{"Accept":"text/html","X-Requested-With":"XMLHttpRequest","X-CSRF-Token":"${csrfToken}"}}).then(function(r){if(!r.ok){return JSON.stringify({error:"http_"+r.status});}return r.json().then(function(d){var p=new DOMParser();var doc=p.parseFromString(d.edit_body||"","text/html");var f=doc.querySelector('[name="maintenance_work_order[party]"]');if(!f){return JSON.stringify({error:"field_not_found"});}return JSON.stringify({ok:true,party:f.value});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const currentPartyResult = abEval(currentPartyScript);

  // Any abEval failure, parse failure, missing field, non-ok HTTP, or null party → block; never fail open
  if (!currentPartyResult.ok) {
    ab('close');
    return { error: 'idempotency_check_failed', reason: 'abEval error', raw: currentPartyResult.output };
  }
  let currentPartyParsed: { ok?: boolean; party?: string; error?: string } = {};
  try {
    let inner2 = currentPartyResult.output;
    if (inner2.startsWith('"') && inner2.endsWith('"')) inner2 = JSON.parse(inner2) as string;
    currentPartyParsed = JSON.parse(inner2) as typeof currentPartyParsed;
  } catch {
    ab('close');
    return { error: 'idempotency_check_failed', reason: 'JSON parse error', raw: currentPartyResult.output };
  }
  if (currentPartyParsed.error || !currentPartyParsed.ok || typeof currentPartyParsed.party !== 'string') {
    ab('close');
    return { error: 'idempotency_check_failed', reason: currentPartyParsed.error ?? 'missing party field or ok flag', raw: currentPartyResult.output };
  }
  const currentParty = currentPartyParsed.party;

  // Only empty string may proceed to POST. All other states are explicit decisions.
  if (currentParty === partyValue) {
    ab('close');
    return { already_assigned: true, party_value: partyValue, appfolio_vendor_id: appfolioVendorId, sr_id: srId, wo_id: woId, message: 'Vendor already assigned — no POST sent.' };
  }
  if (currentParty !== '') {
    ab('close');
    return { error: 'different_vendor_assigned', current_party: currentParty, requested_party: partyValue, message: 'A different vendor is already assigned. Override requires explicit approval — this command does not support override.' };
  }

  const patchUrl = `/maintenance/service_requests/${srId}/work_orders/${woId}`;
  const patchParams: Record<string, string> = {
    '_method': 'patch',
    'authenticity_token': csrfToken,
    'maintenance_work_order[party]': partyValue,
    'maintenance_work_order[send_vendor_wo_link]': dispatch.emailLink ? '1' : '0',
    'maintenance_work_order[send_vendor_text]': dispatch.textLink ? '1' : '0',
    'maintenance_work_order[require_vendor_accept_wo]': dispatch.requireAccept ? '1' : '0',
  };
  const patchBody = Object.entries(patchParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // [fix-0] Dry-run is the default (safe). Live requires --execute flag explicitly.
  const expectedHash = computeApprovalHash(srId, woId, appfolioVendorId, dispatch, woStatus, currentParty);

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SUBMIT BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only after chief + Albie greenlight on this specific WO+vendor.',
      approval_hash: expectedHash,
      would_patch: patchUrl,
      wo_status: woStatus,
      csrf_token_extracted: true,
      csrf_token_prefix: csrfToken.slice(0, 8) + '…',
      csrf_status: csrfStatus,
      current_party: currentParty,
      appfolio_vendor_id: appfolioVendorId,
      party_value: partyValue,
      dispatch: {
        email_link: dispatch.emailLink,
        text_link: dispatch.textLink,
        require_accept: dispatch.requireAccept,
      },
      patch_body: patchParams,
    };
  }

  // Approval-packet binding: live path requires a matching hash from a prior dry-run
  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run. Run without --execute first to get the hash.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters (srId, woId, vendorId, dispatch flags). Re-run dry-run to get a fresh hash.' };
  }

  // ── LIVE SUBMIT — requires explicit --execute flag + per-WO chief + Albie greenlight ──────────
  // patchUrl contains only validated numeric IDs; patchBody is URL-encoded (no JS special chars);
  // csrfToken is base64url — all safe for direct JS interpolation via execFileSync argv.
  const bodyLiteral = JSON.stringify(patchBody); // URL-encoded string → safe JSON literal for JS
  const submitScript = `fetch("${patchUrl}",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-CSRF-Token":"${csrfToken}","X-Requested-With":"XMLHttpRequest"},body:${bodyLiteral}}).then(function(r){return r.text().then(function(){return JSON.stringify({status:r.status,ok:r.ok,final_url:r.url});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const submitResult = abEval(submitScript);

  let submitJson: Record<string, unknown> = {};
  try { let si = submitResult.output; if (si.startsWith('"') && si.endsWith('"')) si = JSON.parse(si) as string; submitJson = JSON.parse(si); } catch { /* use raw */ }

  const submitOk = submitResult.ok && (submitJson.ok === true || (typeof submitJson.status === 'number' && submitJson.status < 400));
  if (!submitOk) {
    ab('close');
    return {
      error: 'submit_failed',
      appfolio_vendor_id: appfolioVendorId,
      party_value: partyValue,
      sr_id: srId,
      wo_id: woId,
      submit_result: Object.keys(submitJson).length ? submitJson : submitResult.output,
    };
  }

  // Post-assign verification: re-read WO detail, check Actions Log + vendor contact card
  await new Promise(r => setTimeout(r, 2000));
  abSafe('open', woUrl);
  abSafe('wait', '--load', 'networkidle');

  const verifyResult = abEval(`
    var vendorCard = document.querySelector(".js-vendor-contact-card");
    var vendorLink = vendorCard ? vendorCard.querySelector("a[href*='/vendors/']") : null;
    var vendorHref = vendorLink ? vendorLink.getAttribute("href") : "";
    var vendorIdMatch = vendorHref.match(/\\/vendors\\/(\\d+)/);
    var assignedVendorId = vendorIdMatch ? vendorIdMatch[1] : "";

    var logH3 = null;
    var h3s = document.querySelectorAll("h3");
    for (var i = 0; i < h3s.length; i++) {
      if (/Actions Log/i.test(h3s[i].textContent.trim())) { logH3 = h3s[i]; break; }
    }
    var logEntries = [];
    if (logH3) {
      var sib = logH3.nextElementSibling;
      while (sib && sib.tagName !== "H3" && sib.tagName !== "H2") {
        var lines = sib.textContent.trim().split("\\n").map(function(l){return l.trim();}).filter(function(l){return l.length>0;});
        for (var li = 0; li < lines.length; li++) logEntries.push(lines[li]);
        sib = sib.nextElementSibling;
      }
    }
    var recentLog = logEntries.slice(0, 5).join(" | ");

    JSON.stringify({
      assigned_vendor_id: assignedVendorId,
      recent_log: recentLog,
      has_assigned_phrase: /Assigned \\(pending accept\\)/i.test(recentLog),
      has_email_phrase: /Work order link emailed to vendor/i.test(recentLog),
      has_text_phrase: /Work order details with link texted to vendor/i.test(recentLog),
    });
  `);

  ab('close');

  let verification: Record<string, unknown> = {};
  try {
    let vi = verifyResult.output;
    if (vi.startsWith('"') && vi.endsWith('"')) vi = JSON.parse(vi) as string;
    verification = JSON.parse(vi) as Record<string, unknown>;
  } catch { verification = { parse_error: true, raw: verifyResult.output }; }

  const vendorIdVerified = String(verification.assigned_vendor_id) === appfolioVendorId;
  const assignPhraseVerified = verification.has_assigned_phrase === true;
  const emailPhraseVerified = !dispatch.emailLink || verification.has_email_phrase === true;
  const textPhraseVerified = !dispatch.textLink || verification.has_text_phrase === true;
  const allVerified = vendorIdVerified && assignPhraseVerified && emailPhraseVerified && textPhraseVerified;

  return {
    live: true,
    verified: allVerified,
    appfolio_vendor_id: appfolioVendorId,
    party_value: partyValue,
    sr_id: srId,
    wo_id: woId,
    wo_status: woStatus,
    csrf_token_prefix: csrfToken.slice(0, 8) + '…',
    submit_result: submitJson,
    verification,
    dispatch: {
      email_link: dispatch.emailLink,
      text_link: dispatch.textLink,
      require_accept: dispatch.requireAccept,
    },
  };
}

interface WorkOrderDetail {
  sr_number: string;
  wo_number: string;
  status: string;
  property: string;
  owner: string;
  tenant: string;
  description: string;
  vendor_trade: string;
  vendor_name: string;
  vendor_phone: string;
  vendor_email: string;
  vendor_status: string;
  assignee: string;
  submitted_by: string;
  created_on: string;
  created_by: string;
  priority: string;
  permission_to_enter: string;
  recent_open_wos: string;
  owner_approved: string;
  maintenance_limit: string;
  vendor_instructions: string;
  scheduled: string;
  follow_up_date: string;
  wo_adjustments: string;
  actions_log: string;
  invoices: string;
  notes: string;
  sr_id: string;
  wo_id: string;
  url: string;
  error?: string;
  message?: string;
}

const WO_QUERY_RE = /^\d+(?:-\d+)?$/;
const WO_HREF_RE = /^https?:\/\/[^/]+\/maintenance\/service_requests\/\d+(?:\?work_order_id=\d+)?$/;

function findWoLinkFromAutocomplete(query: string): { text: string; href: string } | { error: string } {
  const result = abEval(`
    var links = document.querySelectorAll("a");
    var found = [];
    for (var i = 0; i < links.length; i++) {
      var t = links[i].textContent.trim();
      var h = links[i].getAttribute("href") || "";
      if (/^\\d+-\\d+$/.test(t) && h.includes("/service_requests/")) {
        found.push({text: t, href: h});
      }
    }
    JSON.stringify(found);
  `);
  if (!result.ok) return { error: 'eval_failed' };

  let links: Array<{ text: string; href: string }> = [];
  try {
    let inner3 = result.output;
    if (inner3.startsWith('"') && inner3.endsWith('"')) inner3 = JSON.parse(inner3) as string;
    links = JSON.parse(inner3) as typeof links;
  } catch { return { error: 'parse_failed' }; }

  // Match: if query includes dash (e.g. "8014-1"), require exact text match.
  // If query is base number (e.g. "8014"), require prefix match (text starts with "8014-").
  const hasDash = query.includes('-');
  const matches = links.filter(l =>
    hasDash ? l.text === query : l.text.startsWith(`${query}-`)
  );

  if (matches.length === 0) return { error: 'not_found' };

  // Deduplicate by href (autocomplete renders the same link in heading + anchor)
  const seen = new Set<string>();
  const unique = matches.filter(m => {
    if (seen.has(m.href)) return false;
    seen.add(m.href);
    return true;
  });

  if (unique.length > 1) {
    const texts = unique.map(m => m.text).join(', ');
    return { error: `ambiguous_match: ${texts}` };
  }

  const match = unique[0];
  if (!WO_HREF_RE.test(match.href)) {
    return { error: `invalid_href: ${match.href.substring(0, 100)}` };
  }

  return match;
}

function extractWoDetailFields(): WorkOrderDetail {
  const result = abEval(`
    function q(sel) { return (document.querySelector(sel) || {}).textContent || ""; }
    function qt(sel) { return q(sel).trim(); }

    var statusLabel = qt(".js-status-label");
    var srTitle = qt(".js-service-request-title");
    var srMatch = srTitle.match(/#(\\d+)/);

    // Contact cards: property, owner, tenant
    var contactLinks = document.querySelectorAll("a.js-contact-card-name-link");
    var property = "", owner = "", tenant = "";
    for (var i = 0; i < contactLinks.length; i++) {
      var href = contactLinks[i].getAttribute("href") || "";
      var txt = contactLinks[i].textContent.trim();
      if (href.includes("/units/")) property = txt;
      else if (href.includes("/owners/")) owner = txt;
      else if (href.includes("/occupancies/") || href.includes("/tenants/")) tenant = txt;
    }

    // Vendor contact card (js-vendor-contact-card)
    var vendorCard = document.querySelector(".js-vendor-contact-card");
    var vendorName = "", vendorPhone = "", vendorEmail = "";
    if (vendorCard) {
      var vNameLink = vendorCard.querySelector("a.js-contact-card-name-link");
      vendorName = vNameLink ? vNameLink.textContent.trim() : "";
      if (!vendorName) {
        var vNameEl = vendorCard.querySelector(".contact-card__name");
        vendorName = vNameEl ? vNameEl.textContent.trim() : "";
      }
      if (!vendorName) {
        var vText = vendorCard.textContent || "";
        var vMatch = vText.match(/Vendor[\\s\\n]+([^\\n]+)/);
        vendorName = vMatch ? vMatch[1].trim() : "";
      }
      var phoneEl = vendorCard.querySelector("[href^='tel:']");
      if (phoneEl) vendorPhone = phoneEl.textContent.trim();
      if (!vendorPhone) {
        var pMatch = (vendorCard.textContent || "").match(/Phone:\\s*([^\\n]+)/);
        vendorPhone = pMatch ? pMatch[1].trim() : "";
      }
      var emailEl = vendorCard.querySelector("[href^='mailto:']");
      if (emailEl) vendorEmail = emailEl.textContent.trim();
      if (!vendorEmail) {
        var eMatch = (vendorCard.textContent || "").match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}/);
        vendorEmail = eMatch ? eMatch[0] : "";
      }
    }

    // Vendor status from actions log
    var vendorStatus = "";
    var actionsLog = [];
    var logH3 = null;
    var h3s = document.querySelectorAll("h3");
    for (var hi = 0; hi < h3s.length; hi++) {
      if (/Actions Log/i.test(h3s[hi].textContent.trim())) { logH3 = h3s[hi]; break; }
    }
    if (logH3) {
      var sib = logH3.nextElementSibling;
      while (sib && sib.tagName !== "H3" && sib.tagName !== "H2") {
        var lines = sib.textContent.trim().split("\\n").map(function(l){return l.trim();}).filter(function(l){return l.length>0;});
        for (var li = 0; li < lines.length; li++) actionsLog.push(lines[li]);
        sib = sib.nextElementSibling;
      }
    }
    var logText = actionsLog.join(" | ").substring(0, 2000);
    // Parse vendor status per-entry, taking the LATEST (first in page order = reverse-chron)
    for (var vi = 0; vi < actionsLog.length; vi++) {
      var entry = actionsLog[vi];
      if (/Vendor Accepted/i.test(entry)) { vendorStatus = "Accepted"; break; }
      if (/Vendor Declined/i.test(entry)) { vendorStatus = "Declined"; break; }
      if (/Vendor Dispatched|Dispatched to vendor|texted to vendor|emailed.*vendor|sent.*vendor/i.test(entry)) { vendorStatus = "Dispatched"; break; }
    }

    // SR header fields via js-* selectors
    var createdOn = qt(".js-service-request-header-created-on");
    var createdBy = qt(".js-service-request-header-created-by");
    var priority = qt(".js-service-request-header-priority");
    var permissionToEnter = qt(".js-service-request-header-permission-to-enter");
    var recentWosEl = document.querySelector(".js-recent-work-orders-link");
    var recentWos = recentWosEl ? recentWosEl.textContent.trim() : "";

    // WO body fields
    var description = qt(".js-work-order-description");
    var vendorTrade = qt(".js-vendor-trade");
    var vendorInstructions = qt(".js-work-order-vendor-instructions");
    var assigneeName = qt(".js-assignee-name");

    // Owner approval
    var ownerApproved = "";
    var peArea = document.querySelector(".service-request__work-order-pe-area");
    if (peArea) {
      var oaMatch = peArea.textContent.match(/Owner approved:\\s*([^\\n]+)/);
      ownerApproved = oaMatch ? oaMatch[1].trim() : "";
    }

    // Maintenance limit
    var maintenanceLimit = qt(".js-service-request__property-card__maintenance-limit");

    // Scheduling
    var scheduledWarn = document.querySelector(".js-work-order-not-scheduled-warning");
    var scheduled = scheduledWarn ? scheduledWarn.textContent.trim() : "Scheduled";

    // Follow-up date
    var followUpDate = qt(".js-work-order-follow-up-date");

    // WO adjustments
    var woAdjustments = qt(".js-work-order-adjustments");

    // Submitted by
    var submittedBy = qt(".js-service-request-header-submitted-by-tenant");

    // Invoices table
    var invoiceText = "";
    var invContainer = document.querySelector(".js-work-order-invoices-container");
    if (invContainer) {
      var tds = invContainer.querySelectorAll("td");
      var invParts = [];
      for (var ti = 0; ti < tds.length; ti++) {
        var tdText = tds[ti].textContent.trim();
        if (tdText.length > 0) invParts.push(tdText);
      }
      invoiceText = invParts.join(" | ").substring(0, 1000);
    }

    // Notes section
    var notesText = "";
    var notesH2 = null;
    var h2s = document.querySelectorAll("h2");
    for (var ni = 0; ni < h2s.length; ni++) {
      if (/^Notes$/i.test(h2s[ni].textContent.trim())) { notesH2 = h2s[ni]; break; }
    }
    if (notesH2) {
      var nsib = notesH2.nextElementSibling;
      var noteLines = [];
      while (nsib && nsib.tagName !== "H2") {
        var nt = nsib.textContent.trim();
        if (nt.length > 0) noteLines.push(nt);
        nsib = nsib.nextElementSibling;
      }
      notesText = noteLines.join(" | ").substring(0, 2000);
    }

    JSON.stringify({
      sr_number: srMatch ? srMatch[1] : "",
      status: statusLabel,
      property: property,
      owner: owner,
      tenant: tenant,
      description: description.substring(0, 1000),
      vendor_trade: vendorTrade,
      vendor_name: vendorName,
      vendor_phone: vendorPhone,
      vendor_email: vendorEmail,
      vendor_status: vendorStatus,
      assignee: assigneeName,
      submitted_by: submittedBy,
      created_on: createdOn,
      created_by: createdBy,
      priority: priority,
      permission_to_enter: permissionToEnter,
      recent_open_wos: recentWos,
      owner_approved: ownerApproved,
      maintenance_limit: maintenanceLimit,
      vendor_instructions: vendorInstructions.substring(0, 1000),
      scheduled: scheduled,
      follow_up_date: followUpDate,
      wo_adjustments: woAdjustments,
      actions_log: logText,
      invoices: invoiceText,
      notes: notesText
    });
  `);

  const empty: WorkOrderDetail = {
    sr_number: '', wo_number: '', status: '', property: '', owner: '', tenant: '',
    description: '', vendor_trade: '', vendor_name: '', vendor_phone: '', vendor_email: '',
    vendor_status: '', assignee: '', submitted_by: '',
    created_on: '', created_by: '', priority: '', permission_to_enter: '', recent_open_wos: '',
    owner_approved: '', maintenance_limit: '', vendor_instructions: '', scheduled: '',
    follow_up_date: '', wo_adjustments: '', actions_log: '', invoices: '', notes: '',
    sr_id: '', wo_id: '', url: '',
  };
  if (!result.ok) return { ...empty, error: 'eval_failed', message: result.output };

  try {
    let inner = result.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    const parsed = JSON.parse(inner) as Partial<WorkOrderDetail>;
    return { ...empty, ...parsed };
  } catch {
    return { ...empty, error: 'parse_failed', message: result.output };
  }
}

const WO_EMPTY: WorkOrderDetail = {
  sr_number: '', wo_number: '', status: '', property: '', owner: '', tenant: '',
  description: '', vendor_trade: '', vendor_name: '', vendor_phone: '', vendor_email: '',
  vendor_status: '', assignee: '', submitted_by: '',
  created_on: '', created_by: '', priority: '', permission_to_enter: '', recent_open_wos: '',
  owner_approved: '', maintenance_limit: '', vendor_instructions: '', scheduled: '',
  follow_up_date: '', wo_adjustments: '', actions_log: '', invoices: '', notes: '',
  sr_id: '', wo_id: '', url: '',
};

async function readWorkOrder(query: string, keepOpen = false): Promise<WorkOrderDetail> {
  const empty = { ...WO_EMPTY };

  // [fix-1] Validate WO query: digits only, optionally with dash suffix (e.g. "8014" or "8014-1")
  if (!WO_QUERY_RE.test(query)) {
    return { ...empty, error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${query.substring(0, 50)}").` };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { ...empty, error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  // Navigate to dashboard and search
  abSafe('open', APPFOLIO_URL);
  abSafe('wait', '--load', 'networkidle');

  // Find the search box ref from snapshot, then fill by ref
  const snapResult = abSafe('snapshot', '-i', '--json');
  let searchRef = '';
  if (snapResult.ok) {
    try {
      const snapData = JSON.parse(snapResult.output) as { data?: { refs?: Record<string, { name?: string; role?: string }> } };
      const refs = snapData.data?.refs ?? {};
      for (const [ref, info] of Object.entries(refs)) {
        if (info.role === 'searchbox' && info.name === 'Search') {
          searchRef = ref;
          break;
        }
      }
    } catch { /* fall back to text match */ }
    if (!searchRef) {
      const refMatch = snapResult.output.match(/searchbox "Search" \[ref=(e\d+)\]/);
      if (refMatch) searchRef = refMatch[1];
    }
  }
  if (!searchRef) {
    if (!keepOpen) ab('close');
    return { ...empty, error: 'search_box_not_found', message: 'Could not find global search box in snapshot.' };
  }

  // [fix-1] query is validated digits-only above, safe for shell-backed abSafe
  // Retry-with-backoff: autocomplete can be slow to populate for some WOs
  let woLinkResult: ReturnType<typeof findWoLinkFromAutocomplete> = { error: 'not_found' };
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      // Clear search and retype on retry
      abSafe('fill', `ref=${searchRef}`, '');
      await new Promise(r => setTimeout(r, 500));
    }
    abSafe('fill', `ref=${searchRef}`, query);
    await new Promise(r => setTimeout(r, attempt === 0 ? 4000 : 6000));
    woLinkResult = findWoLinkFromAutocomplete(query);
    if (!('error' in woLinkResult) || woLinkResult.error !== 'not_found') break;
  }
  if ('error' in woLinkResult) {
    if (!keepOpen) ab('close');
    return { ...empty, error: 'wo_lookup_failed', message: `WO lookup for "${query}": ${woLinkResult.error} (after 3 attempts)` };
  }

  const woNumber = woLinkResult.text;

  // [fix-1] href already validated by findWoLinkFromAutocomplete against WO_HREF_RE
  abSafe('open', woLinkResult.href);
  abSafe('wait', '--load', 'networkidle');

  // Verify we landed on the detail page, not the auth page or dashboard
  const currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    if (!keepOpen) ab('close');
    return { ...empty, error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Guard: detect redirect to dashboard (no WO detail page rendered)
  if (!/\/service_requests\/\d+/.test(currentUrl)) {
    if (!keepOpen) ab('close');
    return { ...empty, wo_number: woNumber, error: 'navigation_redirected', message: `WO detail page not accessible — redirected to: ${currentUrl}. Possible permission issue or WO not viewable by this account.` };
  }

  // Extract SR ID and WO ID from the final URL
  const urlMatch = currentUrl.match(/service_requests\/(\d+)\/work_orders\/(\d+)/);
  const srId = urlMatch?.[1] ?? '';
  const woId = urlMatch?.[2] ?? '';

  // Extract all fields from the detail page
  let detail = extractWoDetailFields();

  // Retry once if critical fields are empty (AppFolio async-loads content after page shell)
  if (!detail.status && !detail.description && !detail.property) {
    await new Promise(r => setTimeout(r, 5000));
    detail = extractWoDetailFields();
  }

  detail.wo_number = woNumber;
  detail.sr_id = srId;
  detail.wo_id = woId;
  detail.url = currentUrl;

  // [fix-3] Fail closed on missing critical fields — blank status is UNKNOWN, not success
  if (!detail.status && !detail.description && !detail.property) {
    if (!keepOpen) ab('close');
    return {
      ...empty, wo_number: woNumber, sr_id: srId, wo_id: woId, url: currentUrl,
      error: 'content_not_loaded',
      message: 'WO detail page loaded (URL correct) but content never rendered. Likely a Scheduled-status WO with a different page layout, or a permission issue.',
    };
  }
  const missingFields: string[] = [];
  if (!detail.status) missingFields.push('status');
  if (!detail.sr_id) missingFields.push('sr_id');
  if (!detail.wo_id) missingFields.push('wo_id');
  if (!detail.wo_number) missingFields.push('wo_number');
  if (missingFields.length > 0) {
    detail.error = 'incomplete_extraction';
    detail.message = `Critical fields missing after extraction: ${missingFields.join(', ')}. Status is UNKNOWN.`;
  }

  if (!keepOpen) ab('close');
  return detail;
}

async function batchWorkOrders(queries: string[]): Promise<WorkOrderDetail[]> {
  const empty = { ...WO_EMPTY };

  // Validate all queries before starting the browser session
  for (const q of queries) {
    if (!WO_QUERY_RE.test(q)) {
      return [{ ...empty, error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${q.substring(0, 50)}").` }];
    }
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return [{ ...empty, error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' }];
  }

  const results: WorkOrderDetail[] = [];
  try {
    for (const q of queries) {
      const detail = await readWorkOrder(q, true);
      results.push(detail);
    }
  } finally {
    ab('close');
  }
  return results;
}

// ─── Self-heal helpers ───────────────────────────────────────────────────────

function sendAlert(message: string): void {
  const chatId = process.env.CTX_TELEGRAM_CHAT_ID;
  if (chatId) {
    try {
      execSync(`cortextos bus send-telegram ${chatId} ${JSON.stringify(message)}`, { timeout: 10_000, stdio: 'pipe' });
    } catch { /* best-effort */ }
  }
  // Secondary: Slack ops channel (requires SLACK_BOT_TOKEN in env)
  try {
    execSync(`cortextos bus send-slack "#fleet-dispatch" ${JSON.stringify(message)}`, { timeout: 10_000, stdio: 'pipe' });
  } catch { /* no token or channel unreachable */ }
}

function logSelfHealEvent(type: string, detail: string): void {
  try {
    const meta = JSON.stringify({ event: type, detail, agent: process.env.CTX_AGENT_NAME ?? 'claudia' });
    execSync(`cortextos bus log-event action appfolio_${type} warn --meta '${meta.replace(/'/g, "'\\''")}'`, { timeout: 10_000, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

/**
 * Check session; attempt one trust-device relogin if expired.
 * Tracks consecutive failures in a state file; applies exponential backoff and
 * pauses after MAX_CONSECUTIVE_FAILURES to prevent lockout.
 * Challenge detection is the live signal for trust-device state — no hardcoded date.
 * Only logs/alerts on action; ok/no-op path is silent.
 */
async function selfHeal(): Promise<{ status: string; action: string; reason?: string }> {
  const state = readFailureState();
  const sessionCheck = await checkSession();

  if (sessionCheck.authenticated) {
    if (state.consecutiveFailures > 0 || state.paused) {
      writeFailureState({ consecutiveFailures: 0, lastFailureAt: null, backoffUntil: null, paused: false });
    }
    return { status: 'ok', action: 'none' };
  }

  // Paused: too many consecutive failures — skip login, send throttled alert
  if (state.paused) {
    const lastFailureMs = state.lastFailureAt ? new Date(state.lastFailureAt).getTime() : 0;
    if (Date.now() - lastFailureMs > BASE_BACKOFF_HOURS * 60 * 60 * 1000) {
      const msg = `AppFolio session down — auto-relogin paused after ${state.consecutiveFailures} consecutive failures. Manual attended login needed.`;
      sendAlert(msg);
      logSelfHealEvent('session_relogin_paused', msg);
      writeFailureState({ ...state, lastFailureAt: new Date().toISOString() });
    }
    return { status: 'paused', action: 'none', reason: `${state.consecutiveFailures} consecutive failures` };
  }

  // In backoff window: skip login attempt this cycle
  if (state.backoffUntil && Date.now() < new Date(state.backoffUntil).getTime()) {
    return { status: 'backoff', action: 'none', reason: `backing off until ${state.backoffUntil}` };
  }

  // Attempt one login
  const loginResult = await login();

  if (loginResult.success) {
    writeFailureState({ consecutiveFailures: 0, lastFailureAt: null, backoffUntil: null, paused: false });
    logSelfHealEvent('session_self_healed', 'Auto-relogin succeeded via trust-device (no 2FA required)');
    return { status: 'self-healed', action: 'relogin', reason: loginResult.reason };
  }

  // Login failed — increment counter and compute next backoff
  const newCount = state.consecutiveFailures + 1;
  const isChallenge = /MFA|CAPTCHA|challenge/i.test(loginResult.reason);
  const nowPaused = newCount >= MAX_CONSECUTIVE_FAILURES;
  const backoffMs = BASE_BACKOFF_HOURS * 60 * 60 * 1000 * Math.pow(2, newCount - 1);
  const backoffUntil = nowPaused ? null : new Date(Date.now() + backoffMs).toISOString();

  writeFailureState({
    consecutiveFailures: newCount,
    lastFailureAt: new Date().toISOString(),
    backoffUntil,
    paused: nowPaused,
  });

  const backoffHours = Math.round(backoffMs / 3_600_000);
  const alertMsg = nowPaused
    ? `AppFolio auto-relogin PAUSED after ${newCount} consecutive failures. Last: ${loginResult.reason}. Manual attended login required (Albie relay).`
    : isChallenge
    ? `AppFolio relogin blocked: 2FA challenge (failure ${newCount}/${MAX_CONSECUTIVE_FAILURES}). Next retry in ${backoffHours}h.`
    : `AppFolio relogin failed (${newCount}/${MAX_CONSECUTIVE_FAILURES}): ${loginResult.reason}. Next retry in ${backoffHours}h.`;

  sendAlert(alertMsg);
  logSelfHealEvent(
    nowPaused ? 'session_relogin_paused' : isChallenge ? 'session_relogin_blocked' : 'session_relogin_failed',
    alertMsg,
  );

  return {
    status: nowPaused ? 'paused' : isChallenge ? 'blocked-challenge' : 'failed',
    action: 'alerted',
    reason: loginResult.reason,
  };
}

// ─── CLI dispatch ────────────────────────────────────────────────────────────

const [,, command, ...cmdArgs] = process.argv;

async function main() {
  switch (command) {
    case 'check-session': {
      const result = await checkSession();
      console.log(JSON.stringify(result));
      process.exit(result.authenticated ? 0 : 1);
      break;
    }
    case 'login': {
      const result = await login();
      console.log(JSON.stringify(result));
      process.exit(result.success ? 0 : 2);
      break;
    }
    case 'self-heal': {
      const result = await selfHeal();
      console.log(JSON.stringify(result));
      process.exit(result.status === 'ok' || result.status === 'self-healed' ? 0 : 2);
      break;
    }
    case 'reset-failures': {
      writeFailureState({ consecutiveFailures: 0, lastFailureAt: null, backoffUntil: null, paused: false });
      console.log(JSON.stringify({ reset: true }));
      break;
    }
    case 'lookup-tenant': {
      if (!cmdArgs[0]) { console.error('Usage: lookup-tenant <search-term>'); process.exit(1); }
      const result = await lookupTenant(cmdArgs.join(' '));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'lookup-unit': {
      if (!cmdArgs[0]) { console.error('Usage: lookup-unit <address-or-id>'); process.exit(1); }
      const result = await lookupUnit(cmdArgs.join(' '));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'lookup-work-order':
    case 'read-work-order': {
      if (!cmdArgs[0]) { console.error('Usage: read-work-order <WO-number>'); process.exit(1); }
      const result = await readWorkOrder(cmdArgs[0]);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
      break;
    }
    case 'batch-work-orders': {
      if (!cmdArgs[0]) { console.error('Usage: batch-work-orders <WO1> <WO2> ...'); process.exit(1); }
      const results = await batchWorkOrders(cmdArgs);
      console.log(JSON.stringify(results, null, 2));
      const anyError = results.some(r => r.error);
      process.exit(anyError ? 1 : 0);
      break;
    }
    case 'assign-vendor': {
      // Default: dry-run (safe). Pass --execute to actually submit.
      // assign-vendor --sr-id <id> --wo-id <id> --vendor-id <appfolio_vendor_id> [--email-link] [--text-link] [--require-accept] [--execute]
      const srIdIdx = cmdArgs.indexOf('--sr-id');
      const woIdIdx = cmdArgs.indexOf('--wo-id');
      const vendorIdIdx = cmdArgs.indexOf('--vendor-id');
      const approvalHashIdx = cmdArgs.indexOf('--approval-hash');
      const live = cmdArgs.includes('--execute');
      const dispatchFlags = {
        emailLink: cmdArgs.includes('--email-link'),
        textLink: cmdArgs.includes('--text-link'),
        requireAccept: cmdArgs.includes('--require-accept'),
      };
      const approvalHashVal = approvalHashIdx !== -1 ? cmdArgs[approvalHashIdx + 1] : undefined;

      if (srIdIdx === -1 || woIdIdx === -1 || vendorIdIdx === -1) {
        console.error('Usage: assign-vendor --sr-id <id> --wo-id <id> --vendor-id <appfolio_vendor_id> [--email-link] [--text-link] [--require-accept] [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  --email-link       Send vendor a secure WO link via email');
        console.error('  --text-link        Send vendor a secure WO link via text');
        console.error('  --require-accept   Require vendor to confirm receipt');
        console.error('  --approval-hash    Hash from dry-run output (required with --execute)');
        process.exit(1);
      }
      const srId = cmdArgs[srIdIdx + 1];
      const woId = cmdArgs[woIdIdx + 1];
      const appfolioVendorId = cmdArgs[vendorIdIdx + 1];
      if (!srId || !woId || !appfolioVendorId) {
        console.error('assign-vendor: --sr-id, --wo-id, and --vendor-id are all required');
        process.exit(1);
      }
      const result = await assignVendor(srId, woId, appfolioVendorId, live, dispatchFlags, approvalHashVal);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error || result.verified === false ? 1 : 0);
      break;
    }
    default: {
      console.error([
        'Usage: appfolio-browser-read.ts <command> [args]',
        'Commands:',
        '  check-session                 — check if AppFolio session is active',
        '  login                         — attempt login (one attempt; stops on MFA)',
        '  self-heal                     — check session; auto-relogin if expired; exponential backoff after failures',
        '  reset-failures                — clear failure state after manual relogin',
        '  lookup-tenant <name>          — search tenants by name',
        '  lookup-unit <address>         — search units by address or ID',
        '  read-work-order <WO-number>   — read WO detail page (status badge, property, vendor, description, etc.)',
        '  lookup-work-order <WO-number> — alias for read-work-order',
        '  batch-work-orders <WO1> ...   — read multiple WOs in sequence',
        '  assign-vendor --sr-id <id> --wo-id <id> --vendor-id <id> [--email-link] [--text-link] [--require-accept] [--execute --approval-hash <hash>]',
        '                                — assign vendor to WO; dry-run default, --execute + hash submits PATCH',
      ].join('\n'));
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});

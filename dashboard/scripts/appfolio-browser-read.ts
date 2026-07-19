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
 *   npx tsx scripts/appfolio-browser-read.ts assign-vendor --sr-id <id> --wo-id <id> --vendor-id <id> [--execute --approval-hash <hash>]
 *   npx tsx scripts/appfolio-browser-read.ts create-work-order --property-id <id> --description "<text>" [--execute --approval-hash <hash>]
 *   npx tsx scripts/appfolio-browser-read.ts add-note --sr-id <id> --wo-id <id> --body "<text>" [--execute --approval-hash <hash>]
 *   npx tsx scripts/appfolio-browser-read.ts update-vendor-instructions --sr-id <id> --wo-id <id> --instructions "<text>" [--replace] [--execute --approval-hash <hash>]
 *   npx tsx scripts/appfolio-browser-read.ts read-wo-messages <WO-number>
 *   npx tsx scripts/appfolio-browser-read.ts send-wo-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>] [--capture]
 *   npx tsx scripts/appfolio-browser-read.ts send-vendor-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>]
 *   npx tsx scripts/appfolio-browser-read.ts photo-intake --wo <WO-number> [--execute --approval-hash <hash>]
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
import { readFileSync, writeFileSync, mkdirSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

const SESSION_NAME = 'appfolio-ops';
const APPFOLIO_URL = process.env.APPFOLIO_WEB_URL ?? '';
const APPFOLIO_USER = process.env.APPFOLIO_WEB_USERNAME ?? '';
const APPFOLIO_PASS = process.env.APPFOLIO_WEB_PASSWORD ?? '';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

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
interface VendorResolution {
  appfolio_vendor_id: string;
  party: string;
  company_name: string;
  display_name: string;
  is_active: boolean;
}

async function resolveVendor(name: string): Promise<{ vendor?: VendorResolution; error?: string; candidates?: VendorResolution[] }> {
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return { error: 'missing_supabase_config', };
  }
  const trimmed = name.trim();
  if (!trimmed) return { error: 'empty_vendor_name' };

  const headers: Record<string, string> = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${SUPABASE_KEY}`,
  };

  // Two queries: one on company_name, one on display_name (PostgREST `or` chokes on commas in values)
  const baseSelect = 'appfolio_vendor_id,vendors!inner(is_active)';
  const fields = `display_name,company_name,${baseSelect}`;

  const companyUrl = `${SUPABASE_URL}/rest/v1/contacts?select=${encodeURIComponent(fields)}&company_name=ilike.${encodeURIComponent(trimmed)}&appfolio_vendor_id=not.is.null&vendors.is_active=eq.true`;
  const displayUrl = `${SUPABASE_URL}/rest/v1/contacts?select=${encodeURIComponent(fields)}&display_name=ilike.${encodeURIComponent(trimmed)}&appfolio_vendor_id=not.is.null&vendors.is_active=eq.true`;

  const [companyRes, displayRes] = await Promise.all([
    fetch(companyUrl, { headers }),
    fetch(displayUrl, { headers }),
  ]);

  if (!companyRes.ok || !displayRes.ok) {
    return { error: `supabase_query_failed: company=${companyRes.status}, display=${displayRes.status}` };
  }

  const companyRows = (await companyRes.json()) as Array<Record<string, unknown>>;
  const displayRows = (await displayRes.json()) as Array<Record<string, unknown>>;

  // Dedupe by appfolio_vendor_id
  const seen = new Set<string>();
  const candidates: VendorResolution[] = [];
  for (const row of [...companyRows, ...displayRows]) {
    const vid = String(row.appfolio_vendor_id ?? '');
    if (!vid || seen.has(vid)) continue;
    seen.add(vid);
    candidates.push({
      appfolio_vendor_id: vid,
      party: `v_${vid}`,
      company_name: String(row.company_name ?? ''),
      display_name: String(row.display_name ?? ''),
      is_active: (row.vendors as { is_active: boolean })?.is_active ?? false,
    });
  }

  if (candidates.length === 0) return { error: 'vendor_not_found', candidates: [] };
  if (candidates.length === 1) return { vendor: candidates[0] };
  return { error: 'ambiguous_match', candidates };
}

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

  let currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Dashboard-redirect guard: AppFolio sometimes redirects WO direct-nav back to dashboard.
  // Re-navigate once if we're not on the expected WO detail page.
  if (!/\/service_requests\/\d+/.test(currentUrl)) {
    abSafe('open', woUrl);
    abSafe('wait', '--load', 'networkidle');
    currentUrl = abSafe('get', 'url').output.trim();
    if (!/\/service_requests\/\d+/.test(currentUrl)) {
      ab('close');
      return { error: 'navigation_redirected', message: `WO detail page not accessible — redirected to: ${currentUrl}` };
    }
  }

  // Status precondition: gate on WO status, not Assign button presence.
  // Assign reappears on Completed/Canceled/Ready-to-Bill as a silent re-assign.
  // Retry once if status empty (AppFolio async-renders content after page shell).
  let woStatus = '';
  for (let statusAttempt = 0; statusAttempt < 2; statusAttempt++) {
    if (statusAttempt > 0) abSafe('wait', '5000');
    const statusResult = abEval(`(document.querySelector(".js-status-label")||{}).textContent||""`);
    try {
      let sv = statusResult.output;
      if (sv.startsWith('"') && sv.endsWith('"')) sv = JSON.parse(sv) as string;
      woStatus = sv.trim();
    } catch { /* stays empty */ }
    if (woStatus) break;
  }

  if (!woStatus) {
    ab('close');
    return { error: 'status_unreadable', message: 'Could not read WO status from .js-status-label after retry — fail closed.' };
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
      has_assigned_phrase: /Assigned/i.test(recentLog),
      has_pending_accept_phrase: /Assigned \\(pending accept\\)/i.test(recentLog),
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
  const assignPhraseVerified = dispatch.requireAccept
    ? verification.has_pending_accept_phrase === true
    : verification.has_assigned_phrase === true;
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

// ─── update-vendor-instructions ─────────────────────────────────────────────

interface UpdateVendorInstructionsParams {
  srId: string;
  woId: string;
  instructions: string;
  replace?: boolean;
}

function computeVendorInstructionsHash(params: UpdateVendorInstructionsParams, currentInstructions: string): string {
  const payload = JSON.stringify({
    srId: params.srId,
    woId: params.woId,
    instructions: params.instructions,
    replace: params.replace ?? false,
    currentInstructions,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function updateVendorInstructions(
  params: UpdateVendorInstructionsParams,
  live: boolean,
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!/^\d+$/.test(params.srId) || !/^\d+$/.test(params.woId)) {
    return { error: 'invalid_ids', message: 'srId and woId must be numeric digits only' };
  }
  if (!params.instructions.trim()) {
    return { error: 'empty_instructions', message: 'Instructions text is required' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  const woUrl = `${APPFOLIO_URL}/maintenance/service_requests/${params.srId}/work_orders/${params.woId}`;

  const opened = abSafe('open', woUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  let currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  if (!/\/service_requests\/\d+/.test(currentUrl)) {
    abSafe('open', woUrl);
    abSafe('wait', '--load', 'networkidle');
    currentUrl = abSafe('get', 'url').output.trim();
    if (!/\/service_requests\/\d+/.test(currentUrl)) {
      ab('close');
      return { error: 'navigation_redirected', message: `WO detail page not accessible — redirected to: ${currentUrl}` };
    }
  }

  // Status gate: block if terminal
  let woStatus = '';
  for (let statusAttempt = 0; statusAttempt < 2; statusAttempt++) {
    if (statusAttempt > 0) abSafe('wait', '5000');
    const statusResult = abEval(`(document.querySelector(".js-status-label")||{}).textContent||""`);
    try {
      let sv = statusResult.output;
      if (sv.startsWith('"') && sv.endsWith('"')) sv = JSON.parse(sv) as string;
      woStatus = sv.trim();
    } catch { /* stays empty */ }
    if (woStatus) break;
  }

  if (!woStatus) {
    ab('close');
    return { error: 'status_unreadable', message: 'Could not read WO status from .js-status-label after retry.' };
  }
  if (/^(Completed|Completed No Need to Bill|Canceled|Cancelled|Ready to Bill|Ready-to-Bill|Closed)$/i.test(woStatus)) {
    ab('close');
    return { error: 'terminal_status', wo_status: woStatus, message: `WO is "${woStatus}" — vendor instructions update blocked.` };
  }

  // Extract CSRF token
  const csrfResult = abEval(`var m=document.querySelector("meta[name=csrf-token]");m?m.getAttribute("content"):""`);
  let csrfToken = '';
  try {
    let ct = csrfResult.output;
    if (ct.startsWith('"') && ct.endsWith('"')) ct = JSON.parse(ct) as string;
    csrfToken = ct.trim();
  } catch { /* stays empty */ }
  if (!csrfToken) {
    ab('close');
    return { error: 'no_csrf_token', message: 'Could not extract CSRF token from page meta tag' };
  }

  // Idempotency preflight: fetch SR edit form and read current special_instructions
  const editPath = `/maintenance/service_requests/${params.srId}/edit`;
  const readInstructionsScript = `fetch("${editPath}",{headers:{"Accept":"text/html","X-Requested-With":"XMLHttpRequest","X-CSRF-Token":"${csrfToken}"}}).then(function(r){if(!r.ok){return JSON.stringify({error:"http_"+r.status});}return r.text().then(function(html){var p=new DOMParser();var doc=p.parseFromString(html,"text/html");var ta=doc.querySelector("#maintenance_service_request_special_instructions");if(!ta){return JSON.stringify({error:"field_not_found"});}return JSON.stringify({ok:true,current:ta.value||ta.textContent||""});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const readResult = abEval(readInstructionsScript);

  if (!readResult.ok) {
    ab('close');
    return { error: 'preflight_failed', reason: 'abEval error', raw: readResult.output };
  }
  let readParsed: { ok?: boolean; current?: string; error?: string } = {};
  try {
    let inner = readResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    readParsed = JSON.parse(inner) as typeof readParsed;
  } catch {
    ab('close');
    return { error: 'preflight_failed', reason: 'JSON parse error', raw: readResult.output };
  }
  if (readParsed.error || !readParsed.ok) {
    ab('close');
    return { error: 'preflight_failed', reason: readParsed.error ?? 'missing ok flag', raw: readResult.output };
  }

  const currentInstructions = readParsed.current ?? '';

  // Compute final instructions: append or replace
  let finalInstructions: string;
  if (params.replace || !currentInstructions.trim()) {
    finalInstructions = params.instructions;
  } else {
    finalInstructions = currentInstructions.trim() + '\n---\n' + params.instructions;
  }

  // Compute approval hash binding all parameters including current state
  const expectedHash = computeVendorInstructionsHash(params, currentInstructions);

  const patchUrl = `/maintenance/service_requests/${params.srId}`;
  const patchParams: Record<string, string> = {
    '_method': 'patch',
    'authenticity_token': csrfToken,
    'maintenance_service_request[special_instructions]': finalInstructions,
  };

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SUBMIT BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.',
      approval_hash: expectedHash,
      would_patch: patchUrl,
      wo_status: woStatus,
      sr_id: params.srId,
      wo_id: params.woId,
      current_instructions: currentInstructions || '(empty)',
      new_instructions: finalInstructions,
      mode: params.replace ? 'replace' : (currentInstructions.trim() ? 'append' : 'set'),
      csrf_token_extracted: true,
      csrf_token_prefix: csrfToken.slice(0, 8) + '...',
    };
  }

  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  // LIVE SUBMIT
  const patchBody = Object.entries(patchParams)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
  const bodyLiteral = JSON.stringify(patchBody);
  const submitScript = `fetch("${patchUrl}",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-CSRF-Token":"${csrfToken}","X-Requested-With":"XMLHttpRequest"},body:${bodyLiteral}}).then(function(r){return r.text().then(function(t){return JSON.stringify({status:r.status,ok:r.ok});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const submitResult = abEval(submitScript);

  let submitJson: Record<string, unknown> = {};
  try { let si = submitResult.output; if (si.startsWith('"') && si.endsWith('"')) si = JSON.parse(si) as string; submitJson = JSON.parse(si); } catch { /* use raw */ }

  const submitOk = submitResult.ok && (submitJson.ok === true || (typeof submitJson.status === 'number' && (submitJson.status as number) < 400));
  if (!submitOk) {
    ab('close');
    return { error: 'submit_failed', sr_id: params.srId, wo_id: params.woId, submit_result: Object.keys(submitJson).length ? submitJson : submitResult.output };
  }

  // Verification: re-read SR edit form to confirm instructions were saved
  await new Promise(r => setTimeout(r, 2000));
  const verifyScript = `fetch("${editPath}",{headers:{"Accept":"text/html","X-Requested-With":"XMLHttpRequest","X-CSRF-Token":"${csrfToken}"}}).then(function(r){if(!r.ok){return JSON.stringify({error:"http_"+r.status});}return r.text().then(function(html){var p=new DOMParser();var doc=p.parseFromString(html,"text/html");var ta=doc.querySelector("#maintenance_service_request_special_instructions");if(!ta){return JSON.stringify({error:"field_not_found"});}return JSON.stringify({ok:true,value:ta.value||ta.textContent||""});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const verifyResult = abEval(verifyScript);

  ab('close');

  let verifyParsed: { ok?: boolean; value?: string; error?: string } = {};
  try {
    let vi = verifyResult.output;
    if (vi.startsWith('"') && vi.endsWith('"')) vi = JSON.parse(vi) as string;
    verifyParsed = JSON.parse(vi) as typeof verifyParsed;
  } catch { verifyParsed = { error: 'parse_failed' }; }

  const normalize = (s: string) => s.replace(/\r\n/g, '\n').trim();
  const actualValue = normalize(verifyParsed.value ?? '');
  const expectedValue = normalize(finalInstructions);
  const verified = verifyParsed.ok === true && actualValue === expectedValue;

  return {
    live: true,
    verified,
    sr_id: params.srId,
    wo_id: params.woId,
    wo_status: woStatus,
    previous_instructions: currentInstructions || '(empty)',
    new_instructions: finalInstructions,
    mode: params.replace ? 'replace' : (currentInstructions.trim() ? 'append' : 'set'),
    submit_result: submitJson,
    verification: verifyParsed,
    ...(!verified && verifyParsed.ok ? { mismatch: { expected: expectedValue.substring(0, 500), actual: actualValue.substring(0, 500) } } : {}),
  };
}

// ─── create-work-order ──────────────────────────────────────────────────────

interface CreateWorkOrderParams {
  propertyId: string;
  unitId?: string;
  occupancyId?: string;
  description: string;
  category?: string;
  issueDescriptorId?: string;
  priority?: 'Urgent' | 'Normal' | 'Low';
  permissionToEnter?: 'true' | 'false' | 'not_applicable';
  specialInstructions?: string;
  requestType?: 'internal' | 'tenant_requested' | 'unit_turn';
}

const CREATE_WO_NONCE_DIR = resolve(process.cwd(), '.create-wo-nonces');

function reserveNonce(hash: string): 'reserved' | 'already_used' | 'error' {
  try { mkdirSync(CREATE_WO_NONCE_DIR, { recursive: true }); } catch { return 'error'; }
  const noncePath = resolve(CREATE_WO_NONCE_DIR, hash);
  try {
    const fd = openSync(noncePath, 'wx');
    closeSync(fd);
    return 'reserved';
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') return 'already_used';
    return 'error';
  }
}

function computeCreateWoApprovalHash(params: CreateWorkOrderParams): string {
  const propertyIdToken = params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;
  const payload = JSON.stringify({
    propertyId: params.propertyId,
    propertyIdToken,
    unitId: params.unitId ?? '',
    occupancyId: params.occupancyId ?? '',
    description: params.description,
    category: params.category ?? '',
    issueDescriptorId: params.issueDescriptorId ?? '',
    priority: params.priority ?? 'Normal',
    permissionToEnter: params.permissionToEnter ?? '',
    specialInstructions: params.specialInstructions ?? '',
    requestType: params.requestType ?? 'internal',
    party: '',
    sendVendorWoLink: '0',
    sendVendorText: '0',
    requireVendorAcceptWo: '0',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function createWorkOrder(
  params: CreateWorkOrderParams,
  live: boolean,
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!/^\d+$/.test(params.propertyId)) {
    return { error: 'invalid_property_id', message: 'propertyId must be numeric digits only' };
  }
  if (params.unitId && !/^\d+$/.test(params.unitId)) {
    return { error: 'invalid_unit_id', message: 'unitId must be numeric digits only' };
  }
  if (params.occupancyId && !/^\d+$/.test(params.occupancyId)) {
    return { error: 'invalid_occupancy_id', message: 'occupancyId must be numeric digits only' };
  }
  if (params.occupancyId && !params.unitId) {
    return { error: 'missing_unit_id', message: 'unitId is required when occupancyId is supplied (tenant-path requires both)' };
  }
  if (!params.description.trim()) {
    return { error: 'empty_description', message: 'description is required' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  // Navigate to the create form to extract CSRF from the live page
  const newFormUrl = `${APPFOLIO_URL}/maintenance/service_requests/new`;

  const opened = abSafe('open', newFormUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  let currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Dashboard-redirect guard
  if (!/\/service_requests\/new/i.test(currentUrl)) {
    abSafe('open', newFormUrl);
    abSafe('wait', '--load', 'networkidle');
    currentUrl = abSafe('get', 'url').output.trim();
    if (!/\/service_requests\/new/i.test(currentUrl)) {
      ab('close');
      return { error: 'navigation_redirected', message: `Create form not accessible — redirected to: ${currentUrl}` };
    }
  }

  // Verify the form exists on page
  const formCheck = abEval(`document.getElementById("new_maintenance_service_request")?"found":"missing"`);
  let formFound = '';
  try { let fc = formCheck.output; if (fc.startsWith('"') && fc.endsWith('"')) fc = JSON.parse(fc) as string; formFound = fc.trim(); } catch { /* stays empty */ }
  if (formFound !== 'found') {
    ab('close');
    return { error: 'form_not_found', message: 'new_maintenance_service_request form not found on page' };
  }

  // CSRF token extraction
  const csrfResult = abEval(`var m=document.querySelector("meta[name=csrf-token]");m?m.getAttribute("content"):""`);
  let csrfToken = '';
  try {
    let ct = csrfResult.output;
    if (ct.startsWith('"') && ct.endsWith('"')) ct = JSON.parse(ct) as string;
    csrfToken = ct.trim();
  } catch { /* stays empty */ }
  if (!csrfToken) {
    ab('close');
    return { error: 'no_csrf_token', message: 'Could not extract CSRF token from page meta tag' };
  }

  // Build POST body with real Rails field names
  // property_id is polymorphic: t_{occupancyId} for tenant-path, p_{propertyId} for property-path
  const propertyIdToken = params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;
  const postUrl = `${APPFOLIO_URL}/maintenance/service_requests`;
  const formFields: Record<string, string> = {
    'authenticity_token': csrfToken,
    'maintenance_service_request[property_id]': propertyIdToken,
    'maintenance_service_request[unit_id]': params.unitId ?? '',
    'maintenance_service_request[occupancy_id]': params.occupancyId ?? '',
    'maintenance_service_request[description]': params.description,
    'maintenance_service_request[maintenance_work_order][maintenance_work_order_category][work_order_category]': params.category ?? '',
    'maintenance_service_request[maintenance_work_order][issue_descriptor_id]': params.issueDescriptorId ?? '',
    'maintenance_service_request[priority]': params.priority ?? 'Normal',
    'maintenance_service_request[request_type]': params.requestType ?? 'internal',
    'maintenance_service_request[maintenance_work_order][party]': '',
    'maintenance_service_request[maintenance_work_order][send_vendor_wo_link]': '0',
    'maintenance_service_request[maintenance_work_order][send_vendor_text]': '0',
    'maintenance_service_request[maintenance_work_order][require_vendor_accept_wo]': '0',
  };
  if (params.permissionToEnter) {
    formFields['maintenance_service_request[permission_to_enter]'] = params.permissionToEnter;
  }
  if (params.specialInstructions) {
    formFields['maintenance_service_request[special_instructions]'] = params.specialInstructions;
  }

  const postBody = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const expectedHash = computeCreateWoApprovalHash(params);

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SUBMIT BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only after chief + Albie greenlight.',
      approval_hash: expectedHash,
      would_post: postUrl,
      csrf_token_extracted: true,
      csrf_token_prefix: csrfToken.slice(0, 8) + '…',
      form_id_verified: true,
      params: {
        property_id: params.propertyId,
        property_id_token: propertyIdToken,
        unit_id: params.unitId ?? '',
        occupancy_id: params.occupancyId ?? '',
        description: params.description,
        category: params.category ?? '',
        priority: params.priority ?? 'Normal',
        permission_to_enter: params.permissionToEnter ?? '',
        request_type: params.requestType ?? 'internal',
      },
      field_map: formFields,
    };
  }

  // Approval-hash binding
  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  // Atomic once-only guard: exclusive file create (wx) is check+reserve in one syscall
  const nonceResult = reserveNonce(expectedHash);
  if (nonceResult === 'already_used') {
    ab('close');
    return { error: 'hash_already_used', approval_hash: expectedHash, message: 'This approval hash has already been used to create a WO. Run a new dry-run for a fresh hash.' };
  }
  if (nonceResult === 'error') {
    ab('close');
    return { error: 'nonce_reservation_failed', message: 'Could not reserve nonce file. Refusing to POST without once-only guarantee.' };
  }

  // ── LIVE SUBMIT ──
  const bodyLiteral = JSON.stringify(postBody);
  const submitScript = `fetch("${postUrl}",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-CSRF-Token":"${csrfToken}","X-Requested-With":"XMLHttpRequest"},body:${bodyLiteral},redirect:"follow"}).then(function(r){return r.text().then(function(t){return JSON.stringify({status:r.status,ok:r.ok,final_url:r.url,body_preview:t.substring(0,500)});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const submitResult = abEval(submitScript);

  let submitJson: Record<string, unknown> = {};
  try { let si = submitResult.output; if (si.startsWith('"') && si.endsWith('"')) si = JSON.parse(si) as string; submitJson = JSON.parse(si); } catch { /* use raw */ }

  const submitOk = submitResult.ok && (submitJson.ok === true || (typeof submitJson.status === 'number' && (submitJson.status as number) < 400));
  if (!submitOk) {
    ab('close');
    return {
      error: 'submit_failed',
      hash_consumed: true,
      message: 'POST failed but approval hash is consumed (non-idempotent guard). Run a new dry-run for a fresh hash before retrying.',
      submit_result: Object.keys(submitJson).length ? submitJson : submitResult.output,
    };
  }

  // Post-create verification: navigate browser to the final_url from fetch response
  // (fetch follows redirects server-side but does NOT navigate the browser page)
  const fetchFinalUrl = String(submitJson.final_url ?? '');
  const srMatchResponse = fetchFinalUrl.match(/\/service_requests\/(\d+)/);
  const woMatchResponse = fetchFinalUrl.match(/\/work_orders\/(\d+)/);

  let verification: Record<string, unknown> = {};

  if (srMatchResponse) {
    const verifyUrl = fetchFinalUrl.startsWith('http') ? fetchFinalUrl : `${APPFOLIO_URL}${fetchFinalUrl}`;
    abSafe('open', verifyUrl);
    abSafe('wait', '--load', 'networkidle');

    const verifyResult = abEval(`
      var header = document.querySelector(".js-work-order-header-left");
      var woNum = header ? header.textContent.trim() : "";
      var srTitle = document.querySelector("h2.js-service-request-title");
      var srNum = srTitle ? srTitle.textContent.trim() : "";
      var logH3 = null;
      var h3s = document.querySelectorAll("h3");
      for (var i = 0; i < h3s.length; i++) {
        if (/Actions Log/i.test(h3s[i].textContent.trim())) { logH3 = h3s[i]; break; }
      }
      var firstLog = "";
      if (logH3) {
        var sib = logH3.nextElementSibling;
        if (sib) firstLog = sib.textContent.trim().split("\\n").map(function(l){return l.trim();}).filter(function(l){return l.length>0;}).slice(0,3).join(" | ");
      }
      JSON.stringify({ wo_number: woNum, sr_number: srNum, first_log: firstLog });
    `);

    try {
      let vi = verifyResult.output;
      if (vi.startsWith('"') && vi.endsWith('"')) vi = JSON.parse(vi) as string;
      verification = JSON.parse(vi) as Record<string, unknown>;
    } catch { verification = { parse_error: true, raw: verifyResult.output }; }
  }

  ab('close');

  const hasCreatedPhrase = /Created/i.test(String(verification.first_log ?? ''));
  const redirectedToSr = !!srMatchResponse;

  return {
    live: true,
    verified: redirectedToSr && hasCreatedPhrase,
    sr_id: srMatchResponse?.[1] ?? '',
    wo_id: woMatchResponse?.[1] ?? '',
    final_url: fetchFinalUrl,
    submit_result: submitJson,
    verification,
    hash_consumed: true,
  };
}

// ─── add-work-order-note ────────────────────────────────────────────────────

interface AddNoteParams {
  srId: string;
  woId: string;
  body: string;
}

const ADD_NOTE_NONCE_DIR = resolve(process.cwd(), '.add-note-nonces');

function reserveAddNoteNonce(hash: string): 'reserved' | 'already_used' | 'error' {
  try { mkdirSync(ADD_NOTE_NONCE_DIR, { recursive: true }); } catch { return 'error'; }
  const noncePath = resolve(ADD_NOTE_NONCE_DIR, hash);
  try {
    const fd = openSync(noncePath, 'wx');
    closeSync(fd);
    return 'reserved';
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'already_used';
    return 'error';
  }
}

function computeAddNoteApprovalHash(params: AddNoteParams): string {
  const payload = JSON.stringify({
    srId: params.srId,
    woId: params.woId,
    body: params.body,
    parentType: 'Maintenance::WorkOrderDecorator',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function addWorkOrderNote(
  params: AddNoteParams,
  live: boolean,
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!/^\d+$/.test(params.srId) || !/^\d+$/.test(params.woId)) {
    return { error: 'invalid_ids', message: 'srId and woId must be numeric digits only' };
  }
  if (!params.body.trim()) {
    return { error: 'empty_body', message: 'Note body is required' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  // Navigate to WO detail page for session context and CSRF token.
  // AppFolio changed /notes/new to XHR-only (data-remote="true"), returning 422
  // on plain browser navigation. We get the CSRF from the WO page meta tag instead,
  // then XHR POST to /notes with the required headers.
  // Warm-up: Keycloak OAuth requires the base URL first to establish the session
  // callback; direct deep-links redirect to dashboard without the warm-up.
  const woDetailUrl = `${APPFOLIO_URL}/maintenance/service_requests/${params.srId}/work_orders/${params.woId}`;
  abSafe('open', APPFOLIO_URL);
  abSafe('wait', '--load', 'networkidle');
  const opened = abSafe('open', woDetailUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  let currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  if (!/\/work_orders\//i.test(currentUrl)) {
    ab('close');
    return { error: 'navigation_redirected', message: `WO page not accessible — redirected to: ${currentUrl}` };
  }

  const csrfResult = abEval(`var m=document.querySelector("meta[name=csrf-token]");m?m.getAttribute("content"):""`);
  let csrfToken = '';
  try {
    let ct = csrfResult.output;
    if (ct.startsWith('"') && ct.endsWith('"')) ct = JSON.parse(ct) as string;
    csrfToken = ct.trim();
  } catch { /* stays empty */ }
  if (!csrfToken) {
    ab('close');
    return { error: 'no_csrf_token', message: 'Could not extract CSRF token from page meta tag' };
  }

  const postUrl = `${APPFOLIO_URL}/notes`;
  const formFields: Record<string, string> = {
    'authenticity_token': csrfToken,
    'parent_id': params.woId,
    'parent_type': 'Maintenance::WorkOrderDecorator',
    'note[body]': params.body,
    'commit': 'Save',
  };

  const postBody = Object.entries(formFields)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  const expectedHash = computeAddNoteApprovalHash(params);

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SUBMIT BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.',
      approval_hash: expectedHash,
      would_post: postUrl,
      csrf_token_extracted: true,
      csrf_token_prefix: csrfToken.slice(0, 8) + '…',
      wo_page_verified: true,
      params: {
        sr_id: params.srId,
        wo_id: params.woId,
        parent_type: 'Maintenance::WorkOrderDecorator',
        body: params.body,
      },
      field_map: formFields,
    };
  }

  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  const nonceResult = reserveAddNoteNonce(expectedHash);
  if (nonceResult === 'already_used') {
    ab('close');
    return { error: 'hash_already_used', approval_hash: expectedHash, message: 'This approval hash has already been used to add a note. Run a new dry-run for a fresh hash.' };
  }
  if (nonceResult === 'error') {
    ab('close');
    return { error: 'nonce_reserve_failed', message: 'Could not create nonce file for once-only guard.' };
  }

  const bodyLiteral = JSON.stringify(postBody);
  const submitScript = `fetch("${postUrl}",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded","X-CSRF-Token":"${csrfToken}","X-Requested-With":"XMLHttpRequest"},body:${bodyLiteral}}).then(function(r){return r.text().then(function(){return JSON.stringify({status:r.status,ok:r.ok,final_url:r.url});});}).catch(function(e){return JSON.stringify({error:e.message});})`;
  const submitResult = abEval(submitScript);

  let submitJson: Record<string, unknown> = {};
  try { let si = submitResult.output; if (si.startsWith('"') && si.endsWith('"')) si = JSON.parse(si) as string; submitJson = JSON.parse(si); } catch { /* use raw */ }

  const submitOk = submitResult.ok && (submitJson.ok === true || (typeof submitJson.status === 'number' && (submitJson.status as number) < 400));
  if (!submitOk) {
    ab('close');
    return {
      error: 'submit_failed',
      hash_consumed: true,
      message: 'POST to /notes failed but approval hash is consumed (once-only guard). Run a new dry-run for a fresh hash before retrying.',
      submit_result: Object.keys(submitJson).length ? submitJson : submitResult.output,
    };
  }

  // Post-submit verification: navigate to WO detail page and check h2 Notes section
  abSafe('open', woDetailUrl);
  abSafe('wait', '--load', 'networkidle');

  const verifyResult = abEval(`
    var notesText = "";
    var nl = document.getElementById("notes-list");
    if (nl) {
      notesText = nl.textContent.trim().substring(0, 2000);
    }
    JSON.stringify({ notes: notesText });
  `);

  let verification: Record<string, unknown> = {};
  try {
    let vi = verifyResult.output;
    if (vi.startsWith('"') && vi.endsWith('"')) vi = JSON.parse(vi) as string;
    verification = JSON.parse(vi) as Record<string, unknown>;
  } catch { verification = { parse_error: true, raw: verifyResult.output }; }

  ab('close');

  const notesContent = String(verification.notes ?? '');
  const hasPostedPhrase = /Posted/i.test(notesContent);
  const bodySnippet = params.body.substring(0, 40);
  const bodyVisible = notesContent.includes(bodySnippet);

  return {
    live: true,
    verified: hasPostedPhrase && bodyVisible,
    sr_id: params.srId,
    wo_id: params.woId,
    final_url: String(submitJson.final_url ?? ''),
    submit_result: submitJson,
    verification,
    hash_consumed: true,
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

// ─── A2: WO tenant messaging ────────────────────────────────────────────────

interface WoThreadMessage {
  direction: 'inbound' | 'outbound' | 'unknown';
  text: string;
  media_urls?: string[];
}

const MAX_SMS_LENGTH = 910;
const SEND_MSG_NONCE_DIR = resolve(process.cwd(), '.send-msg-nonces');
const SMS_SEND_CONTRACT_PATH = resolve(process.cwd(), '.sms-send-contract.json');

interface SmsSendContract {
  endpoint: string;
  method: string;
  content_type: string;
  textarea_id: string;
  payload_shape: Record<string, string>;
  verified_at: string;
  verified_by: string;
}

function readSmsSendContract(): { ok: boolean; contract?: SmsSendContract; hash?: string; error?: string } {
  try {
    const raw = readFileSync(SMS_SEND_CONTRACT_PATH, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const stringFields: (keyof Omit<SmsSendContract, 'payload_shape'>)[] = ['endpoint', 'method', 'content_type', 'textarea_id', 'verified_at', 'verified_by'];
    const badStrings = stringFields.filter(k => typeof obj[k] !== 'string' || (obj[k] as string).trim().length === 0);
    if (badStrings.length > 0) {
      return { ok: false, error: `contract_incomplete: ${badStrings.join(', ')} must be non-empty strings` };
    }
    if (typeof obj.payload_shape !== 'object' || obj.payload_shape === null || Array.isArray(obj.payload_shape)) {
      return { ok: false, error: 'contract_incomplete: payload_shape must be a non-empty object mapping POST body keys to their types' };
    }
    const shape = obj.payload_shape as Record<string, unknown>;
    const shapeEntries = Object.entries(shape);
    if (shapeEntries.length === 0) {
      return { ok: false, error: 'contract_incomplete: payload_shape must be a non-empty object mapping POST body keys to their types' };
    }
    const badShapeKeys = shapeEntries.filter(([k, v]) => k.trim().length === 0 || typeof v !== 'string' || (v as string).trim().length === 0);
    if (badShapeKeys.length > 0) {
      return { ok: false, error: 'contract_incomplete: payload_shape keys and values must be non-empty strings' };
    }
    const parsed: SmsSendContract = {
      endpoint: (obj.endpoint as string).trim(),
      method: (obj.method as string).trim(),
      content_type: (obj.content_type as string).trim(),
      textarea_id: (obj.textarea_id as string).trim(),
      payload_shape: Object.fromEntries(shapeEntries.map(([k, v]) => [k.trim(), (v as string).trim()])),
      verified_at: (obj.verified_at as string).trim(),
      verified_by: (obj.verified_by as string).trim(),
    };
    const contentHash = createHash('sha256').update(raw).digest('hex').slice(0, 16);
    return { ok: true, contract: parsed, hash: contentHash };
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ok: false, error: 'contract_not_found: .sms-send-contract.json does not exist. Requires supervised laptop discovery.' };
    }
    return { ok: false, error: `contract_read_failed: ${String(err)}` };
  }
}

function reserveSendMsgNonce(hash: string): 'reserved' | 'already_used' | 'error' {
  try { mkdirSync(SEND_MSG_NONCE_DIR, { recursive: true }); } catch { return 'error'; }
  const noncePath = resolve(SEND_MSG_NONCE_DIR, hash);
  try {
    const fd = openSync(noncePath, 'wx');
    closeSync(fd);
    return 'reserved';
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') return 'already_used';
    return 'error';
  }
}

function normalizeNameTokens(name: string): string[] {
  return name.toLowerCase().replace(/[^a-z\s]/g, '').trim().split(/\s+/).filter(t => t.length >= 2);
}

function verifyTenantNameMatch(tenantName: string, label: string): boolean {
  const tenantTokens = normalizeNameTokens(tenantName);
  const labelTokens = normalizeNameTokens(label);
  if (tenantTokens.length === 0 || labelTokens.length === 0) return false;
  if (tenantTokens.length >= 2) {
    return tenantTokens.every(t => labelTokens.some(l => l === t));
  }
  return labelTokens.includes(tenantTokens[0]);
}

function normalizeVendorName(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function vendorNameTokens(normalized: string): string[] {
  return normalized.split(' ').filter(t => t.length >= 2);
}

function verifyVendorNameMatch(vendorName: string, label: string): boolean {
  const stripped = label.replace(/\s*\(Vendor\)\s*$/i, '').trim();
  const normVendor = normalizeVendorName(vendorName);
  const normLabel = normalizeVendorName(stripped);
  if (normVendor.length === 0 || normLabel.length === 0) return false;
  if (normVendor === normLabel) return true;

  // Handle AppFolio pseudo-person "Last, First" -> "First Last" reorder
  const commaFlip = (s: string) => {
    const parts = s.split(',').map(p => p.trim());
    return parts.length === 2 ? normalizeVendorName(`${parts[1]} ${parts[0]}`) : null;
  };
  const flippedVendor = commaFlip(vendorName);
  const flippedLabel = commaFlip(stripped);
  if (flippedVendor && flippedVendor === normLabel) return true;
  if (flippedLabel && flippedLabel === normVendor) return true;
  if (flippedVendor && flippedLabel && flippedVendor === flippedLabel) return true;

  // Token-bound matching: all tokens of the shorter must appear as whole tokens in the longer
  const vTokens = vendorNameTokens(normVendor);
  const lTokens = vendorNameTokens(normLabel);
  if (vTokens.length === 0 || lTokens.length === 0) return false;

  const shorter = vTokens.length <= lTokens.length ? vTokens : lTokens;
  const longer = vTokens.length <= lTokens.length ? lTokens : vTokens;

  // Single-token names must match exactly (prevents "Pro" matching "All Pro Rooter")
  if (shorter.length === 1) return false;

  return shorter.every(t => longer.includes(t));
}

function computeEmailApprovalHash(
  srId: string, woId: string, subject: string, message: string,
  vendor: string, toAddress: string, rowLabel: string,
): string {
  const payload = JSON.stringify({
    srId, woId, subject, message, vendor, toAddress, rowLabel, channel: 'email',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function computeMessageApprovalHash(
  srId: string, woId: string, message: string, tenant: string,
  channel: string, recipientLabel: string, rowLabel: string,
  formAction: string, formMethod: string, textareaName: string,
  hiddenFieldNames: string, endpointContractHash: string,
): string {
  const payload = JSON.stringify({
    srId, woId, message, tenant, channel, recipientLabel, rowLabel,
    formAction, formMethod, textareaName, hiddenFieldNames, endpointContractHash,
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

/**
 * Open the messaging panel on a WO detail page and select the Resident thread.
 * Panel is a PARTY-TYPE picker: "Name (Resident)" / "Name (Vendor)" / "Name (Owner)".
 * Scoped to LI.list-group-item inside .js-communication-inbox-container.
 * Primary guard: regex targets (Resident) suffix only — Vendor/Owner rows excluded deterministically.
 * Secondary guard: verifyTenantNameMatch confirms clicked row matches WO tenant.
 */
function openResidentThread(tenantName?: string): { ok: boolean; tenant_label?: string; error?: string; count?: number; labels?: string[]; message?: string } {
  const launcherResult = abEval(
    'var btn=document.querySelector(\'button[data-messaging-launcher-trigger="true"]\');' +
    'if(btn){btn.click();JSON.stringify({ok:true});}' +
    'else{JSON.stringify({error:"messaging_launcher_not_found"});}'
  );
  let launcherParsed: { ok?: boolean; error?: string } = {};
  try {
    let inner = launcherResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    launcherParsed = JSON.parse(inner);
  } catch { launcherParsed = { error: 'launcher_parse_failed' }; }
  if (launcherParsed.error || !launcherParsed.ok) {
    return { ok: false, error: launcherParsed.error ?? 'launcher_click_failed' };
  }

  abSafe('wait', '3000');

  // Find party-type picker rows: LI.list-group-item inside .js-communication-inbox-container
  // Real format is "Name (Resident)" / "Name (Vendor)" / "Name (Owner)" — match (Resident) suffix only
  const residentResult = abEval(
    'var matches=[];' +
    'var container=document.querySelector(".js-communication-inbox-container");' +
    'if(container){' +
    '  var els=container.querySelectorAll("li.list-group-item");' +
    '  for(var i=0;i<els.length;i++){' +
    '    var t=els[i].textContent.trim();' +
    '    if(/\\(Resident\\)\\s*$/.test(t)&&els[i].offsetHeight>0){' +
    '      matches.push(els[i]);' +
    '    }' +
    '  }' +
    '}' +
    'JSON.stringify({count:matches.length,' +
    '  labels:matches.map(function(m){return m.textContent.trim().substring(0,200)})});'
  );
  let residentParsed: { count?: number; labels?: string[]; error?: string } = {};
  try {
    let inner = residentResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    residentParsed = JSON.parse(inner);
  } catch { residentParsed = { error: 'resident_parse_failed' }; }
  if (residentParsed.error) {
    return { ok: false, error: residentParsed.error };
  }

  const count = residentParsed.count ?? 0;
  const labels = residentParsed.labels ?? [];

  if (count === 0) {
    return { ok: false, error: 'resident_row_not_found' };
  }

  let targetIndex = 0;
  if (count === 1) {
    targetIndex = 0;
  } else if (tenantName) {
    const matchingIndices = labels
      .map((label, i) => ({ label, i }))
      .filter(({ label }) => verifyTenantNameMatch(tenantName, label));
    if (matchingIndices.length === 0) {
      return { ok: false, error: 'resident_no_tenant_match', count, labels: labels.slice(0, 5),
        message: `${count} Resident rows found but none match WO tenant "${tenantName}"` };
    }
    if (matchingIndices.length > 1) {
      return { ok: false, error: 'resident_multiple_tenant_match', count, labels: labels.slice(0, 5),
        message: `${count} Resident rows, ${matchingIndices.length} match tenant "${tenantName}" — cannot disambiguate` };
    }
    targetIndex = matchingIndices[0].i;
  } else {
    return { ok: false, error: 'resident_ambiguous', count, labels: labels.slice(0, 5) };
  }

  // Click the selected Resident row by index (same scoped selector as discovery)
  const clickResult = abEval(
    'var matches=[];' +
    'var container=document.querySelector(".js-communication-inbox-container");' +
    'if(container){' +
    '  var els=container.querySelectorAll("li.list-group-item");' +
    '  for(var i=0;i<els.length;i++){' +
    '    var t=els[i].textContent.trim();' +
    '    if(/\\(Resident\\)\\s*$/.test(t)&&els[i].offsetHeight>0){' +
    '      matches.push(els[i]);' +
    '    }' +
    '  }' +
    '}' +
    `var idx=${targetIndex};` +
    'if(idx<matches.length){matches[idx].click();JSON.stringify({ok:true,label:matches[idx].textContent.trim().substring(0,200)});}' +
    'else{JSON.stringify({error:"resident_index_out_of_range"});}'
  );
  let clickParsed: { ok?: boolean; error?: string; label?: string } = {};
  try {
    let inner = clickResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    clickParsed = JSON.parse(inner);
  } catch { clickParsed = { error: 'click_parse_failed' }; }
  if (clickParsed.error || !clickParsed.ok) {
    return { ok: false, error: clickParsed.error ?? 'resident_click_failed' };
  }

  // Defense-in-depth: re-verify clicked row label matches tenant (guards against DOM order-swap between queries)
  if (tenantName && clickParsed.label && !verifyTenantNameMatch(tenantName, clickParsed.label)) {
    return { ok: false, error: 'resident_click_tenant_mismatch',
      message: `Clicked row label "${clickParsed.label}" does not match WO tenant "${tenantName}" — possible DOM reorder between queries` };
  }

  abSafe('wait', '3000');

  return { ok: true, tenant_label: clickParsed.label };
}

function openVendorThread(vendorName?: string): { ok: boolean; vendor_label?: string; error?: string; count?: number; labels?: string[]; message?: string } {
  const launcherResult = abEval(
    'var btn=document.querySelector(\'button[data-messaging-launcher-trigger="true"]\');' +
    'if(btn){btn.click();JSON.stringify({ok:true});}' +
    'else{JSON.stringify({error:"messaging_launcher_not_found"});}'
  );
  let launcherParsed: { ok?: boolean; error?: string } = {};
  try {
    let inner = launcherResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    launcherParsed = JSON.parse(inner);
  } catch { launcherParsed = { error: 'launcher_parse_failed' }; }
  if (launcherParsed.error || !launcherParsed.ok) {
    return { ok: false, error: launcherParsed.error ?? 'launcher_click_failed' };
  }

  abSafe('wait', '3000');

  const vendorResult = abEval(
    'var matches=[];' +
    'var container=document.querySelector(".js-communication-inbox-container");' +
    'if(container){' +
    '  var els=container.querySelectorAll("li.list-group-item");' +
    '  for(var i=0;i<els.length;i++){' +
    '    var t=els[i].textContent.trim();' +
    '    if(/\\(Vendor\\)\\s*$/.test(t)&&els[i].offsetHeight>0){' +
    '      matches.push(els[i]);' +
    '    }' +
    '  }' +
    '}' +
    'JSON.stringify({count:matches.length,' +
    '  labels:matches.map(function(m){return m.textContent.trim().substring(0,200)})});'
  );
  let vendorParsed: { count?: number; labels?: string[]; error?: string } = {};
  try {
    let inner = vendorResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    vendorParsed = JSON.parse(inner);
  } catch { vendorParsed = { error: 'vendor_parse_failed' }; }
  if (vendorParsed.error) {
    return { ok: false, error: vendorParsed.error };
  }

  const count = vendorParsed.count ?? 0;
  const labels = vendorParsed.labels ?? [];

  if (count === 0) {
    return { ok: false, error: 'vendor_row_not_found' };
  }

  let targetIndex = 0;
  if (count === 1) {
    targetIndex = 0;
  } else if (vendorName) {
    const matchingIndices = labels
      .map((label, i) => ({ label, i }))
      .filter(({ label }) => verifyVendorNameMatch(vendorName, label));
    if (matchingIndices.length === 0) {
      return { ok: false, error: 'vendor_no_name_match', count, labels: labels.slice(0, 5),
        message: `${count} Vendor rows found but none match WO vendor "${vendorName}"` };
    }
    if (matchingIndices.length > 1) {
      return { ok: false, error: 'vendor_multiple_name_match', count, labels: labels.slice(0, 5),
        message: `${count} Vendor rows, ${matchingIndices.length} match vendor "${vendorName}" — cannot disambiguate` };
    }
    targetIndex = matchingIndices[0].i;
  } else {
    return { ok: false, error: 'vendor_ambiguous', count, labels: labels.slice(0, 5) };
  }

  const clickResult = abEval(
    'var matches=[];' +
    'var container=document.querySelector(".js-communication-inbox-container");' +
    'if(container){' +
    '  var els=container.querySelectorAll("li.list-group-item");' +
    '  for(var i=0;i<els.length;i++){' +
    '    var t=els[i].textContent.trim();' +
    '    if(/\\(Vendor\\)\\s*$/.test(t)&&els[i].offsetHeight>0){' +
    '      matches.push(els[i]);' +
    '    }' +
    '  }' +
    '}' +
    `var idx=${targetIndex};` +
    'if(idx<matches.length){matches[idx].click();JSON.stringify({ok:true,label:matches[idx].textContent.trim().substring(0,200)});}' +
    'else{JSON.stringify({error:"vendor_index_out_of_range"});}'
  );
  let clickParsed: { ok?: boolean; error?: string; label?: string } = {};
  try {
    let inner = clickResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    clickParsed = JSON.parse(inner);
  } catch { clickParsed = { error: 'click_parse_failed' }; }
  if (clickParsed.error || !clickParsed.ok) {
    return { ok: false, error: clickParsed.error ?? 'vendor_click_failed' };
  }

  if (vendorName && clickParsed.label && !verifyVendorNameMatch(vendorName, clickParsed.label)) {
    return { ok: false, error: 'vendor_click_name_mismatch',
      message: `Clicked row label "${clickParsed.label}" does not match WO vendor "${vendorName}" — possible DOM reorder between queries` };
  }

  abSafe('wait', '3000');

  return { ok: true, vendor_label: clickParsed.label };
}

/**
 * Extract messages from the currently-open tenant message thread.
 * Thread direction is STRUCTURAL per chief's deep-pass map:
 *   inbound (from tenant): offset-sm-0 + bg-light
 *   outbound (to tenant): offset-sm-4 + bg-primary
 * Key on offset/bg class pair, NOT sender-label (labels vary).
 */
function extractThreadMessages(): { messages: WoThreadMessage[]; channel: string } {
  const msgResult = abEval(
    'var msgs=[];' +
    'var allEls=document.querySelectorAll("[class*=\\"col-sm\\"]");' +
    'for(var i=0;i<allEls.length;i++){' +
    '  var el=allEls[i];var cls=el.className||"";' +
    '  if(!/offset-sm-[04]/.test(cls))continue;' +
    '  var isIn=/offset-sm-0/.test(cls);' +
    '  var isOut=/offset-sm-4/.test(cls);' +
    '  var html=el.innerHTML||"";' +
    '  var bgL=/bg-light|bg-secondary/.test(html)||/bg-light|bg-secondary/.test(cls);' +
    '  var bgP=/bg-primary/.test(html)||/bg-primary/.test(cls);' +
    '  var dir="unknown";' +
    '  if(isIn&&bgL)dir="inbound";' +
    '  else if(isOut&&bgP)dir="outbound";' +
    '  else continue;' +
    '  var t=el.textContent.trim();' +
    '  var imgs=el.querySelectorAll("img");' +
    '  var urls=[];' +
    '  for(var k=0;k<imgs.length&&k<5;k++){' +
    '    var s=imgs[k].src||"";' +
    '    if(s&&/^https?:\\/\\//.test(s))urls.push(s.substring(0,500));' +
    '  }' +
    '  if(t.length>0||urls.length>0){' +
    '    var m={direction:dir,text:t.substring(0,500)};' +
    '    if(urls.length>0)m.media_urls=urls;' +
    '    msgs.push(m);' +
    '  }' +
    '}' +
    'var ch="unknown";' +
    'var sel=document.querySelector("select");' +
    'if(sel){for(var j=0;j<sel.options.length;j++){' +
    '  if(sel.options[j].selected){ch=sel.options[j].text.trim();break;}' +
    '}}' +
    'JSON.stringify({count:msgs.length,messages:msgs.slice(0,50),channel:ch});'
  );
  let parsed: { count: number; messages: WoThreadMessage[]; channel: string } = { count: 0, messages: [], channel: 'unknown' };
  try {
    let inner = msgResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    parsed = JSON.parse(inner);
  } catch { /* stays empty */ }
  return { messages: parsed.messages, channel: parsed.channel };
}

interface ComposerContract {
  recipient_label: string;
  channel: string;
  textarea_name: string;
  container_found: boolean;
  send_button_text: string;
  send_button_scoped: boolean;
  form_action: string;
  form_method: string;
  hidden_fields: string[];
}

function extractComposerContract(): { ok: boolean; contract?: ComposerContract; error?: string } {
  const result = abEval(
    'var ta=document.getElementById("messaging-input");' +
    'if(!ta){JSON.stringify({ok:false,error:"textarea_not_found"});}' +
    'else{' +
    '  var container=null;var p=ta;' +
    '  for(var i=0;i<15&&p.parentElement;i++){' +
    '    p=p.parentElement;' +
    '    if(p.querySelector&&' +
    '       p.querySelector(".btn-primary,button[type=submit]")){' +
    '      container=p;break;' +
    '    }' +
    '  }' +
    '  var containerFound=!!container;' +
    '  var searchRoot=container||ta.parentElement;' +
    '  var ch="unknown";' +
    '  var sel=searchRoot?searchRoot.querySelector("select"):null;' +
    '  if(sel){for(var j=0;j<sel.options.length;j++){' +
    '    if(sel.options[j].selected){ch=sel.options[j].text.trim();break;}' +
    '  }}' +
    '  if(ch==="unknown"&&searchRoot){' +
    '    var toggles=searchRoot.querySelectorAll(".dropdown-toggle,button,a");' +
    '    for(var ti=0;ti<toggles.length;ti++){' +
    '      var tt=toggles[ti].textContent.trim();' +
    '      if(/^Send via (SMS|Email)/i.test(tt)&&tt.length<40){ch=tt;break;}' +
    '    }' +
    '  }' +
    '  if(ch==="unknown"&&searchRoot){' +
    '    var labels=searchRoot.querySelectorAll("label,span,div");' +
    '    for(var li=0;li<labels.length;li++){' +
    '      var lt=labels[li].textContent.trim();' +
    '      if(/^(SMS|Text Message)/i.test(lt)&&lt.length<30){ch=lt;break;}' +
    '    }' +
    '  }' +
    '  var recipient="";' +
    '  var skipRe=/^(Send|Message|Conversations|Reply|New|Subject|All Conversations|Toggle|Attach|Use Template|View Email)/i;' +
    '  var recipientScopes=[searchRoot,searchRoot?searchRoot.closest("section"):null,searchRoot?searchRoot.closest(".position-fixed"):null];' +
    '  for(var rs=0;rs<recipientScopes.length&&!recipient;rs++){' +
    '    var scope=recipientScopes[rs];if(!scope)continue;' +
    '    var cands=scope.querySelectorAll(' +
    '      "h1,h2,h3,h4,h5,.name,.recipient,strong,b,' +
    '      [class*=header],[class*=title],[class*=contact]");' +
    '    for(var h=0;h<cands.length;h++){' +
    '      var ht=cands[h].textContent.trim();' +
    '      if(ht.length>2&&ht.length<200&&!skipRe.test(ht)&&cands[h].offsetHeight>0){' +
    '        recipient=ht.substring(0,200);break;' +
    '      }' +
    '    }' +
    '  }' +
    '  var form=ta.closest("form");' +
    '  var formAction=form?(form.action||"empty"):"no_form";' +
    '  var formMethod=form?(form.method||"get").toUpperCase():"no_form";' +
    '  var taName=ta.name||ta.id||"";' +
    '  var hiddenFields=[];' +
    '  if(form){var hids=form.querySelectorAll("input[type=hidden]");' +
    '    for(var k=0;k<hids.length;k++){' +
    '      hiddenFields.push(hids[k].name+"="+(hids[k].value||"").substring(0,50));' +
    '    }' +
    '  }' +
    '  var sendBtn=null;var sendBtnText="";var scoped=false;' +
    '  if(form){sendBtn=form.querySelector(".btn-primary:not([disabled]),button[type=submit]:not([disabled])");scoped=!!sendBtn;}' +
    '  if(!sendBtn&&container){sendBtn=container.querySelector(".btn-primary,button[type=submit]");scoped=!!sendBtn;}' +
    '  if(sendBtn)sendBtnText=sendBtn.textContent.trim().substring(0,50);' +
    '  JSON.stringify({ok:true,recipient_label:recipient,channel:ch,' +
    '    textarea_name:taName,container_found:containerFound,' +
    '    send_button_text:sendBtnText,send_button_scoped:scoped,' +
    '    form_action:formAction,form_method:formMethod,hidden_fields:hiddenFields});' +
    '}'
  );
  let parsed: { ok: boolean; error?: string } & Partial<ComposerContract> = { ok: false };
  try {
    let inner = result.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    parsed = JSON.parse(inner);
  } catch { parsed = { ok: false, error: 'contract_parse_failed' }; }

  if (!parsed.ok || parsed.error) {
    return { ok: false, error: parsed.error ?? 'contract_extraction_failed' };
  }

  return {
    ok: true,
    contract: {
      recipient_label: parsed.recipient_label ?? '',
      channel: parsed.channel ?? 'unknown',
      textarea_name: parsed.textarea_name ?? '',
      container_found: parsed.container_found ?? false,
      send_button_text: parsed.send_button_text ?? '',
      send_button_scoped: parsed.send_button_scoped ?? false,
      form_action: parsed.form_action ?? 'unknown',
      form_method: parsed.form_method ?? 'unknown',
      hidden_fields: parsed.hidden_fields ?? [],
    },
  };
}

async function readWoMessages(woQuery: string): Promise<object> {
  if (!WO_QUERY_RE.test(woQuery)) {
    return { error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${woQuery.substring(0, 50)}").` };
  }

  const woDetail = await readWorkOrder(woQuery, true);
  if (woDetail.error) {
    try { ab('close'); } catch { /* already closed */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, messages: [], error: woDetail.error, message: woDetail.message,
    };
  }

  const threadResult = openResidentThread(woDetail.tenant ?? undefined);
  if (!threadResult.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, messages: [], error: threadResult.error,
      ...(threadResult.count ? { resident_count: threadResult.count, resident_labels: threadResult.labels } : {}),
    };
  }

  const { messages, channel } = extractThreadMessages();

  ab('close');

  return {
    wo_number: woDetail.wo_number,
    sr_id: woDetail.sr_id,
    wo_id: woDetail.wo_id,
    tenant: woDetail.tenant,
    tenant_label: threadResult.tenant_label,
    channel,
    messages,
    message_count: messages.length,
  };
}

// ─── photo-intake pipeline (inbound: A→B→D→E) ─────────────────────────────

const PHOTO_INTAKE_PLAN_DIR = resolve(process.cwd(), '.photo-intake-plans');

interface VisionResult {
  make?: string;
  model?: string;
  serial?: string;
  other_details?: string;
  confidence: 'high' | 'medium' | 'low';
  raw_text?: string;
}

interface PhotoIntakeResult {
  wo_number?: string;
  sr_id?: string;
  wo_id?: string;
  tenant?: string;
  photos_found: number;
  photos_analyzed: number;
  analyses: Array<{
    url: string;
    download_ok: boolean;
    vision?: VisionResult;
    note_added?: boolean;
    error?: string;
  }>;
  error?: string;
  message?: string;
}

async function downloadImage(url: string): Promise<{ path: string; content_type: string } | { error: string }> {
  const MAX_SIZE = 20 * 1024 * 1024; // 20MB
  try {
    const resp = await fetch(url, { redirect: 'follow' });
    if (!resp.ok) return { error: `http_${resp.status}` };

    const contentType = resp.headers.get('content-type') ?? '';
    if (!contentType.startsWith('image/')) {
      return { error: `not_image: ${contentType.substring(0, 50)}` };
    }

    const contentLength = parseInt(resp.headers.get('content-length') ?? '0', 10);
    if (contentLength > MAX_SIZE) return { error: `too_large: ${contentLength}` };

    const buffer = Buffer.from(await resp.arrayBuffer());
    if (buffer.length > MAX_SIZE) return { error: `too_large: ${buffer.length}` };

    const ext = contentType.includes('png') ? '.png' : contentType.includes('webp') ? '.webp' : '.jpg';
    const filename = `photo-intake-${Date.now()}${ext}`;
    const filepath = join(tmpdir(), filename);
    writeFileSync(filepath, buffer);
    return { path: filepath, content_type: contentType };
  } catch (err) {
    return { error: `download_failed: ${String(err).substring(0, 100)}` };
  }
}

async function analyzeImage(imagePath: string, woContext: string): Promise<VisionResult | { error: string }> {
  const imageData = readFileSync(imagePath);
  const base64 = imageData.toString('base64');
  const ext = imagePath.endsWith('.png') ? 'image/png' : imagePath.endsWith('.webp') ? 'image/webp' : 'image/jpeg';

  const geminiKey = process.env.GEMINI_API_KEY;
  const apiKey = process.env.ANTHROPIC_API_KEY;

  if (geminiKey) {
    return analyzeWithGemini(base64, ext, woContext, geminiKey);
  } else if (apiKey) {
    return analyzeWithClaude(base64, ext, woContext, apiKey);
  }
  return { error: 'no_vision_api_key: set GEMINI_API_KEY or ANTHROPIC_API_KEY' };
}

async function analyzeWithClaude(base64: string, mimeType: string, woContext: string, apiKey: string): Promise<VisionResult | { error: string }> {
  const body = {
    model: 'claude-sonnet-4-6-20250514',
    max_tokens: 1024,
    messages: [{
      role: 'user' as const,
      content: [
        { type: 'image' as const, source: { type: 'base64' as const, media_type: mimeType, data: base64 } },
        { type: 'text' as const, text: buildVisionPrompt(woContext) },
      ],
    }],
  };

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) return { error: `claude_api_${resp.status}: ${(await resp.text()).substring(0, 200)}` };
    const result = await resp.json() as { content: Array<{ type: string; text?: string }> };
    const text = result.content?.find(c => c.type === 'text')?.text ?? '';
    return parseVisionResponse(text);
  } catch (err) {
    return { error: `claude_error: ${String(err).substring(0, 100)}` };
  }
}

async function analyzeWithGemini(base64: string, mimeType: string, woContext: string, apiKey: string): Promise<VisionResult | { error: string }> {
  const body = {
    contents: [{
      parts: [
        { inline_data: { mime_type: mimeType, data: base64 } },
        { text: buildVisionPrompt(woContext) },
      ],
    }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 1024 },
  };

  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (!resp.ok) return { error: `gemini_api_${resp.status}: ${(await resp.text()).substring(0, 200)}` };
    const result = await resp.json() as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }> };
    const text = result.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    return parseVisionResponse(text);
  } catch (err) {
    return { error: `gemini_error: ${String(err).substring(0, 100)}` };
  }
}

function buildVisionPrompt(woContext: string): string {
  return `You are analyzing a maintenance work order photo sent by a tenant. Context: ${woContext}

Extract any appliance or equipment information visible in this image. Look for:
- Make/manufacturer (brand name on labels, stickers, or the unit itself)
- Model number (on labels, stickers, rating plates)
- Serial number (on labels, stickers, rating plates)
- Any other relevant specs (capacity, voltage, year, etc.)

Respond in EXACTLY this JSON format (no markdown, no extra text):
{"make":"","model":"","serial":"","other_details":"","confidence":"high|medium|low","raw_text":""}

Rules:
- "confidence": "high" = clearly readable text on label/sticker
- "confidence": "medium" = partially readable or inferred from visible branding
- "confidence": "low" = unclear, guessing, or no relevant info found
- If you cannot find appliance/equipment info (e.g. photo shows damage only, no labels), set confidence to "low" and put description in other_details
- "raw_text": any text you can read verbatim from labels/stickers
- Leave fields empty string if not found`;
}

function parseVisionResponse(text: string): VisionResult {
  const cleaned = text.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();

  // Try direct parse first
  let parsed: Record<string, string> | null = null;
  try {
    parsed = JSON.parse(cleaned) as Record<string, string>;
  } catch {
    // Try extracting JSON object from surrounding text
    const jsonMatch = cleaned.match(/\{[\s\S]*"confidence"[\s\S]*\}/);
    if (jsonMatch) {
      try { parsed = JSON.parse(jsonMatch[0]) as Record<string, string>; } catch { /* fall through */ }
    }
  }

  if (parsed) {
    let make = parsed.make || '';
    let model = parsed.model || '';
    let serial = parsed.serial || '';
    let otherDetails = parsed.other_details || '';
    let rawText = parsed.raw_text || '';
    let confidence = parsed.confidence || '';

    // Gemini sometimes nests structured fields as a JSON string inside other_details/raw_text
    if (!make && !model && !serial) {
      for (const candidate of [otherDetails, rawText]) {
        const trimmed = candidate.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
          const inner = JSON.parse(trimmed) as Record<string, string>;
          make = inner.make || '';
          model = inner.model || '';
          serial = inner.serial || '';
          if (inner.other_details) otherDetails = inner.other_details;
          if (inner.raw_text) rawText = inner.raw_text;
          if (inner.confidence) confidence = inner.confidence;
          break;
        } catch { /* try next candidate */ }
      }
    }

    // Confidence reflects genuine read quality: fields present + Gemini's own signal
    if (!['high', 'medium', 'low'].includes(confidence)) {
      confidence = (make && model) ? 'medium' : 'low';
    }

    return {
      make: make || undefined,
      model: model || undefined,
      serial: serial || undefined,
      other_details: otherDetails || undefined,
      confidence: confidence as 'high' | 'medium' | 'low',
      raw_text: rawText || undefined,
    };
  }

  return { confidence: 'low', other_details: text.substring(0, 500), raw_text: text.substring(0, 500) };
}

function buildNoteBody(vision: VisionResult, photoUrl: string): string {
  const parts: string[] = ['[Photo Analysis]'];

  if (vision.make || vision.model) {
    const id = [vision.make, vision.model].filter(Boolean).join(' ');
    parts.push(`Appliance: ${id}`);
  }
  if (vision.serial) parts.push(`S/N: ${vision.serial}`);
  if (vision.other_details) parts.push(`Details: ${vision.other_details}`);
  if (vision.raw_text && vision.raw_text !== vision.other_details) {
    parts.push(`Label text: ${vision.raw_text}`);
  }
  parts.push(`Confidence: ${vision.confidence}`);
  parts.push(`Source: tenant MMS photo`);
  parts.push(`[FIDUCIARY NOTE: This is a vision-model read of a tenant photo. Confidence level indicates extraction reliability. Verify against physical unit before ordering parts.]`);

  return parts.join('\n');
}

interface PlannedNote {
  url: string;
  body: string;
  add_note_hash: string;
  vision: VisionResult;
}

interface PhotoIntakePlan {
  wo_number: string;
  sr_id: string;
  wo_id: string;
  tenant: string;
  tenant_label: string;
  media_urls: string[];
  planned_notes: PlannedNote[];
  skipped: Array<{ url: string; reason: string }>;
}

function computePhotoIntakePlanHash(plan: PhotoIntakePlan): string {
  const payload = JSON.stringify({
    sr_id: plan.sr_id,
    wo_id: plan.wo_id,
    tenant: plan.tenant,
    media_urls: plan.media_urls,
    planned_notes: plan.planned_notes.map(n => ({ url: n.url, body: n.body, hash: n.add_note_hash })),
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

async function photoIntake(woQuery: string, execute: boolean, approvalHash?: string): Promise<PhotoIntakeResult> {
  if (!WO_QUERY_RE.test(woQuery)) {
    return { photos_found: 0, photos_analyzed: 0, analyses: [], error: 'invalid_query', message: `WO query must be digits (got "${woQuery.substring(0, 50)}").` };
  }

  // Execute mode: read stored plan, verify media presence, post notes (no vision re-run)
  if (execute) {
    if (!approvalHash) {
      return { photos_found: 0, photos_analyzed: 0, analyses: [], error: 'missing_approval_hash', message: 'Execute mode requires --approval-hash from a prior dry-run.' };
    }
    const planPath = join(PHOTO_INTAKE_PLAN_DIR, `${approvalHash}.json`);
    if (!existsSync(planPath)) {
      return { photos_found: 0, photos_analyzed: 0, analyses: [], error: 'plan_not_found', message: `No stored plan for hash ${approvalHash}. Run dry-run first.` };
    }

    let storedPlan: PhotoIntakePlan;
    try {
      storedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
    } catch {
      return { photos_found: 0, photos_analyzed: 0, analyses: [], error: 'plan_parse_error', message: `Failed to parse stored plan at ${planPath}.` };
    }

    // Integrity: recompute hash from loaded content; reject if tampered/corrupted
    const recomputedHash = computePhotoIntakePlanHash(storedPlan);
    if (recomputedHash !== approvalHash) {
      return { photos_found: 0, photos_analyzed: 0, analyses: [], error: 'plan_integrity_failed', message: `Stored plan content does not match approval hash. Expected ${approvalHash}, got ${recomputedHash}. Plan file may be corrupted.` };
    }

    // Light guard: open thread and confirm approved media URLs are still present
    const woDetail = await readWorkOrder(woQuery, true);
    if (woDetail.error) {
      try { ab('close'); } catch { /* */ }
      return {
        wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
        tenant: woDetail.tenant, photos_found: 0, photos_analyzed: 0, analyses: [],
        error: woDetail.error, message: woDetail.message,
      };
    }

    const threadResult = openResidentThread(woDetail.tenant ?? undefined);
    if (!threadResult.ok) {
      try { ab('close'); } catch { /* */ }
      return {
        wo_number: storedPlan.wo_number, sr_id: storedPlan.sr_id, wo_id: storedPlan.wo_id,
        tenant: storedPlan.tenant, photos_found: 0, photos_analyzed: 0, analyses: [],
        error: threadResult.error,
      };
    }

    const { messages } = extractThreadMessages();
    ab('close');

    const currentMediaUrls: string[] = [];
    for (const msg of messages) {
      if (msg.direction === 'inbound' && msg.media_urls) {
        for (const url of msg.media_urls) {
          if (!currentMediaUrls.includes(url)) currentMediaUrls.push(url);
        }
      }
    }

    // Verify all planned note URLs are still present in thread
    const missingUrls = storedPlan.planned_notes
      .map(n => n.url)
      .filter(url => !currentMediaUrls.includes(url));

    if (missingUrls.length > 0) {
      return {
        wo_number: storedPlan.wo_number, sr_id: storedPlan.sr_id, wo_id: storedPlan.wo_id,
        tenant: storedPlan.tenant, photos_found: currentMediaUrls.length, photos_analyzed: 0, analyses: [],
        error: 'media_missing',
        message: `${missingUrls.length} photo(s) from the approved plan are no longer in the thread. Re-run dry-run.`,
      };
    }

    // Post exact stored note bodies (skip verified-posted notes on retry)
    const analyses: PhotoIntakeResult['analyses'] = [];
    let noteFailed = false;
    for (const planned of storedPlan.planned_notes) {
      // Skip notes with a verified-success marker (confirmed posted on a prior attempt)
      const postedMarker = join(PHOTO_INTAKE_PLAN_DIR, `${approvalHash}.${planned.add_note_hash}.posted`);
      if (existsSync(postedMarker)) {
        analyses.push({ url: planned.url, download_ok: true, vision: planned.vision, note_added: true });
        continue;
      }

      const noteParams: AddNoteParams = { srId: storedPlan.sr_id, woId: storedPlan.wo_id, body: planned.body };
      const noteResult = await addWorkOrderNote(noteParams, true, planned.add_note_hash);
      const entry: PhotoIntakeResult['analyses'][number] = { url: planned.url, download_ok: true, vision: planned.vision };
      if (noteResult.error) {
        entry.error = `note_failed: ${noteResult.error}`;
        entry.note_added = false;
        noteFailed = true;
      } else if (noteResult.verified === false) {
        entry.error = 'note_failed: verification_failed';
        entry.note_added = false;
        noteFailed = true;
      } else {
        entry.note_added = true;
        try { writeFileSync(postedMarker, ''); } catch { /* best-effort */ }
      }
      analyses.push(entry);
    }

    // Single-use: consume plan file + markers on full success
    if (!noteFailed) {
      try {
        for (const planned of storedPlan.planned_notes) {
          const marker = join(PHOTO_INTAKE_PLAN_DIR, `${approvalHash}.${planned.add_note_hash}.posted`);
          try { unlinkSync(marker); } catch { /* */ }
        }
        unlinkSync(planPath);
      } catch {
        return {
          wo_number: storedPlan.wo_number, sr_id: storedPlan.sr_id, wo_id: storedPlan.wo_id,
          tenant: storedPlan.tenant, photos_found: currentMediaUrls.length,
          photos_analyzed: storedPlan.planned_notes.length, analyses,
          error: 'plan_cleanup_failed',
          message: 'All notes posted successfully but plan file could not be deleted. Manual cleanup required.',
        };
      }
    }

    return {
      wo_number: storedPlan.wo_number,
      sr_id: storedPlan.sr_id,
      wo_id: storedPlan.wo_id,
      tenant: storedPlan.tenant,
      photos_found: currentMediaUrls.length,
      photos_analyzed: storedPlan.planned_notes.length,
      analyses,
      ...(noteFailed ? { error: 'note_write_failed', message: 'One or more notes failed to post or verify. See analyses for details.' } : {}),
    };
  }

  // Dry-run mode: full pipeline (read thread → download → vision → build plan → persist)
  const woDetail = await readWorkOrder(woQuery, true);
  if (woDetail.error) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, photos_found: 0, photos_analyzed: 0, analyses: [],
      error: woDetail.error, message: woDetail.message,
    };
  }

  const threadResult = openResidentThread(woDetail.tenant ?? undefined);
  if (!threadResult.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, photos_found: 0, photos_analyzed: 0, analyses: [],
      error: threadResult.error,
    };
  }

  const { messages } = extractThreadMessages();
  ab('close');

  const inboundPhotos: string[] = [];
  for (const msg of messages) {
    if (msg.direction === 'inbound' && msg.media_urls) {
      for (const url of msg.media_urls) {
        if (!inboundPhotos.includes(url)) inboundPhotos.push(url);
      }
    }
  }

  if (inboundPhotos.length === 0) {
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, photos_found: 0, photos_analyzed: 0, analyses: [],
      message: 'No inbound photos found in tenant thread.',
    };
  }

  const woContext = `WO#${woDetail.wo_number} - ${woDetail.description ?? 'maintenance request'}`;
  const analyses: PhotoIntakeResult['analyses'] = [];
  const plannedNotes: PlannedNote[] = [];
  const skipped: Array<{ url: string; reason: string }> = [];

  for (const url of inboundPhotos.slice(0, 10)) {
    const dlResult = await downloadImage(url);
    if ('error' in dlResult) {
      analyses.push({ url, download_ok: false, error: dlResult.error });
      skipped.push({ url, reason: `download: ${dlResult.error}` });
      continue;
    }

    const visionResult = await analyzeImage(dlResult.path, woContext);
    try { unlinkSync(dlResult.path); } catch { /* */ }

    if ('error' in visionResult) {
      analyses.push({ url, download_ok: true, error: visionResult.error });
      skipped.push({ url, reason: `vision: ${visionResult.error}` });
      continue;
    }

    analyses.push({ url, download_ok: true, vision: visionResult });

    if (visionResult.confidence !== 'low' && woDetail.sr_id && woDetail.wo_id) {
      const noteBody = buildNoteBody(visionResult, url);
      const noteParams: AddNoteParams = { srId: woDetail.sr_id, woId: woDetail.wo_id, body: noteBody };
      const noteHash = computeAddNoteApprovalHash(noteParams);
      plannedNotes.push({ url, body: noteBody, add_note_hash: noteHash, vision: visionResult });
    } else {
      skipped.push({ url, reason: `confidence_low` });
    }
  }

  const plan: PhotoIntakePlan = {
    wo_number: woDetail.wo_number ?? '',
    sr_id: woDetail.sr_id ?? '',
    wo_id: woDetail.wo_id ?? '',
    tenant: woDetail.tenant ?? '',
    tenant_label: threadResult.tenant_label ?? '',
    media_urls: inboundPhotos.slice(0, 10),
    planned_notes: plannedNotes,
    skipped,
  };

  const planHash = computePhotoIntakePlanHash(plan);

  // Persist plan to disk so execute can reuse exact approved bodies
  mkdirSync(PHOTO_INTAKE_PLAN_DIR, { recursive: true });
  writeFileSync(join(PHOTO_INTAKE_PLAN_DIR, `${planHash}.json`), JSON.stringify(plan, null, 2));

  return {
    wo_number: woDetail.wo_number,
    sr_id: woDetail.sr_id,
    wo_id: woDetail.wo_id,
    tenant: woDetail.tenant,
    photos_found: inboundPhotos.length,
    photos_analyzed: analyses.filter(a => a.download_ok).length,
    analyses,
    dry_run: true,
    approval_hash: planHash,
    execution_plan: {
      notes_to_add: plannedNotes.map(n => ({
        photo_url: n.url,
        note_body: n.body,
        add_note_hash: n.add_note_hash,
        confidence: n.vision.confidence,
      })),
      skipped: plan.skipped,
    },
    message: plannedNotes.length > 0
      ? `Analyzed ${analyses.filter(a => a.download_ok).length} photo(s). ${plannedNotes.length} note(s) planned. Pass --execute --approval-hash ${planHash} to post notes.`
      : `Analyzed ${analyses.filter(a => a.download_ok).length} photo(s). No notes to add (all below confidence threshold).`,
  } as PhotoIntakeResult & { dry_run: boolean; approval_hash: string; execution_plan: unknown };
}

async function sendWoMessage(
  woQuery: string,
  message: string,
  live: boolean,
  approvalHash?: string,
  capture = false,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!WO_QUERY_RE.test(woQuery)) {
    return { error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${woQuery.substring(0, 50)}").` };
  }
  if (!message || message.trim().length === 0) {
    return { error: 'empty_message', message: 'Message text is required.' };
  }
  if (message.length > MAX_SMS_LENGTH) {
    return { error: 'message_too_long', message: `Message exceeds ${MAX_SMS_LENGTH} character SMS limit (got ${message.length}).` };
  }

  const woDetail = await readWorkOrder(woQuery, true);
  if (woDetail.error) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: woDetail.error, message: woDetail.message,
    };
  }

  if (!woDetail.tenant) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      error: 'no_tenant', message: 'No tenant associated with this WO — cannot send message.',
    };
  }

  const threadResult = openResidentThread(woDetail.tenant ?? undefined);
  if (!threadResult.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: threadResult.error,
      ...(threadResult.count ? { resident_count: threadResult.count, resident_labels: threadResult.labels } : {}),
    };
  }

  const { messages: existingMessages } = extractThreadMessages();

  // Extract and verify the active composer contract: recipient, channel, send surface
  const composerResult = extractComposerContract();
  if (!composerResult.ok || !composerResult.contract) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: composerResult.error ?? 'composer_contract_failed',
      message: 'Could not extract messaging composer contract. Fail closed — will not send without verified destination.',
    };
  }
  const contract = composerResult.contract;

  // Fail closed: channel must be SMS/Text (not email, not unknown, not other)
  if (!/sms|text/i.test(contract.channel)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: 'channel_not_sms',
      message: `Channel "${contract.channel}" is not SMS/Text. This command is SMS-only. Fail closed.`,
      composer_contract: contract,
    };
  }

  // Fail closed: recipient label must be present
  if (!contract.recipient_label || contract.recipient_label.length < 2) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: 'recipient_unknown',
      message: 'Could not identify the messaging recipient from the composer. Fail closed — will not send to an unverified destination.',
      composer_contract: contract,
    };
  }

  // Fail closed: BOTH clicked Resident row label AND composer recipient must match WO tenant
  const rowLabel = threadResult.tenant_label ?? '';
  if (!verifyTenantNameMatch(woDetail.tenant ?? '', rowLabel)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: 'row_tenant_mismatch',
      message: `Clicked Resident row "${rowLabel}" does not match WO tenant "${woDetail.tenant}". Fail closed.`,
      composer_contract: contract,
    };
  }
  if (!verifyTenantNameMatch(woDetail.tenant ?? '', contract.recipient_label)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: 'recipient_tenant_mismatch',
      message: `Composer recipient "${contract.recipient_label}" does not match WO tenant "${woDetail.tenant}". Fail closed.`,
      composer_contract: contract,
    };
  }

  // Fail closed: send button must be scoped to the messaging container (not document-level)
  if (!contract.send_button_scoped) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: 'send_button_not_scoped',
      message: 'No Send button found within the messaging composer/form. Fail closed — will not click an unscoped primary button.',
      composer_contract: contract,
    };
  }

  // Fill textarea#messaging-input using native setter + event dispatch for framework reactivity
  const escapedMessage = JSON.stringify(message);
  const fillResult = abEval(
    'var ta=document.getElementById("messaging-input");' +
    'if(ta){' +
    '  var msg=' + escapedMessage + ';' +
    '  var ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;' +
    '  ns.call(ta,msg);' +
    '  ta.dispatchEvent(new Event("input",{bubbles:true}));' +
    '  ta.dispatchEvent(new Event("change",{bubbles:true}));' +
    '  JSON.stringify({ok:true,length:ta.value.length});' +
    '}else{JSON.stringify({error:"textarea_not_found"});}'
  );
  let fillParsed: { ok?: boolean; error?: string; length?: number } = {};
  try {
    let inner = fillResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    fillParsed = JSON.parse(inner);
  } catch { fillParsed = { error: 'fill_parse_failed' }; }

  if (fillParsed.error || !fillParsed.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: fillParsed.error ?? 'textarea_fill_failed',
    };
  }

  const hiddenFieldNames = contract.hidden_fields.map(f => f.split('=')[0]).sort().join(',');

  // For SPA (no_form), require a concrete send contract file
  let endpointContractHash = '';
  let spaContract: SmsSendContract | undefined;
  if (contract.form_action === 'no_form') {
    const contractResult = readSmsSendContract();
    if (!contractResult.ok || !contractResult.contract || !contractResult.hash) {
      try { ab('close'); } catch { /* */ }
      return {
        wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
        tenant: woDetail.tenant, error: 'sms_contract_missing',
        message: contractResult.error ?? 'No .sms-send-contract.json found. Requires supervised laptop discovery with Albie.',
        composer_contract: contract,
      };
    }
    spaContract = contractResult.contract;
    endpointContractHash = contractResult.hash;
  }

  const expectedHash = computeMessageApprovalHash(
    woDetail.sr_id, woDetail.wo_id, message, woDetail.tenant,
    contract.channel, contract.recipient_label, rowLabel,
    contract.form_action, contract.form_method, contract.textarea_name,
    hiddenFieldNames, endpointContractHash,
  );

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SEND BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only after chief + Albie greenlight on this specific WO+message.',
      approval_hash: expectedHash,
      would_send_to: woDetail.tenant,
      tenant_label: threadResult.tenant_label,
      composer_recipient: contract.recipient_label,
      row_label_matched: rowLabel,
      channel: contract.channel,
      sent_message: message,
      message_length: message.length,
      max_length: MAX_SMS_LENGTH,
      send_button_text: contract.send_button_text,
      send_button_scoped: contract.send_button_scoped,
      composer_contract: {
        form_action: contract.form_action,
        form_method: contract.form_method,
        textarea_name: contract.textarea_name,
        container_found: contract.container_found,
        hidden_fields: contract.hidden_fields,
        hidden_field_names_bound: hiddenFieldNames,
        ...(spaContract ? {
          sms_send_contract: spaContract,
          endpoint_contract_hash: endpointContractHash,
        } : {
          endpoint_note: `Form action: ${contract.form_action} (${contract.form_method})`,
        }),
      },
      wo_number: woDetail.wo_number,
      wo_status: woDetail.status,
      sr_id: woDetail.sr_id,
      wo_id: woDetail.wo_id,
      existing_thread_count: existingMessages.length,
      latest_inbound: existingMessages.find(m => m.direction === 'inbound') ?? null,
    };
  }

  // Live path: verify approval hash
  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  // Re-verify SPA contract file hasn't changed since dry-run
  if (contract.form_action === 'no_form') {
    const liveContractFile = readSmsSendContract();
    if (!liveContractFile.ok || liveContractFile.hash !== endpointContractHash) {
      ab('close');
      return {
        error: 'sms_contract_drift',
        message: 'SPA send contract file changed or missing since dry-run. Re-run dry-run.',
        expected_hash: endpointContractHash,
        actual_hash: liveContractFile.hash ?? 'missing',
      };
    }
  }

  // Re-verify composer contract before send (state may have changed since dry-run)
  const liveContract = extractComposerContract();
  if (!liveContract.ok || !liveContract.contract) {
    ab('close');
    return { error: 'live_contract_failed', message: 'Could not re-verify composer contract before live send. Fail closed.' };
  }
  const lc = liveContract.contract;
  const liveHiddenFieldNames = lc.hidden_fields.map(f => f.split('=')[0]).sort().join(',');
  if (lc.channel !== contract.channel || lc.recipient_label !== contract.recipient_label ||
      lc.form_action !== contract.form_action || lc.form_method !== contract.form_method ||
      lc.textarea_name !== contract.textarea_name || liveHiddenFieldNames !== hiddenFieldNames) {
    ab('close');
    return {
      error: 'contract_drift',
      message: 'Composer contract changed between dry-run and live execution. Fail closed — re-run dry-run.',
      drift: {
        channel: lc.channel !== contract.channel ? { expected: contract.channel, actual: lc.channel } : 'ok',
        recipient: lc.recipient_label !== contract.recipient_label ? { expected: contract.recipient_label, actual: lc.recipient_label } : 'ok',
        form_action: lc.form_action !== contract.form_action ? { expected: contract.form_action, actual: lc.form_action } : 'ok',
        form_method: lc.form_method !== contract.form_method ? { expected: contract.form_method, actual: lc.form_method } : 'ok',
        textarea_name: lc.textarea_name !== contract.textarea_name ? { expected: contract.textarea_name, actual: lc.textarea_name } : 'ok',
        hidden_fields: liveHiddenFieldNames !== hiddenFieldNames ? { expected: hiddenFieldNames, actual: liveHiddenFieldNames } : 'ok',
      },
    };
  }
  if (!lc.send_button_scoped) {
    ab('close');
    return { error: 'live_send_button_not_scoped', message: 'Send button is no longer scoped to the messaging composer. Fail closed.' };
  }

  // Atomic once-only guard: duplicate tenant text is real external harm
  const nonceResult = reserveSendMsgNonce(expectedHash);
  if (nonceResult === 'already_used') {
    ab('close');
    return { error: 'hash_already_used', approval_hash: expectedHash, message: 'This approval hash has already been used to send a message. Run a new dry-run for a fresh hash.' };
  }
  if (nonceResult === 'error') {
    ab('close');
    return { error: 'nonce_reserve_failed', message: 'Could not create nonce file for once-only guard.' };
  }

  // CDP interceptor: only when --capture flag is passed (contract discovery, not production)
  if (capture) {
    abEval(
      'window.__cdpCaptures=[];' +
      'function serializeBody(b){' +
      '  if(!b)return "";' +
      '  if(b instanceof FormData){var entries=[];b.forEach(function(v,k){entries.push(k+"="+String(v).substring(0,500));});return entries.join("&");}' +
      '  if(typeof b==="string")return b.substring(0,2000);' +
      '  try{return JSON.stringify(b).substring(0,2000);}catch(e){return String(b).substring(0,2000);}' +
      '}' +
      'var origFetch=window.fetch;' +
      'window.fetch=function(url,opts){' +
      '  if(opts&&opts.method&&opts.method.toUpperCase()==="POST"){' +
      '    var ct=(opts.headers&&(opts.headers["Content-Type"]||opts.headers["content-type"]))||"";' +
      '    window.__cdpCaptures.push({type:"fetch",url:String(url),body:serializeBody(opts.body),contentType:ct});' +
      '  }' +
      '  return origFetch.apply(this,arguments);' +
      '};' +
      'var origXhrOpen=XMLHttpRequest.prototype.open;' +
      'var origXhrSend=XMLHttpRequest.prototype.send;' +
      'XMLHttpRequest.prototype.open=function(m,u){this.__method=m;this.__url=u;return origXhrOpen.apply(this,arguments);};' +
      'XMLHttpRequest.prototype.send=function(body){' +
      '  if(this.__method&&this.__method.toUpperCase()==="POST"){' +
      '    window.__cdpCaptures.push({type:"xhr",url:String(this.__url),body:serializeBody(body),contentType:""});' +
      '  }' +
      '  return origXhrSend.apply(this,arguments);' +
      '};' +
      '"interceptor_installed"'
    );
  }

  // Click Send button scoped to the verified messaging container (no document-level fallback)
  const sendResult = abEval(
    'var ta=document.getElementById("messaging-input");' +
    'if(!ta||!ta.value){JSON.stringify({error:"textarea_empty"});}' +
    'else{' +
    '  var container=null;var p=ta;' +
    '  for(var i=0;i<15&&p.parentElement;i++){' +
    '    p=p.parentElement;' +
    '    if(p.querySelector&&p.querySelector(".btn-primary,button[type=submit]")){container=p;break;}' +
    '  }' +
    '  if(!container){JSON.stringify({error:"messaging_container_not_found"});}' +
    '  else{' +
    '    var btn=container.querySelector(".btn-primary:not([disabled]),button[type=submit]:not([disabled])");' +
    '    if(!btn){JSON.stringify({error:"send_button_not_found_or_disabled"});}' +
    '    else{btn.click();JSON.stringify({ok:true,button_text:btn.textContent.trim().substring(0,50)});}' +
    '  }' +
    '}'
  );
  let sendParsed: { ok?: boolean; error?: string; button_text?: string } = {};
  try {
    let inner = sendResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    sendParsed = JSON.parse(inner);
  } catch { sendParsed = { error: 'send_parse_failed' }; }

  if (sendParsed.error || !sendParsed.ok) {
    ab('close');
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      tenant: woDetail.tenant, error: sendParsed.error ?? 'send_failed',
      hash_consumed: true,
      message: 'Send failed but approval hash is consumed (once-only guard). Run a new dry-run for a fresh hash before retrying.',
    };
  }

  // Wait for send to process
  abSafe('wait', '5000');

  // Retrieve captured POST bodies from the interceptor (only when --capture)
  let capturedRequests: Array<{ type: string; url: string; body: string; contentType: string }> = [];
  if (capture) {
    try {
      const capResult = abEval('JSON.stringify(window.__cdpCaptures||[])');
      let capInner = capResult.output;
      if (capInner.startsWith('"') && capInner.endsWith('"')) capInner = JSON.parse(capInner) as string;
      capturedRequests = JSON.parse(capInner);
    } catch { /* capture is best-effort */ }
  }

  // Post-send verification: check if message appears in thread as newest outbound
  const { messages: postSendMessages } = extractThreadMessages();
  const outbounds = postSendMessages.filter(m => m.direction === 'outbound');
  const latestOutbound = outbounds.length > 0 ? outbounds[outbounds.length - 1] : null;
  const verified = latestOutbound ? latestOutbound.text.includes(message.substring(0, 50)) : false;

  ab('close');

  return {
    live: true,
    verified,
    hash_consumed: true,
    ...(capture && capturedRequests.length > 0 ? { cdp_captured_requests: capturedRequests } : {}),
    wo_number: woDetail.wo_number,
    sr_id: woDetail.sr_id,
    wo_id: woDetail.wo_id,
    tenant: woDetail.tenant,
    tenant_label: threadResult.tenant_label,
    composer_recipient: contract.recipient_label,
    row_label_matched: rowLabel,
    channel: contract.channel,
    sent_message: message,
    message_length: message.length,
    send_button_clicked: sendParsed.button_text,
    post_send_thread_count: postSendMessages.length,
    latest_outbound: latestOutbound ?? null,
  };
}

async function sendVendorMessage(
  woQuery: string,
  message: string,
  live: boolean,
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!WO_QUERY_RE.test(woQuery)) {
    return { error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${woQuery.substring(0, 50)}").` };
  }
  if (!message || message.trim().length === 0) {
    return { error: 'empty_message', message: 'Message text is required.' };
  }

  const woDetail = await readWorkOrder(woQuery, true);
  if (woDetail.error) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: woDetail.error, message: woDetail.message,
    };
  }

  if (!woDetail.vendor_name) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      error: 'no_vendor', message: 'No vendor assigned to this WO — cannot send message.',
    };
  }

  const threadResult = openVendorThread(woDetail.vendor_name);
  if (!threadResult.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: threadResult.error,
      ...(threadResult.count ? { vendor_count: threadResult.count, vendor_labels: threadResult.labels } : {}),
    };
  }

  const { messages: existingMessages } = extractThreadMessages();

  const composerResult = extractComposerContract();
  if (!composerResult.ok || !composerResult.contract) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: composerResult.error ?? 'composer_contract_failed',
      message: 'Could not extract messaging composer contract. Fail closed — will not send without verified destination.',
    };
  }
  const contract = composerResult.contract;

  if (!/sms|text/i.test(contract.channel)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'channel_not_sms',
      message: `Channel "${contract.channel}" is not SMS/Text. V1 vendor messaging is SMS-only via inline composer. Fail closed.`,
      composer_contract: contract,
    };
  }

  if (message.length > MAX_SMS_LENGTH) {
    try { ab('close'); } catch { /* */ }
    return { error: 'message_too_long', message: `Message exceeds ${MAX_SMS_LENGTH} character SMS limit (got ${message.length}).` };
  }

  if (!contract.recipient_label || contract.recipient_label.length < 2) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'recipient_unknown',
      message: 'Could not identify the messaging recipient from the composer. Fail closed.',
      composer_contract: contract,
    };
  }

  const rowLabel = threadResult.vendor_label ?? '';
  if (!verifyVendorNameMatch(woDetail.vendor_name, rowLabel)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'row_vendor_mismatch',
      message: `Clicked Vendor row "${rowLabel}" does not match WO vendor "${woDetail.vendor_name}". Fail closed.`,
      composer_contract: contract,
    };
  }
  if (!verifyVendorNameMatch(woDetail.vendor_name, contract.recipient_label)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'recipient_vendor_mismatch',
      message: `Composer recipient "${contract.recipient_label}" does not match WO vendor "${woDetail.vendor_name}". Fail closed.`,
      composer_contract: contract,
    };
  }

  if (!contract.send_button_scoped) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'send_button_not_scoped',
      message: 'No Send button found within the messaging composer/form. Fail closed.',
      composer_contract: contract,
    };
  }

  const escapedMessage = JSON.stringify(message);
  const fillResult = abEval(
    'var ta=document.getElementById("messaging-input");' +
    'if(ta){' +
    '  var msg=' + escapedMessage + ';' +
    '  var ns=Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,"value").set;' +
    '  ns.call(ta,msg);' +
    '  ta.dispatchEvent(new Event("input",{bubbles:true}));' +
    '  ta.dispatchEvent(new Event("change",{bubbles:true}));' +
    '  JSON.stringify({ok:true,length:ta.value.length});' +
    '}else{JSON.stringify({error:"textarea_not_found"});}'
  );
  let fillParsed: { ok?: boolean; error?: string; length?: number } = {};
  try {
    let inner = fillResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    fillParsed = JSON.parse(inner);
  } catch { fillParsed = { error: 'fill_parse_failed' }; }

  if (fillParsed.error || !fillParsed.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: fillParsed.error ?? 'textarea_fill_failed',
    };
  }

  const hiddenFieldNames = contract.hidden_fields.map(f => f.split('=')[0]).sort().join(',');

  let endpointContractHash = '';
  let spaContract: SmsSendContract | undefined;
  if (contract.form_action === 'no_form') {
    const contractResult = readSmsSendContract();
    if (!contractResult.ok || !contractResult.contract || !contractResult.hash) {
      try { ab('close'); } catch { /* */ }
      return {
        wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
        vendor_name: woDetail.vendor_name, error: 'sms_contract_missing',
        message: contractResult.error ?? 'No .sms-send-contract.json found. Requires supervised laptop discovery.',
        composer_contract: contract,
      };
    }
    spaContract = contractResult.contract;
    endpointContractHash = contractResult.hash;
  }

  const expectedHash = computeMessageApprovalHash(
    woDetail.sr_id, woDetail.wo_id, message, woDetail.vendor_name,
    contract.channel, contract.recipient_label, rowLabel,
    contract.form_action, contract.form_method, contract.textarea_name,
    hiddenFieldNames, endpointContractHash,
  );

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SEND BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only after chief + Albie greenlight on this specific WO+message.',
      approval_hash: expectedHash,
      would_send_to: woDetail.vendor_name,
      vendor_label: threadResult.vendor_label,
      composer_recipient: contract.recipient_label,
      row_label_matched: rowLabel,
      channel: contract.channel,
      sent_message: message,
      message_length: message.length,
      max_length: MAX_SMS_LENGTH,
      send_button_text: contract.send_button_text,
      send_button_scoped: contract.send_button_scoped,
      composer_contract: {
        form_action: contract.form_action,
        form_method: contract.form_method,
        textarea_name: contract.textarea_name,
        container_found: contract.container_found,
        hidden_fields: contract.hidden_fields,
        hidden_field_names_bound: hiddenFieldNames,
        ...(spaContract ? {
          sms_send_contract: spaContract,
          endpoint_contract_hash: endpointContractHash,
        } : {
          endpoint_note: `Form action: ${contract.form_action} (${contract.form_method})`,
        }),
      },
      wo_number: woDetail.wo_number,
      wo_status: woDetail.status,
      sr_id: woDetail.sr_id,
      wo_id: woDetail.wo_id,
      existing_thread_count: existingMessages.length,
      latest_inbound: existingMessages.find(m => m.direction === 'inbound') ?? null,
    };
  }

  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  if (contract.form_action === 'no_form') {
    const liveContractFile = readSmsSendContract();
    if (!liveContractFile.ok || liveContractFile.hash !== endpointContractHash) {
      ab('close');
      return {
        error: 'sms_contract_drift',
        message: 'SPA send contract file changed or missing since dry-run. Re-run dry-run.',
        expected_hash: endpointContractHash,
        actual_hash: liveContractFile.hash ?? 'missing',
      };
    }
  }

  const liveContract = extractComposerContract();
  if (!liveContract.ok || !liveContract.contract) {
    ab('close');
    return { error: 'live_contract_failed', message: 'Could not re-verify composer contract before live send. Fail closed.' };
  }
  const lc = liveContract.contract;
  const liveHiddenFieldNames = lc.hidden_fields.map(f => f.split('=')[0]).sort().join(',');
  if (lc.channel !== contract.channel || lc.recipient_label !== contract.recipient_label ||
      lc.form_action !== contract.form_action || lc.form_method !== contract.form_method ||
      lc.textarea_name !== contract.textarea_name || liveHiddenFieldNames !== hiddenFieldNames) {
    ab('close');
    return {
      error: 'contract_drift',
      message: 'Composer contract changed between dry-run and live execution. Fail closed — re-run dry-run.',
      drift: {
        channel: lc.channel !== contract.channel ? { expected: contract.channel, actual: lc.channel } : 'ok',
        recipient: lc.recipient_label !== contract.recipient_label ? { expected: contract.recipient_label, actual: lc.recipient_label } : 'ok',
        form_action: lc.form_action !== contract.form_action ? { expected: contract.form_action, actual: lc.form_action } : 'ok',
        form_method: lc.form_method !== contract.form_method ? { expected: contract.form_method, actual: lc.form_method } : 'ok',
        textarea_name: lc.textarea_name !== contract.textarea_name ? { expected: contract.textarea_name, actual: lc.textarea_name } : 'ok',
        hidden_fields: liveHiddenFieldNames !== hiddenFieldNames ? { expected: hiddenFieldNames, actual: liveHiddenFieldNames } : 'ok',
      },
    };
  }
  if (!lc.send_button_scoped) {
    ab('close');
    return { error: 'live_send_button_not_scoped', message: 'Send button is no longer scoped to the messaging composer. Fail closed.' };
  }

  const nonceResult = reserveSendMsgNonce(expectedHash);
  if (nonceResult === 'already_used') {
    ab('close');
    return { error: 'hash_already_used', approval_hash: expectedHash, message: 'This approval hash has already been used to send a message. Run a new dry-run for a fresh hash.' };
  }
  if (nonceResult === 'error') {
    ab('close');
    return { error: 'nonce_reserve_failed', message: 'Could not create nonce file for once-only guard.' };
  }

  const sendResult = abEval(
    'var ta=document.getElementById("messaging-input");' +
    'if(!ta||!ta.value){JSON.stringify({error:"textarea_empty"});}' +
    'else{' +
    '  var container=null;var p=ta;' +
    '  for(var i=0;i<15&&p.parentElement;i++){' +
    '    p=p.parentElement;' +
    '    if(p.querySelector&&p.querySelector(".btn-primary,button[type=submit]")){container=p;break;}' +
    '  }' +
    '  if(!container){JSON.stringify({error:"messaging_container_not_found"});}' +
    '  else{' +
    '    var btn=container.querySelector(".btn-primary:not([disabled]),button[type=submit]:not([disabled])");' +
    '    if(!btn){JSON.stringify({error:"send_button_not_found_or_disabled"});}' +
    '    else{btn.click();JSON.stringify({ok:true,button_text:btn.textContent.trim().substring(0,50)});}' +
    '  }' +
    '}'
  );
  let sendParsed: { ok?: boolean; error?: string; button_text?: string } = {};
  try {
    let inner = sendResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    sendParsed = JSON.parse(inner);
  } catch { sendParsed = { error: 'send_parse_failed' }; }

  if (sendParsed.error || !sendParsed.ok) {
    ab('close');
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: sendParsed.error ?? 'send_failed',
      hash_consumed: true,
      message: 'Send failed but approval hash is consumed (once-only guard). Run a new dry-run for a fresh hash before retrying.',
    };
  }

  abSafe('wait', '5000');

  const { messages: postSendMessages } = extractThreadMessages();
  const outbounds = postSendMessages.filter(m => m.direction === 'outbound');
  const latestOutbound = outbounds.length > 0 ? outbounds[outbounds.length - 1] : null;
  const verified = latestOutbound ? latestOutbound.text.includes(message.substring(0, 50)) : false;

  ab('close');

  return {
    live: true,
    verified,
    hash_consumed: true,
    wo_number: woDetail.wo_number,
    sr_id: woDetail.sr_id,
    wo_id: woDetail.wo_id,
    vendor_name: woDetail.vendor_name,
    vendor_label: threadResult.vendor_label,
    composer_recipient: contract.recipient_label,
    row_label_matched: rowLabel,
    channel: contract.channel,
    sent_message: message,
    message_length: message.length,
    send_button_clicked: sendParsed.button_text,
    post_send_thread_count: postSendMessages.length,
    latest_outbound: latestOutbound ?? null,
  };
}

interface EmailDialogContract {
  to_address: string;
  from_address: string;
  subject_value: string;
  message_value: string;
  send_button_found: boolean;
  send_button_text: string;
  dialog_found: boolean;
}

function extractEmailDialogContract(): { ok: boolean; contract?: EmailDialogContract; error?: string } {
  const result = abEval(
    'var dialogs=document.querySelectorAll("[role=dialog],dialog");' +
    'var d=null;' +
    'for(var i=dialogs.length-1;i>=0;i--){' +
    '  var h=dialogs[i].querySelector("h5,h4,h3");' +
    '  if(h&&/compose.*email/i.test(h.textContent)){d=dialogs[i];break;}' +
    '}' +
    'if(!d){JSON.stringify({ok:false,error:"email_dialog_not_found"});}' +
    'else{' +
    '  var toInput=d.querySelector("input[name=to]");' +
    '  var toAddr=toInput?toInput.value.trim():"";' +
    '  var fromText="";' +
    '  var labels=d.querySelectorAll("label");' +
    '  for(var j=0;j<labels.length;j++){' +
    '    if(/^From$/i.test(labels[j].textContent.trim())){' +
    '      var sib=labels[j].nextElementSibling||labels[j].parentElement;' +
    '      if(sib){var st=sib.textContent.trim();if(st.indexOf("@")>0)fromText=st.substring(0,200);}' +
    '      break;' +
    '    }' +
    '  }' +
    '  if(!fromText){' +
    '    var spans=d.querySelectorAll("span,div,p");' +
    '    for(var k=0;k<spans.length;k++){' +
    '      var t=spans[k].textContent.trim();' +
    '      if(/opsassistant@/.test(t)){fromText=t.substring(0,200);break;}' +
    '    }' +
    '  }' +
    '  var subjectInput=d.querySelector("input[name=subject]");' +
    '  var subjectVal=subjectInput?subjectInput.value.trim():"";' +
    '  var ce=d.querySelector("[contenteditable]");' +
    '  var msgVal=ce?ce.textContent.trim():"";' +
    '  var btns=d.querySelectorAll(".btn-primary");' +
    '  var sendBtn=null;var sendBtnText="";' +
    '  for(var b=0;b<btns.length;b++){' +
    '    var bt=btns[b].textContent.trim();' +
    '    if(/^Send$/i.test(bt)){sendBtn=btns[b];sendBtnText=bt;break;}' +
    '  }' +
    '  JSON.stringify({ok:true,to_address:toAddr,from_address:fromText,' +
    '    subject_value:subjectVal,message_value:msgVal,' +
    '    send_button_found:!!sendBtn,send_button_text:sendBtnText,dialog_found:true});' +
    '}'
  );
  let parsed: { ok: boolean; error?: string } & Partial<EmailDialogContract> = { ok: false };
  try {
    let inner = result.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    parsed = JSON.parse(inner);
  } catch { parsed = { ok: false, error: 'email_contract_parse_failed' }; }

  if (!parsed.ok || parsed.error) {
    return { ok: false, error: parsed.error ?? 'email_contract_extraction_failed' };
  }

  return {
    ok: true,
    contract: {
      to_address: parsed.to_address ?? '',
      from_address: parsed.from_address ?? '',
      subject_value: parsed.subject_value ?? '',
      message_value: parsed.message_value ?? '',
      send_button_found: parsed.send_button_found ?? false,
      send_button_text: parsed.send_button_text ?? '',
      dialog_found: parsed.dialog_found ?? false,
    },
  };
}

function openEmailComposer(): { ok: boolean; error?: string } {
  // Click the "Send via SMS" dropdown to reveal "Compose New Email"
  const dropdownResult = abEval(
    'var btns=document.querySelectorAll("button");' +
    'var dropdown=null;' +
    'for(var i=0;i<btns.length;i++){' +
    '  if(/^Send via SMS$/i.test(btns[i].textContent.trim())){dropdown=btns[i];break;}' +
    '}' +
    'if(dropdown){dropdown.click();JSON.stringify({ok:true});}' +
    'else{JSON.stringify({error:"sms_dropdown_not_found"});}'
  );
  let dropdownParsed: { ok?: boolean; error?: string } = {};
  try {
    let inner = dropdownResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    dropdownParsed = JSON.parse(inner);
  } catch { dropdownParsed = { error: 'dropdown_parse_failed' }; }
  if (dropdownParsed.error || !dropdownParsed.ok) {
    return { ok: false, error: dropdownParsed.error ?? 'dropdown_click_failed' };
  }

  abSafe('wait', '1000');

  // Click "Compose New Email" menuitem
  const emailResult = abEval(
    'var items=document.querySelectorAll("[role=menuitem]");' +
    'var target=null;' +
    'for(var i=0;i<items.length;i++){' +
    '  if(/compose.*new.*email/i.test(items[i].textContent.trim())){target=items[i];break;}' +
    '}' +
    'if(target){target.click();JSON.stringify({ok:true});}' +
    'else{JSON.stringify({error:"compose_email_menuitem_not_found"});}'
  );
  let emailParsed: { ok?: boolean; error?: string } = {};
  try {
    let inner = emailResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    emailParsed = JSON.parse(inner);
  } catch { emailParsed = { error: 'email_menuitem_parse_failed' }; }
  if (emailParsed.error || !emailParsed.ok) {
    return { ok: false, error: emailParsed.error ?? 'email_menuitem_click_failed' };
  }

  abSafe('wait', '3000');
  return { ok: true };
}

async function sendVendorEmail(
  woQuery: string,
  subject: string,
  message: string,
  live: boolean,
  approvalHash?: string,
): Promise<{ error?: string; verified?: boolean; [key: string]: unknown }> {
  if (!WO_QUERY_RE.test(woQuery)) {
    return { error: 'invalid_query', message: `WO query must be digits with optional -N suffix (got "${woQuery.substring(0, 50)}").` };
  }
  if (!subject || subject.trim().length === 0) {
    return { error: 'empty_subject', message: 'Email subject is required.' };
  }
  if (!message || message.trim().length === 0) {
    return { error: 'empty_message', message: 'Email message body is required.' };
  }

  const woDetail = await readWorkOrder(woQuery, true);
  if (woDetail.error) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: woDetail.error, message: woDetail.message,
    };
  }

  if (!woDetail.vendor_name) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      error: 'no_vendor', message: 'No vendor assigned to this WO — cannot send email.',
    };
  }

  if (!woDetail.vendor_email) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name,
      error: 'no_vendor_email', message: 'No email address on file for this vendor — cannot send email.',
    };
  }

  const threadResult = openVendorThread(woDetail.vendor_name);
  if (!threadResult.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: threadResult.error,
      ...(threadResult.count ? { vendor_count: threadResult.count, vendor_labels: threadResult.labels } : {}),
    };
  }

  const rowLabel = threadResult.vendor_label ?? '';
  if (!verifyVendorNameMatch(woDetail.vendor_name, rowLabel)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'row_vendor_mismatch',
      message: `Clicked Vendor row "${rowLabel}" does not match WO vendor "${woDetail.vendor_name}". Fail closed.`,
    };
  }

  const emailOpened = openEmailComposer();
  if (!emailOpened.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: emailOpened.error ?? 'email_composer_open_failed',
    };
  }

  const dialogResult = extractEmailDialogContract();
  if (!dialogResult.ok || !dialogResult.contract) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: dialogResult.error ?? 'email_dialog_contract_failed',
      message: 'Could not extract email dialog contract. Fail closed.',
    };
  }
  const dialog = dialogResult.contract;

  if (!dialog.to_address || dialog.to_address.length < 3 || !dialog.to_address.includes('@')) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'email_to_invalid',
      message: `Email To address "${dialog.to_address}" is empty or invalid. Fail closed.`,
      email_dialog: dialog,
    };
  }

  // Blocker fix 1: verify dialog To address matches WO vendor_email (authoritative source)
  const normalizeEmail = (e: string) => e.trim().toLowerCase();
  if (normalizeEmail(dialog.to_address) !== normalizeEmail(woDetail.vendor_email)) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'email_to_vendor_mismatch',
      message: `Dialog To address "${dialog.to_address}" does not match WO vendor email "${woDetail.vendor_email}". Fail closed.`,
      dialog_to: dialog.to_address,
      vendor_email: woDetail.vendor_email,
    };
  }

  if (!dialog.send_button_found) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'email_send_button_not_found',
      message: 'No Send button found in email dialog. Fail closed.',
      email_dialog: dialog,
    };
  }

  // Fill Subject field
  const escapedSubject = JSON.stringify(subject);
  const subjectFillResult = abEval(
    'var dialogs=document.querySelectorAll("[role=dialog],dialog");' +
    'var d=null;' +
    'for(var i=dialogs.length-1;i>=0;i--){' +
    '  var h=dialogs[i].querySelector("h5,h4,h3");' +
    '  if(h&&/compose.*email/i.test(h.textContent)){d=dialogs[i];break;}' +
    '}' +
    'if(!d){JSON.stringify({error:"email_dialog_not_found"});}' +
    'else{' +
    '  var subInput=d.querySelector("input[name=subject]");' +
    '  if(!subInput){JSON.stringify({error:"subject_input_not_found"});}' +
    '  else{' +
    '    var ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,"value").set;' +
    '    ns.call(subInput,' + escapedSubject + ');' +
    '    subInput.dispatchEvent(new Event("input",{bubbles:true}));' +
    '    subInput.dispatchEvent(new Event("change",{bubbles:true}));' +
    '    JSON.stringify({ok:true,value:subInput.value});' +
    '  }' +
    '}'
  );
  let subjectParsed: { ok?: boolean; error?: string; value?: string } = {};
  try {
    let inner = subjectFillResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    subjectParsed = JSON.parse(inner);
  } catch { subjectParsed = { error: 'subject_fill_parse_failed' }; }
  if (subjectParsed.error || !subjectParsed.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: subjectParsed.error ?? 'subject_fill_failed',
    };
  }

  // Fill Message body (contenteditable div)
  const escapedMessage = JSON.stringify(message);
  const messageFillResult = abEval(
    'var dialogs=document.querySelectorAll("[role=dialog],dialog");' +
    'var d=null;' +
    'for(var i=dialogs.length-1;i>=0;i--){' +
    '  var h=dialogs[i].querySelector("h5,h4,h3");' +
    '  if(h&&/compose.*email/i.test(h.textContent)){d=dialogs[i];break;}' +
    '}' +
    'if(!d){JSON.stringify({error:"email_dialog_not_found"});}' +
    'else{' +
    '  var ce=d.querySelector("[contenteditable]");' +
    '  if(!ce){JSON.stringify({error:"message_contenteditable_not_found"});}' +
    '  else{' +
    '    ce.focus();' +
    '    ce.textContent=' + escapedMessage + ';' +
    '    ce.dispatchEvent(new Event("input",{bubbles:true}));' +
    '    ce.dispatchEvent(new Event("change",{bubbles:true}));' +
    '    JSON.stringify({ok:true,length:ce.textContent.length});' +
    '  }' +
    '}'
  );
  let messageParsed: { ok?: boolean; error?: string; length?: number } = {};
  try {
    let inner = messageFillResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    messageParsed = JSON.parse(inner);
  } catch { messageParsed = { error: 'message_fill_parse_failed' }; }
  if (messageParsed.error || !messageParsed.ok) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: messageParsed.error ?? 'message_fill_failed',
    };
  }

  const expectedHash = computeEmailApprovalHash(
    woDetail.sr_id, woDetail.wo_id, subject, message,
    woDetail.vendor_name, dialog.to_address, rowLabel,
  );

  // Blocker fix 2: re-extract dialog and verify filled subject/body match intended values
  const postFillDialog = extractEmailDialogContract();
  if (!postFillDialog.ok || !postFillDialog.contract) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'post_fill_dialog_extraction_failed',
      message: 'Could not re-extract email dialog after filling fields. Fail closed.',
    };
  }
  const filledSubject = postFillDialog.contract.subject_value.trim();
  const filledBody = postFillDialog.contract.message_value.trim();
  if (filledSubject !== subject.trim()) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'subject_fill_mismatch',
      message: `Filled subject "${filledSubject}" does not match intended subject "${subject.trim()}". Fail closed.`,
      filled_subject: filledSubject, intended_subject: subject.trim(),
    };
  }
  if (filledBody !== message.trim()) {
    try { ab('close'); } catch { /* */ }
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: 'body_fill_mismatch',
      message: `Filled body "${filledBody.substring(0, 80)}..." does not match intended message. Fail closed.`,
      filled_body_length: filledBody.length, intended_body_length: message.trim().length,
    };
  }

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'SEND BLOCKED — default mode is dry-run. Pass --execute --approval-hash <hash> only after chief + Albie greenlight on this specific WO+email.',
      approval_hash: expectedHash,
      would_send_to: woDetail.vendor_name,
      vendor_label: threadResult.vendor_label,
      row_label_matched: rowLabel,
      channel: 'email',
      to_address: dialog.to_address,
      vendor_email: woDetail.vendor_email,
      to_matches_vendor_email: true,
      from_address: dialog.from_address,
      subject,
      subject_verified_in_dialog: true,
      sent_message: message,
      body_verified_in_dialog: true,
      message_length: message.length,
      wo_number: woDetail.wo_number,
      wo_status: woDetail.status,
      sr_id: woDetail.sr_id,
      wo_id: woDetail.wo_id,
    };
  }

  if (!approvalHash) {
    ab('close');
    return { error: 'missing_approval_hash', message: 'Live execute requires --approval-hash from a prior dry-run.' };
  }
  if (approvalHash !== expectedHash) {
    ab('close');
    return { error: 'approval_hash_mismatch', provided: approvalHash, expected: expectedHash, message: 'Approval hash does not match current parameters. Re-run dry-run to get a fresh hash.' };
  }

  // Re-verify full email dialog state before nonce reservation
  const liveDialog = extractEmailDialogContract();
  if (!liveDialog.ok || !liveDialog.contract) {
    ab('close');
    return { error: 'live_dialog_failed', message: 'Could not re-verify email dialog before live send. Fail closed.' };
  }
  if (normalizeEmail(liveDialog.contract.to_address) !== normalizeEmail(woDetail.vendor_email)) {
    ab('close');
    return {
      error: 'email_to_drift',
      message: `Live dialog To "${liveDialog.contract.to_address}" does not match vendor email "${woDetail.vendor_email}". Fail closed.`,
    };
  }
  if (liveDialog.contract.subject_value.trim() !== subject.trim()) {
    ab('close');
    return {
      error: 'live_subject_drift',
      message: `Live dialog subject "${liveDialog.contract.subject_value}" does not match approved subject "${subject}". Fail closed.`,
    };
  }
  if (liveDialog.contract.message_value.trim() !== message.trim()) {
    ab('close');
    return {
      error: 'live_body_drift',
      message: 'Live dialog body does not match approved message. Fail closed.',
    };
  }

  const nonceResult = reserveSendMsgNonce(expectedHash);
  if (nonceResult === 'already_used') {
    ab('close');
    return { error: 'hash_already_used', approval_hash: expectedHash, message: 'This approval hash has already been used to send an email. Run a new dry-run for a fresh hash.' };
  }
  if (nonceResult === 'error') {
    ab('close');
    return { error: 'nonce_reserve_failed', message: 'Could not create nonce file for once-only guard.' };
  }

  // Record pre-send outbound count for post-send verification
  const { messages: preSendMessages } = extractThreadMessages();
  const preSendOutbounds = preSendMessages.filter(m => m.direction === 'outbound');
  const preSendOutboundCount = preSendOutbounds.length;

  // Click Send button scoped to the email dialog — require button text matches "Send"
  const sendResult = abEval(
    'var dialogs=document.querySelectorAll("[role=dialog],dialog");' +
    'var d=null;' +
    'for(var i=dialogs.length-1;i>=0;i--){' +
    '  var h=dialogs[i].querySelector("h5,h4,h3");' +
    '  if(h&&/compose.*email/i.test(h.textContent)){d=dialogs[i];break;}' +
    '}' +
    'if(!d){JSON.stringify({error:"email_dialog_not_found"});}' +
    'else{' +
    '  var btns=d.querySelectorAll(".btn-primary");' +
    '  var sendBtn=null;var count=0;' +
    '  for(var b=0;b<btns.length;b++){' +
    '    var bt=btns[b].textContent.trim();' +
    '    if(/^Send$/i.test(bt)){sendBtn=btns[b];count++;}' +
    '  }' +
    '  if(!sendBtn){JSON.stringify({error:"send_button_not_found_by_text"});}' +
    '  else if(count>1){JSON.stringify({error:"multiple_send_buttons",count:count});}' +
    '  else{sendBtn.click();JSON.stringify({ok:true,button_text:sendBtn.textContent.trim().substring(0,50)});}' +
    '}'
  );
  let sendParsed: { ok?: boolean; error?: string; button_text?: string } = {};
  try {
    let inner = sendResult.output;
    if (inner.startsWith('"') && inner.endsWith('"')) inner = JSON.parse(inner) as string;
    sendParsed = JSON.parse(inner);
  } catch { sendParsed = { error: 'send_parse_failed' }; }

  if (sendParsed.error || !sendParsed.ok) {
    ab('close');
    return {
      wo_number: woDetail.wo_number, sr_id: woDetail.sr_id, wo_id: woDetail.wo_id,
      vendor_name: woDetail.vendor_name, error: sendParsed.error ?? 'send_failed',
      hash_consumed: true,
      message: 'Send failed but approval hash is consumed (once-only guard). Run a new dry-run for a fresh hash before retrying.',
    };
  }

  abSafe('wait', '5000');

  // Post-send verification: require a NEW outbound with both subject AND body content
  const { messages: postSendMessages } = extractThreadMessages();
  const postSendOutbounds = postSendMessages.filter(m => m.direction === 'outbound');
  const postSendOutboundCount = postSendOutbounds.length;
  const hasNewOutbound = postSendOutboundCount > preSendOutboundCount;
  const latestOutbound = postSendOutbounds.length > 0 ? postSendOutbounds[postSendOutbounds.length - 1] : null;
  const subjectInLatest = latestOutbound ? latestOutbound.text.includes(subject.trim().substring(0, 50)) : false;
  const bodyInLatest = latestOutbound ? latestOutbound.text.includes(message.trim().substring(0, 50)) : false;
  const verified = hasNewOutbound && subjectInLatest && bodyInLatest;

  ab('close');

  return {
    live: true,
    verified,
    hash_consumed: true,
    wo_number: woDetail.wo_number,
    sr_id: woDetail.sr_id,
    wo_id: woDetail.wo_id,
    vendor_name: woDetail.vendor_name,
    vendor_label: threadResult.vendor_label,
    row_label_matched: rowLabel,
    channel: 'email',
    to_address: dialog.to_address,
    vendor_email: woDetail.vendor_email,
    from_address: dialog.from_address,
    subject,
    sent_message: message,
    message_length: message.length,
    send_button_clicked: sendParsed.button_text,
    pre_send_outbound_count: preSendOutboundCount,
    post_send_outbound_count: postSendOutboundCount,
    new_outbound_detected: hasNewOutbound,
    subject_in_latest: subjectInLatest,
    body_in_latest: bodyInLatest,
    latest_outbound: latestOutbound ?? null,
  };
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
    case 'resolve-vendor': {
      if (!cmdArgs[0]) { console.error('Usage: resolve-vendor "<vendor name>"'); process.exit(1); }
      const vendorName = cmdArgs.join(' ');
      const resolved = await resolveVendor(vendorName);
      console.log(JSON.stringify(resolved, null, 2));
      process.exit(resolved.error ? 1 : 0);
      break;
    }
    case 'assign-vendor': {
      // Default: dry-run (safe). Pass --execute to actually submit.
      // assign-vendor --sr-id <id> --wo-id <id> (--vendor-id <id> | --vendor-name "<name>") [--email-link] [--text-link] [--require-accept] [--execute]
      const srIdIdx = cmdArgs.indexOf('--sr-id');
      const woIdIdx = cmdArgs.indexOf('--wo-id');
      const vendorIdIdx = cmdArgs.indexOf('--vendor-id');
      const vendorNameIdx = cmdArgs.indexOf('--vendor-name');
      const approvalHashIdx = cmdArgs.indexOf('--approval-hash');
      const live = cmdArgs.includes('--execute');
      const dispatchFlags = {
        emailLink: cmdArgs.includes('--email-link'),
        textLink: cmdArgs.includes('--text-link'),
        requireAccept: cmdArgs.includes('--require-accept'),
      };
      const approvalHashVal = approvalHashIdx !== -1 ? cmdArgs[approvalHashIdx + 1] : undefined;

      if (vendorIdIdx !== -1 && vendorNameIdx !== -1) {
        console.error('assign-vendor: provide --vendor-id OR --vendor-name, not both (ambiguous target source)');
        process.exit(1);
      }
      if (srIdIdx === -1 || woIdIdx === -1 || (vendorIdIdx === -1 && vendorNameIdx === -1)) {
        console.error('Usage: assign-vendor --sr-id <id> --wo-id <id> (--vendor-id <id> | --vendor-name "<name>") [options]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  --vendor-id <id>   AppFolio numeric vendor ID (direct)');
        console.error('  --vendor-name "<n>" Resolve vendor by company or person name via paseo-ops DB');
        console.error('  --email-link       Send vendor a secure WO link via email');
        console.error('  --text-link        Send vendor a secure WO link via text');
        console.error('  --require-accept   Require vendor to confirm receipt');
        console.error('  --approval-hash    Hash from dry-run output (required with --execute)');
        process.exit(1);
      }
      const srId = cmdArgs[srIdIdx + 1];
      const woId = cmdArgs[woIdIdx + 1];

      let appfolioVendorId: string;
      if (vendorIdIdx !== -1) {
        appfolioVendorId = cmdArgs[vendorIdIdx + 1];
      } else {
        const vendorNameVal = cmdArgs[vendorNameIdx + 1];
        if (!vendorNameVal) { console.error('assign-vendor: --vendor-name requires a value'); process.exit(1); }
        const resolved = await resolveVendor(vendorNameVal);
        if (resolved.error || !resolved.vendor) {
          console.log(JSON.stringify({ error: 'vendor_resolution_failed', ...resolved }, null, 2));
          process.exit(1);
        }
        console.error(`Resolved vendor: "${vendorNameVal}" → ${resolved.vendor.company_name} (${resolved.vendor.display_name}), id=${resolved.vendor.appfolio_vendor_id}`);
        appfolioVendorId = resolved.vendor.appfolio_vendor_id;
      }

      if (!srId || !woId || !appfolioVendorId) {
        console.error('assign-vendor: --sr-id, --wo-id, and --vendor-id/--vendor-name are all required');
        process.exit(1);
      }
      const result = await assignVendor(srId, woId, appfolioVendorId, live, dispatchFlags, approvalHashVal);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error || result.verified === false ? 1 : 0);
      break;
    }
    case 'create-work-order': {
      const propIdIdx = cmdArgs.indexOf('--property-id');
      const descIdx = cmdArgs.indexOf('--description');
      const unitIdIdx = cmdArgs.indexOf('--unit-id');
      const occupancyIdIdx = cmdArgs.indexOf('--occupancy-id');
      const categoryIdx = cmdArgs.indexOf('--category');
      const issueDescIdx = cmdArgs.indexOf('--issue-descriptor-id');
      const priorityIdx = cmdArgs.indexOf('--priority');
      const pteIdx = cmdArgs.indexOf('--permission-to-enter');
      const specialInstIdx = cmdArgs.indexOf('--special-instructions');
      const requestTypeIdx = cmdArgs.indexOf('--request-type');
      const approvalHashIdx2 = cmdArgs.indexOf('--approval-hash');
      const live2 = cmdArgs.includes('--execute');

      const approvalHashVal2 = approvalHashIdx2 !== -1 ? cmdArgs[approvalHashIdx2 + 1] : undefined;

      if (propIdIdx === -1 || descIdx === -1) {
        console.error('Usage: create-work-order --property-id <id> --description "<text>" [options]');
        console.error('  --unit-id <id>              Unit within property');
        console.error('  --occupancy-id <id>         Tenant occupancy (set by typeahead)');
        console.error('  --category <num>            WO category (1=Alarm, 2=Appliances, 6=Electrical, ""=No Trade)');
        console.error('  --issue-descriptor-id <id>  Issue descriptor');
        console.error('  --priority <level>          Urgent|Normal|Low (default: Normal)');
        console.error('  --permission-to-enter <val> true|false|not_applicable');
        console.error('  --special-instructions "<t>" Entry instructions text');
        console.error('  --request-type <type>       internal|tenant_requested|unit_turn (default: internal)');
        console.error('  --execute --approval-hash <hash>  Submit live (requires prior dry-run hash)');
        process.exit(1);
      }
      const cwParams: CreateWorkOrderParams = {
        propertyId: cmdArgs[propIdIdx + 1],
        description: cmdArgs[descIdx + 1],
        unitId: unitIdIdx !== -1 ? cmdArgs[unitIdIdx + 1] : undefined,
        occupancyId: occupancyIdIdx !== -1 ? cmdArgs[occupancyIdIdx + 1] : undefined,
        category: categoryIdx !== -1 ? cmdArgs[categoryIdx + 1] : undefined,
        issueDescriptorId: issueDescIdx !== -1 ? cmdArgs[issueDescIdx + 1] : undefined,
        priority: priorityIdx !== -1 ? cmdArgs[priorityIdx + 1] as CreateWorkOrderParams['priority'] : undefined,
        permissionToEnter: pteIdx !== -1 ? cmdArgs[pteIdx + 1] as CreateWorkOrderParams['permissionToEnter'] : undefined,
        specialInstructions: specialInstIdx !== -1 ? cmdArgs[specialInstIdx + 1] : undefined,
        requestType: requestTypeIdx !== -1 ? cmdArgs[requestTypeIdx + 1] as CreateWorkOrderParams['requestType'] : undefined,
      };
      if (!cwParams.propertyId || !cwParams.description) {
        console.error('create-work-order: --property-id and --description are required');
        process.exit(1);
      }
      const result2 = await createWorkOrder(cwParams, live2, approvalHashVal2);
      console.log(JSON.stringify(result2, null, 2));
      process.exit(result2.error || result2.verified === false ? 1 : 0);
      break;
    }
    case 'add-note': {
      const noteSrIdIdx = cmdArgs.indexOf('--sr-id');
      const noteWoIdIdx = cmdArgs.indexOf('--wo-id');
      const bodyIdx = cmdArgs.indexOf('--body');
      const noteHashIdx = cmdArgs.indexOf('--approval-hash');
      const noteLive = cmdArgs.includes('--execute');
      const noteHashVal = noteHashIdx !== -1 ? cmdArgs[noteHashIdx + 1] : undefined;

      if (noteSrIdIdx === -1 || noteWoIdIdx === -1 || bodyIdx === -1) {
        console.error('Usage: add-note --sr-id <id> --wo-id <id> --body "<text>" [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  --sr-id            Service request ID (numeric)');
        console.error('  --wo-id            Work order ID (numeric)');
        console.error('  --body             Note text to add');
        console.error('  --approval-hash    Hash from dry-run output (required with --execute)');
        process.exit(1);
      }
      const noteSrId = cmdArgs[noteSrIdIdx + 1];
      const noteWoId = cmdArgs[noteWoIdIdx + 1];
      const noteBody = cmdArgs[bodyIdx + 1];
      if (!noteSrId || !noteWoId || !noteBody) {
        console.error('add-note: --sr-id, --wo-id, and --body are required');
        process.exit(1);
      }
      const result3 = await addWorkOrderNote({ srId: noteSrId, woId: noteWoId, body: noteBody }, noteLive, noteHashVal);
      console.log(JSON.stringify(result3, null, 2));
      process.exit(result3.error || result3.verified === false ? 1 : 0);
      break;
    }
    case 'update-vendor-instructions': {
      const viSrIdIdx = cmdArgs.indexOf('--sr-id');
      const viWoIdIdx = cmdArgs.indexOf('--wo-id');
      const viInstrIdx = cmdArgs.indexOf('--instructions');
      const viHashIdx = cmdArgs.indexOf('--approval-hash');
      const viHashVal = viHashIdx !== -1 ? cmdArgs[viHashIdx + 1] : undefined;

      // Exclude positions consumed as values of other flags
      const viConsumed = new Set<number>();
      if (viSrIdIdx !== -1) viConsumed.add(viSrIdIdx + 1);
      if (viWoIdIdx !== -1) viConsumed.add(viWoIdIdx + 1);
      if (viInstrIdx !== -1) viConsumed.add(viInstrIdx + 1);
      if (viHashIdx !== -1) viConsumed.add(viHashIdx + 1);
      const viLive = cmdArgs.some((arg, i) => arg === '--execute' && !viConsumed.has(i));
      const viReplace = cmdArgs.some((arg, i) => arg === '--replace' && !viConsumed.has(i));

      if (viSrIdIdx === -1 || viWoIdIdx === -1 || viInstrIdx === -1) {
        console.error('Usage: update-vendor-instructions --sr-id <id> --wo-id <id> --instructions "<text>" [--replace] [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  --replace          Replace existing instructions (default: append with separator)');
        process.exit(1);
      }
      const viSrId = cmdArgs[viSrIdIdx + 1];
      const viWoId = cmdArgs[viWoIdIdx + 1];
      const viInstr = cmdArgs[viInstrIdx + 1];
      if (!viSrId || !viWoId || !viInstr) {
        console.error('update-vendor-instructions: --sr-id, --wo-id, and --instructions are required');
        process.exit(1);
      }
      const result3c = await updateVendorInstructions(
        { srId: viSrId, woId: viWoId, instructions: viInstr, replace: viReplace },
        viLive, viHashVal,
      );
      console.log(JSON.stringify(result3c, null, 2));
      process.exit(result3c.error || result3c.verified === false ? 1 : 0);
      break;
    }
    case 'read-wo-messages': {
      if (!cmdArgs[0]) { console.error('Usage: read-wo-messages <WO-number>'); process.exit(1); }
      const result3b = await readWoMessages(cmdArgs[0]);
      console.log(JSON.stringify(result3b, null, 2));
      process.exit((result3b as Record<string, unknown>).error ? 1 : 0);
      break;
    }
    case 'send-wo-message': {
      const msgWoIdx = cmdArgs.indexOf('--wo');
      const msgIdx = cmdArgs.indexOf('--message');
      const msgHashIdx = cmdArgs.indexOf('--approval-hash');

      if (msgWoIdx === -1 || msgIdx === -1) {
        console.error('Usage: send-wo-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  GATED EXTERNAL: texting a real tenant requires per-instance approval.');
        process.exit(1);
      }
      const msgWoQuery = cmdArgs[msgWoIdx + 1];
      const msgText = cmdArgs[msgIdx + 1];
      const msgHashVal = msgHashIdx !== -1 ? cmdArgs[msgHashIdx + 1] : undefined;

      // Parse --execute and --capture as standalone flags, excluding positions consumed as values of other flags
      const consumedValueIndices = new Set<number>();
      if (msgWoIdx !== -1) consumedValueIndices.add(msgWoIdx + 1);
      if (msgIdx !== -1) consumedValueIndices.add(msgIdx + 1);
      if (msgHashIdx !== -1) consumedValueIndices.add(msgHashIdx + 1);
      const msgLive = cmdArgs.some((arg, i) => arg === '--execute' && !consumedValueIndices.has(i));
      const msgCapture = cmdArgs.some((arg, i) => arg === '--capture' && !consumedValueIndices.has(i));

      if (!msgWoQuery || !msgText) {
        console.error('send-wo-message: --wo and --message are required');
        process.exit(1);
      }
      const result4 = await sendWoMessage(msgWoQuery, msgText, msgLive, msgHashVal, msgCapture);
      console.log(JSON.stringify(result4, null, 2));
      process.exit(result4.error || result4.verified === false ? 1 : 0);
      break;
    }
    case 'send-vendor-message': {
      const vmWoIdx = cmdArgs.indexOf('--wo');
      const vmMsgIdx = cmdArgs.indexOf('--message');
      const vmHashIdx = cmdArgs.indexOf('--approval-hash');

      if (vmWoIdx === -1 || vmMsgIdx === -1) {
        console.error('Usage: send-vendor-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  GATED EXTERNAL: messaging a real vendor requires per-instance approval.');
        process.exit(1);
      }
      const vmWoQuery = cmdArgs[vmWoIdx + 1];
      const vmText = cmdArgs[vmMsgIdx + 1];
      const vmHashVal = vmHashIdx !== -1 ? cmdArgs[vmHashIdx + 1] : undefined;

      const consumedVmIndices = new Set<number>();
      if (vmWoIdx !== -1) consumedVmIndices.add(vmWoIdx + 1);
      if (vmMsgIdx !== -1) consumedVmIndices.add(vmMsgIdx + 1);
      if (vmHashIdx !== -1) consumedVmIndices.add(vmHashIdx + 1);
      const vmLive = cmdArgs.some((arg, i) => arg === '--execute' && !consumedVmIndices.has(i));

      if (!vmWoQuery || !vmText) {
        console.error('send-vendor-message: --wo and --message are required');
        process.exit(1);
      }
      const result4b = await sendVendorMessage(vmWoQuery, vmText, vmLive, vmHashVal);
      console.log(JSON.stringify(result4b, null, 2));
      process.exit(result4b.error || result4b.verified === false ? 1 : 0);
      break;
    }
    case 'send-vendor-email': {
      const veWoIdx = cmdArgs.indexOf('--wo');
      const veSubIdx = cmdArgs.indexOf('--subject');
      const veMsgIdx = cmdArgs.indexOf('--message');
      const veHashIdx = cmdArgs.indexOf('--approval-hash');

      if (veWoIdx === -1 || veSubIdx === -1 || veMsgIdx === -1) {
        console.error('Usage: send-vendor-email --wo <WO-number> --subject "<text>" --message "<text>" [--execute --approval-hash <hash>]');
        console.error('  Default is dry-run. Pass --execute --approval-hash <hash> only with chief + Albie greenlight.');
        console.error('  GATED EXTERNAL: emailing a real vendor requires per-instance approval.');
        process.exit(1);
      }
      const veWoQuery = cmdArgs[veWoIdx + 1];
      const veSubject = cmdArgs[veSubIdx + 1];
      const veMessage = cmdArgs[veMsgIdx + 1];
      const veHashVal = veHashIdx !== -1 ? cmdArgs[veHashIdx + 1] : undefined;

      const consumedVeIndices = new Set<number>();
      if (veWoIdx !== -1) consumedVeIndices.add(veWoIdx + 1);
      if (veSubIdx !== -1) consumedVeIndices.add(veSubIdx + 1);
      if (veMsgIdx !== -1) consumedVeIndices.add(veMsgIdx + 1);
      if (veHashIdx !== -1) consumedVeIndices.add(veHashIdx + 1);
      const veLive = cmdArgs.some((arg, i) => arg === '--execute' && !consumedVeIndices.has(i));

      if (!veWoQuery || !veSubject || !veMessage) {
        console.error('send-vendor-email: --wo, --subject, and --message are required');
        process.exit(1);
      }
      const result4c = await sendVendorEmail(veWoQuery, veSubject, veMessage, veLive, veHashVal);
      console.log(JSON.stringify(result4c, null, 2));
      process.exit(result4c.error || result4c.verified === false ? 1 : 0);
      break;
    }
    case 'photo-intake': {
      const piWoIdx = cmdArgs.indexOf('--wo');
      const piHashIdx = cmdArgs.indexOf('--approval-hash');
      const piExecute = cmdArgs.includes('--execute');
      const piHashVal = piHashIdx !== -1 ? cmdArgs[piHashIdx + 1] : undefined;

      if (piWoIdx === -1) {
        console.error('Usage: photo-intake --wo <WO-number> [--execute --approval-hash <hash>]');
        console.error('  Reads inbound tenant photos, runs vision analysis, adds note with findings.');
        console.error('  Default is dry-run (analyze only). --execute adds notes to the WO.');
        process.exit(1);
      }
      const piWoQuery = cmdArgs[piWoIdx + 1];
      if (!piWoQuery) {
        console.error('photo-intake: --wo is required');
        process.exit(1);
      }
      const result5 = await photoIntake(piWoQuery, piExecute, piHashVal);
      console.log(JSON.stringify(result5, null, 2));
      process.exit(result5.error ? 1 : 0);
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
        '  resolve-vendor "<name>"     — resolve vendor name to AppFolio ID via paseo-ops DB (company or person name)',
        '  assign-vendor --sr-id <id> --wo-id <id> (--vendor-id <id> | --vendor-name "<name>") [--email-link] [--text-link] [--require-accept] [--execute --approval-hash <hash>]',
        '                                — assign vendor to WO; dry-run default, --execute + hash submits PATCH',
        '                                — --vendor-name resolves via paseo-ops DB before assign',
        '  create-work-order --property-id <id> --description "<text>" [--unit-id <id>] [--category <num>] [--priority Urgent|Normal|Low] [--request-type internal|tenant_requested] [--execute --approval-hash <hash>]',
        '                                — create new WO; dry-run default, --execute + hash submits POST',
        '  add-note --sr-id <id> --wo-id <id> --body "<text>" [--execute --approval-hash <hash>]',
        '                                — add note to WO; dry-run default, --execute + hash submits POST',
        '  update-vendor-instructions --sr-id <id> --wo-id <id> --instructions "<text>" [--replace] [--execute --approval-hash <hash>]',
        '                                — set/append vendor instructions on SR; dry-run default, --execute + hash submits PATCH',
        '  read-wo-messages <WO-number>  — read tenant SMS thread for a WO',
        '  send-wo-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>]',
        '                                — send SMS to tenant; dry-run default, --execute + hash sends (GATED EXTERNAL)',
        '  send-vendor-message --wo <WO-number> --message "<text>" [--execute --approval-hash <hash>]',
        '                                — send SMS to vendor; dry-run default, --execute + hash sends (GATED EXTERNAL)',
        '  send-vendor-email --wo <WO-number> --subject "<text>" --message "<text>" [--execute --approval-hash <hash>]',
        '                                — send email to vendor; dry-run default, --execute + hash sends (GATED EXTERNAL)',
        '  photo-intake --wo <WO-number> [--execute --approval-hash <hash>]',
        '                                — analyze inbound tenant photos via vision; dry-run default, --execute adds WO notes',
      ].join('\n'));
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});

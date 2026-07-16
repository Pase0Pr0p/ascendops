#!/usr/bin/env node
/**
 * AppFolio browser read automation — read-only UI lookups via agent-browser.
 *
 * Usage:
 *   npx tsx scripts/appfolio-browser-read.ts check-session
 *   npx tsx scripts/appfolio-browser-read.ts login
 *   npx tsx scripts/appfolio-browser-read.ts lookup-tenant "John Smith"
 *   npx tsx scripts/appfolio-browser-read.ts lookup-unit "123 Main St Apt 1"
 *   npx tsx scripts/appfolio-browser-read.ts lookup-work-order "WO-12345"
 *
 * Session: persistent, keyed to 'appfolio-ops'. Established once by attended login;
 * subsequent runs restore automatically without human input.
 *
 * Login guardrail: one attempt only. On any MFA/CAPTCHA/challenge page, exits with
 * code 2 and prints a human-action-required message. Never retries login.
 *
 * All output is JSON to stdout; errors to stderr.
 */

import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { join, resolve } from 'node:path';

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
 * Lookup a work order by ID or search term.
 */
async function lookupWorkOrder(query: string): Promise<object> {
  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session. Run login first.' };
  }

  const searchUrl = `${APPFOLIO_URL}/maintenance_requests?search=${encodeURIComponent(query)}`;
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

// ─── Texting functions ───────────────────────────────────────────────────────

interface TextResult {
  error?: string;
  message?: string;
  [key: string]: unknown;
}

function validatePhone(phone: string): boolean {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

function escapeForEval(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Send a text to a tenant from their occupancy/tenant page.
 *
 * Flow: navigate to tenant page → locate Texts panel → select phone dropdown →
 * type message → click Send.
 *
 * Safe by default: --execute required for actual send.
 */
async function textTenant(
  occupancyId: string,
  tenantId: string,
  messageText: string,
  live: boolean,
): Promise<TextResult> {
  if (!/^\d+$/.test(occupancyId) || !/^\d+$/.test(tenantId)) {
    return { error: 'invalid_ids', message: 'occupancyId and tenantId must be numeric digits only' };
  }
  if (!messageText.trim()) {
    return { error: 'empty_message', message: 'Message text cannot be empty' };
  }
  if (messageText.length > 1600) {
    return { error: 'message_too_long', message: 'Message exceeds 1600 characters (10 SMS segments max)' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session.' };
  }

  const tenantUrl = `${APPFOLIO_URL}/occupancies/${occupancyId}/selected_tenant/${tenantId}`;
  const opened = abSafe('open', tenantUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  const currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Extract available phone numbers from the texting dropdown
  // AppFolio tenant page has a phone dropdown with entries like "Tenant Name - Mobile (415) 747-9469"
  const phoneResult = abEval(`
    var phones = [];
    var selects = document.querySelectorAll('select');
    selects.forEach(function(sel) {
      Array.from(sel.options).forEach(function(opt) {
        if (opt.value && opt.textContent && /mobile|cell|phone/i.test(opt.textContent)) {
          phones.push({value: opt.value, label: opt.textContent.trim()});
        }
      });
    });
    if (phones.length === 0) {
      selects.forEach(function(sel) {
        Array.from(sel.options).forEach(function(opt) {
          if (opt.value && opt.value !== '' && /\d{3}.*\d{4}/.test(opt.textContent)) {
            phones.push({value: opt.value, label: opt.textContent.trim()});
          }
        });
      });
    }
    JSON.stringify(phones);
  `);

  let phones: Array<{value: string; label: string}> = [];
  try { phones = JSON.parse(phoneResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Find the texting input area — AppFolio uses placeholder "Enter SMS message or type / to use a template"
  const textAreaResult = abEval(`
    var areas = [];
    var inputs = document.querySelectorAll('textarea, input[type="text"]');
    inputs.forEach(function(el) {
      var ph = el.placeholder || '';
      if (/sms|text|message|template/i.test(ph)) {
        areas.push({tag: el.tagName, placeholder: ph, name: el.name || '', id: el.id || ''});
      }
    });
    JSON.stringify(areas);
  `);

  let textAreas: Array<{tag: string; placeholder: string; name: string; id: string}> = [];
  try { textAreas = JSON.parse(textAreaResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Extract tenant name for logging
  const nameResult = abEval(`
    var h = document.querySelector('h1, .tenant-name, [data-testid="tenant-name"]');
    h ? h.textContent.trim() : 'unknown';
  `);
  const tenantName = nameResult.output.replace(/^"|"$/g, '').trim();

  // Extract and validate the phone number that will receive the text
  let selectedPhone = '';
  if (phones.length > 0) {
    const phoneDigits = phones[0].label.replace(/\D/g, '');
    if (!validatePhone(phoneDigits)) {
      ab('close');
      return { error: 'invalid_phone', message: `Phone number from dropdown fails validation: ${phones[0].label}` };
    }
    selectedPhone = phones[0].label;
  } else {
    ab('close');
    return { error: 'no_phone', message: 'No phone numbers found in dropdown on tenant page. Cannot send without a validated recipient.' };
  }

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute --approval-id <id> after human approval.',
      tenant_name: tenantName,
      occupancy_id: occupancyId,
      tenant_id: tenantId,
      validated_phone: selectedPhone,
      phones_found: phones,
      text_inputs_found: textAreas,
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  // LIVE SEND: select phone, type message, click send
  const phoneVal = escapeForEval(phones[0].value);
  const selectPhone = abEval(`
    var selects = document.querySelectorAll('select');
    var sel = null;
    selects.forEach(function(s) {
      Array.from(s.options).forEach(function(o) {
        if (/mobile|cell|\\d{3}/i.test(o.textContent)) sel = s;
      });
    });
    if (sel) {
      sel.value = "${phoneVal}";
      sel.dispatchEvent(new Event('change', {bubbles: true}));
      'selected';
    } else { 'no_phone_dropdown'; }
  `);
  if (selectPhone.output.includes('no_phone_dropdown')) {
    ab('close');
    return { error: 'phone_select_failed', message: 'Could not find phone dropdown on tenant page' };
  }

  const sanitized = escapeForEval(messageText);
  const fillResult = abEval(`
    var input = null;
    var candidates = document.querySelectorAll('textarea, input[type="text"]');
    candidates.forEach(function(el) {
      if (/sms|text.*message|enter.*message|template/i.test(el.placeholder || '')) input = el;
    });
    if (!input) {
      candidates.forEach(function(el) {
        if (/message/i.test(el.name || '') || /message/i.test(el.id || '')) input = el;
      });
    }
    if (input) {
      input.focus();
      input.value = "${sanitized}";
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text message input field on tenant page', fill_output: fillResult.output };
  }

  const sendResult = abEval(`
    var candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    var sendBtn = candidates.find(function(b) {
      var t = (b.textContent || b.value || '').trim().toLowerCase();
      return (t === 'send' || t === 'send message') && !b.disabled;
    });
    if (sendBtn) { sendBtn.click(); 'clicked'; }
    else { 'no_send_button'; }
  `);

  await new Promise(r => setTimeout(r, 2000));
  ab('close');

  if (sendResult.output.includes('no_send_button')) {
    return { error: 'send_button_not_found', message: 'Could not locate Send button', send_output: sendResult.output };
  }

  return {
    live: true,
    sent: true,
    tenant_name: tenantName,
    occupancy_id: occupancyId,
    tenant_id: tenantId,
    validated_phone: selectedPhone,
    message_length: messageText.length,
    message_preview: messageText.slice(0, 100),
  };
}

/**
 * Send a text from a work order — to the tenant (Tenant-PM conversation)
 * or to the vendor (Vendor-PM conversation).
 *
 * Flow: navigate to WO page → locate Texts section → select conversation type →
 * type message → Send.
 */
async function textFromWorkOrder(
  srId: string,
  woId: string,
  recipient: 'tenant' | 'vendor',
  messageText: string,
  live: boolean,
): Promise<TextResult> {
  if (!/^\d+$/.test(srId) || !/^\d+$/.test(woId)) {
    return { error: 'invalid_ids', message: 'srId and woId must be numeric digits only' };
  }
  if (!messageText.trim()) {
    return { error: 'empty_message', message: 'Message text cannot be empty' };
  }
  if (messageText.length > 1600) {
    return { error: 'message_too_long', message: 'Message exceeds 1600 characters' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session.' };
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

  // Check WO page state — who's assigned, text button availability
  const woStateResult = abEval(`
    var state = {};
    var textBtn = document.querySelector('button[data-action*="text"], a[href*="texting"], [class*="text-button"]');
    state.hasTextButton = !!textBtn;
    state.textButtonText = textBtn ? textBtn.textContent.trim() : null;
    var vendor = document.querySelector('[data-testid*="vendor"], .vendor-name, [class*="vendor"]');
    state.vendorName = vendor ? vendor.textContent.trim() : null;
    var tenant = document.querySelector('[data-testid*="tenant"], .tenant-name');
    state.tenantName = tenant ? tenant.textContent.trim() : null;
    var conversations = document.querySelectorAll('[class*="conversation"], [data-testid*="conversation"]');
    state.conversationCount = conversations.length;
    JSON.stringify(state);
  `);

  let woState: Record<string, unknown> = {};
  try { woState = JSON.parse(woStateResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Look for the texting area on the WO page
  const textSectionResult = abEval(`
    var sections = [];
    var textHeadings = document.querySelectorAll('h2, h3, h4, [class*="heading"]');
    textHeadings.forEach(function(h) {
      if (/text/i.test(h.textContent)) sections.push({tag: h.tagName, text: h.textContent.trim()});
    });
    var textareas = document.querySelectorAll('textarea, input[type="text"][placeholder*="message"], input[placeholder*="SMS"]');
    textareas.forEach(function(t) {
      sections.push({tag: t.tagName, placeholder: t.placeholder || '', name: t.name || ''});
    });
    JSON.stringify(sections);
  `);

  let textSections: Array<Record<string, string>> = [];
  try { textSections = JSON.parse(textSectionResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Extract and validate the recipient phone from the WO text section
  const recipientPhoneResult = abEval(`
    var phones = [];
    var links = Array.from(document.querySelectorAll('a'));
    links.forEach(function(a) {
      var t = a.textContent.trim();
      if (/\\(\\d{3}\\)\\s*\\d{3}-\\d{4}/.test(t) || /\\d{3}-\\d{3}-\\d{4}/.test(t)) {
        phones.push(t);
      }
    });
    var tds = Array.from(document.querySelectorAll('td, span, div'));
    tds.forEach(function(el) {
      var t = el.textContent.trim();
      if (/^\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}$/.test(t) && phones.indexOf(t) === -1) {
        phones.push(t);
      }
    });
    JSON.stringify(phones);
  `);

  let recipientPhones: string[] = [];
  try { recipientPhones = JSON.parse(recipientPhoneResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Validate recipient has a phone number (fail-closed)
  let validatedWoPhone = '';
  for (const p of recipientPhones) {
    const digits = p.replace(/\D/g, '');
    if (validatePhone(digits)) { validatedWoPhone = p; break; }
  }

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute --approval-id <id> after human approval.',
      recipient,
      sr_id: srId,
      wo_id: woId,
      wo_state: woState,
      validated_phone: validatedWoPhone || 'NONE — no valid phone found on WO page for this recipient',
      phones_on_page: recipientPhones,
      text_sections_found: textSections,
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  if (!validatedWoPhone) {
    ab('close');
    return { error: 'no_valid_phone', message: `No valid phone number found on WO page for ${recipient}. Cannot send without a validated recipient.`, phones_on_page: recipientPhones, wo_state: woState };
  }

  // LIVE: Navigate to the Texts section on the WO page
  const clickTextResult = abEval(`
    var btns = Array.from(document.querySelectorAll('button, a'));
    var textBtn = btns.find(function(b) {
      var t = b.textContent.trim().toLowerCase();
      return (t === 'text' || t === 'send text') && !b.disabled;
    });
    if (textBtn) { textBtn.click(); 'clicked'; }
    else { 'no_text_button'; }
  `);

  if (clickTextResult.output.includes('no_text_button')) {
    const scrollResult = abEval(`
      var headings = Array.from(document.querySelectorAll('h2, h3, h4, [class*="heading"], [class*="section-title"]'));
      var textsSection = headings.find(function(h) { return /^texts$/i.test(h.textContent.trim()); });
      if (textsSection) { textsSection.scrollIntoView({behavior:'smooth'}); 'scrolled'; }
      else { 'no_texts_section'; }
    `);

    if (scrollResult.output.includes('no_texts_section')) {
      ab('close');
      return { error: 'no_text_surface', message: 'No Text button or Texts section found on WO page. ' + (recipient === 'tenant' ? 'Tenant may not be selected on the service request.' : 'Vendor may not be assigned to the WO.'), wo_state: woState };
    }
  }

  await new Promise(r => setTimeout(r, 1000));

  if (recipient === 'vendor') {
    abEval(`
      var tabs = Array.from(document.querySelectorAll('[role="tab"], button, a'));
      var vendorTab = tabs.find(function(t) { return /vendor/i.test(t.textContent) && /pm|text|conversation/i.test(t.textContent); });
      if (!vendorTab) vendorTab = tabs.find(function(t) { return /vendor/i.test(t.textContent); });
      if (vendorTab) vendorTab.click();
    `);
    await new Promise(r => setTimeout(r, 500));
  }

  const sanitized = escapeForEval(messageText);
  const fillResult = abEval(`
    var input = null;
    var candidates = document.querySelectorAll('textarea, input[type="text"]');
    candidates.forEach(function(el) {
      if (/sms|text.*message|enter.*message|template/i.test(el.placeholder || '')) input = el;
    });
    if (!input) {
      candidates.forEach(function(el) {
        if (/message/i.test(el.name || '') || /message/i.test(el.id || '')) input = el;
      });
    }
    if (input) {
      input.focus();
      input.value = "${sanitized}";
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text message input on WO page', fill_output: fillResult.output };
  }

  const sendResult = abEval(`
    var candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    var sendBtn = candidates.find(function(b) {
      var t = (b.textContent || b.value || '').trim().toLowerCase();
      return (t === 'send' || t === 'send message') && !b.disabled;
    });
    if (sendBtn) { sendBtn.click(); 'clicked'; }
    else { 'no_send_button'; }
  `);

  await new Promise(r => setTimeout(r, 2000));
  ab('close');

  if (sendResult.output.includes('no_send_button')) {
    return { error: 'send_button_not_found', message: 'Could not locate Send button on WO text panel' };
  }

  return {
    live: true,
    sent: true,
    recipient,
    sr_id: srId,
    wo_id: woId,
    wo_state: woState,
    phones_on_page: recipientPhones,
    message_length: messageText.length,
    message_preview: messageText.slice(0, 100),
  };
}

/**
 * Send a text to a vendor directly from their vendor page.
 * Flow: navigate to vendor page → find Text link/button → type message → Send.
 */
async function textVendor(
  vendorId: string,
  messageText: string,
  live: boolean,
): Promise<TextResult> {
  if (!/^\d+$/.test(vendorId)) {
    return { error: 'invalid_id', message: 'vendorId must be numeric digits only' };
  }
  if (!messageText.trim()) {
    return { error: 'empty_message', message: 'Message text cannot be empty' };
  }
  if (messageText.length > 1600) {
    return { error: 'message_too_long', message: 'Message exceeds 1600 characters' };
  }

  const sessionCheck = await checkSession();
  if (!sessionCheck.authenticated) {
    return { error: 'not_authenticated', message: 'No active AppFolio session.' };
  }

  const vendorUrl = `${APPFOLIO_URL}/vendors/${vendorId}`;
  const opened = abSafe('open', vendorUrl);
  if (!opened.ok) return { error: 'navigation_failed', message: opened.output };
  abSafe('wait', '--load', 'networkidle');

  const currentUrl = abSafe('get', 'url').output.trim();
  if (/account\.appfolio\.com|\/openid-connect\/auth|\/users\/sign_in|\/login/i.test(currentUrl)) {
    ab('close');
    return { error: 'not_authenticated', message: `Redirected to auth page: ${currentUrl}` };
  }

  // Check vendor page for text surfaces
  const vendorStateResult = abEval(`
    var state = {};
    var nameEl = document.querySelector('h1, .vendor-name, [data-testid="vendor-name"]');
    state.vendorName = nameEl ? nameEl.textContent.trim() : 'unknown';
    var textLinks = Array.from(document.querySelectorAll('a'));
    var textLink = textLinks.find(function(a) { return a.textContent.trim().toLowerCase() === 'text'; });
    state.hasTextLink = !!textLink;
    var phones = [];
    var phoneEls = document.querySelectorAll('[class*="phone"], [data-testid*="phone"], td');
    phoneEls.forEach(function(el) {
      var t = el.textContent.trim();
      if (/\(\d{3}\)\s*\d{3}-\d{4}/.test(t) || /\d{3}-\d{3}-\d{4}/.test(t)) phones.push(t);
    });
    state.phones = phones.slice(0, 5);
    JSON.stringify(state);
  `);

  let vendorState: Record<string, unknown> = {};
  try { vendorState = JSON.parse(vendorStateResult.output.replace(/^"|"$/g, '').replace(/\\"/g, '"')); } catch { /* empty */ }

  // Validate vendor has a phone number
  const vendorPhones = (vendorState.phones as string[]) ?? [];
  let validatedVendorPhone = '';
  for (const p of vendorPhones) {
    const digits = p.replace(/\D/g, '');
    if (validatePhone(digits)) { validatedVendorPhone = p; break; }
  }

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute --approval-id <id> after human approval.',
      vendor_id: vendorId,
      vendor_state: vendorState,
      validated_phone: validatedVendorPhone || 'NONE — vendor may not have a valid mobile number',
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  if (!validatedVendorPhone) {
    ab('close');
    return { error: 'no_valid_phone', message: 'No valid phone number found on vendor page. Cannot send without a validated recipient.', vendor_state: vendorState };
  }

  // LIVE: Click the "text" link tied to the validated phone number
  const escapedPhone = escapeForEval(validatedVendorPhone);
  const clickResult = abEval(`
    var targetPhone = "${escapedPhone}";
    var found = null;
    var rows = document.querySelectorAll('tr, div, li, dd, span');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.textContent.indexOf(targetPhone) !== -1) {
        var links = row.querySelectorAll('a');
        for (var j = 0; j < links.length; j++) {
          var t = links[j].textContent.trim().toLowerCase();
          if (t === 'text' || t === 'send text') { found = links[j]; break; }
        }
        if (found) break;
      }
    }
    if (found) { found.click(); 'clicked'; }
    else { 'no_text_link_for_phone'; }
  `);

  if (clickResult.output.includes('no_text_link')) {
    ab('close');
    return { error: 'no_text_surface', message: `No text link found adjacent to validated phone ${validatedVendorPhone}. Vendor page layout may have changed.`, vendor_state: vendorState };
  }

  await new Promise(r => setTimeout(r, 1500));

  const sanitized = escapeForEval(messageText);
  const fillResult = abEval(`
    var input = null;
    var candidates = document.querySelectorAll('textarea, input[type="text"]');
    candidates.forEach(function(el) {
      if (/sms|text.*message|enter.*message|template/i.test(el.placeholder || '')) input = el;
    });
    if (!input) {
      candidates.forEach(function(el) {
        if (/message/i.test(el.name || '') || /message/i.test(el.id || '')) input = el;
      });
    }
    if (input) {
      input.focus();
      input.value = "${sanitized}";
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text input on vendor texting page', fill_output: fillResult.output };
  }

  const sendResult = abEval(`
    var candidates = Array.from(document.querySelectorAll('button, input[type="submit"]'));
    var sendBtn = candidates.find(function(b) {
      var t = (b.textContent || b.value || '').trim().toLowerCase();
      return (t === 'send' || t === 'send message') && !b.disabled;
    });
    if (sendBtn) { sendBtn.click(); 'clicked'; }
    else { 'no_send_button'; }
  `);

  await new Promise(r => setTimeout(r, 2000));
  ab('close');

  if (sendResult.output.includes('no_send_button')) {
    return { error: 'send_button_not_found', message: 'Could not locate Send button' };
  }

  return {
    live: true,
    sent: true,
    vendor_id: vendorId,
    vendor_state: vendorState,
    validated_phone: validatedVendorPhone,
    message_length: messageText.length,
    message_preview: messageText.slice(0, 100),
  };
}

// ─── CLI arg parsing ─────────────────────────────────────────────────────────

function parseTextArgs(args: string[]): {
  flags: Record<string, string>;
  execute: boolean;
  approvalId: string;
  message: string;
} {
  const flags: Record<string, string> = {};
  let execute = false;
  let approvalId = '';
  let message = '';
  const knownFlags = ['--occupancy-id', '--tenant-id', '--vendor-id', '--sr-id', '--wo-id', '--recipient'];

  const msgIdx = args.indexOf('--message');
  if (msgIdx !== -1) {
    message = args.slice(msgIdx + 1).join(' ');
  }

  const argsBeforeMessage = msgIdx !== -1 ? args.slice(0, msgIdx) : args;
  let i = 0;
  while (i < argsBeforeMessage.length) {
    if (argsBeforeMessage[i] === '--execute') {
      execute = true;
      i++;
    } else if (argsBeforeMessage[i] === '--approval-id' && i + 1 < argsBeforeMessage.length) {
      approvalId = argsBeforeMessage[i + 1];
      i += 2;
    } else if (knownFlags.includes(argsBeforeMessage[i]) && i + 1 < argsBeforeMessage.length) {
      flags[argsBeforeMessage[i]] = argsBeforeMessage[i + 1];
      i += 2;
    } else {
      i++;
    }
  }

  return { flags, execute, approvalId, message };
}

function loadApprovalFile(approvalId: string): Record<string, unknown> | null {
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  const org = process.env.CTX_ORG || '';
  const home = process.env.HOME || '';
  const ctxRoot = join(home, '.cortextos', instanceId);
  const orgBase = org ? join(ctxRoot, 'orgs', org) : ctxRoot;
  const approvalDir = join(orgBase, 'approvals');

  for (const sub of ['resolved', 'pending']) {
    const file = join(approvalDir, sub, `${approvalId}.json`);
    if (existsSync(file)) {
      return JSON.parse(readFileSync(file, 'utf-8'));
    }
  }
  return null;
}

function validateExecuteGate(execute: boolean, approvalId: string): void {
  if (!execute) return;
  if (!approvalId) {
    console.error('ERROR: --execute requires --approval-id <id>. Get approval via cortextos bus create-approval first.');
    process.exit(1);
  }
  const approval = loadApprovalFile(approvalId);
  if (!approval) {
    console.error(`ERROR: approval ${approvalId} not found.`);
    process.exit(1);
  }
  if (approval.status !== 'approved') {
    console.error(`ERROR: approval ${approvalId} status is "${approval.status}", not "approved".`);
    process.exit(1);
  }
  if (approval.category !== 'external-comms') {
    console.error(`ERROR: approval ${approvalId} category is "${approval.category}", expected "external-comms".`);
    process.exit(1);
  }
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
    case 'lookup-work-order': {
      if (!cmdArgs[0]) { console.error('Usage: lookup-work-order <id-or-term>'); process.exit(1); }
      const result = await lookupWorkOrder(cmdArgs.join(' '));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'text-tenant': {
      const parsed = parseTextArgs(cmdArgs);
      const occId = parsed.flags['--occupancy-id'];
      const tenId = parsed.flags['--tenant-id'];
      if (!occId || !tenId || !parsed.message) {
        console.error('Usage: text-tenant --occupancy-id <id> --tenant-id <id> --message <text> [--execute --approval-id <id>]');
        console.error('  Default is dry-run. --execute requires --approval-id from cortextos approval gate.');
        process.exit(1);
      }
      validateExecuteGate(parsed.execute, parsed.approvalId);
      const result = await textTenant(occId, tenId, parsed.message, parsed.execute);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
      break;
    }
    case 'text-wo': {
      const parsed = parseTextArgs(cmdArgs);
      const srId = parsed.flags['--sr-id'];
      const woId = parsed.flags['--wo-id'];
      const recipient = parsed.flags['--recipient'] as 'tenant' | 'vendor';
      if (!srId || !woId || !recipient || !parsed.message) {
        console.error('Usage: text-wo --sr-id <id> --wo-id <id> --recipient <tenant|vendor> --message <text> [--execute --approval-id <id>]');
        process.exit(1);
      }
      if (recipient !== 'tenant' && recipient !== 'vendor') {
        console.error('text-wo: --recipient must be "tenant" or "vendor"');
        process.exit(1);
      }
      validateExecuteGate(parsed.execute, parsed.approvalId);
      const result = await textFromWorkOrder(srId, woId, recipient, parsed.message, parsed.execute);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
      break;
    }
    case 'text-vendor': {
      const parsed = parseTextArgs(cmdArgs);
      const vendorId = parsed.flags['--vendor-id'];
      if (!vendorId || !parsed.message) {
        console.error('Usage: text-vendor --vendor-id <id> --message <text> [--execute --approval-id <id>]');
        process.exit(1);
      }
      validateExecuteGate(parsed.execute, parsed.approvalId);
      const result = await textVendor(vendorId, parsed.message, parsed.execute);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
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
        '  lookup-work-order <id|term>   — search work orders',
        '  text-tenant --occupancy-id <id> --tenant-id <id> --message <text> [--execute]',
        '                                — text a tenant from their page (dry-run default)',
        '  text-wo --sr-id <id> --wo-id <id> --recipient <tenant|vendor> --message <text> [--execute]',
        '                                — text from a work order (dry-run default)',
        '  text-vendor --vendor-id <id> --message <text> [--execute]',
        '                                — text a vendor directly (dry-run default)',
      ].join('\n'));
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});

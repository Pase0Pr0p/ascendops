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

function sanitizeMessageForEval(msg: string): string {
  return msg
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '');
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

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute only after human approval via cortextos approval gate.',
      tenant_name: tenantName,
      occupancy_id: occupancyId,
      tenant_id: tenantId,
      phones_found: phones,
      text_inputs_found: textAreas,
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  // LIVE SEND: select phone, type message, click send
  // Select first phone from dropdown if multiple available
  if (phones.length > 0) {
    const phoneVal = phones[0].value.replace(/'/g, "\\'");
    const selectPhone = abEval(`
      var selects = document.querySelectorAll('select');
      var sel = null;
      selects.forEach(function(s) {
        Array.from(s.options).forEach(function(o) {
          if (/mobile|cell|\\d{3}/i.test(o.textContent)) sel = s;
        });
      });
      if (sel) {
        sel.value = '${phoneVal}';
        sel.dispatchEvent(new Event('change', {bubbles: true}));
        'selected';
      } else { 'no_phone_dropdown'; }
    `);
    if (selectPhone.output.includes('no_phone_dropdown')) {
      ab('close');
      return { error: 'phone_select_failed', message: 'Could not find phone dropdown on tenant page' };
    }
  }

  // Type the message — target the SMS input by placeholder pattern
  const sanitized = sanitizeMessageForEval(messageText);
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
      input.value = '${sanitized}';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text message input field on tenant page', fill_output: fillResult.output };
  }

  // Click Send — look for send-style button near the texting area
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
    phone: phones.length > 0 ? phones[0].label : 'default',
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

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute only after human approval.',
      recipient,
      sr_id: srId,
      wo_id: woId,
      wo_state: woState,
      text_sections_found: textSections,
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  // LIVE: Navigate to the Texts section on the WO page
  // WO pages have: "Text" button in top action bar, and a Texts section with conversation tabs
  // For tenant text: Tenant-PM conversation requires tenant selected on SR
  // For vendor text: Vendor-PM conversation requires vendor assigned to WO
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
    // Try scrolling to the Texts section and clicking the right conversation type
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

  // If targeting vendor, try to switch to Vendor-PM conversation tab
  if (recipient === 'vendor') {
    abEval(`
      var tabs = Array.from(document.querySelectorAll('[role="tab"], button, a'));
      var vendorTab = tabs.find(function(t) { return /vendor/i.test(t.textContent) && /pm|text|conversation/i.test(t.textContent); });
      if (!vendorTab) vendorTab = tabs.find(function(t) { return /vendor/i.test(t.textContent); });
      if (vendorTab) vendorTab.click();
    `);
    await new Promise(r => setTimeout(r, 500));
  }

  // Fill message — same pattern as tenant text
  const sanitized = sanitizeMessageForEval(messageText);
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
      input.value = '${sanitized}';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text message input on WO page', fill_output: fillResult.output };
  }

  // Click Send
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

  if (!live) {
    ab('close');
    return {
      dry_run: true,
      guardrail: 'TEXT BLOCKED — dry-run mode. Pass --execute only after human approval.',
      vendor_id: vendorId,
      vendor_state: vendorState,
      message_preview: messageText.slice(0, 100) + (messageText.length > 100 ? '...' : ''),
      message_length: messageText.length,
    };
  }

  // LIVE: Click the "text" link next to the vendor's phone number
  // AppFolio vendor pages have a "text" link in the Contact section near each mobile number
  const clickResult = abEval(`
    var links = Array.from(document.querySelectorAll('a'));
    var textLink = links.find(function(a) {
      var t = a.textContent.trim().toLowerCase();
      return t === 'text' || t === 'send text';
    });
    if (textLink) { textLink.click(); 'clicked'; }
    else { 'no_text_link'; }
  `);

  if (clickResult.output.includes('no_text_link')) {
    ab('close');
    return { error: 'no_text_surface', message: 'No text link found on vendor page. Vendor may not have a mobile number on file.', vendor_state: vendorState };
  }

  await new Promise(r => setTimeout(r, 1500));

  // Fill message — same SMS input pattern
  const sanitized = sanitizeMessageForEval(messageText);
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
      input.value = '${sanitized}';
      input.dispatchEvent(new Event('input', {bubbles: true}));
      input.dispatchEvent(new Event('change', {bubbles: true}));
      'filled';
    } else { 'no_input'; }
  `);

  if (!fillResult.ok || fillResult.output.includes('no_input')) {
    ab('close');
    return { error: 'text_input_not_found', message: 'Could not locate text input on vendor texting page', fill_output: fillResult.output };
  }

  // Click Send
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
    message_length: messageText.length,
    message_preview: messageText.slice(0, 100),
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
    case 'lookup-work-order': {
      if (!cmdArgs[0]) { console.error('Usage: lookup-work-order <id-or-term>'); process.exit(1); }
      const result = await lookupWorkOrder(cmdArgs.join(' '));
      console.log(JSON.stringify(result, null, 2));
      break;
    }
    case 'text-tenant': {
      const occIdx = cmdArgs.indexOf('--occupancy-id');
      const tenIdx = cmdArgs.indexOf('--tenant-id');
      const msgIdx = cmdArgs.indexOf('--message');
      const live = cmdArgs.includes('--execute');
      if (occIdx === -1 || tenIdx === -1 || msgIdx === -1) {
        console.error('Usage: text-tenant --occupancy-id <id> --tenant-id <id> --message <text> [--execute]');
        console.error('  Default is dry-run. --execute sends the text (requires prior human approval).');
        process.exit(1);
      }
      const occId = cmdArgs[occIdx + 1];
      const tenId = cmdArgs[tenIdx + 1];
      const msg = cmdArgs.slice(msgIdx + 1).filter(a => a !== '--execute').join(' ');
      if (!occId || !tenId || !msg) {
        console.error('text-tenant: --occupancy-id, --tenant-id, and --message are all required');
        process.exit(1);
      }
      const result = await textTenant(occId, tenId, msg, live);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
      break;
    }
    case 'text-wo': {
      const srIdx = cmdArgs.indexOf('--sr-id');
      const woIdx = cmdArgs.indexOf('--wo-id');
      const recIdx = cmdArgs.indexOf('--recipient');
      const msgIdx = cmdArgs.indexOf('--message');
      const live = cmdArgs.includes('--execute');
      if (srIdx === -1 || woIdx === -1 || recIdx === -1 || msgIdx === -1) {
        console.error('Usage: text-wo --sr-id <id> --wo-id <id> --recipient <tenant|vendor> --message <text> [--execute]');
        process.exit(1);
      }
      const srId = cmdArgs[srIdx + 1];
      const woId = cmdArgs[woIdx + 1];
      const recipient = cmdArgs[recIdx + 1] as 'tenant' | 'vendor';
      if (recipient !== 'tenant' && recipient !== 'vendor') {
        console.error('text-wo: --recipient must be "tenant" or "vendor"');
        process.exit(1);
      }
      const msg = cmdArgs.slice(msgIdx + 1).filter(a => a !== '--execute').join(' ');
      if (!srId || !woId || !msg) {
        console.error('text-wo: --sr-id, --wo-id, --recipient, and --message are all required');
        process.exit(1);
      }
      const result = await textFromWorkOrder(srId, woId, recipient, msg, live);
      console.log(JSON.stringify(result, null, 2));
      process.exit(result.error ? 1 : 0);
      break;
    }
    case 'text-vendor': {
      const vidIdx = cmdArgs.indexOf('--vendor-id');
      const msgIdx = cmdArgs.indexOf('--message');
      const live = cmdArgs.includes('--execute');
      if (vidIdx === -1 || msgIdx === -1) {
        console.error('Usage: text-vendor --vendor-id <id> --message <text> [--execute]');
        process.exit(1);
      }
      const vendorId = cmdArgs[vidIdx + 1];
      const msg = cmdArgs.slice(msgIdx + 1).filter(a => a !== '--execute').join(' ');
      if (!vendorId || !msg) {
        console.error('text-vendor: --vendor-id and --message are required');
        process.exit(1);
      }
      const result = await textVendor(vendorId, msg, live);
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

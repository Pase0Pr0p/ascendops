/**
 * crash-alert.ts — Daemon-side crash-loop detector and Telegram alerter.
 *
 * Runs entirely within the daemon process — fires even when the agent session
 * is dead. Reads BOT_TOKEN + CHAT_ID from the agent's .env file directly.
 *
 * Trigger: N restarts within a rolling time window (default: 3 / 10 min).
 * Debounce: suppress repeat alerts for the same agent within 30 min.
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from 'https';

export const ALERT_CRASH_THRESHOLD = 3;
export const ALERT_WINDOW_MS = 10 * 60 * 1000;    // 10 minutes
export const ALERT_DEBOUNCE_MS = 30 * 60 * 1000;  // 30 minutes

/**
 * Stateful rolling-window crash-loop detector for one agent.
 * Instantiate once per AgentProcess; keep alive for the agent's lifetime.
 */
export class CrashLoopDetector {
  private timestamps: number[] = [];
  private lastAlertAt: number = -Infinity;

  constructor(
    readonly threshold = ALERT_CRASH_THRESHOLD,
    readonly windowMs = ALERT_WINDOW_MS,
    readonly debounceMs = ALERT_DEBOUNCE_MS,
  ) {}

  /**
   * Record one crash event. Returns true if an alert should fire.
   * Prunes stale timestamps, checks threshold, applies debounce.
   *
   * @param now  Override for current time (tests only).
   */
  recordCrash(now = Date.now()): boolean {
    this.timestamps.push(now);
    this.timestamps = this.timestamps.filter(t => now - t <= this.windowMs);

    if (this.timestamps.length < this.threshold) return false;
    if (now - this.lastAlertAt < this.debounceMs) return false;

    this.lastAlertAt = now;
    return true;
  }

  /**
   * Number of crash timestamps currently within the window.
   * Useful for composing the alert message.
   *
   * @param now  Override for current time (tests only).
   */
  recentCount(now = Date.now()): number {
    return this.timestamps.filter(t => now - t <= this.windowMs).length;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function readEnvVar(envPath: string, key: string): string | null {
  try {
    if (!existsSync(envPath)) return null;
    for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      if (trimmed.slice(0, eq).trim() === key) {
        return trimmed.slice(eq + 1).trim() || null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function telegramPost(botToken: string, chatId: string, text: string): Promise<void> {
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: chatId, text });
    const req = request(
      {
        hostname: 'api.telegram.org',
        port: 443,
        path: `/bot${botToken}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume(); // drain response; we don't inspect it
        resolve();
      },
    );
    req.on('error', () => resolve()); // never throw — safety system must not fault
    req.setTimeout(10_000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface CrashAlertOpts {
  /** Absolute path to the agent's .env file (BOT_TOKEN + CHAT_ID). */
  agentEnvPath: string;
  agentName: string;
  org: string;
  /** Number of crashes in the recent window (for the message body). */
  recentCount: number;
  log: (msg: string) => void;
  /** Override the Telegram POST implementation (tests only). */
  _telegramPost?: (botToken: string, chatId: string, text: string) => Promise<void>;
}

export interface AuthFailureAlertOpts {
  /** Absolute path to the triggering agent's .env (BOT_TOKEN + CHAT_ID for fallback). */
  agentEnvPath: string;
  /** Absolute path to the org secrets.env (FLEET_ALERT_SENDER_AGENT + FLEET_ALERT_CHAT_IDS). */
  orgSecretsPath: string;
  /** Root dir of all agents (e.g. ~/.cortextos/<instance>/orgs/<org>/agents/) — used to
   *  resolve the sender agent's .env path from FLEET_ALERT_SENDER_AGENT. */
  agentsDir: string;
  /** Instance-level state directory for the fleet debounce marker. */
  instanceStateDir: string;
  agentName: string;
  log: (msg: string) => void;
  /** Override Telegram POST (tests only). */
  _telegramPost?: (botToken: string, chatId: string, text: string) => Promise<void>;
  /** Override current time (tests only). */
  _now?: number;
}

/** Debounce window for fleet-wide auth-failure Telegram alerts (10 minutes). */
export const AUTH_ALERT_DEBOUNCE_MS = 10 * 60 * 1000;
/** Filename of the shared fleet debounce marker in instanceStateDir. */
export const AUTH_ALERT_MARKER = 'auth-failure-alert-at';

/**
 * Send a fleet-wide Telegram auth-failure alert.
 *
 * When CLAUDE_CODE_OAUTH_TOKEN expires the daemon detects it on the FIRST
 * agent exit and halts-fast (no backoff, no crash-budget burn). Every agent
 * hits the same bad token — this function fires ONE debounced Telegram so
 * operators are not hit with 7 identical messages.
 *
 * Recipient contract (reads from orgSecretsPath / secrets.env):
 *   FLEET_ALERT_SENDER_AGENT  — agent name whose BOT_TOKEN to send from
 *                               (default: "chief")
 *   FLEET_ALERT_CHAT_IDS      — comma-separated list of operator chat IDs
 *
 * Fallback: if either fleet key is absent, send via the triggering agent's
 * own BOT_TOKEN + CHAT_ID so the function stays testable without org secrets.
 *
 * Fire-and-forget safe — never throws.
 */
export async function sendAuthFailureAlert(opts: AuthFailureAlertOpts): Promise<void> {
  const { agentEnvPath, orgSecretsPath, agentsDir, instanceStateDir, agentName, log, _telegramPost } = opts;
  const post = _telegramPost ?? telegramPost;
  const now = opts._now ?? Date.now();

  // Fleet debounce: if another agent already sent this alert within the window,
  // skip Telegram but still allow the caller to write its per-agent .auth-failure
  // marker — each agent's halt state must be recorded regardless.
  const debounceMarker = join(instanceStateDir, AUTH_ALERT_MARKER);
  try {
    if (existsSync(debounceMarker)) {
      const ts = parseInt(readFileSync(debounceMarker, 'utf-8').trim(), 10);
      if (!isNaN(ts) && now - ts < AUTH_ALERT_DEBOUNCE_MS) {
        log(`auth-failure-alert: debounced — fleet alert already sent ${Math.round((now - ts) / 1000)}s ago`);
        return;
      }
    }
  } catch { /* non-critical — proceed to send */ }

  // Resolve sender bot token and recipient chat IDs.
  const senderAgent = readEnvVar(orgSecretsPath, 'FLEET_ALERT_SENDER_AGENT') ?? 'chief';
  const chatIdsRaw  = readEnvVar(orgSecretsPath, 'FLEET_ALERT_CHAT_IDS');

  let botToken: string | null = null;
  let chatIds: string[] = [];

  if (chatIdsRaw) {
    // Fleet config present: use sender agent's BOT_TOKEN
    const senderEnvPath = join(agentsDir, senderAgent, '.env');
    botToken = readEnvVar(senderEnvPath, 'BOT_TOKEN');
    chatIds = chatIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
    if (!botToken) {
      log(`auth-failure-alert: no BOT_TOKEN in ${senderEnvPath} — falling back to triggering agent`);
    }
  }

  // Fallback: use triggering agent's own creds (degrades gracefully, keeps unit tests working)
  if (!botToken || chatIds.length === 0) {
    botToken = readEnvVar(agentEnvPath, 'BOT_TOKEN');
    const fallbackChatId = readEnvVar(agentEnvPath, 'CHAT_ID');
    chatIds = fallbackChatId ? [fallbackChatId] : [];
  }

  if (!botToken || chatIds.length === 0) {
    log(`auth-failure-alert: no BOT_TOKEN/CHAT_ID available — skipping Telegram`);
    return;
  }

  const message =
    `AscendOps alert: ${agentName} — CLAUDE_CODE_OAUTH_TOKEN expired or invalid. ` +
    `Agent halted (restarting cannot fix this). ` +
    `Run: claude setup-token, then cortextos start ${agentName}`;

  log(`auth-failure-alert: sending fleet alert (triggered by ${agentName})`);
  // Write debounce marker BEFORE sending so concurrent agents racing this path skip
  try {
    writeFileSync(debounceMarker, String(now), 'utf-8');
  } catch (err) {
    log(`auth-failure-alert: failed to write debounce marker: ${err}`);
  }

  for (const chatId of chatIds) {
    try {
      await post(botToken, chatId, message);
    } catch { /* swallow — alert failure must never propagate */ }
  }
  log(`auth-failure-alert: sent to ${chatIds.length} recipient(s)`);
}

/**
 * Send a Telegram crash-loop alert for one agent.
 * Reads BOT_TOKEN and CHAT_ID from the agent's .env file.
 * Fire-and-forget safe — never throws.
 */
export async function sendCrashLoopAlert(opts: CrashAlertOpts): Promise<void> {
  const { agentEnvPath, agentName, org, recentCount, log, _telegramPost } = opts;
  const post = _telegramPost ?? telegramPost;

  const botToken = readEnvVar(agentEnvPath, 'BOT_TOKEN');
  const chatId   = readEnvVar(agentEnvPath, 'CHAT_ID');

  if (!botToken || !chatId) {
    log(`crash-alert: no BOT_TOKEN/CHAT_ID in ${agentEnvPath} — skipping alert`);
    return;
  }

  const message =
    `AscendOps alert: ${agentName} restarted ${recentCount}x in 10min, possible crash loop. ` +
    `See orgs/${org}/RECOVERY.md`;

  log(`crash-alert: sending Telegram alert for ${agentName}`);
  try {
    await post(botToken, chatId, message);
    log(`crash-alert: alert sent for ${agentName}`);
  } catch {
    // swallow — alert failure must never propagate into crash recovery
  }
}

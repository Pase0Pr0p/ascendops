/**
 * crash-alert.ts — Daemon-side crash-loop detector and Telegram alerter.
 *
 * Runs entirely within the daemon process — fires even when the agent session
 * is dead. Reads BOT_TOKEN + CHAT_ID from the agent's .env file directly.
 *
 * Trigger: N restarts within a rolling time window (default: 3 / 10 min).
 * Debounce: suppress repeat alerts for the same agent within 30 min.
 */

import { existsSync, readFileSync } from 'fs';
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

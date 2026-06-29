import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  CrashLoopDetector,
  ALERT_CRASH_THRESHOLD,
  ALERT_WINDOW_MS,
  ALERT_DEBOUNCE_MS,
  sendCrashLoopAlert,
} from '../../../src/daemon/crash-alert.js';

// ---------------------------------------------------------------------------
// CrashLoopDetector — unit tests (no I/O)
// ---------------------------------------------------------------------------

describe('CrashLoopDetector', () => {
  describe('recordCrash - threshold', () => {
    it('returns false when crash count is below threshold', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      expect(det.recordCrash(now)).toBe(false);      // 1 crash
      expect(det.recordCrash(now + 1000)).toBe(false); // 2 crashes
    });

    it('returns true at threshold (3rd crash within window)', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      det.recordCrash(now);
      det.recordCrash(now + 1000);
      expect(det.recordCrash(now + 2000)).toBe(true); // 3rd crash — alert
    });

    it('returns false for crashes beyond threshold if still within debounce', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      det.recordCrash(now);
      det.recordCrash(now + 1000);
      det.recordCrash(now + 2000); // alert fires
      expect(det.recordCrash(now + 3000)).toBe(false); // 4th — debounced
      expect(det.recordCrash(now + 4000)).toBe(false); // 5th — still debounced
    });
  });

  describe('recordCrash - debounce', () => {
    it('suppresses re-alert within debounce window', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      det.recordCrash(now);
      det.recordCrash(now + 1000);
      det.recordCrash(now + 2000); // fires alert

      // Three more crashes 1 min later — still within 30 min debounce
      const later = now + 60_000;
      det.recordCrash(later);
      det.recordCrash(later + 1000);
      expect(det.recordCrash(later + 2000)).toBe(false); // debounced
    });

    it('fires again after debounce window expires', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      det.recordCrash(now);
      det.recordCrash(now + 1000);
      det.recordCrash(now + 2000); // 1st alert

      // 31 minutes later — debounce expired, window also reset
      const afterDebounce = now + ALERT_DEBOUNCE_MS + 60_000;
      det.recordCrash(afterDebounce);
      det.recordCrash(afterDebounce + 1000);
      expect(det.recordCrash(afterDebounce + 2000)).toBe(true); // new alert
    });
  });

  describe('recordCrash - window pruning', () => {
    it('does not count crashes outside the rolling window', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const old = 1_000_000;
      det.recordCrash(old);                              // will be outside window
      det.recordCrash(old + 1000);                       // will be outside window

      // Jump forward past the 10 min window — those old timestamps are pruned
      const now = old + ALERT_WINDOW_MS + 1000;
      det.recordCrash(now);          // 1st fresh crash
      det.recordCrash(now + 1000);   // 2nd — not enough for alert
      expect(det.recordCrash(now + 2000)).toBe(true); // 3rd — threshold met
    });

    it('old crash + 2 new does not trigger (only 2 in window)', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const old = 1_000_000;
      det.recordCrash(old);                              // expires before window

      const now = old + ALERT_WINDOW_MS + 1000;
      det.recordCrash(now);
      expect(det.recordCrash(now + 1000)).toBe(false);  // only 2 in window
    });
  });

  describe('recentCount', () => {
    it('returns count of crashes within the window', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const now = 1_000_000;
      det.recordCrash(now);
      det.recordCrash(now + 1000);
      det.recordCrash(now + 2000);
      expect(det.recentCount(now + 3000)).toBe(3);
    });

    it('excludes expired timestamps', () => {
      const det = new CrashLoopDetector(3, ALERT_WINDOW_MS, ALERT_DEBOUNCE_MS);
      const old = 1_000_000;
      det.recordCrash(old);
      det.recordCrash(old + 1000);
      const now = old + ALERT_WINDOW_MS + 5000;
      det.recordCrash(now);
      // recentCount queries at `now` — only the 3rd crash is in-window
      expect(det.recentCount(now)).toBe(1);
    });
  });
});

// ---------------------------------------------------------------------------
// sendCrashLoopAlert — integration-level (file I/O, mocked https)
// ---------------------------------------------------------------------------

describe('sendCrashLoopAlert', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `crash-alert-test-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('skips alert when .env is missing', async () => {
    const log = vi.fn();
    await sendCrashLoopAlert({
      agentEnvPath: join(tmpDir, 'missing.env'),
      agentName: 'chief',
      org: 'paseo-pm',
      recentCount: 3,
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping alert'));
  });

  it('skips alert when BOT_TOKEN is absent from .env', async () => {
    writeFileSync(join(tmpDir, '.env'), 'CHAT_ID=123456\n', 'utf-8');
    const log = vi.fn();
    await sendCrashLoopAlert({
      agentEnvPath: join(tmpDir, '.env'),
      agentName: 'chief',
      org: 'paseo-pm',
      recentCount: 3,
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping alert'));
  });

  it('skips alert when CHAT_ID is absent from .env', async () => {
    writeFileSync(join(tmpDir, '.env'), 'BOT_TOKEN=bot:abc\n', 'utf-8');
    const log = vi.fn();
    await sendCrashLoopAlert({
      agentEnvPath: join(tmpDir, '.env'),
      agentName: 'chief',
      org: 'paseo-pm',
      recentCount: 3,
      log,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipping alert'));
  });

  it('logs send attempt when both BOT_TOKEN and CHAT_ID are present', async () => {
    writeFileSync(join(tmpDir, '.env'), 'BOT_TOKEN=bot:abc\nCHAT_ID=999\n', 'utf-8');
    const mockPost = vi.fn().mockResolvedValue(undefined);
    const log = vi.fn();
    await sendCrashLoopAlert({
      agentEnvPath: join(tmpDir, '.env'),
      agentName: 'chief',
      org: 'paseo-pm',
      recentCount: 3,
      log,
      _telegramPost: mockPost,
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('sending Telegram alert'));
    expect(log).toHaveBeenCalledWith(expect.stringContaining('alert sent'));
    expect(mockPost).toHaveBeenCalledWith(
      'bot:abc',
      '999',
      expect.stringContaining('chief'),
    );
  });

  it('alert message names the agent and points to RECOVERY.md', async () => {
    writeFileSync(join(tmpDir, '.env'), 'BOT_TOKEN=bot:abc\nCHAT_ID=999\n', 'utf-8');
    const mockPost = vi.fn().mockResolvedValue(undefined);
    await sendCrashLoopAlert({
      agentEnvPath: join(tmpDir, '.env'),
      agentName: 'scout',
      org: 'paseo-pm',
      recentCount: 4,
      log: vi.fn(),
      _telegramPost: mockPost,
    });
    const [, , text] = mockPost.mock.calls[0] as [string, string, string];
    expect(text).toContain('scout');
    expect(text).toContain('4x');
    expect(text).toContain('RECOVERY.md');
  });
});

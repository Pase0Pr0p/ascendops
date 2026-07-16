import { appendFileSync, existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'fs';
import { join, sep } from 'path';
import { homedir } from 'os';
import type { AgentConfig, AgentStatus, CtxEnv } from '../types/index.js';
import { AgentPTY } from '../pty/agent-pty.js';
import { CodexAppServerPTY } from '../pty/codex-app-server-pty.js';
import { HermesPTY, hermesDbExists } from '../pty/hermes-pty.js';
import { MessageDedup, injectMessage } from '../pty/inject.js';
import type { TelegramAPI } from '../telegram/api.js';
import { ensureDir } from '../utils/atomic.js';
import { writeCortextosEnv } from '../utils/env.js';
import { getOverdueReminders } from '../bus/reminders.js';
import { resolvePaths } from '../utils/paths.js';
import {
  findGitRoot,
  recordFailure,
  markHealthy,
  shouldRollback,
  performRollback,
  readRecoveryNote,
  deleteRecoveryNote,
  MIN_HEALTHY_SECONDS,
} from './watchdog.js';
import { CrashLoopDetector, sendCrashLoopAlert, sendAuthFailureAlert } from './crash-alert.js';
type LogFn = (msg: string) => void;
type StartOptions = { partOfFleetStart?: boolean };

/**
 * Manages a single agent's lifecycle.
 * Replaces agent-wrapper.sh for one agent.
 */
export class AgentProcess {
  readonly name: string;
  private env: CtxEnv;
  private config: AgentConfig;
  private pty: AgentPTY | CodexAppServerPTY | null = null;
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  private crashCount: number = 0;
  private maxCrashesPerDay: number = 10;
  // CrashLoopPauser (instar-inspired): sliding-window crash detection.
  // Timestamps of recent crashes within the configured window. If the
  // window fills, the agent auto-pauses instead of retrying with backoff.
  private crashTimestamps: number[] = [];
  private crashWindowMs: number = 0;
  private crashWindowMax: number = 0;
  private sessionStart: Date | null = null;
  private status: AgentStatus['status'] = 'stopped';
  private stopping: boolean = false;
  // BUG-040 fix: persists across stop() return until handleExit clears it.
  // Required because BUG-032's CRLF + 5s wait can cause graceful shutdown to
  // exceed the 5s Promise.race timeout in stop(), which would otherwise reset
  // `stopping=false` BEFORE the PTY actually exits, then handleExit would fire
  // with stopping=false and trigger spurious crash recovery (a partial regression
  // of BUG-011). stopRequested survives the timeout and is only cleared either
  // by handleExit when an intentional exit fires, or by start() at the beginning
  // of a new lifecycle.
  private stopRequested: boolean = false;
  // BUG-040 fix: monotonic generation counter incremented on each successful
  // start(). Each PTY's onExit closure captures the generation at spawn time
  // and bails out if the generation doesn't match — i.e. a NEW PTY has been
  // spawned since this old one was created. Without this guard, a late exit
  // from an old PTY can race past stopRequested and trigger crash recovery on
  // the new agent.
  private lifecycleGeneration: number = 0;
  // BUG-011 fix: stop() awaits this promise (resolved by the onExit handler in start())
  // to guarantee the PTY exit has fired before stopping=false is reset. Without
  // this, the exit handler can fire after stopping=false and trigger spurious
  // crash recovery for an agent we just stopped intentionally.
  private exitPromise: Promise<void> | null = null;
  private resolveExit: (() => void) | null = null;
  private dedup: MessageDedup;
  private log: LogFn;
  private onStatusChange: ((status: AgentStatus) => void) | null = null;
  // Watchdog: git repo root for crash-loop detection and rollback
  private repoRoot: string | null = null;
  // Crash-loop alert: rolling-window detector, independent of crashWindowMs config
  private crashLoopDetector = new CrashLoopDetector();
  // Watchdog: timer to mark the current commit healthy after MIN_HEALTHY_SECONDS
  private healthTimer: ReturnType<typeof setTimeout> | null = null;
  // Rate-limit recovery: pending restart timer. Stored so it can be cancelled
  // if a second rate-limit exit fires before the first timer elapses (preventing
  // two overlapping timers from racing and triggering a premature restart).
  private rateLimitTimer: ReturnType<typeof setTimeout> | null = null;
  // Issue #330: held here so CodexAppServerPTY can be re-wired across session refresh
  // (each start() recreates the PTY, but the Telegram handle persists).
  private telegramApi: TelegramAPI | null = null;
  private telegramChatId: string | null = null;
  // Issue #392: tracks whether the most recently built startup prompt consumed
  // a handoff doc marker. start() reads this after spawn to decide whether the
  // daemon should fire the codex-app-server back-online Telegram directly
  // (skipped on handoff restart — the agent sends its own contextual reply).
  private lastSpawnWasHandoff = false;

  constructor(name: string, env: CtxEnv, config: AgentConfig, log?: LogFn) {
    this.name = name;
    this.env = env;
    this.config = config;
    if (config.max_crashes_per_day !== undefined) {
      this.maxCrashesPerDay = config.max_crashes_per_day;
    }
    if (config.crash_window?.seconds) {
      this.crashWindowMs = config.crash_window.seconds * 1000;
      this.crashWindowMax = config.crash_window.max_crashes ?? 3;
    }
    this.dedup = new MessageDedup();
    this.log = log || ((msg) => console.log(`[${name}] ${msg}`));

    // Resolve the git root once at construction time. Used by the watchdog for
    // commit-stability tracking and rollback. Null if not inside a git repo.
    const agentDir = env.agentDir;
    if (agentDir) {
      this.repoRoot = findGitRoot(agentDir);
    }
  }

  /**
   * Start the agent. Spawns Claude Code in a PTY.
   */
  async start(options: StartOptions = {}): Promise<void> {
    if (this.status === 'running') {
      this.log('Already running');
      return;
    }

    // Apply startup delay
    const delay = this.config.startup_delay || 0;
    if (delay > 0) {
      this.log(`Startup delay: ${delay}s`);
      await sleep(delay * 1000);
    }

    // Write .cortextos-env for backward compat (D6)
    if (this.env.agentDir) {
      writeCortextosEnv(this.env.agentDir, this.env);
    }

    // Determine start mode
    const mode = this.shouldContinue() ? 'continue' : 'fresh';
    // Read the recovery note and rate-limit marker before building the prompt
    // but do NOT delete them yet. Both are deleted only after pty.spawn() succeeds
    // so that a spawn failure doesn't permanently swallow the recovery context
    // (mirrors the watchdog Bug-1 fix pattern).
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const recoveryNote = readRecoveryNote(stateDir);
    const hadRateLimit = this.hasRateLimitMarker(stateDir);
    const prompt = mode === 'fresh'
      ? this.buildStartupPrompt(recoveryNote, options)
      : this.buildContinuePrompt(recoveryNote, options);

    this.log(`Starting in ${mode} mode`);
    this.status = 'starting';

    // BUG-040 fix: clear any stale stop request from a previous lifecycle
    // (e.g. if the previous stop() timed out before the PTY actually exited).
    // We're starting fresh — the new PTY has no pending stop.
    this.stopRequested = false;
    // BUG-040 fix: bump generation. The onExit closure below captures THIS
    // value and uses it to detect "I'm an old PTY whose exit fired after a
    // new lifecycle began" — in which case it bails out without touching
    // handleExit, preventing spurious crash recovery on the new agent.
    const myGeneration = ++this.lifecycleGeneration;

    // Create PTY — runtime-specific subclass handles binary, args, bootstrap detection
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    ensureDir(join(this.env.ctxRoot, 'logs', this.name));
    this.log(`Log path: ${logPath}`);
    this.pty = this.config.runtime === 'hermes'
      ? new HermesPTY(this.env, this.config, logPath)
      : this.config.runtime === 'codex-app-server'
        ? new CodexAppServerPTY(this.env, this.config, logPath)
        : new AgentPTY(this.env, this.config, logPath);

    // Issue #330: re-wire the Telegram handle on every start() (session refresh
    // creates a fresh CodexAppServerPTY). Only CodexAppServerPTY uses this — Claude / Hermes
    // typing indicators flow through fast-checker.
    if (this.config.runtime === 'codex-app-server' && this.telegramApi && this.telegramChatId) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(this.telegramApi, this.telegramChatId);
    }

    // BUG-011 fix: create a fresh exit signal for this run. resolveExit is
    // called from the onExit handler below; stop() awaits exitPromise to
    // guarantee the exit handler has fired before clearing stopping.
    this.exitPromise = new Promise<void>((resolve) => {
      this.resolveExit = resolve;
    });

    // Handle exit
    this.pty.onExit((exitCode, signal) => {
      // BUG-040 fix: if the lifecycle has moved on (a new start() incremented
      // the generation since this PTY was spawned), this is an old PTY's late
      // exit. Ignore it entirely — we don't want it to trigger handleExit on
      // the current PTY's state.
      if (myGeneration !== this.lifecycleGeneration) {
        this.log(`Ignoring late exit from previous lifecycle gen ${myGeneration} (current: ${this.lifecycleGeneration})`);
        return;
      }
      this.log(`Exited with code ${exitCode} signal ${signal}`);
      this.handleExit(exitCode);
      // Signal anyone awaiting this PTY's exit (e.g. stop() — BUG-011 fix)
      this.resolveExit?.();
      this.resolveExit = null;
    });

    try {
      await this.pty.spawn(mode, prompt);
      // Codex exec-per-turn race: the new PTY's onExit can fire BEFORE this
      // line if `codex exec` completes its prompt quickly (CodexAppServerPTY's spawn
      // resolves once exec is launched, but the process may exit moments
      // later as it finishes the bootstrap turn). handleExit() nulls
      // this.pty and schedules crash recovery — we must not claim 'running'
      // or call getPid() on null in that window.
      if (!this.pty) {
        this.log('PTY exited during spawn — handleExit will recover');
        return;
      }
      this.status = 'running';
      this.sessionStart = new Date();
      this.log(`Running (pid: ${this.pty.getPid()})`);

      // Delete markers only after spawn succeeds so a spawn failure doesn't
      // permanently lose the recovery context (Bug-1 fix pattern).
      if (recoveryNote) deleteRecoveryNote(stateDir);
      if (hadRateLimit) this.deleteRateLimitMarker(stateDir);
      // Clear auth-failure marker so a later unrelated HALT doesn't inherit
      // the stale "token expired" message after the operator fixed the token.
      try { const m = join(stateDir, '.auth-failure'); if (existsSync(m)) unlinkSync(m); } catch { /* non-critical */ }

      // Issue #392: codex-app-server does not reliably execute the inline
      // "Send a Telegram message saying you are back online" instruction the
      // way claude-code does, so fire the back-online ping directly from the
      // daemon for that runtime. Skipped on handoff restart — the agent
      // sends its own contextual "back — ..." reply in that case.
      this.maybeSendCodexBootNotification(options);

      // Start session timer
      this.startSessionTimer();

      // Start watchdog health timer — marks commit healthy after MIN_HEALTHY_SECONDS
      this.startHealthTimer();

      this.notifyStatusChange();
    } catch (err) {
      // Surface startup failures to the caller. Previously this catch only
      // logged + flipped status to 'crashed' and returned silently, so
      // AgentManager.startAgent() couldn't tell apart a successful spawn
      // from a dead one and would proceed to wire crons / fast-checker /
      // Telegram pollers against a process that never reached running.
      // Throwing here lets startAgent abort the secondary wiring.
      this.log(`Failed to start: ${err}`);
      this.status = 'crashed';
      this.notifyStatusChange();
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  /**
   * Stop the agent gracefully.
   */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    // BUG-040 fix: stopRequested persists ACROSS stop()'s return until
    // handleExit clears it. This is the safety net for the case where the
    // PTY exits later than the Promise.race timeout below.
    this.stopRequested = true;
    this.log('Stopping...');
    this.clearSessionTimer();
    this.clearHealthTimer();

    // Capture and null out pty BEFORE any awaits so handleExit() during graceful
    // shutdown doesn't race with us and trigger crash recovery or a double-kill.
    const pty = this.pty;
    this.pty = null;
    // Capture the exit promise before any awaits — we'll wait on this AFTER
    // pty.kill() to guarantee the exit handler has run before stopping=false.
    const exitPromise = this.exitPromise;

    if (pty) {
      try {
        if (this.config.runtime === 'hermes') {
          // Hermes REPL exit: Ctrl+D is the clean exit signal.
          // Hermes has a double-tap guard on Ctrl+C (accidental exit protection),
          // so we use Ctrl+D which exits cleanly on the first press.
          pty.write('\x04'); // Ctrl+D
          await sleep(3000);
        } else if (this.config.runtime === 'codex-app-server') {
          // Codex uses an exec-per-turn model — there is no persistent REPL
          // between turns, so /exit + sleep below are no-ops on CodexAppServerPTY
          // (write() just buffers). The only meaningful stop step is
          // pty.kill(), which terminates the in-flight `codex exec` (if any)
          // and flips _alive=false. Skipping the 6s Claude-REPL dance makes
          // `bus hard-restart` feel responsive instead of appearing to do
          // nothing for several seconds.
        } else {
          // BUG-032 fix: use CRLF (not lone CR) so Claude Code's REPL actually
          // recognizes the /exit line as a complete command, AND wait long
          // enough (5s, was 3s) for the child to flush + exit cleanly. Without
          // these the child often dies from SIGHUP (exit code 129) when the
          // PTY is torn down before /exit has been processed. PR #11's
          // BUG-011 fix already ensured the daemon doesn't misinterpret 129
          // as a real crash, but the underlying graceful-shutdown sequence
          // still wasn't graceful — this PR makes it so.
          pty.write('\x03'); // Ctrl-C
          await sleep(1000);
          pty.write('/exit\r\n');
          await sleep(5000);
        }
      } catch (err) {
        // A failed Ctrl-C / /exit write means the graceful shutdown sequence
        // didn't actually complete; we'll fall through to pty.kill() below.
        // Log it so an operator at least sees that the kill path was forced.
        this.log(`shutdown write failed (falling through to kill): ${err instanceof Error ? err.message : String(err)}`);
      }
      // BUG-032 follow-up: only kill the PTY if the process is still alive.
      // After /exit + 5s wait, the child has usually exited cleanly. Calling
      // pty.kill() on an already-exited PTY tears down the file descriptor,
      // which can send SIGHUP (exit code 129) to a process that was in the
      // middle of flushing. Polling first eliminates the remaining SIGHUP risk.
      if (pty.isAlive()) {
        try {
          pty.kill();
        } catch {
          // PTY may have exited between the check and the kill — ignore
        }
      }

      // BUG-011 fix: AWAIT the exit handler before resolving stop().
      // BUG-040 fix: bumped timeout from 5s to 15s to give the PTY plenty of
      // time to exit cleanly even when BUG-032's slow graceful shutdown stacks
      // on top of pty.kill() lag. The functional correctness no longer depends
      // on this timeout (stopRequested handles late exits), but a generous
      // timeout reduces "Ignoring late exit from previous lifecycle" log noise.
      if (exitPromise) {
        await Promise.race([exitPromise, sleep(15000)]);
      }
    }

    this.stopping = false;
    // NOTE: this.stopRequested is intentionally NOT cleared here. It is
    // cleared by handleExit when the intentional exit fires (or by start()
    // when a new lifecycle begins). See BUG-040 fix in handleExit().
    this.status = 'stopped';
    this.notifyStatusChange();
    this.log('Stopped');
  }

  /**
   * Hard-restart (fresh session, no --continue).
   * Writes the force-fresh marker, then stop()+start(). shouldContinue() sees
   * the marker on next start and boots fresh.
   */
  async hardRestartSelf(reason: string): Promise<void> {
    // HALTED is terminal for automated restarts. Without this guard, the
    // fast-checker can keep triggering hard-restarts after the crash limit
    // is hit (observed 2026-05-10: restarts.log climbed past max_crashes
    // because watchdog signals fired regardless of halt state). User-initiated
    // restarts should clear status first via `cortextos start <name>`.
    if (this.status === 'halted' || this.status === 'stopped') {
      this.log(`Refusing hard-restart in status=${this.status}: ${reason}`);
      return;
    }
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      writeFileSync(join(stateDir, '.force-fresh'), reason + '\n', 'utf-8');
      writeFileSync(join(stateDir, '.restart-planned'), reason + '\n', 'utf-8');
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      appendFileSync(
        join(logDir, 'restarts.log'),
        `[${new Date().toISOString()}] WATCHDOG-HARD-RESTART: ${reason}\n`,
      );
    } catch (e) {
      this.log(`Failed to write restart markers: ${e}`);
    }
    this.log(`Hard-restart initiated: ${reason}`);
    await this.stop();
    await this.start();
  }

  /**
   * Restart with --continue (session refresh).
   *
   * Delegates to stop() + start() so it inherits the BUG-011 race fix
   * automatically. This also eliminates a separate bug in the previous
   * inline implementation where the OLD pty's exit handler could fire
   * AFTER the NEW pty was set up, nulling out the wrong reference.
   * `start()` will pick up `continue` mode automatically because the
   * conversation directory still has .jsonl files (shouldContinue() is true).
   */
  async sessionRefresh(): Promise<void> {
    if (this.status === 'halted' || this.status === 'stopped') {
      this.log(`Refusing session refresh in status=${this.status}`);
      return;
    }
    this.log('Session refresh (--continue restart)');
    // Write .session-refresh marker so the SessionEnd crash-alert hook
    // (src/hooks/hook-crash-alert.ts) classifies the imminent PTY exit as a
    // session refresh rather than a crash. The hook's marker handler +
    // quiet-suppression set + message switch were all wired for this type,
    // but no writer existed — every --continue rollover at the session-time
    // cap surfaced as a false-positive 'crash' on chief/analyst + the
    // crashes.log file.
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      writeFileSync(
        join(paths.stateDir, '.session-refresh'),
        'session-time-cap rollover\n',
        'utf-8',
      );
    } catch (err) {
      this.log(`Failed to write .session-refresh marker: ${err}`);
    }
    await this.stop();
    await this.start();
    this.log('Session refreshed');
  }

  /**
   * Inject a message into the agent's PTY — structured outcome.
   *
   * Distinguishes NOT_RUNNING (agent registered but no live PTY) from
   * DEDUPED (content collapsed against the in-process MessageDedup window).
   * See issue #346 — both used to surface as a bare `false` and got mistaken
   * for "agent not found" by operators investigating restart/cron failures.
   */
  injectMessageDetailed(content: string): { ok: true } | { ok: false; code: 'NOT_RUNNING' | 'DEDUPED'; message: string } {
    if (!this.pty || this.status !== 'running') {
      return { ok: false, code: 'NOT_RUNNING', message: `agent "${this.name}" is registered but not running (status: ${this.status})` };
    }

    if (this.dedup.isDuplicate(content)) {
      this.log('Dedup: skipping duplicate message');
      return { ok: false, code: 'DEDUPED', message: `inject for "${this.name}" deduped — content matches MessageDedup hash window` };
    }

    injectMessage((data) => this.pty?.write(data), content);
    return { ok: true };
  }

  /**
   * Inject a message into the agent's PTY (back-compat boolean wrapper).
   * New callers that need to distinguish DEDUPED from NOT_RUNNING should use
   * `injectMessageDetailed()` instead.
   */
  injectMessage(content: string): boolean {
    return this.injectMessageDetailed(content).ok;
  }

  /**
   * Check if the agent has bootstrapped (ready for messages).
   */
  isBootstrapped(): boolean {
    return this.pty?.getOutputBuffer().isBootstrapped() ?? false;
  }

  /**
   * Get current agent status.
   */
  getStatus(): AgentStatus {
    // Liveness reconciliation: if cached status is 'running' but the
    // underlying OS process is gone, surface 'crashed' instead. This catches
    // silent-PTY-death paths where the codex-cli child exited but the
    // PTY-layer onExit event never fired (observed 2026-05-10: codie went
    // silent at 18:40 UTC, codex process disappeared from ps, this.pty +
    // _alive stayed true, `cortextos status` reported stale 'running pid'
    // until daemon restart).
    //
    // We probe the actual OS pid with signal 0 instead of trusting
    // pty.isAlive() — _alive is a JS field that flips on the onExit event,
    // which is exactly the event that fails to fire in the silent-death
    // case. Signal 0 is the canonical "does this pid exist" check on POSIX.
    //
    // Important: do NOT downgrade when this.pty is null. handleExit() nulls
    // this.pty in shutdown / daemon-stop / stop-requested paths where the
    // existing semantics keep status === 'running' on purpose (the PTY is
    // going to be respawned on the next start() and dashboards should not
    // flap to 'crashed' in that window). Only act when we have a pid we
    // can probe and the probe fails.
    let reportedStatus = this.status;
    if (reportedStatus === 'running' && this.pty) {
      const pid = this.pty.getPid();
      if (pid && pid > 0) {
        let alive = true;
        try {
          process.kill(pid, 0);
        } catch (err) {
          // EPERM = process exists but we lack permission; treat as alive
          // ESRCH = no such process — actually dead
          alive = (err as NodeJS.ErrnoException).code === 'EPERM';
        }
        if (!alive) {
          reportedStatus = 'crashed';
        }
      }
    }
    return {
      name: this.name,
      status: reportedStatus,
      pid: this.pty?.getPid() || undefined,
      uptime: this.sessionStart
        ? Math.floor((Date.now() - this.sessionStart.getTime()) / 1000)
        : undefined,
      sessionStart: this.sessionStart?.toISOString(),
      crashCount: this.crashCount,
      model: this.config.model,
    };
  }

  /**
   * Register a status change handler.
   */
  onStatusChanged(handler: (status: AgentStatus) => void): void {
    this.onStatusChange = handler;
  }

  /**
   * Wire the agent's Telegram bot handle. Used by CodexAppServerPTY (issue #330) to
   * fire sendChatAction directly from the JSONL stream. Safe to call before
   * or after start() — the handle is re-applied on every PTY (re)spawn.
   */
  setTelegramHandle(api: TelegramAPI, chatId: string): void {
    this.telegramApi = api;
    this.telegramChatId = chatId;
    if (this.config.runtime === 'codex-app-server' && this.pty) {
      (this.pty as CodexAppServerPTY).setTelegramHandle(api, chatId);
    }
  }

  /**
   * Write raw data to the agent's PTY.
   * Used for TUI navigation (key sequences).
   */
  write(data: string): void {
    if (this.pty) {
      this.pty.write(data);
    }
  }

  /**
   * Get the output buffer for reading agent output.
   */
  getOutputBuffer() {
    return this.pty?.getOutputBuffer();
  }

  // --- Private methods ---

  /**
   * Read the tail of this agent's stdout.log without loading the whole file.
   * Used by handleExit() to inspect recent output for known-crash signatures
   * (e.g. the image-poison API 400 pattern) so it can decide whether the
   * exit is a real crash or a recoverable upstream artifact.
   *
   * Returns an empty string if the log doesn't exist or can't be read.
   */
  private tailStdoutLog(maxBytes: number): string {
    const logPath = join(this.env.ctxRoot, 'logs', this.name, 'stdout.log');
    try {
      if (!existsSync(logPath)) return '';
      const stats = statSync(logPath);
      const start = Math.max(0, stats.size - maxBytes);
      const len = stats.size - start;
      // Synchronous read of the tail; small and bounded so the cost is fine
      // even in the exit handler.
      const fd = require('fs').openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(len);
        const read = require('fs').readSync(fd, buf, 0, len, start);
        return buf.toString('utf-8', 0, read);
      } finally {
        require('fs').closeSync(fd);
      }
    } catch {
      return '';
    }
  }

  /**
   * Match the API 400 image-poison signature in recent stdout.
   *
   * Two variants observed in Anthropic's Messages API responses:
   *   `API Error: 400 messages.N.content.M.image.source.base64.data: Image format image/<fmt> not supported`
   *   `API Error: 400 ... image.source.base64.data: ...`
   *
   * Matching the prefix `image.source.base64` is robust to wording changes
   * in Anthropic's error string; matching `image format image/<fmt>` is the
   * confirmed exact wording today and gives a second signal. Either is enough.
   */
  private detectImagePoisonCrash(recentOutput: string): boolean {
    if (!recentOutput) return false;
    if (recentOutput.includes('API Error: 400') && recentOutput.includes('image.source.base64')) {
      return true;
    }
    if (/image format image\/[a-z]+ not supported/i.test(recentOutput)) {
      return true;
    }
    return false;
  }

  /**
   * Write the `.force-fresh` marker that AgentProcess.shouldContinue() reads
   * on the next start() to force a fresh Claude Code session (no --continue).
   * Used by the image-poison auto-recovery in handleExit().
   */
  private armForceFresh(reason: string): void {
    try {
      const stateDir = join(this.env.ctxRoot, 'state', this.name);
      ensureDir(stateDir);
      const markerPath = join(stateDir, '.force-fresh');
      writeFileSync(markerPath, `${new Date().toISOString()} ${reason}\n`, 'utf-8');
    } catch (err) {
      this.log(`Failed to arm .force-fresh marker: ${err}`);
    }
  }

  private handleExit(exitCode: number): void {
    // Capture the output buffer BEFORE nulling this.pty — needed for rate-limit
    // detection below (hasRateLimitSignature reads from the buffer).
    const outputBuffer = this.pty?.getOutputBuffer();
    // Capture last 16KB of the agent's stdout BEFORE nulling pty.
    // Used by the image-poison auto-recovery check below — reads the log
    // file so this works even if the PTY buffer has already been GC'd.
    const recentOutput = this.tailStdoutLog(16384);

    this.pty = null;
    this.clearSessionTimer();
    this.clearHealthTimer();

    // When the cortextos daemon is shut down by PM2, SIGTERM propagates to
    // the whole process group and reaches each PTY's Claude Code child
    // BEFORE the daemon's stopAll() loop has a chance to call stopAgent() on
    // it. Those children exit cleanly (code 0) but arrive at handleExit with
    // stopRequested=false, which used to classify the exit as a crash and
    // inflate .crash_count_today by one per agent, per PM2 restart.
    //
    // agent-manager.ts:stopAll() already writes a `.daemon-stop` marker in
    // every agent's state dir at the START of its shutdown loop for an
    // unrelated reason (SessionEnd crash-alert hook). We reuse that marker
    // here as the authoritative "the daemon is going down" signal. If the
    // marker exists AND is recent (written within the last 60s), any PTY
    // exit is a shutdown casualty, not a real crash — swallow it.
    //
    // The 60s window guards against a stale marker from a previous shutdown
    // that wasn't cleaned up: we do NOT want an old marker to silently mask
    // a genuine crash days later. handleExit does NOT delete the marker —
    // cleanup stays with agent-manager / hook-crash-alert per the existing
    // separation of concerns.
    if (this.isDaemonShuttingDown()) {
      return;
    }

    // BUG-040 fix: check stopRequested instead of (only) stopping. The
    // stopping flag is cleared inside stop() after a 15s timeout window —
    // which means a slow PTY shutdown can fire handleExit AFTER stopping is
    // already false, leading to spurious crash recovery. stopRequested is
    // set by stop() at the START of the shutdown sequence and persists across
    // stop()'s return until handleExit clears it (right here). This guarantees
    // that the FIRST exit after a stop() call is treated as intentional, no
    // matter how delayed it is.
    //
    // Also keep the legacy `stopping` check for in-progress detection during
    // the (most common) case where the exit fires while stop() is still
    // awaiting. Either flag short-circuits crash recovery.
    if (this.stopRequested || this.stopping) {
      this.stopRequested = false;
      return;
    }

    const stateDir = join(this.env.ctxRoot, 'state', this.name);

    // Rate-limit detection: if the PTY output contains Anthropic rate-limit or
    // overload signatures, treat this as a planned pause rather than a crash.
    // Rate-limit pauses do NOT count toward max_crashes_per_day and do NOT
    // trigger the git watchdog — they are expected operational events tied to
    // Anthropic's 5-hour rolling rate-limit window.
    if (outputBuffer?.hasRateLimitSignature()) {
      const pauseSeconds = this.config.rate_limit_pause_seconds ?? 18000;
      this.log(`Rate-limit detected — pausing ${pauseSeconds}s before restart (not counted as crash)`);
      this.status = 'rate-limited';
      this.notifyStatusChange();
      // Write a marker so the next boot prompt informs the agent it's recovering
      // from a rate-limit pause rather than a normal crash.
      try {
        writeFileSync(join(stateDir, '.rate-limited'), pauseSeconds.toString(), 'utf-8');
      } catch { /* ignore write errors */ }
      // Cancel any prior rate-limit timer before scheduling a new one (Bug-1 fix).
      // Without this, two sequential rate-limit exits leave two timers running;
      // the first fires into the second pause window and triggers an early restart.
      if (this.rateLimitTimer) {
        clearTimeout(this.rateLimitTimer);
        this.rateLimitTimer = null;
      }
      this.rateLimitTimer = setTimeout(() => {
        this.rateLimitTimer = null;
        if (this.status === 'rate-limited') {
          this.start().catch(err => this.log(`Rate-limit restart failed: ${err}`));
        }
      }, pauseSeconds * 1000);
      return;
    }

    // Auth-failure detection: if the PTY output contains the Claude Code CLI's
    // exact auth-error signatures (expired/invalid CLAUDE_CODE_OAUTH_TOKEN),
    // halt immediately — restarting cannot fix a dead token, and burning the
    // crash budget to HALT via backoff took 20+ silent minutes in the Jun-27
    // incident. Distinct from rate-limit (time-based, auto-recovers) and crash
    // (code bug, auto-restarts). Does NOT count toward max_crashes_per_day.
    if (outputBuffer?.hasAuthFailureSignature()) {
      this.log('Auth-failure detected (CLAUDE_CODE_OAUTH_TOKEN expired/invalid) — halting fast, no backoff');
      try {
        writeFileSync(join(stateDir, '.auth-failure'), new Date().toISOString(), 'utf-8');
      } catch { /* ignore write errors */ }
      this.appendCrashToRestartsLog(exitCode, 0, 'AUTH_FAILURE');
      this.status = 'halted';
      this.notifyStatusChange();
      // Fire fleet-wide Telegram alert (debounced — one message even if 7 agents halt).
      // Fire-and-forget: alert failure must not interrupt the halt path.
      sendAuthFailureAlert({
        agentEnvPath: join(this.env.agentDir, '.env'),
        orgSecretsPath: join(this.env.frameworkRoot, 'orgs', this.env.org, 'secrets.env'),
        agentsDir: join(this.env.frameworkRoot, 'orgs', this.env.org, 'agents'),
        instanceStateDir: this.env.ctxRoot,
        agentName: this.name,
        log: this.log,
      }).catch(() => { /* non-fatal */ });
      return;
    }

    // Image-poison auto-recovery (companion to PR #446's photo-injection fix).
    // Checked FIRST so a poisoned-context crash neither trips the crash-loop
    // window nor charges the daily counter — it is an upstream artifact, not
    // an agent malfunction.
    //
    // Claude Code crashes with `API Error: 400 messages.N.content.M.image.source.base64.data:
    // Image format image/<fmt> not supported` when conversation history holds a
    // base64-encoded image whose claimed media_type does not match the actual
    // bytes. The poison is permanent: every `--continue` restart reloads the
    // same conversation history and re-hits the same 400, so the agent
    // crash-loops until it exhausts max_crashes_per_day and the daemon halts.
    //
    // This block covers agents that ALREADY have a poisoned context: detect
    // the 400 signature in the recent stdout, write `.force-fresh` so the next
    // start discards the saved conversation, and respawn WITHOUT charging the
    // crash counter. (The photo-suppression source fix from #446 was superseded
    // by the Track-2 byte-sniff mime reconciliation; this recovery block is the
    // independent resilience half and stands on its own.)
    //
    // Exit is always code 0 in this failure mode (Claude Code surfaces the
    // 400 to the user then exits cleanly), so we gate on both exit code and
    // the error signature to avoid false positives that would skip a real
    // crash counter increment.
    if (exitCode === 0 && this.detectImagePoisonCrash(recentOutput)) {
      this.log('Image-poison crash detected (API 400, unsupported image format). Arming .force-fresh and restarting without counting against max_crashes_per_day.');
      this.armForceFresh('image-poison auto-recovery');
      this.appendCrashToRestartsLog(exitCode, 5000, 'IMAGE_POISON_RECOVERY');
      this.status = 'crashed';
      this.notifyStatusChange();
      setTimeout(() => {
        if (this.status === 'crashed') {
          this.start().catch(err => this.log(`Image-poison restart failed: ${err}`));
        }
      }, 5000);
      return;
    }

    // Crash-loop alert: track every real crash (post rate-limit, post image-poison)
    // and fire a Telegram alert when the rolling threshold is hit. Runs independently
    // of crashWindowMs config so it works even with no crash_window configured.
    // Fire-and-forget — alert failure must never interrupt crash recovery.
    if (this.crashLoopDetector.recordCrash()) {
      const agentEnvPath = join(this.env.agentDir, '.env');
      sendCrashLoopAlert({
        agentEnvPath,
        agentName: this.name,
        org: this.env.org,
        recentCount: this.crashLoopDetector.recentCount(),
        log: this.log,
      }).catch(() => {/* non-fatal */});
    }

    // CrashLoopPauser (instar-inspired): if a sliding window is configured,
    // check whether the agent is crash-looping before falling through to
    // the legacy daily counter. The window is a more precise signal than
    // the per-day count: 3 crashes in 30 minutes is a crash loop even if
    // the daily budget of 10 is far from exhausted.
    if (this.crashWindowMs > 0) {
      const now = Date.now();
      this.crashTimestamps.push(now);
      // Prune timestamps outside the window.
      this.crashTimestamps = this.crashTimestamps.filter(
        (ts) => now - ts <= this.crashWindowMs,
      );
      if (this.crashTimestamps.length >= this.crashWindowMax) {
        this.log(
          `CRASH_LOOP: ${this.crashTimestamps.length} crashes in ${this.crashWindowMs / 1000}s window — auto-pausing`,
        );
        this.appendCrashToRestartsLog(exitCode, 0, 'CRASH_LOOP');
        this.status = 'halted';
        this.notifyStatusChange();
        return;
      }
    }

    // Legacy daily crash counter (fallback when no crash_window is configured,
    // or as a secondary gate when the window hasn't filled yet).
    this.crashCount++;
    const today = new Date().toISOString().split('T')[0];
    this.resetCrashCountIfNewDay(today);
    // Defensive normalization: resetCrashCountIfNewDay already guards the
    // persisted-token parse, but normalize here too so the halt gate and the
    // backoff math below can NEVER see a NaN regardless of how crashCount was
    // seeded. A NaN here would make `crashCount >= maxCrashesPerDay` false
    // forever (cap never fires) and `Math.pow(2, NaN)` → setTimeout(fn, NaN)
    // → an immediate tight restart loop. Symmetric with the read-site guard;
    // does not alter the ++/reset interplay above.
    this.crashCount = this.safeCrashCount(String(this.crashCount));

    if (this.crashCount >= this.maxCrashesPerDay) {
      this.log(`HALTED: exceeded ${this.maxCrashesPerDay} crashes today`);
      this.appendCrashToRestartsLog(exitCode, 0, 'HALTED');
      this.status = 'halted';
      this.notifyStatusChange();
      return;
    }

    // Watchdog: record this crash against the current commit, then check
    // whether the commit has been crashing repeatedly and needs a rollback.
    recordFailure(stateDir, this.repoRoot);

    if (this.repoRoot && shouldRollback(stateDir, this.repoRoot)) {
      this.log(`Watchdog: commit unstable after ${this.crashCount} crashes — performing git rollback`);
      const result = performRollback(stateDir, this.repoRoot);
      if (result.success) {
        this.log(`Watchdog: rolled back to ${result.rolledBackTo.slice(0, 12)}${result.stashRef ? `, stash: ${result.stashRef}` : ''}`);
      } else {
        this.log(`Watchdog: rollback failed — ${result.reason}`);
      }
    }

    // Exponential backoff restart
    const backoff = Math.min(5000 * Math.pow(2, this.crashCount - 1), 300000);
    this.log(`Crash recovery: restart in ${backoff / 1000}s (crash #${this.crashCount})`);
    // Persist the crash to restarts.log so operators have a durable audit
    // trail. Previously only planned SELF-RESTART / HARD-RESTART from
    // bus/system.ts wrote here, which left daemon-classified crashes
    // invisible outside the rotating PM2 daemon stdout log.
    this.appendCrashToRestartsLog(exitCode, backoff, 'CRASH');
    this.status = 'crashed';
    this.notifyStatusChange();

    setTimeout(() => {
      if (this.status === 'crashed') {
        this.start().catch(err => this.log(`Restart failed: ${err}`));
      }
    }, backoff);
  }

  /**
   * Check whether the rate-limit recovery marker exists (read-only).
   * The caller is responsible for deleting it after a successful spawn via
   * deleteRateLimitMarker(), so a failed spawn doesn't permanently swallow
   * the recovery context (mirrors the watchdog readRecoveryNote pattern).
   */
  private hasRateLimitMarker(stateDir: string): boolean {
    return existsSync(join(stateDir, '.rate-limited'));
  }

  /**
   * Delete the rate-limit recovery marker.
   * Call only after pty.spawn() succeeds.
   */
  private deleteRateLimitMarker(stateDir: string): void {
    try {
      const { unlinkSync } = require('fs');
      unlinkSync(join(stateDir, '.rate-limited'));
    } catch { /* ignore */ }
  }

  private shouldContinue(): boolean {
    // Check for force-fresh marker FIRST (all runtimes honor it).
    //
    // Ordering matters: this check used to sit BELOW the Hermes early-return,
    // which meant hardRestartSelf() and armForceFresh() on a Hermes agent
    // never actually forced a fresh session — the marker was bypassed (the
    // agent kept resuming via --continue as long as state.db existed) AND
    // never consumed, so it leaked in the state dir indefinitely.
    const forceFreshPath = join(this.env.ctxRoot, 'state', this.name, '.force-fresh');
    if (existsSync(forceFreshPath)) {
      // Context watchdog and hard-restart use this marker to force a fresh
      // session instead of `--continue`. The marker is consumed here in the
      // daemon launch decision, before runtime-specific boot prompts run; do
      // not expect codex-app-server itself to read or clear `.force-fresh`.
      try {
        unlinkSync(forceFreshPath);
      } catch { /* ignore */ }
      return false;
    }

    // Hermes: session continuity is determined by whether the SQLite DB exists.
    // HERMES_HOME (agent .env, falling back to the daemon's process env)
    // overrides the default ~/.hermes path.
    if (this.config.runtime === 'hermes') {
      return hermesDbExists(this.resolveHermesHome());
    }

    // codex-app-server: session continuity is tracked by the adapter's own
    // codex-app-server-thread.json under ctxRoot/state/<agent>/. The Claude
    // JSONL check below is meaningless for the codex runtime, and a stale
    // Claude JSONL left over from a prior Claude-runtime tenure caused
    // continue-mode → thread/resume timeout → exit_code=0 crash loop
    // (testorg codex-agent crashed 3x with this signature on 2026-05-09,
    // 05-14, and 05-16 before backoff drained the pending resume RPC).
    if (this.config.runtime === 'codex-app-server') {
      const threadStatePath = join(
        this.env.ctxRoot,
        'state',
        this.name,
        'codex-app-server-thread.json',
      );
      return existsSync(threadStatePath);
    }

    // Default (Claude runtime): existing conversation = JSONL files present.
    const launchDir = this.config.working_directory || this.env.agentDir;
    if (!launchDir) return false;

    // Claude projects dir uses the absolute path with all separators replaced by dashes
    // e.g. /Users/foo/agents/boss -> -Users-foo-agents-boss (leading sep becomes -)
    // Use homedir() for cross-platform compatibility (HOME is not set on Windows).
    const convDir = join(
      homedir(),
      '.claude',
      'projects',
      launchDir.split(sep).join('-'),
    );

    try {
      const files = require('fs').readdirSync(convDir);
      const hasConversation = files.some((f: string) => f.endsWith('.jsonl'));
      if (!hasConversation) return false;

      // Check if the previous session died at full context or hit a billing gate.
      // Read the tail of the most recent .jsonl — if it contains fatal API errors,
      // resuming with --continue will just hit the same wall. Force fresh instead.
      const jsonlFiles = files.filter((f: string) => f.endsWith('.jsonl')).sort();
      const lastJsonl = jsonlFiles[jsonlFiles.length - 1];
      if (lastJsonl) {
        try {
          const convPath = join(convDir, lastJsonl);
          const stat = statSync(convPath);
          const tailSize = Math.min(10_000, stat.size);
          const buf = Buffer.alloc(tailSize);
          const fd = require('fs').openSync(convPath, 'r');
          require('fs').readSync(fd, buf, 0, tailSize, Math.max(0, stat.size - tailSize));
          require('fs').closeSync(fd);
          const tail = buf.toString('utf-8');
          if (/Extra usage is required for 1M context/.test(tail) ||
              /context window is full/.test(tail)) {
            this.log('shouldContinue: previous session hit context/billing limit — forcing fresh start');
            return false;
          }
        } catch { /* best effort — fall through to continue */ }
      }

      return true;
    } catch {
      return false;
    }
  }

  /**
   * Resolve HERMES_HOME for session-continuity detection.
   *
   * Resolution order: agent .env file (the documented place for per-agent
   * overrides — see hermesDbExists' doc comment) → daemon process.env.
   *
   * The agent's .env is loaded into the PTY CHILD's environment by
   * AgentPTY.spawn(), not into the daemon's process.env — so the previous
   * behavior of reading only process.env silently ignored a HERMES_HOME
   * set in the agent .env, and shouldContinue() would probe the wrong
   * path (~/.hermes) for state.db.
   */
  private resolveHermesHome(): string | undefined {
    try {
      const envFile = join(this.env.agentDir, '.env');
      if (existsSync(envFile)) {
        for (const line of readFileSync(envFile, 'utf-8').split('\n')) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;
          const eqIdx = trimmed.indexOf('=');
          if (eqIdx > 0 && trimmed.slice(0, eqIdx).trim() === 'HERMES_HOME') {
            const value = trimmed.slice(eqIdx + 1).trim();
            if (value) return value;
          }
        }
      }
    } catch {
      // Unreadable/malformed .env — fall through to the daemon's env.
    }
    return process.env['HERMES_HOME'];
  }

  private buildStartupPrompt(recoveryNote: string | null, options: StartOptions = {}): string {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const onboardedPath = join(stateDir, '.onboarded');
    const onboardingPath = join(this.env.agentDir, 'ONBOARDING.md');
    const heartbeatPath = join(stateDir, 'heartbeat.json');
    const identityPath = join(this.env.agentDir, 'IDENTITY.md');
    const memoryPath = join(this.env.agentDir, 'MEMORY.md');
    let isOnboarded = existsSync(onboardedPath);
    let onboardingAppend = '';

    // Belt-and-suspenders onboarding recovery: if the marker is missing but the
    // agent either has a heartbeat OR clearly non-template bootstrap content,
    // retro-write `.onboarded` so a restart does not force setup again.
    if (!isOnboarded && (
      existsSync(heartbeatPath) || this.hasCompletedBootstrapContent(identityPath, memoryPath)
    )) {
      try {
        writeFileSync(onboardedPath, '', 'utf-8');
        isOnboarded = true;
      } catch { /* ignore */ }
    }

    if (!isOnboarded && existsSync(onboardingPath)) {
      onboardingAppend = ' IMPORTANT: This is your FIRST BOOT. Before doing anything else, read ONBOARDING.md and complete the onboarding protocol.';
    }

    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    const recoveryBlock = recoveryNote
      ? ` WATCHDOG RECOVERY: The daemon rolled back your git repository due to repeated crashes. Before doing anything else, read this recovery note and investigate the root cause:\n\n${recoveryNote}\n\nAfter reviewing, write your findings to memory and notify the operator.`
      : '';
    const rateLimitBlock = this.hasRateLimitMarker(stateDir)
      ? ' RATE-LIMIT RECOVERY: Your previous session was paused by the daemon due to an Anthropic rate-limit or overload response. You have been restarted after the configured recovery window. Resume normal operations — this was not a crash.'
      : '';
    const deliverablesBlock = this.buildDeliverablesBlock();
    const handoffBlock = this.consumeHandoffBlock();
    const isHandoffRestart = handoffBlock.length > 0;
    this.lastSpawnWasHandoff = isHandoffRestart;
    const suppressBootBlock = this.config.suppress_boot_notify
      ? ' SUPPRESS_BOOT_NOTIFY: skip AGENTS.md cold-boot steps 1 and 13, fast-path step 6, and the CONTEXT HANDOFF pickup message. Do NOT send any boot/restart/online notification via Telegram. Still reply to incoming Telegrams and send real deliverables.'
      : '';
    return `You are starting a new session. Current UTC time: ${nowUtc}. Read AGENTS.md and follow its session-start instructions. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock}${handoffBlock}${suppressBootBlock}${onboardingAppend}${recoveryBlock}${rateLimitBlock}`;
  }

  private hasCompletedBootstrapContent(identityPath: string, memoryPath: string): boolean {
    if (!existsSync(identityPath) || !existsSync(memoryPath)) return false;

    try {
      const identity = readFileSync(identityPath, 'utf-8');
      const memory = readFileSync(memoryPath, 'utf-8');

      const nameMatch = identity.match(/^## Name\s+([\s\S]*?)(?:\n## |\s*$)/m);
      const roleMatch = identity.match(/^## Role\s+([\s\S]*?)(?:\n## |\s*$)/m);
      const nameValue = nameMatch?.[1]?.trim() ?? '';
      const roleValue = roleMatch?.[1]?.trim() ?? '';

      const hasIdentityContent = Boolean(
        nameValue &&
        roleValue &&
        !nameValue.includes('<!--') &&
        !roleValue.includes('<!--'),
      );
      const hasMemoryContent = memory.length > 80 && !memory.includes('<!--');
      return hasIdentityContent && hasMemoryContent;
    } catch {
      return false;
    }
  }

  private buildContinuePrompt(recoveryNote: string | null, options: StartOptions = {}): string {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const nowUtc = new Date().toISOString();
    const reminderBlock = this.buildReminderBlock();
    // Bug-2 fix: inject recovery note in continue mode too.
    // After a rollback, .jsonl files survive (they live outside the git repo),
    // so shouldContinue() returns true and this path runs — without this the
    // recovery note would sit on disk unused until a cold-start that may never come.
    const recoveryBlock = recoveryNote
      ? ` WATCHDOG RECOVERY: The daemon rolled back your git repository due to repeated crashes. Before doing anything else, read this recovery note and investigate the root cause:\n\n${recoveryNote}\n\nAfter reviewing, write your findings to memory and notify the operator.`
      : '';
    const rateLimitBlock = this.hasRateLimitMarker(stateDir)
      ? ' RATE-LIMIT RECOVERY: Your previous session was paused by the daemon due to an Anthropic rate-limit or overload response. You have been restarted after the configured recovery window. Resume normal operations — this was not a crash.'
      : '';
    const deliverablesBlock = this.buildDeliverablesBlock();
    // Session refresh (--continue) is never a handoff restart.
    this.lastSpawnWasHandoff = false;
    const suppressBootBlock = this.config.suppress_boot_notify
      ? ' SUPPRESS_BOOT_NOTIFY: skip AGENTS.md cold-boot steps 1 and 13, fast-path step 6, and the CONTEXT HANDOFF pickup message. Do NOT send any boot/restart/online notification via Telegram. Still reply to incoming Telegrams and send real deliverables.'
      : '';
    return `SESSION CONTINUATION: Your CLI process was restarted with --continue to reload configs. Current UTC time: ${nowUtc}. Your full conversation history is preserved. Read AGENTS.md and follow its session-start instructions. External crons are auto-loaded by the daemon — do NOT call CronCreate or CronList for cron restoration.${reminderBlock}${deliverablesBlock} Check inbox. Resume normal operations.${suppressBootBlock}${recoveryBlock}${rateLimitBlock}`;
  }

  /**
   * Build a reminder block for the boot prompt.
   * If any pending reminders are overdue, include them so the agent handles them
   * even after a hard-restart that cleared in-memory cron state (#69).
   */
  private buildReminderBlock(): string {
    try {
      const paths = resolvePaths(this.name, this.env.instanceId, this.env.org);
      const overdue = getOverdueReminders(paths);
      if (overdue.length === 0) return '';
      const items = overdue.map(r =>
        `  - [${r.id}] (due ${r.fire_at}): ${r.prompt}`,
      ).join('\n');
      return ` You also have ${overdue.length} overdue persistent reminder(s) from before this restart — handle each one, then run: cortextos bus ack-reminder <id>\n${items}`;
    } catch {
      return '';
    }
  }

  /**
   * Build a deliverable-standard instruction block for the boot prompt.
   * When require_deliverables is enabled in the org's context.json, agents
   * are told that every task submitted for review must have at least one
   * file attached via save-output. The instruction is injected dynamically
   * so existing agents pick up the rule on their next boot with zero file
   * changes, and toggling it off removes it from the next startup prompt.
   */
  private buildDeliverablesBlock(): string {
    try {
      const contextPath = join(this.env.frameworkRoot, 'orgs', this.env.org, 'context.json');
      if (!existsSync(contextPath)) return '';
      const ctx = JSON.parse(readFileSync(contextPath, 'utf-8'));
      if (!ctx.require_deliverables) return '';
      return ' DELIVERABLE STANDARD: Every task you submit for review MUST have at least one file deliverable attached via the save-output bus command. A task with zero file deliverables will be sent back. Attach files with: cortextos bus save-output <task-id> <file-path> --label "<descriptive label>". Labels must be human-readable at a glance: describe WHAT it is plus enough context to understand at a glance. Good: "Traffic Growth Plan — 10 channels, 30-day launch sequence". Bad: "traffic-growth-plan.md" or "output-1". Notes are for context only, never file paths or URLs.';
    } catch {
      return '';
    }
  }

  getAgentDir(): string {
    return this.env.agentDir;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  private consumeHandoffBlock(): string {
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const markerPath = join(stateDir, '.handoff-doc-path');
    if (!existsSync(markerPath)) return '';
    try {
      const docPath = readFileSync(markerPath, 'utf-8').trim();
      unlinkSync(markerPath);
      if (!docPath || !existsSync(docPath)) return '';
      // Record the consumed doc (path + mtime) so a watchdog restart shortly
      // after this handoff does not re-preserve (resurrect) the same
      // already-consumed doc and inject stale prior-session context. mtime is
      // stored alongside the path so a NEW handoff written to a REUSED filename
      // (same path, newer mtime) is still preserved rather than wrongly skipped.
      // See FastChecker.preserveRecentHandoffDoc.
      try {
        const mtimeMs = statSync(docPath).mtimeMs;
        writeFileSync(
          join(stateDir, '.handoff-doc-consumed'),
          JSON.stringify({ path: docPath, mtimeMs }),
          'utf-8',
        );
      } catch { /* non-fatal */ }
      return ` CONTEXT HANDOFF: Before restoring crons or checking inbox, read the handoff document at ${docPath} to resume your prior session state.`;
    } catch {
      return '';
    }
  }

  /**
   * Issue #392: send the back-online Telegram notification directly from the
   * daemon when the codex-app-server runtime spawns. The boot prompt's inline
   * "Send a Telegram message..." instruction reaches the codex thread but is
   * not executed reliably as a tool call, leaving James without the standard
   * post-restart notification claude-code peers send.
   *
   * Skipped when:
   *  - runtime is anything other than codex-app-server (claude-code/hermes
   *    already emit this via the prompt),
   *  - the most recent prompt was built for a handoff restart (the agent
   *    sends its own contextual "back — ..." reply in that case),
   *  - no Telegram handle has been wired (no chat_id configured).
   */
  private maybeSendCodexBootNotification(options: StartOptions = {}): void {
    if (options.partOfFleetStart) return;
    if (this.config.suppress_boot_notify) return;
    if (this.config.runtime !== 'codex-app-server') return;
    if (this.lastSpawnWasHandoff) return;
    if (!this.telegramApi || !this.telegramChatId) return;
    // Fully defensive fire-and-forget: this runs inside start()'s try-block, so
    // a malformed/partial Telegram handle (e.g. sendMessage missing or returning
    // a non-promise) must NOT throw and abort agent startup. Guard the call and
    // swallow both sync throws and async rejections — the boot ping is
    // observability only and never load-bearing for the agent coming online.
    try {
      const result = this.telegramApi.sendMessage(
        this.telegramChatId,
        `Agent ${this.name} is back online`,
      );
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>)
          .then(() => {
            this.log(`Telegram back-online notification sent for ${this.name}`);
          })
          .catch(() => { /* non-fatal */ });
      }
    } catch {
      /* non-fatal: notification is observability only */
    }
  }

  private startSessionTimer(): void {
    const DEFAULT_MAX_SESSION_S = 255600;
    // Node setTimeout uses int32 ms internally. Values > 2^31-1 (~24.8d) silently
    // coerce to 1ms, which combined with the BUG-048 reschedule loop below causes
    // an infinite tight loop. Clamp at the call site so any future misconfigured
    // max_session_seconds (e.g. a stray 3600000s = 1000h) cannot wedge the daemon.
    const MAX_SETTIMEOUT_MS = 2_147_483_647;
    const startedAt = Date.now();
    const initialMs = (this.config.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;

    // BUG-048 fix: re-read max_session_seconds from config.json on each timer
    // fire so that config changes after start() take effect. Without this, a
    // briefly-low max_session_seconds baked at start time causes a fleet-wide
    // simultaneous restart when all agents hit the same stale deadline.
    const scheduleCheck = (delayMs: number): void => {
      this.sessionTimer = setTimeout(() => {
        // Re-read current config from disk
        let currentMaxMs = initialMs;
        try {
          const configPath = join(this.env.agentDir, 'config.json');
          if (existsSync(configPath)) {
            const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
            currentMaxMs = (cfg.max_session_seconds || DEFAULT_MAX_SESSION_S) * 1000;
          }
        } catch { /* use initial value on read error */ }

        const elapsedMs = Date.now() - startedAt;
        const remainingMs = currentMaxMs - elapsedMs;

        if (remainingMs > 5000) {
          // Config was updated to a longer duration — reschedule for the remaining time.
          this.log(`Session timer: config updated to ${currentMaxMs / 1000}s, rescheduling (${Math.round(remainingMs / 1000)}s remaining)`);
          scheduleCheck(remainingMs);
          return;
        }

        this.log(`Session timer fired after ${Math.round(elapsedMs / 1000)}s (limit: ${currentMaxMs / 1000}s)`);
        this.sessionRefresh().catch(err => this.log(`Session refresh failed: ${err}`));
      }, Math.min(delayMs, MAX_SETTIMEOUT_MS));
    };

    scheduleCheck(initialMs);
  }

  private clearSessionTimer(): void {
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }
  }

  private startHealthTimer(): void {
    this.clearHealthTimer();
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    this.healthTimer = setTimeout(() => {
      this.healthTimer = null;
      markHealthy(stateDir, this.repoRoot);
    }, MIN_HEALTHY_SECONDS * 1000);
  }

  private clearHealthTimer(): void {
    if (this.healthTimer) {
      clearTimeout(this.healthTimer);
      this.healthTimer = null;
    }
  }

  /**
   * Check whether the daemon is currently in its shutdown sequence.
   *
   * Returns true iff a `.daemon-stop` marker exists in this agent's state
   * dir AND was written within the last 60 seconds. The marker is written
   * by AgentManager.stopAll() before it begins iterating stopAgent() calls.
   * A stale marker older than 60s is treated as leftover from a prior
   * shutdown and ignored — real crashes must not be masked indefinitely.
   */
  private isDaemonShuttingDown(): boolean {
    const marker = join(this.env.ctxRoot, 'state', this.name, '.daemon-stop');
    try {
      if (!existsSync(marker)) return false;
      const ageMs = Date.now() - statSync(marker).mtimeMs;
      return ageMs < 60_000;
    } catch {
      return false;
    }
  }

  /**
   * Append an unplanned-exit entry to restarts.log. Complements the planned
   * SELF-RESTART / HARD-RESTART entries written by src/bus/system.ts so that
   * a single file gives the complete restart history for an agent.
   *
   * Format matches bus/system.ts: `[ISO] <KIND>: <details>`. appendFileSync
   * uses write(2) with O_APPEND on Linux, which is atomic for writes under
   * PIPE_BUF (~4KB) — each CRASH line fits comfortably. All errors are
   * swallowed: logging must never break crash recovery.
   */
  private appendCrashToRestartsLog(
    exitCode: number,
    backoffMs: number,
    kind: 'CRASH' | 'HALTED' | 'CRASH_LOOP' | 'IMAGE_POISON_RECOVERY' | 'AUTH_FAILURE',
  ): void {
    try {
      const logDir = join(this.env.ctxRoot, 'logs', this.name);
      ensureDir(logDir);
      const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      const details =
        kind === 'HALTED'
          ? `exit_code=${exitCode} crash_count=${this.crashCount} max_crashes=${this.maxCrashesPerDay}`
          : kind === 'IMAGE_POISON_RECOVERY'
            ? `exit_code=${exitCode} backoff_s=${backoffMs / 1000} (not counted toward max_crashes)`
            : `exit_code=${exitCode} crash_count=${this.crashCount} backoff_s=${backoffMs / 1000}`;
      const logLine = `[${timestamp}] ${kind}: ${details}\n`;
      appendFileSync(join(logDir, 'restarts.log'), logLine, 'utf-8');
    } catch {
      /* swallow — never break crash recovery on a logging failure */
    }
  }

  /**
   * Coerce a persisted crash-count token to a safe non-negative integer.
   *
   * The on-disk format is `<date>:<count>`; a torn/garbled write can leave
   * `count` as `undefined`, `''`, or non-numeric junk. `parseInt` on those
   * yields NaN, and an unguarded NaN silently defeats the `max_crashes_per_day`
   * halt gate (`NaN >= N` is always false) and produces `setTimeout(fn, NaN)`
   * — i.e. an immediate, tight, infinite restart loop. We treat any
   * non-finite value as 0 ("no recoverable prior count"): that is safe for the
   * cap (the very next increment makes it 1 and counting resumes), and because
   * a garbage token carries no recoverable prior value there is nothing to
   * erase. Must stay byte-for-byte in step with hook-crash-alert.ts's
   * safeCrashCount — asymmetric guarding here previously caused a count
   * divergence between the daemon halt path and the operator-alert path.
   */
  private safeCrashCount(raw: string | undefined): number {
    const n = parseInt(raw ?? '', 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  private resetCrashCountIfNewDay(today: string): void {
    // Canonical crash-count location is state/<agent>/.crash_count_today —
    // matches hook-crash-alert.ts so daemon halt logic and operator alerts
    // read/write the same counter. Previous logs/<agent>/ path produced
    // divergent counts where the hook's reset/fetch had no effect on the
    // daemon's halt threshold and vice versa (Zone C M1 / Zone A M3).
    const stateDir = join(this.env.ctxRoot, 'state', this.name);
    const crashFile = join(stateDir, '.crash_count_today');
    try {
      if (existsSync(crashFile)) {
        const content = readFileSync(crashFile, 'utf-8').trim();
        const [storedDate, count] = content.split(':');
        if (storedDate === today) {
          // Guard parse: a malformed `count` must coerce to a finite 0 so the
          // same-day increment still produces a real number (0 + 1 = 1), never
          // propagating NaN into the halt/backoff comparisons below.
          this.crashCount = this.safeCrashCount(count) + 1;
        } else {
          this.crashCount = 1;
        }
      }
      ensureDir(stateDir);
      writeFileSync(crashFile, `${today}:${this.crashCount}`, 'utf-8');
    } catch { /* ignore */ }
  }

  private notifyStatusChange(): void {
    if (this.onStatusChange) {
      this.onStatusChange(this.getStatus());
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

import { appendFileSync, renameSync, statSync } from 'fs';
import { redactSecrets, splitTrailingPartialJwt, BARE_PREFIX_FRAGMENT } from './redact.js';

// Dynamic import for strip-ansi (ESM module)
let stripAnsi: (text: string) => string;
async function loadStripAnsi() {
  if (!stripAnsi) {
    const mod = await import('strip-ansi');
    stripAnsi = mod.default;
  }
  return stripAnsi;
}

const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB — rotate well before the ~8MB watchdog stall point

/**
 * Ring buffer for PTY output. Replaces tmux capture-pane.
 * Stores raw output chunks and provides search/retrieval with ANSI stripping.
 */
export class OutputBuffer {
  private chunks: string[] = [];
  private maxChunks: number;
  private logPath: string | null;
  private bootstrapPattern: string;
  // Trailing substring of the previous push that could be the prefix of a
  // JWT split across the OS chunk boundary. Prepended to the next chunk so
  // redactSecrets sees the reassembled token. Bounded by
  // MAX_PARTIAL_HOLDBACK in redact.ts. Included (redacted) in getRecent()
  // so bootstrap / rate-limit / activity detection never miss live output.
  private pendingTail: string = '';

  constructor(maxChunks: number = 1000, logPath?: string, bootstrapPattern?: string) {
    this.maxChunks = maxChunks;
    this.logPath = logPath || null;
    this.bootstrapPattern = bootstrapPattern || 'permissions';
  }

  /**
   * Push new output data into the buffer.
   * Also streams to log file if configured.
   *
   * Secret redaction runs once at the top via `redactSecrets` and the
   * scrubbed string is used for BOTH the in-memory ring buffer AND the
   * disk log. Without this, any JWT or session cookie an agent's shell
   * happens to print (e.g. curl -v against an authenticated endpoint)
   * would end up persisted to stdout.log verbatim. See src/pty/redact.ts
   * for the rationale.
   *
   * Chunk-boundary handling: a trailing substring that looks like the
   * start of a JWT is held back (pendingTail) and prepended to the next
   * chunk, so a token split across two push() calls is reassembled and
   * redacted before it reaches the disk log. Held-tail contract: a tail
   * is held only until the next push() proves it JWT-or-not, OR until
   * close() flushes it at PTY exit — it is never silently dropped. See
   * close() for the exit-time disposition.
   */
  push(data: string): void {
    const combined = this.pendingTail + data;
    const [emit, hold] = splitTrailingPartialJwt(combined);
    this.pendingTail = hold;
    if (!emit) return; // everything held back as a potential partial token

    this.commit(redactSecrets(emit));
  }

  /**
   * Append already-redacted data to the in-memory ring buffer and stream
   * it to the disk log. Shared by push() and close().
   */
  private commit(safe: string): void {
    this.chunks.push(safe);
    if (this.chunks.length > this.maxChunks) {
      this.chunks.shift();
    }

    // Stream to log file (replaces tmux pipe-pane)
    if (this.logPath) {
      try {
        try {
          const size = statSync(this.logPath).size;
          if (size >= MAX_LOG_BYTES) {
            try { renameSync(this.logPath, this.logPath + '.1'); } catch { /* ignore */ }
          }
        } catch { /* file doesn't exist yet — skip rotation check */ }
        appendFileSync(this.logPath, safe, 'utf-8');
      } catch {
        // Ignore log write errors
      }
    }
  }

  /**
   * Flush the held-back tail at end-of-stream (PTY exit/teardown).
   *
   * If the PTY dies while a potential partial-JWT tail is held, those
   * bytes would otherwise vanish silently — not lossless for false
   * positives (legitimate base64 JSON that merely starts with `eyJ`, or
   * ordinary output ending in `e`/`ey`). Disposition:
   *
   * - Bare prefix fragment (`e`, `ey`, `eyJ`): emitted VERBATIM — it
   *   contains no token header/payload/signature bytes, and replacing a
   *   legit trailing `e` with a marker would mangle ordinary output.
   * - Anything longer: may contain real JWT header/payload bytes that
   *   redactSecrets cannot match (the token is incomplete), so the log
   *   gets an explicit `[REDACTED_POSSIBLE_JWT_TAIL]` marker instead —
   *   loss is recorded, secrets are not.
   *
   * Idempotent: the tail is cleared first, so a second close() (e.g.
   * kill() followed by the onExit event) writes nothing.
   */
  close(): void {
    const tail = this.pendingTail;
    this.pendingTail = '';
    if (!tail) return;
    this.commit(BARE_PREFIX_FRAGMENT.test(tail) ? tail : '[REDACTED_POSSIBLE_JWT_TAIL]');
  }

  /**
   * Get the last N chunks of output joined together.
   */
  getRecent(n?: number): string {
    const count = n || this.chunks.length;
    // Append the (redacted) held-back tail so consumers that poll recent
    // output — bootstrap detection, trust-prompt detection, rate-limit
    // scans — see the latest bytes even while a potential partial JWT is
    // being withheld from the disk log.
    return this.chunks.slice(-count).join('') + redactSecrets(this.pendingTail);
  }

  /**
   * Search for a pattern in recent output (ANSI codes stripped).
   * Used for bootstrap detection ("permissions" text).
   */
  async search(pattern: string): Promise<boolean> {
    const strip = await loadStripAnsi();
    const text = strip(this.getRecent());
    return text.includes(pattern);
  }

  /**
   * Synchronous search for simple patterns.
   * Does basic ANSI stripping inline (strips ESC[ sequences).
   */
  searchSync(pattern: string): boolean {
    const text = this.getRecent().replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
    return text.includes(pattern);
  }

  /**
   * Check if agent has bootstrapped (ready-for-input signal appeared).
   *
   * For Claude Code: looks for the "permissions" status-bar text.
   * For Hermes: looks for the "❯" prompt character (configurable via constructor).
   * The bootstrap pattern is set at construction time by the PTY class.
   */
  isBootstrapped(): boolean {
    const recent = this.getRecent();
    const cleaned = recent.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');

    if (this.bootstrapPattern === 'permissions') {
      // Claude Code: exclude trust-folder prompt false positives.
      // The trust prompt shows "trust this folder" before the status bar appears.
      if (cleaned.includes('trust') && !cleaned.includes('> ')) {
        return false;
      }
    }

    return cleaned.includes(this.bootstrapPattern);
  }

  /**
   * Get the total size of buffered output in bytes.
   * Useful for activity detection (typing indicator).
   */
  getSize(): number {
    let size = 0;
    for (const chunk of this.chunks) {
      size += chunk.length;
    }
    // Include the held-back tail so size-based activity detection still
    // registers output that is pending the chunk-boundary redaction check.
    return size + this.pendingTail.length;
  }

  /**
   * Check whether the recent PTY output contains signatures of an Anthropic
   * API rate-limit or overload response. Used by the daemon to distinguish
   * rate-limit exits from real crashes so it can apply an extended pause
   * instead of the normal crash-backoff cycle.
   *
   * Patterns matched (case-insensitive, ANSI stripped):
   *   - "overloaded_error" / "overloaded" (HTTP 529 body)
   *   - "rate_limit_error" / "rate limit" / "rate-limit"
   *   - "too many requests"
   *   - "quota exceeded" / "usage limit"
   *   - "529"
   */
  hasRateLimitSignature(): boolean {
    // Only scan the last 200 chunks — rate-limit messages appear near session end
    const text = this.chunks.slice(-200).join('').replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').toLowerCase();
    return (
      text.includes('overloaded_error') ||
      text.includes('rate_limit_error') ||
      text.includes('rate limit') ||
      text.includes('rate-limit') ||
      text.includes('too many requests') ||
      text.includes('quota exceeded') ||
      text.includes('usage limit') ||
      // HTTP 529 status line or JSON error code
      (text.includes('529') && (text.includes('overload') || text.includes('error')))
    );
  }

  /**
   * Clear the buffer.
   */
  clear(): void {
    this.chunks = [];
    this.pendingTail = '';
  }
}

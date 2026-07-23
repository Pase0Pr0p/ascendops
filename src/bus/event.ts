import { appendFileSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';
import type { EventCategory, EventSeverity, BusPaths, Heartbeat } from '../types/index.js';
import { atomicWriteSync, ensureDir } from '../utils/atomic.js';
import { withFileLockSync } from '../utils/lock.js';
import { randomString } from '../utils/random.js';
import { validateEventCategory, validateEventSeverity, isValidJson } from '../utils/validate.js';

/**
 * Log a structured event. Appends JSONL line to daily event file.
 * Identical to bash log-event.sh format.
 *
 * Events are stored at: {analyticsDir}/events/{agent}/{YYYY-MM-DD}.jsonl
 *
 * Side-effect: if this agent has an existing heartbeat.json, refresh its
 * `last_heartbeat` timestamp. Activity is liveness — if the agent is
 * logging events, it is by definition alive, so the stale-heartbeat
 * monitor should not page on it. Other fields (status, mode, etc.) are
 * preserved from the last explicit update-heartbeat call. Best-effort:
 * a failing heartbeat refresh never blocks the event write itself.
 * If no heartbeat file exists yet we do nothing — the first
 * update-heartbeat call creates it with full field values.
 */
export function logEvent(
  paths: BusPaths,
  agentName: string,
  org: string,
  category: EventCategory,
  eventName: string,
  severity: EventSeverity,
  metadata?: Record<string, unknown> | string,
): void {
  if (!org) {
    throw new Error('logEvent: org is required. Without it, events write to the non-org-nested path and become invisible to org-scoped readers (metrics, forge, dashboard).');
  }
  validateEventCategory(category);
  validateEventSeverity(severity);

  // Parse metadata if it's a string
  let meta: Record<string, unknown> = {};
  if (typeof metadata === 'string') {
    if (isValidJson(metadata)) {
      meta = JSON.parse(metadata);
    }
  } else if (metadata) {
    meta = metadata;
  }

  const epoch = Math.floor(Date.now() / 1000);
  const rand = randomString(5);
  const eventId = `${epoch}-${agentName}-${rand}`;
  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

  const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const eventsDir = join(paths.analyticsDir, 'events', agentName);
  ensureDir(eventsDir);

  const eventLine = JSON.stringify({
    id: eventId,
    agent: agentName,
    org,
    timestamp,
    category,
    event: eventName,
    severity,
    metadata: meta,
  });

  appendFileSync(join(eventsDir, `${today}.jsonl`), eventLine + '\n', 'utf-8');

  // Refresh heartbeat timestamp as a side-effect. See doc comment above.
  refreshHeartbeatTimestamp(paths, timestamp);
}

/**
 * Bump the `last_heartbeat` timestamp on the existing heartbeat.json,
 * preserving every other field. No-op when the file does not exist yet
 * or when any step fails — event writes are the authoritative record
 * and must never be blocked by heartbeat housekeeping.
 */
function refreshHeartbeatTimestamp(paths: BusPaths, timestamp: string): void {
  try {
    const hbPath = join(paths.stateDir, 'heartbeat.json');
    if (!existsSync(hbPath)) return;
    // The read-modify-write below is NOT atomic against a concurrent
    // updateHeartbeat() overwrite: without a lock, this reader can load a
    // stale heartbeat, an explicit update-heartbeat can write new status/
    // mode/task fields, and then this write clobbers them back to stale
    // (TOCTOU lost-update). Take the per-agent stateDir lock — the SAME lock
    // updateHeartbeat() takes — so the read+write is serialized against it.
    // withFileLockSync may throw on timeout; the surrounding try/catch keeps
    // the refresh best-effort and never blocks the already-persisted event.
    withFileLockSync(paths.stateDir, () => {
      const hb = JSON.parse(readFileSync(hbPath, 'utf-8')) as Heartbeat;
      hb.last_heartbeat = timestamp;
      atomicWriteSync(hbPath, JSON.stringify(hb));
    });
  } catch {
    // Best-effort — event already persisted, heartbeat refresh is secondary.
  }
}

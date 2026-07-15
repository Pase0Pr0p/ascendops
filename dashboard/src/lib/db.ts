// cortextOS Dashboard - SQLite database singleton
// Read cache for JSON/JSONL files on disk. WAL mode for concurrent reads.

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const instanceId = process.env.CTX_INSTANCE_ID ?? 'default';
const ctxRoot = process.env.CTX_ROOT;
const DB_PATH = ctxRoot
  ? path.join(ctxRoot, 'dashboard', `cortextos-${instanceId}.db`)
  : path.join(process.cwd(), '.data', `cortextos-${instanceId}.db`);

const SQLITE_BUSY_RETRIES = 8;
const SQLITE_BUSY_BASE_DELAY_MS = 50;

function sleepMs(ms: number): void {
  // Block without CPU spin; safe here because db init is a startup path.
  const sab = new SharedArrayBuffer(4);
  const arr = new Int32Array(sab);
  Atomics.wait(arr, 0, 0, ms);
}

function isSqliteBusy(err: unknown): boolean {
  return (err as NodeJS.ErrnoException & { code?: string })?.code === 'SQLITE_BUSY';
}

function withSqliteBusyRetry<T>(label: string, fn: () => T): T {
  let attempt = 0;
  let lastErr: unknown;
  while (attempt <= SQLITE_BUSY_RETRIES) {
    try {
      return fn();
    } catch (err: unknown) {
      if (!isSqliteBusy(err)) throw err;
      lastErr = err;
      if (attempt === SQLITE_BUSY_RETRIES) break;
      // Linear backoff with tiny deterministic jitter.
      const delayMs = SQLITE_BUSY_BASE_DELAY_MS * (attempt + 1) + (attempt % 3) * 7;
      sleepMs(delayMs);
      attempt += 1;
    }
  }
  throw new Error(`[db] ${label} failed after ${SQLITE_BUSY_RETRIES + 1} SQLITE_BUSY retries`, {
    cause: lastErr,
  });
}

function createDatabase(): Database.Database {
  // Ensure .data directory exists
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(DB_PATH, { timeout: 10000 });

  // Set busy_timeout BEFORE attempting any schema or pragma changes that
  // require write locks (e.g. WAL switch, CREATE TABLE). Without this, parallel
  // processes (like Next.js build workers) hit SQLITE_BUSY immediately.
  db.pragma('busy_timeout = 10000');

  // Switch to WAL mode (requires exclusive lock on the DB file).
  // In CI/Next page-data collection, multiple workers can race to initialize.
  // Retry boundedly on SQLITE_BUSY, and tolerate "already switched by another
  // process" by checking current journal mode.
  withSqliteBusyRetry('journal_mode WAL init', () => {
    try {
      db.pragma('journal_mode = WAL');
    } catch (err: unknown) {
      if (!isSqliteBusy(err)) throw err;
      const rows = db.pragma('journal_mode') as { journal_mode: string }[];
      if (rows[0]?.journal_mode === 'wal') return;
      throw err;
    }
  });
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  // Run schema initialization. This can contend when multiple workers open the
  // same DB path at startup, so apply the same bounded SQLITE_BUSY retry.
  withSqliteBusyRetry('schema init', () => initializeSchema(db));

  return db;
}

function initializeSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      priority TEXT NOT NULL DEFAULT 'normal',
      assignee TEXT,
      org TEXT NOT NULL DEFAULT '',
      project TEXT,
      needs_approval INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      completed_at TEXT,
      notes TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      description TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT,
      resolution_note TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      type TEXT NOT NULL,
      category TEXT,
      severity TEXT NOT NULL DEFAULT 'info',
      data TEXT,
      message TEXT,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS heartbeats (
      agent TEXT PRIMARY KEY,
      org TEXT NOT NULL DEFAULT '',
      status TEXT,
      current_task TEXT,
      mode TEXT,
      last_heartbeat TEXT,
      loop_interval INTEGER,
      uptime_seconds INTEGER
    );

    CREATE TABLE IF NOT EXISTS cost_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      from_agent TEXT NOT NULL,
      to_agent TEXT NOT NULL,
      org TEXT NOT NULL DEFAULT '',
      timestamp TEXT NOT NULL,
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'unread',
      source_file TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_meta (
      file_path TEXT PRIMARY KEY,
      mtime REAL NOT NULL,
      last_synced TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Rate limit table: persists across server restarts so limits survive hot-reloads
    -- and intentional restarts. reset_at is a Unix timestamp in milliseconds.
    CREATE TABLE IF NOT EXISTS rate_limits (
      ip TEXT PRIMARY KEY,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at INTEGER NOT NULL
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_tasks_org ON tasks(org);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);
    CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority);

    CREATE INDEX IF NOT EXISTS idx_approvals_org ON approvals(org);
    CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status);
    CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent);

    CREATE INDEX IF NOT EXISTS idx_events_org ON events(org);
    CREATE INDEX IF NOT EXISTS idx_events_agent ON events(agent);
    CREATE INDEX IF NOT EXISTS idx_events_timestamp ON events(timestamp);
    CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    CREATE INDEX IF NOT EXISTS idx_events_severity ON events(severity);

    CREATE INDEX IF NOT EXISTS idx_cost_entries_timestamp ON cost_entries(timestamp);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_agent ON cost_entries(agent);
    CREATE INDEX IF NOT EXISTS idx_cost_entries_org ON cost_entries(org);

    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent);
    CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(org);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
  `);

  migrateCostEntriesNaturalKey(db);
}

/**
 * Migration: enforce natural-key uniqueness on cost_entries.
 *
 * The table was created with only an autoincrement `id` as its unique key, so
 * the cost sync's `INSERT OR IGNORE` never actually deduplicated — a re-sync or
 * backfill could double-count every row (43 duplicate rows had already
 * accumulated in the live DB). Add a UNIQUE INDEX on the natural key so
 * OR IGNORE dedups correctly. A unique index gives the same guarantee as a full
 * table rebuild with no data copy/rename, so it is lower risk.
 *
 * source_file is COALESCE'd to '' in both the dedup and the index because SQLite
 * treats NULL as DISTINCT in a unique index — without the COALESCE a NULL
 * source_file would slip past OR IGNORE. (timestamp/agent/model are NOT NULL by
 * schema.) Existing duplicates are removed first (keeping the lowest id per
 * natural key) or the CREATE UNIQUE INDEX would fail.
 *
 * Concurrency: dashboard init can run in multiple workers at once, so the dedup
 * and index creation run inside an IMMEDIATE transaction that takes the write
 * lock up front. This makes the migration atomic against (a) a second
 * initializer racing the same migration — without it, both observe
 * "index missing" and the loser's bare CREATE UNIQUE INDEX throws
 * "already exists" (a normal error, not SQLITE_BUSY, so the schema-init retry
 * would not catch it); and (b) a concurrent cost-sync INSERT landing between the
 * DELETE and the CREATE, which could re-introduce a duplicate and fail the index
 * build. The in-transaction re-check skips if another initializer already
 * migrated, and CREATE UNIQUE INDEX IF NOT EXISTS is belt-and-suspenders.
 * SQLITE_BUSY on BEGIN IMMEDIATE propagates to the existing
 * withSqliteBusyRetry('schema init') wrapper, which retries the whole init.
 */
function migrateCostEntriesNaturalKey(db: Database.Database): void {
  const indexExists = (): boolean =>
    db
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_cost_entries_natural'`,
      )
      .get() !== undefined;

  // Fast path: already migrated, skip taking the write lock.
  if (indexExists()) return;

  const runMigration = db.transaction(() => {
    // Re-check under the write lock: another initializer may have won the race.
    if (indexExists()) return;
    db.exec(`
      DELETE FROM cost_entries
       WHERE id NOT IN (
         SELECT MIN(id) FROM cost_entries
         GROUP BY timestamp, agent, model, COALESCE(source_file, '')
       );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_entries_natural
        ON cost_entries (timestamp, agent, model, COALESCE(source_file, ''));
    `);
  });
  runMigration.immediate();
}

// globalThis singleton survives Next.js hot reload
const globalForDb = globalThis as unknown as {
  __cortextos_db: Database.Database | undefined;
};

export const db = globalForDb.__cortextos_db ?? createDatabase();

if (process.env.NODE_ENV !== 'production') {
  globalForDb.__cortextos_db = db;
}

/** Re-export for explicit initialization (idempotent - db is created on import) */
export function initializeDb(): Database.Database {
  return db;
}

/** Check if the database connection is healthy */
export function isDatabaseReady(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

/** Get row counts for all tables (useful for diagnostics) */
export function getTableCounts(): Record<string, number> {
  const tables = [
    'tasks',
    'approvals',
    'events',
    'heartbeats',
    'cost_entries',
    'users',
    'messages',
    'sync_meta',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as {
      count: number;
    };
    counts[table] = row.count;
  }
  return counts;
}

export default db;

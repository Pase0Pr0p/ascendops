/**
 * Cap readout source layer.
 *
 * Provides a unified, pluggable view of current Anthropic usage cap state
 * (5-hour window + weekly window) with three sources tried in order:
 *
 *   1. headers    — rate-limit headers captured from the most recent Anthropic
 *                   API response (preferred, freshest, no extra request)
 *   2. dashboard  — direct HTTPS GET against the Anthropic usage summary
 *                   endpoint using the active OAuth access token
 *   3. estimate   — heuristic fallback derived from process uptime + a rough
 *                   token-rate guess; exists only so `getCurrentCap` never
 *                   returns null
 *
 * The OAuth refresh path (src/bus/oauth.ts) is currently broken (~32 days as
 * of 2026-05-18). This module does NOT depend on a working refresh — each
 * source fails gracefully and falls through to the next.
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { readTokenFromEnvFiles } from './oauth.js';

// --- Public types (frozen shape — do not change) ---

export type CapSource = 'headers' | 'dashboard' | 'estimate';

export type CapReadout = {
  source: CapSource;
  five_hour_pct: number;          // 0-100
  weekly_pct: number;             // 0-100
  timestamp: string;              // ISO 8601 UTC
  agent: string;                  // agent name, or "fleet" for global
  meta?: Record<string, unknown>;
};

export type BillingSplitStatus = 'pre_split' | 'split_active';

export type BillingPoolId = 'unified' | 'programmatic';

export type BillingPoolReadout = {
  pool: BillingPoolId;
  label: string;
  source: CapSource | 'unavailable';
  five_hour_pct?: number;
  weekly_pct?: number;
  monthly_credit_pct?: number | null;
};

export type BillingPoolStrain = {
  pool: 'programmatic';
  source: 'programmatic_readout' | 'unavailable';
  source_verified: false;
  enforcement: 'non_enforcing_scaffold';
  status: 'unavailable' | 'normal' | 'watch' | 'strain';
  monthly_credit_pct: number | null;
  watch_threshold_pct: 75;
  strain_threshold_pct: 85;
};

export type ClaudeTokenSpendLog = {
  source: 'codex-tokens-jsonl' | 'unavailable';
  path: string;
  entries: number;
  malformed_lines: number;
  sessions: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  total_tokens: number;
  latest_timestamp: string | null;
};

export type BillingMeta = {
  effective_date: '2026-06-15';
  status: BillingSplitStatus;
  primary_pool: BillingPoolId;
  enforcing_pool: 'unified';
  source_binding_todo: string;
  token_spend: ClaudeTokenSpendLog;
  pool2_strain: BillingPoolStrain;
  pools: {
    unified: BillingPoolReadout;
    programmatic: BillingPoolReadout;
  };
};

export interface GetCurrentCapOpts {
  agent?: string;
  // Test/DI hooks — undocumented in public API.
  ctxRoot?: string;
  org?: string;
  frameworkRoot?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
  uptimeSecs?: () => number;
}

// --- Constants ---

// Dashboard endpoint (parallels the usage path in oauth.ts: /api/oauth/usage).
// Best guess at the cap-summary endpoint shape; falls through on 4xx.
const DASHBOARD_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage_summary';

// Rough heuristic: a "full" 5h window assumes ~10M tokens of activity.
// Weekly window assumes ~5x that. These are deliberately conservative so the
// estimate source never *under*-reports cap pressure.
const ESTIMATE_5H_FULL_SECONDS = 5 * 60 * 60;
const ESTIMATE_WEEKLY_FULL_SECONDS = 7 * 24 * 60 * 60;
const BILLING_SPLIT_EFFECTIVE_MS = Date.UTC(2026, 5, 15, 0, 0, 0);

// --- Path helpers ---

function resolveCtxRoot(opts?: GetCurrentCapOpts): string {
  if (opts?.ctxRoot) return opts.ctxRoot;
  const fromEnv = process.env.CTX_ROOT;
  if (fromEnv) return fromEnv;
  const instanceId = process.env.CTX_INSTANCE_ID || 'default';
  return join(homedir(), '.cortextos', instanceId);
}

function resolveAgent(opts?: GetCurrentCapOpts): string {
  return opts?.agent || process.env.CTX_AGENT_NAME || 'fleet';
}

function resolveOrg(opts?: GetCurrentCapOpts): string {
  return opts?.org || process.env.CTX_ORG || '';
}

function headersCapturePath(opts?: GetCurrentCapOpts): string {
  const ctxRoot = resolveCtxRoot(opts);
  const org = resolveOrg(opts);
  const agent = resolveAgent(opts);
  // Spec requested path: $CTX_ROOT/orgs/$CTX_ORG/state/$CTX_AGENT_NAME/last-ratelimit-headers.json
  return join(ctxRoot, 'orgs', org, 'state', agent, 'last-ratelimit-headers.json');
}

// --- Source 1: headers ---

interface CapturedHeaders {
  // Raw captured headers from the last Anthropic response.
  // Keys may be canonical-cased or lower-cased; we normalise on read.
  headers: Record<string, string | number>;
  captured_at?: string;
}

/**
 * Parse the captured rate-limit headers file. Returns null if missing or
 * unparseable — caller falls through to dashboard.
 */
export async function readHeadersSource(opts?: GetCurrentCapOpts): Promise<CapReadout | null> {
  const path = headersCapturePath(opts);
  if (!existsSync(path)) return null;

  let parsed: CapturedHeaders;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf-8')) as CapturedHeaders;
  } catch {
    return null;
  }

  const h = lowercaseKeys(parsed.headers || {});

  // Anthropic exposes limit + remaining (+ reset) per bucket. We treat the
  // 5h-window proxy as the "tokens" or "input-tokens" bucket and the weekly
  // window as a long-horizon bucket if present, otherwise 0.
  const fiveHour = pctFromHeaders(h, [
    ['anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining'],
    ['anthropic-ratelimit-input-tokens-limit', 'anthropic-ratelimit-input-tokens-remaining'],
    ['anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining'],
  ]);

  const weekly = pctFromHeaders(h, [
    ['anthropic-ratelimit-weekly-tokens-limit', 'anthropic-ratelimit-weekly-tokens-remaining'],
    ['anthropic-ratelimit-output-tokens-limit', 'anthropic-ratelimit-output-tokens-remaining'],
  ]);
  // Pool-2 source binding is intentionally left unbound until the real
  // post-June-15 header shape is observable.
  if (fiveHour === null && weekly === null) return null;

  return withBillingMeta({
    source: 'headers',
    five_hour_pct: fiveHour ?? 0,
    weekly_pct: weekly ?? 0,
    timestamp: new Date().toISOString(),
    agent: resolveAgent(opts),
    meta: {
      captured_at: parsed.captured_at,
      headers_path: path,
    },
  }, opts);
}

function lowercaseKeys(h: Record<string, string | number>): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(h)) out[k.toLowerCase()] = v;
  return out;
}

function pctFromHeaders(
  h: Record<string, string | number>,
  pairs: Array<[string, string]>,
): number | null {
  for (const [limitKey, remainingKey] of pairs) {
    const limit = toNum(h[limitKey]);
    const remaining = toNum(h[remainingKey]);
    if (limit !== null && remaining !== null && limit > 0) {
      const used = Math.max(0, limit - remaining);
      return clampPct((used / limit) * 100);
    }
  }
  return null;
}

function toNum(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampPct(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

// --- Source 2: dashboard ---

interface DashboardUsageResponse {
  five_hour_utilization?: number;
  seven_day_utilization?: number;
  weekly_utilization?: number;
  fiveHourUtilization?: number;
  sevenDayUtilization?: number;
  weeklyUtilization?: number;
}

/**
 * Hit the Anthropic OAuth usage dashboard endpoint. Returns null on any 4xx
 * (broken auth, wrong endpoint, etc.) so the caller falls through to estimate.
 *
 * Reads the OAuth token from the same sources oauth.ts uses, but does NOT
 * trigger a refresh — broken refresh path is out of scope here.
 */
export async function readDashboardSource(opts?: GetCurrentCapOpts): Promise<CapReadout | null> {
  const token = resolveAccessToken(opts);
  if (!token) return null;

  const fetchImpl = opts?.fetchImpl ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchImpl) return null;

  let response: Response;
  try {
    response = await fetchImpl(DASHBOARD_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': 'oauth-2025-04-20',
      },
    });
  } catch {
    return null;
  }

  if (!response.ok) return null;

  let data: DashboardUsageResponse;
  try {
    data = (await response.json()) as DashboardUsageResponse;
  } catch {
    return null;
  }

  const fiveHourRaw = data.five_hour_utilization ?? data.fiveHourUtilization;
  const weeklyRaw =
    data.weekly_utilization ??
    data.weeklyUtilization ??
    data.seven_day_utilization ??
    data.sevenDayUtilization;
  // Pool-2 source binding is intentionally left unbound until the real
  // post-June-15 /api/oauth/usage_summary shape is observable.
  if (fiveHourRaw === undefined && weeklyRaw === undefined) {
    return null;
  }

  return withBillingMeta({
    source: 'dashboard',
    five_hour_pct: clampPct(normalizeUtil(fiveHourRaw)),
    weekly_pct: clampPct(normalizeUtil(weeklyRaw)),
    timestamp: new Date().toISOString(),
    agent: resolveAgent(opts),
    meta: { endpoint: DASHBOARD_USAGE_URL },
  }, opts);
}

function normalizeUtil(v: number | undefined): number {
  if (v === undefined || !Number.isFinite(v)) return 0;
  // Accept either 0-1 fraction or 0-100 percent.
  return v > 1 ? v : v * 100;
}

function resolveAccessToken(opts?: GetCurrentCapOpts): string | null {
  // Prefer env (what agents actually run with) — matches oauth.ts fallback.
  const envToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (envToken) return envToken;

  // CLAUDE_CODE_OAUTH_TOKEN is stripped from Bash subshells by Claude Code.
  // Try org secrets.env → agent .env before falling back to accounts.json.
  const frameworkRoot = opts?.frameworkRoot ?? process.env.CTX_FRAMEWORK_ROOT ?? '';
  const org = resolveOrg(opts);
  const agent = resolveAgent(opts);
  if (frameworkRoot && org) {
    const agentName = agent !== 'fleet' ? agent : undefined;
    const fromFiles = readTokenFromEnvFiles(frameworkRoot, org, agentName);
    if (fromFiles) return fromFiles;
  }

  // Fall back to accounts.json so server-side callers still work.
  const ctxRoot = resolveCtxRoot(opts);
  const accountsPath = join(ctxRoot, 'state', 'oauth', 'accounts.json');
  if (!existsSync(accountsPath)) return null;
  try {
    const store = JSON.parse(readFileSync(accountsPath, 'utf-8')) as {
      active?: string;
      accounts?: Record<string, { access_token?: string }>;
    };
    if (!store.active || !store.accounts) return null;
    return store.accounts[store.active]?.access_token ?? null;
  } catch {
    return null;
  }
}

// --- Source 3: estimate (last-resort heuristic) ---

/**
 * Synthesize a CapReadout from session uptime alone. Worst path: only fires
 * when both real sources are unreachable. Marked clearly via `source` and
 * `meta.confidence: 'low'` so callers can degrade UX accordingly.
 */
export function readEstimateSource(opts?: GetCurrentCapOpts): CapReadout {
  const uptimeFn = opts?.uptimeSecs ?? (() => process.uptime());
  const uptime = Math.max(0, uptimeFn());

  const fiveHour = clampPct((uptime / ESTIMATE_5H_FULL_SECONDS) * 100);
  const weekly = clampPct((uptime / ESTIMATE_WEEKLY_FULL_SECONDS) * 100);

  return withBillingMeta({
    source: 'estimate',
    five_hour_pct: fiveHour,
    weekly_pct: weekly,
    timestamp: new Date().toISOString(),
    agent: resolveAgent(opts),
    meta: {
      confidence: 'low',
      uptime_seconds: uptime,
      note: 'heuristic-only — headers + dashboard both unavailable',
    },
  }, opts);
}

function billingStatus(opts?: GetCurrentCapOpts): BillingSplitStatus {
  const now = opts?.now?.() ?? Date.now();
  return now >= BILLING_SPLIT_EFFECTIVE_MS ? 'split_active' : 'pre_split';
}

function buildBillingMeta(
  readout: CapReadout,
  opts?: GetCurrentCapOpts,
  programmatic?: Pick<BillingPoolReadout, 'monthly_credit_pct' | 'source'>,
): BillingMeta {
  const status = billingStatus(opts);
  const programmaticPct = programmatic?.monthly_credit_pct ?? null;
  return {
    effective_date: '2026-06-15',
    status,
    primary_pool: status === 'split_active' ? 'programmatic' : 'unified',
    // Gate the trust: until the real post-split Pool-2 source is observed and
    // bound, the existing unified-window cap signal remains the enforcing one.
    enforcing_pool: 'unified',
    source_binding_todo:
      'UNVERIFIED scaffold: observe real Anthropic post-June-15 Pool-2 fields before binding /api/oauth/usage_summary or headers.',
    token_spend: readClaudeTokenSpendLog(opts),
    pool2_strain: {
      pool: 'programmatic',
      source: programmaticPct === null ? 'unavailable' : 'programmatic_readout',
      source_verified: false,
      enforcement: 'non_enforcing_scaffold',
      status: classifyPool2Strain(programmaticPct),
      monthly_credit_pct: programmaticPct,
      watch_threshold_pct: 75,
      strain_threshold_pct: 85,
    },
    pools: {
      unified: {
        pool: 'unified',
        label: 'Pre-June-15 unified Claude usage cap',
        source: readout.source,
        five_hour_pct: readout.five_hour_pct,
        weekly_pct: readout.weekly_pct,
      },
      programmatic: {
        pool: 'programmatic',
        label: 'Pool 2 — Agent SDK / programmatic monthly credit',
        source: programmatic?.source ?? 'unavailable',
        monthly_credit_pct: programmatic?.monthly_credit_pct ?? null,
      },
    },
  };
}

export function classifyPool2Strain(pct: number | null): BillingPoolStrain['status'] {
  if (pct === null) return 'unavailable';
  if (pct >= 85) return 'strain';
  if (pct >= 75) return 'watch';
  return 'normal';
}

function tokenSpendLogPath(opts?: GetCurrentCapOpts): string {
  return join(resolveCtxRoot(opts), 'logs', resolveAgent(opts), 'codex-tokens.jsonl');
}

function readClaudeTokenSpendLog(opts?: GetCurrentCapOpts): ClaudeTokenSpendLog {
  const path = tokenSpendLogPath(opts);
  const empty: ClaudeTokenSpendLog = {
    source: 'unavailable',
    path,
    entries: 0,
    malformed_lines: 0,
    sessions: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    total_tokens: 0,
    latest_timestamp: null,
  };
  if (!existsSync(path)) return empty;

  try {
    // codex-app-server writes tokenUsage.total, i.e. cumulative session totals,
    // not per-turn deltas. For fleet spend we therefore keep the largest total
    // per session; summing every turn row would double-count multi-turn threads.
    const latestCumulativeBySession = new Map<string, {
      timestamp: string | null;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_write_tokens: number;
      total_tokens: number;
    }>();
    let entries = 0;
    let malformedLines = 0;
    for (const line of readFileSync(path, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        malformedLines += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        malformedLines += 1;
        continue;
      }
      const record = parsed as Record<string, unknown>;
      const sessionId = typeof record.session_id === 'string' && record.session_id
        ? record.session_id
        : `entry-${entries}`;
      const input = numericField(record.input_tokens);
      const output = numericField(record.output_tokens);
      const cacheRead = numericField(record.cache_read_tokens);
      const cacheWrite = numericField(record.cache_write_tokens);
      // Codex convention: cachedInputTokens is a subset of inputTokens and
      // total tokens = input + output (src/pty/codex-app-server-pty.ts L979-982).
      // Do not add cache_read_tokens/cache_write_tokens here; that double-counts.
      const total = numericField(record.total_tokens, input + output);
      const timestamp = typeof record.timestamp === 'string' ? record.timestamp : null;
      const current = latestCumulativeBySession.get(sessionId);
      if (!current || total >= current.total_tokens) {
        latestCumulativeBySession.set(sessionId, {
          timestamp,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cacheRead,
          cache_write_tokens: cacheWrite,
          total_tokens: total,
        });
      }
      entries += 1;
    }

    const out = { ...empty, source: 'codex-tokens-jsonl' as const, entries };
    out.malformed_lines = malformedLines;
    out.sessions = latestCumulativeBySession.size;
    for (const entry of latestCumulativeBySession.values()) {
      out.input_tokens += entry.input_tokens;
      out.output_tokens += entry.output_tokens;
      out.cache_read_tokens += entry.cache_read_tokens;
      out.cache_write_tokens += entry.cache_write_tokens;
      out.total_tokens += entry.total_tokens;
      if (entry.timestamp && (!out.latest_timestamp || entry.timestamp > out.latest_timestamp)) {
        out.latest_timestamp = entry.timestamp;
      }
    }
    return out;
  } catch {
    return empty;
  }
}

function numericField(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function withBillingMeta(
  readout: CapReadout,
  opts?: GetCurrentCapOpts,
  programmatic?: Pick<BillingPoolReadout, 'monthly_credit_pct' | 'source'>,
): CapReadout {
  return {
    ...readout,
    meta: {
      ...(readout.meta ?? {}),
      billing: buildBillingMeta(readout, opts, programmatic),
    },
  };
}

// --- Public entry point ---

/**
 * Resolve the current cap state. Tries headers → dashboard → estimate.
 * Guaranteed to return a CapReadout; never throws, never returns null.
 */
export async function getCurrentCap(opts?: GetCurrentCapOpts): Promise<CapReadout> {
  try {
    const fromHeaders = await readHeadersSource(opts);
    if (fromHeaders) return fromHeaders;
  } catch {
    // headers source must not throw — fall through
  }

  try {
    const fromDashboard = await readDashboardSource(opts);
    if (fromDashboard) return fromDashboard;
  } catch {
    // dashboard source must not throw — fall through
  }

  return readEstimateSource(opts);
}

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import {
  classifyPool2Strain,
  getCurrentCap,
  readHeadersSource,
  readDashboardSource,
  readEstimateSource,
  type BillingMeta,
  type CapReadout,
} from '../../src/bus/cap-readout.js';

const ORG = 'testorg';
const AGENT = 'testagent';
const BEFORE_BILLING_SPLIT = Date.UTC(2026, 5, 14, 23, 59, 59);

let tmpRoot: string;
let savedEnv: Record<string, string | undefined>;

function writeHeadersFile(headers: Record<string, string | number>, captured_at?: string): string {
  const dir = join(tmpRoot, 'orgs', ORG, 'state', AGENT);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'last-ratelimit-headers.json');
  writeFileSync(path, JSON.stringify({ headers, captured_at }), 'utf-8');
  return path;
}

function writeAccountsFile(accessToken: string): void {
  const dir = join(tmpRoot, 'state', 'oauth');
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'accounts.json'),
    JSON.stringify({
      active: 'primary',
      accounts: { primary: { access_token: accessToken } },
    }),
    'utf-8',
  );
}

function writeTokenLog(lines: Array<Record<string, unknown> | string>): void {
  const dir = join(tmpRoot, 'logs', AGENT);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'codex-tokens.jsonl'),
    lines.map((line) => typeof line === 'string' ? line : JSON.stringify(line)).join('\n') + '\n',
    'utf-8',
  );
}

function billingMeta(readout: CapReadout): BillingMeta {
  return readout.meta?.billing as BillingMeta;
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'cap-readout-test-'));
  savedEnv = {
    CTX_ROOT: process.env.CTX_ROOT,
    CTX_ORG: process.env.CTX_ORG,
    CTX_AGENT_NAME: process.env.CTX_AGENT_NAME,
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
  };
  // Wipe so DI opts take over deterministically.
  delete process.env.CTX_ROOT;
  delete process.env.CTX_ORG;
  delete process.env.CTX_AGENT_NAME;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe('readHeadersSource', () => {
  it('returns null when capture file is missing', async () => {
    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });

  it('returns null when capture file is invalid JSON', async () => {
    const dir = join(tmpRoot, 'orgs', ORG, 'state', AGENT);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'last-ratelimit-headers.json'), 'not-json', 'utf-8');

    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });

  it('computes 5h pct from tokens-limit / tokens-remaining', async () => {
    writeHeadersFile({
      'anthropic-ratelimit-tokens-limit': 1000,
      'anthropic-ratelimit-tokens-remaining': 250,
    });

    const result = await readHeadersSource({
      ctxRoot: tmpRoot,
      org: ORG,
      agent: AGENT,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('headers');
    // 1000 - 250 = 750 used → 75%
    expect(result!.five_hour_pct).toBe(75);
    expect(result!.agent).toBe(AGENT);
    expect(billingMeta(result!).status).toBe('pre_split');
    expect(billingMeta(result!).primary_pool).toBe('unified');
    expect(billingMeta(result!).enforcing_pool).toBe('unified');
    expect(billingMeta(result!).source_binding_todo).toMatch(/UNVERIFIED scaffold/);
    expect(billingMeta(result!).pools.unified.five_hour_pct).toBe(75);
    expect(billingMeta(result!).pools.programmatic.monthly_credit_pct).toBeNull();
    expect(billingMeta(result!).pool2_strain).toMatchObject({
      source: 'unavailable',
      source_verified: false,
      enforcement: 'non_enforcing_scaffold',
      status: 'unavailable',
      watch_threshold_pct: 75,
      strain_threshold_pct: 85,
    });
  });

  it('falls back to input-tokens then requests when tokens bucket absent', async () => {
    writeHeadersFile({
      'anthropic-ratelimit-input-tokens-limit': '200',
      'anthropic-ratelimit-input-tokens-remaining': '50',
    });

    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.five_hour_pct).toBe(75);
  });

  it('reads weekly bucket separately', async () => {
    writeHeadersFile({
      'anthropic-ratelimit-tokens-limit': 100,
      'anthropic-ratelimit-tokens-remaining': 90,
      'anthropic-ratelimit-weekly-tokens-limit': 1000,
      'anthropic-ratelimit-weekly-tokens-remaining': 800,
    });

    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.five_hour_pct).toBe(10);
    expect(result!.weekly_pct).toBe(20);
    expect(billingMeta(result!).pools.unified.weekly_pct).toBe(20);
  });

  it('returns null when no recognised bucket headers present', async () => {
    writeHeadersFile({ 'x-unrelated': 'foo' });
    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });

  it('clamps pct into 0-100 even on absurd inputs', async () => {
    writeHeadersFile({
      'anthropic-ratelimit-tokens-limit': 10,
      'anthropic-ratelimit-tokens-remaining': -999,
    });
    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.five_hour_pct).toBe(100);
  });

  it('normalises header keys regardless of case', async () => {
    writeHeadersFile({
      'Anthropic-Ratelimit-Tokens-Limit': 1000,
      'Anthropic-Ratelimit-Tokens-Remaining': 100,
    });
    const result = await readHeadersSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.five_hour_pct).toBe(90);
  });
});

describe('readDashboardSource', () => {
  it('returns null when no OAuth token is available', async () => {
    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });

  it('returns null on 401 (broken auth)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('returns null when fetch throws (network error)', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });

  it('parses 0-1 fractional utilization', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour_utilization: 0.11, seven_day_utilization: 0.03 }),
    });

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).not.toBeNull();
    expect(result!.source).toBe('dashboard');
    expect(result!.five_hour_pct).toBeCloseTo(11, 5);
    expect(result!.weekly_pct).toBeCloseTo(3, 5);
    expect(billingMeta(result!).pools.programmatic.source).toBe('unavailable');
  });

  it('accepts 0-100 percent-formatted utilization', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour_utilization: 45, weekly_utilization: 12 }),
    });

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.five_hour_pct).toBe(45);
    expect(result!.weekly_pct).toBe(12);
  });

  it('reads token from accounts.json when env not set', async () => {
    writeAccountsFile('tok_from_file');
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour_utilization: 0.5 }),
    });

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result!.source).toBe('dashboard');
    const callArgs = fetchImpl.mock.calls[0];
    expect((callArgs[1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer tok_from_file',
    });
  });

  it('reads token from org secrets.env when env and accounts.json are absent', async () => {
    // Write token into a fake framework-root secrets.env
    const fwRoot = mkdtempSync(join(tmpdir(), 'cap-fw-test-'));
    try {
      mkdirSync(join(fwRoot, 'orgs', ORG), { recursive: true });
      writeFileSync(join(fwRoot, 'orgs', ORG, 'secrets.env'), `CLAUDE_CODE_OAUTH_TOKEN=tok_from_fw_secrets\n`);

      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ five_hour_utilization: 0.2, weekly_utilization: 0.05 }),
      });

      const result = await readDashboardSource({
        ctxRoot: tmpRoot, org: ORG, agent: AGENT,
        frameworkRoot: fwRoot,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => BEFORE_BILLING_SPLIT,
      });
      expect(result).not.toBeNull();
      expect(result!.source).toBe('dashboard');
      const callArgs = fetchImpl.mock.calls[0];
      expect((callArgs[1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer tok_from_fw_secrets',
      });
    } finally {
      try { rmSync(fwRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('falls through to agent .env when secrets.env has no token', async () => {
    const fwRoot = mkdtempSync(join(tmpdir(), 'cap-fw-test-'));
    try {
      mkdirSync(join(fwRoot, 'orgs', ORG), { recursive: true });
      writeFileSync(join(fwRoot, 'orgs', ORG, 'secrets.env'), 'OTHER_KEY=nope\n');
      mkdirSync(join(fwRoot, 'orgs', ORG, 'agents', AGENT), { recursive: true });
      writeFileSync(join(fwRoot, 'orgs', ORG, 'agents', AGENT, '.env'), `CLAUDE_CODE_OAUTH_TOKEN=tok_from_agent_env\n`);

      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ five_hour_utilization: 0.1 }),
      });

      const result = await readDashboardSource({
        ctxRoot: tmpRoot, org: ORG, agent: AGENT,
        frameworkRoot: fwRoot,
        fetchImpl: fetchImpl as unknown as typeof fetch,
        now: () => BEFORE_BILLING_SPLIT,
      });
      expect(result).not.toBeNull();
      const callArgs = fetchImpl.mock.calls[0];
      expect((callArgs[1] as RequestInit).headers).toMatchObject({
        Authorization: 'Bearer tok_from_agent_env',
      });
    } finally {
      try { rmSync(fwRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('returns null when response JSON has no recognised fields', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ unrelated: true }),
    });

    const result = await readDashboardSource({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeNull();
  });
});

describe('readEstimateSource', () => {
  it('returns a valid CapReadout with source=estimate', () => {
    const result = readEstimateSource({
      agent: AGENT, uptimeSecs: () => 0, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result.source).toBe('estimate');
    expect(result.five_hour_pct).toBe(0);
    expect(result.weekly_pct).toBe(0);
    expect(result.agent).toBe(AGENT);
    expect(result.meta?.confidence).toBe('low');
    expect(billingMeta(result).effective_date).toBe('2026-06-15');
    expect(billingMeta(result).pools.programmatic.source).toBe('unavailable');
  });

  it('summarizes cumulative Claude token spend from codex token logs', () => {
    writeTokenLog([
      {
        timestamp: '2026-06-08T10:00:00Z',
        session_id: 'thread-a',
        turn_id: 'turn-1',
        input_tokens: 100,
        output_tokens: 20,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
      },
      {
        timestamp: '2026-06-08T10:05:00Z',
        session_id: 'thread-a',
        turn_id: 'turn-2',
        input_tokens: 300,
        output_tokens: 50,
        cache_read_tokens: 40,
        cache_write_tokens: 10,
      },
      {
        timestamp: '2026-06-08T10:10:00Z',
        session_id: 'thread-b',
        turn_id: 'turn-1',
        input_tokens: 25,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 30,
      },
    ]);

    const result = readEstimateSource({
      ctxRoot: tmpRoot, agent: AGENT, uptimeSecs: () => 0, now: () => BEFORE_BILLING_SPLIT,
    });
    const spend = billingMeta(result).token_spend;
    expect(spend.source).toBe('codex-tokens-jsonl');
    expect(spend.entries).toBe(3);
    expect(spend.sessions).toBe(2);
    expect(spend.input_tokens).toBe(325);
    expect(spend.output_tokens).toBe(55);
    expect(spend.cache_read_tokens).toBe(40);
    expect(spend.cache_write_tokens).toBe(10);
    // Cache counters are reported separately; they are subsets of input tokens
    // and must not be added to the spend total.
    expect(spend.total_tokens).toBe(380);
    expect(spend.latest_timestamp).toBe('2026-06-08T10:10:00Z');
  });

  it('skips malformed token-log lines without dropping valid spend entries', () => {
    writeTokenLog([
      '{not-json',
      'null',
      '["not", "an", "object"]',
      {
        timestamp: '2026-06-08T10:10:00Z',
        session_id: 'thread-good',
        turn_id: 'turn-1',
        input_tokens: 25,
        output_tokens: 5,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
      },
    ]);

    const result = readEstimateSource({
      ctxRoot: tmpRoot, agent: AGENT, uptimeSecs: () => 0, now: () => BEFORE_BILLING_SPLIT,
    });
    const spend = billingMeta(result).token_spend;
    expect(spend.source).toBe('codex-tokens-jsonl');
    expect(spend.entries).toBe(1);
    expect(spend.malformed_lines).toBe(3);
    expect(spend.sessions).toBe(1);
    expect(spend.total_tokens).toBe(30);
  });

  it('marks programmatic as the primary pool after the June 15 billing split', () => {
    const afterSplit = Date.UTC(2026, 5, 15, 0, 0, 1);
    const result = readEstimateSource({
      agent: AGENT,
      now: () => afterSplit,
      uptimeSecs: () => 0,
    });

    const billing = billingMeta(result);
    expect(billing.status).toBe('split_active');
    expect(billing.primary_pool).toBe('programmatic');
    expect(billing.enforcing_pool).toBe('unified');
    expect(billing.pool2_strain.enforcement).toBe('non_enforcing_scaffold');
  });

  it('freezes the clock to cover both billing split states deterministically', () => {
    try {
      vi.useFakeTimers();

      vi.setSystemTime(new Date(BEFORE_BILLING_SPLIT));
      expect(billingMeta(readEstimateSource({ agent: AGENT, uptimeSecs: () => 0 })).status)
        .toBe('pre_split');

      vi.setSystemTime(new Date(Date.UTC(2026, 5, 15, 0, 0, 1)));
      expect(billingMeta(readEstimateSource({ agent: AGENT, uptimeSecs: () => 0 })).status)
        .toBe('split_active');
    } finally {
      vi.useRealTimers();
    }
  });

  it('scales 5h pct linearly with uptime', () => {
    // Half the 5h window → ~50%
    const halfFiveHours = 2.5 * 60 * 60;
    const result = readEstimateSource({
      agent: AGENT, uptimeSecs: () => halfFiveHours, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result.five_hour_pct).toBeCloseTo(50, 1);
  });

  it('clamps to 100 when uptime exceeds the 5h window', () => {
    const result = readEstimateSource({
      agent: AGENT, uptimeSecs: () => 99999999, now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result.five_hour_pct).toBe(100);
    expect(result.weekly_pct).toBe(100);
  });

  it('defaults agent to "fleet" when none provided', () => {
    const result = readEstimateSource({ uptimeSecs: () => 0, now: () => BEFORE_BILLING_SPLIT });
    expect(result.agent).toBe('fleet');
  });
});

describe('classifyPool2Strain', () => {
  it('uses separate Pool-2 75/85 thresholds', () => {
    expect(classifyPool2Strain(null)).toBe('unavailable');
    expect(classifyPool2Strain(74.9)).toBe('normal');
    expect(classifyPool2Strain(75)).toBe('watch');
    expect(classifyPool2Strain(84.9)).toBe('watch');
    expect(classifyPool2Strain(85)).toBe('strain');
  });
});

describe('getCurrentCap (fallback ordering)', () => {
  it('returns headers source when capture file present', async () => {
    writeHeadersFile({
      'anthropic-ratelimit-tokens-limit': 100,
      'anthropic-ratelimit-tokens-remaining': 89,
    });
    const fetchImpl = vi.fn(); // must not be called

    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });

    expect(result.source).toBe('headers');
    expect(result.five_hour_pct).toBe(11);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('falls through to dashboard when no headers file', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ five_hour_utilization: 0.22, weekly_utilization: 0.07 }),
    });

    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      now: () => BEFORE_BILLING_SPLIT,
    });

    expect(result.source).toBe('dashboard');
    expect(result.five_hour_pct).toBeCloseTo(22, 5);
    expect(result.weekly_pct).toBeCloseTo(7, 5);
  });

  it('falls through to estimate when headers missing AND dashboard 401s', async () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'tok_test';
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      uptimeSecs: () => 0,
      now: () => BEFORE_BILLING_SPLIT,
    });

    expect(result.source).toBe('estimate');
    expect(result.five_hour_pct).toBe(0);
    expect(result.agent).toBe(AGENT);
  });

  it('falls through to estimate when no token and no headers', async () => {
    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      fetchImpl: vi.fn() as unknown as typeof fetch,
      uptimeSecs: () => 60,
      now: () => BEFORE_BILLING_SPLIT,
    });

    expect(result.source).toBe('estimate');
  });

  it('never returns null/undefined — always a valid CapReadout', async () => {
    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      uptimeSecs: () => 0,
      now: () => BEFORE_BILLING_SPLIT,
    });
    expect(result).toBeDefined();
    expect(result.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    const sources: CapReadout['source'][] = ['headers', 'dashboard', 'estimate'];
    expect(sources).toContain(result.source);
  });

  it('still returns a readout when headers source throws unexpectedly', async () => {
    // Write a file path that points at a directory to force a read error path.
    const dir = join(tmpRoot, 'orgs', ORG, 'state', AGENT);
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(dir, 'last-ratelimit-headers.json'), { recursive: true });

    const result = await getCurrentCap({
      ctxRoot: tmpRoot, org: ORG, agent: AGENT,
      uptimeSecs: () => 0,
      now: () => BEFORE_BILLING_SPLIT,
    });
    // Should fall through to estimate without throwing.
    expect(['dashboard', 'estimate']).toContain(result.source);
  });
});

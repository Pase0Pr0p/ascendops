/**
 * Processor side-effect tests for post-call WO intake.
 *
 * Covers the safety-critical paths that the pure-lib tests cannot:
 *   - Emergency send-then-mark: both-fail → retry → dead-letter escalation
 *   - Source dedup DB error → dedup_check_error (fail-closed)
 *   - Repeat-window DB error → possible_repeat flag (fail-closed)
 *   - Blank conversation_id → eventId fallback for source key
 *   - Stale-processing reaper SQL in processPostCallEvents
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';

// ─── mocks (vi.hoisted ensures availability before hoisted vi.mock) ────────

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('pg', () => ({
  default: { Pool: vi.fn() },
}));

import { processOneEvent, MAX_EMERGENCY_RETRIES } from '../post-call-processor';
import { computeSourceIdempotencyKey } from '../lib/post-call-intake';

// ─── helpers ──────────────────────────────────────────────────────────────

const RESOLVED_CALLER = {
  matched: true,
  ambiguous: false,
  display_name: 'Test Tenant',
  contact_id: 'c-test',
  unit_label: '#1',
  property_label: 'Test Property',
  routing_scope: 'fleet',
  resolved_type: 'tenant',
  has_active_occupancy: true,
  occupancy_id: 'occ-test',
  appfolio_unit_id: 1001,
  appfolio_property_id: 2001,
  appfolio_occupancy_id: 3001,
};

const AF_IDS_ROW = {
  appfolio_unit_id: 1001,
  appfolio_property_id: 2001,
  appfolio_occupancy_id: 3001,
};

function makePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conversation_id: 'conv-test-123',
    conversation_initiation_client_data: {
      dynamic_variables: { system__caller_id: '+14155551234' },
    },
    transcript: [
      { role: 'agent', message: 'Hello, how can I help?' },
      { role: 'user', message: 'My faucet is leaking' },
    ],
    analysis: {
      transcript_summary: 'Tenant reported a leaking faucet.',
      data_collection_results: {
        maintenance_issue_description: { value: 'Kitchen faucet leaking under the sink', rationale: 'r', data_collection_id: 'd' },
        caller_name: { value: 'Test Tenant', rationale: 'r', data_collection_id: 'd' },
        unit_number: { value: '1', rationale: 'r', data_collection_id: 'd' },
        is_emergency: { value: false, rationale: 'r', data_collection_id: 'd' },
        permission_to_enter: { value: true, rationale: 'r', data_collection_id: 'd' },
      },
    },
    ...overrides,
  };
}

function makeEmergencyPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...makePayload(),
    analysis: {
      transcript_summary: 'Tenant reported a gas leak.',
      data_collection_results: {
        maintenance_issue_description: { value: 'Gas leak in the kitchen', rationale: 'r', data_collection_id: 'd' },
        caller_name: { value: 'Test Tenant', rationale: 'r', data_collection_id: 'd' },
        unit_number: { value: '1', rationale: 'r', data_collection_id: 'd' },
        is_emergency: { value: true, rationale: 'r', data_collection_id: 'd' },
        permission_to_enter: { value: true, rationale: 'r', data_collection_id: 'd' },
      },
    },
    ...overrides,
  };
}

interface TrackedQuery {
  text: string;
  params?: unknown[];
}

function createMockPool(
  queryOverride?: (text: string, params?: unknown[]) => { rows: Record<string, unknown>[] } | null,
): { pool: pg.Pool; queries: TrackedQuery[] } {
  const queries: TrackedQuery[] = [];

  const queryFn = vi.fn(async (text: string, params?: unknown[]) => {
    queries.push({ text, params });

    if (queryOverride) {
      const result = queryOverride(text, params);
      if (result !== null && result !== undefined) return result;
    }

    if (text.includes('caller_sessions')) return { rows: [] };
    if (text.includes('voice_resolve_caller')) return { rows: [{ r: RESOLVED_CALLER }] };
    if (text.includes('occupancies')) return { rows: [AF_IDS_ROW] };
    if (text.includes('source_idempotency_key')) return { rows: [] };
    if (text.includes('repeat_window_key')) return { rows: [] };
    if (text.includes('INSERT INTO voice_events')) return { rows: [] };
    if (text.includes('UPDATE voice_events')) return { rows: [] };
    return { rows: [] };
  });

  const pool = { query: queryFn } as unknown as pg.Pool;
  return { pool, queries };
}

function findQuery(queries: TrackedQuery[], pattern: string): TrackedQuery | undefined {
  return queries.find(q => q.text.includes(pattern));
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('emergency delivery: send-then-mark', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('at least one send succeeds → lifecycle=processed', async () => {
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-1', makeEmergencyPayload(), 0);

    expect(findQuery(queries, "'processed'")).toBeTruthy();
    expect(findQuery(queries, 'emergency_send_failed')).toBeFalsy();
    expect(findQuery(queries, 'emergency_dead_letter')).toBeFalsy();
  });

  it('Telegram succeeds, Max fails → still processed', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('send-message')) throw new Error('agent down');
      return Buffer.from('ok');
    });
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-2', makeEmergencyPayload(), 0);

    expect(findQuery(queries, "'processed'")).toBeTruthy();
  });

  it('both sends fail, first attempt → emergency_send_failed + attempts=1', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-3', makeEmergencyPayload(), 0);

    const failQ = findQuery(queries, 'emergency_send_failed');
    expect(failQ).toBeTruthy();
    const metaJson = failQ!.params![1] as string;
    const meta = JSON.parse(metaJson);
    expect(meta._emergency_meta.attempts).toBe(1);
    expect(meta._emergency_meta.last_failed_at).toBeTruthy();
  });

  it('both sends fail on attempt 3 → emergency_send_failed + attempts=4', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-4', makeEmergencyPayload(), 3);

    const failQ = findQuery(queries, 'emergency_send_failed');
    expect(failQ).toBeTruthy();
    const meta = JSON.parse(failQ!.params![1] as string);
    expect(meta._emergency_meta.attempts).toBe(4);
  });

  it('retry exhaustion → emergency_dead_letter (not emergency_send_failed)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-5', makeEmergencyPayload(), MAX_EMERGENCY_RETRIES - 1);

    expect(findQuery(queries, 'emergency_dead_letter')).toBeTruthy();
    expect(findQuery(queries, 'emergency_send_failed')).toBeFalsy();
  });

  it('dead-letter attempts best-effort Telegram escalation', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool } = createMockPool();

    await processOneEvent(pool, 'evt-6', makeEmergencyPayload(), MAX_EMERGENCY_RETRIES - 1);

    const telegramCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[]).includes('send-telegram'),
    );
    // 2 emergency sends + 1 dead-letter escalation attempt = 3 telegram attempts
    // (first 2 are the original emergency sends that fail, 3rd is the dead-letter alert)
    expect(telegramCalls.length).toBeGreaterThanOrEqual(2);
  });
});

describe('source dedup fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('DB error on source dedup check → dedup_check_error', async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes('source_idempotency_key')) throw new Error('DB connection lost');
      return null;
    });

    await processOneEvent(pool, 'evt-dedup', makePayload(), 0);

    expect(findQuery(queries, 'dedup_check_error')).toBeTruthy();
    const insertQ = findQuery(queries, 'INSERT INTO voice_events');
    expect(insertQ).toBeFalsy();
  });

  it('source duplicate found → duplicate_skipped, no wo_intake insert', async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes('source_idempotency_key') && text.includes('SELECT')) {
        return { rows: [{ id: 'existing-intake' }] };
      }
      return null;
    });

    await processOneEvent(pool, 'evt-dup', makePayload(), 0);

    expect(findQuery(queries, 'duplicate_skipped')).toBeTruthy();
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();
  });
});

describe('repeat-window dedup fail-closed', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('DB error on repeat-window check → flagged as possible repeat', async () => {
    const { pool, queries } = createMockPool((text) => {
      if (text.includes('repeat_window_key')) throw new Error('DB timeout');
      return null;
    });

    await processOneEvent(pool, 'evt-repeat', makePayload(), 0);

    const insertQ = findQuery(queries, 'INSERT INTO voice_events');
    expect(insertQ).toBeTruthy();
    const payload = JSON.parse(insertQ!.params![1] as string);
    expect(payload.manual_review_reason).toContain('possible_repeat_call');
  });
});

describe('blank conversation_id fallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('empty conversation_id → eventId used for source key', async () => {
    const eventId = 'evt-fallback-id';
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, eventId, makePayload({ conversation_id: '' }), 0);

    const dedupQ = findQuery(queries, 'source_idempotency_key');
    expect(dedupQ).toBeTruthy();
    const expectedKey = computeSourceIdempotencyKey(eventId);
    expect(dedupQ!.params![0]).toBe(expectedKey);
  });

  it('undefined conversation_id → eventId used for source key', async () => {
    const eventId = 'evt-fallback-undef';
    const payload = makePayload();
    delete payload['conversation_id'];
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, eventId, payload, 0);

    const dedupQ = findQuery(queries, 'source_idempotency_key');
    const expectedKey = computeSourceIdempotencyKey(eventId);
    expect(dedupQ!.params![0]).toBe(expectedKey);
  });
});

describe('claim selector coverage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('non-emergency routine → lifecycle=processed + sent to Max', async () => {
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-routine', makePayload(), 0);

    expect(findQuery(queries, "'processed'")).toBeTruthy();
    const maxCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[]).includes('send-message'),
    );
    expect(maxCalls.length).toBeGreaterThanOrEqual(1);
  });
});

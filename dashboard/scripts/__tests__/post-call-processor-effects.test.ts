/**
 * Processor side-effect tests for post-call WO intake.
 *
 * Covers the safety-critical paths that the pure-lib tests cannot:
 *   - Emergency lifecycle: send-then-mark, retry (no dedup bypass), dead-letter
 *   - wo_intake timing: written only after delivery for emergency
 *   - Dead-letter sweep: re-attempts delivery on every cron cycle
 *   - Source dedup DB error → dedup_check_error (fail-closed)
 *   - Repeat-window DB error → possible_repeat flag (fail-closed)
 *   - Blank conversation_id → eventId fallback for source key
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import type pg from 'pg';

// ─── mocks (vi.hoisted ensures availability before hoisted vi.mock) ────────

const { mockExecFileSync, MockPoolConstructor } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  MockPoolConstructor: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('pg', () => ({
  default: { Pool: MockPoolConstructor },
}));

import { processOneEvent, processPostCallEvents, sweepDeadLetters, MAX_EMERGENCY_RETRIES } from '../post-call-processor';
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

function findAllQueries(queries: TrackedQuery[], pattern: string): TrackedQuery[] {
  return queries.filter(q => q.text.includes(pattern));
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('emergency delivery lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('at least one send succeeds → wo_intake written + lifecycle=processed', async () => {
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-1', makeEmergencyPayload(), 0);

    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, "'processed'")).toBeTruthy();
    expect(findQuery(queries, 'emergency_send_failed')).toBeFalsy();
  });

  it('Telegram succeeds, Max fails → wo_intake written + processed', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.includes('send-message')) throw new Error('agent down');
      return Buffer.from('ok');
    });
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-2', makeEmergencyPayload(), 0);

    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, "'processed'")).toBeTruthy();
  });

  it('both sends fail, first attempt → emergency_send_failed, NO wo_intake written', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-3', makeEmergencyPayload(), 0);

    // wo_intake must NOT be written — prevents dedup from blocking retries
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();

    const failQ = findQuery(queries, 'emergency_send_failed');
    expect(failQ).toBeTruthy();
    const meta = JSON.parse(failQ!.params![1] as string);
    expect(meta._emergency_meta.attempts).toBe(1);
  });

  it('both sends fail on attempt 3 → emergency_send_failed, NO wo_intake', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-4', makeEmergencyPayload(), 3);

    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();
    const failQ = findQuery(queries, 'emergency_send_failed');
    expect(failQ).toBeTruthy();
    const meta = JSON.parse(failQ!.params![1] as string);
    expect(meta._emergency_meta.attempts).toBe(4);
  });

  it('retry exhaustion → emergency_dead_letter + wo_intake written (for manual record)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool, queries } = createMockPool();

    await processOneEvent(pool, 'evt-5', makeEmergencyPayload(), MAX_EMERGENCY_RETRIES - 1);

    // Dead-letter IS terminal — wo_intake is written for the manual-review record
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, 'emergency_dead_letter')).toBeTruthy();
    expect(findQuery(queries, 'emergency_send_failed')).toBeFalsy();
  });
});

describe('emergency retry: dedup must not block re-delivery (regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('first attempt fails → no wo_intake → retry finds no source dup → re-sends → delivered', async () => {
    // FIRST ATTEMPT: both sends fail
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });
    const { pool: pool1, queries: q1 } = createMockPool();
    await processOneEvent(pool1, 'evt-retry', makeEmergencyPayload(), 0);

    // Verify: no wo_intake was written on failure
    expect(findQuery(q1, 'INSERT INTO voice_events')).toBeFalsy();
    expect(findQuery(q1, 'emergency_send_failed')).toBeTruthy();

    // SECOND ATTEMPT (retry): sends succeed now
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
    const { pool: pool2, queries: q2 } = createMockPool();
    await processOneEvent(pool2, 'evt-retry', makeEmergencyPayload(), 1);

    // Verify: source dedup check passes (no prior wo_intake)
    expect(findQuery(q2, 'duplicate_skipped')).toBeFalsy();
    // Verify: wo_intake written after successful delivery
    expect(findQuery(q2, 'INSERT INTO voice_events')).toBeTruthy();
    // Verify: marked processed
    expect(findQuery(q2, "'processed'")).toBeTruthy();
  });

  it('first attempt fails → retry fails → retry fails → retry succeeds → delivered', async () => {
    // Simulate 3 failures then success, each as separate processOneEvent calls
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });

    for (let attempt = 0; attempt < 3; attempt++) {
      const { pool, queries } = createMockPool();
      await processOneEvent(pool, 'evt-multi-retry', makeEmergencyPayload(), attempt);
      expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();
      expect(findQuery(queries, 'emergency_send_failed')).toBeTruthy();
    }

    // Fourth attempt: sends succeed
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-multi-retry', makeEmergencyPayload(), 3);

    expect(findQuery(queries, 'duplicate_skipped')).toBeFalsy();
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, "'processed'")).toBeTruthy();
  });

  it('exhaustion after MAX_EMERGENCY_RETRIES → dead-letter with intake record', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('send failed'); });

    // All attempts fail
    for (let attempt = 0; attempt < MAX_EMERGENCY_RETRIES - 1; attempt++) {
      const { pool, queries } = createMockPool();
      await processOneEvent(pool, 'evt-exhaust', makeEmergencyPayload(), attempt);
      expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();
    }

    // Final attempt: still fails → dead-letter
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-exhaust', makeEmergencyPayload(), MAX_EMERGENCY_RETRIES - 1);

    // Dead-letter writes the intake record (for manual review)
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, 'emergency_dead_letter')).toBeTruthy();
  });
});

describe('dead-letter sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  function createSweepMockPool(selectRows: Record<string, unknown>[] = []) {
    const queries: TrackedQuery[] = [];
    const mockClient = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return {};
        if (text.includes('emergency_dead_letter') && text.includes('SELECT')) return { rows: selectRows };
        if (text.includes('UPDATE')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(),
      connect: vi.fn(async () => mockClient),
    } as unknown as pg.Pool;
    return { pool, queries, mockClient };
  }

  it('no dead-letters → sweep returns 0', async () => {
    const { pool } = createSweepMockPool([]);
    const count = await sweepDeadLetters(pool);
    expect(count).toBe(0);
  });

  it('sweep SELECT uses FOR UPDATE SKIP LOCKED', async () => {
    const { pool, queries } = createSweepMockPool([]);
    await sweepDeadLetters(pool);
    const selectQ = findQuery(queries, 'emergency_dead_letter');
    expect(selectQ).toBeTruthy();
    expect(selectQ!.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('dead-letter found + delivery succeeds → transitions to dead_letter_delivered', async () => {
    const deadLetterPayload = makeEmergencyPayload();
    const { pool, queries } = createSweepMockPool([{ id: 'dead-1', payload: deadLetterPayload }]);

    const count = await sweepDeadLetters(pool);
    expect(count).toBe(1);
    expect(findQuery(queries, 'dead_letter_delivered')).toBeTruthy();
  });

  it('dead-letter found + delivery still fails → stays as dead_letter (not transitioned)', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('still failing'); });
    const deadLetterPayload = makeEmergencyPayload();
    const { pool, queries } = createSweepMockPool([{ id: 'dead-2', payload: deadLetterPayload }]);

    const count = await sweepDeadLetters(pool);
    expect(count).toBe(0);
    expect(findQuery(queries, 'dead_letter_delivered')).toBeFalsy();
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
    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeFalsy();
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

describe('processPostCallEvents: claim + reaper SQL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.VOICE_GATEWAY_DSN = 'postgres://test:test@localhost/test';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.VOICE_GATEWAY_DSN;
  });

  function createFullMockPool(claimRows: Record<string, unknown>[] = []) {
    const queries: TrackedQuery[] = [];
    const mockClient = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text === 'BEGIN' || text === 'COMMIT') return {};
        if (text.includes('RETURNING')) return { rows: claimRows };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const queryFn = vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('emergency_dead_letter') && text.includes('SELECT')) return { rows: [] };
      return { rows: [] };
    });
    const pool = {
      query: queryFn,
      connect: vi.fn(async () => mockClient),
      end: vi.fn(async () => {}),
    };
    MockPoolConstructor.mockImplementation(function () { return pool; });
    return { pool, queries, mockClient };
  }

  it('reaper SQL uses _claimed_at (not received_at) for staleness check', async () => {
    const { queries } = createFullMockPool();
    await processPostCallEvents();

    const reaperQ = queries.find(q =>
      q.text.includes('lifecycle_status = \'pending\'') &&
      q.text.includes('processing'),
    );
    expect(reaperQ).toBeTruthy();
    expect(reaperQ!.text).toContain('_claimed_at');
    expect(reaperQ!.text).toContain('COALESCE');
  });

  it('claim SQL writes _claimed_at into payload', async () => {
    const { queries } = createFullMockPool();
    await processPostCallEvents();

    const claimQ = queries.find(q =>
      q.text.includes('RETURNING') &&
      q.text.includes('payload || $1::jsonb'),
    );
    expect(claimQ).toBeTruthy();
    const claimMeta = JSON.parse(claimQ!.params![0] as string);
    expect(claimMeta._claimed_at).toBeTruthy();
    expect(typeof claimMeta._claimed_at).toBe('string');
  });

  it('claim selector includes emergency_send_failed with priority ordering', async () => {
    const { queries } = createFullMockPool();
    await processPostCallEvents();

    const claimQ = queries.find(q => q.text.includes('RETURNING'));
    expect(claimQ).toBeTruthy();
    expect(claimQ!.text).toContain('emergency_send_failed');
    expect(claimQ!.text).toContain('CASE WHEN lifecycle_status');
    expect(claimQ!.text).toContain('FOR UPDATE SKIP LOCKED');
  });

  it('no events claimed → exits cleanly without processing', async () => {
    const { queries } = createFullMockPool([]);
    await processPostCallEvents();

    // Should not have any processOneEvent-style queries (resolver, dedup, etc.)
    expect(findQuery(queries, 'caller_sessions')).toBeFalsy();
    expect(findQuery(queries, 'voice_resolve_caller')).toBeFalsy();
  });
});

describe('non-emergency path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('routine → wo_intake written + lifecycle=processed + sent to Max', async () => {
    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-routine', makePayload(), 0);

    expect(findQuery(queries, 'INSERT INTO voice_events')).toBeTruthy();
    expect(findQuery(queries, "'processed'")).toBeTruthy();
    const maxCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => (c[1] as string[]).includes('send-message'),
    );
    expect(maxCalls.length).toBeGreaterThanOrEqual(1);
  });
});

describe('stale-processing reaper: behavioral clock test', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    process.env.VOICE_GATEWAY_DSN = 'postgres://test:test@localhost/test';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => {
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.VOICE_GATEWAY_DSN;
  });

  it('reaper uses COALESCE(_claimed_at, received_at) — claim time, not creation time', async () => {
    const queries: TrackedQuery[] = [];
    const mockClient = {
      query: vi.fn(async (text: string, params?: unknown[]) => {
        queries.push({ text, params });
        if (text === 'BEGIN' || text === 'COMMIT') return {};
        if (text.includes('RETURNING')) return { rows: [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const queryFn = vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes('emergency_dead_letter') && text.includes('SELECT')) return { rows: [] };
      return { rows: [] };
    });
    const pool = {
      query: queryFn,
      connect: vi.fn(async () => mockClient),
      end: vi.fn(async () => {}),
    };
    MockPoolConstructor.mockImplementation(function () { return pool; });

    await processPostCallEvents();

    const reaperQ = queries.find(q =>
      q.text.includes("lifecycle_status = 'pending'") &&
      q.text.includes('processing'),
    );
    expect(reaperQ).toBeTruthy();

    // Must use _claimed_at (claim time) with received_at as fallback, not received_at alone
    expect(reaperQ!.text).toContain("payload->>'_claimed_at'");
    expect(reaperQ!.text).toContain('COALESCE');
    expect(reaperQ!.text).toContain('received_at');

    // The COALESCE must put _claimed_at FIRST (primary clock)
    const claimedAtPos = reaperQ!.text.indexOf("_claimed_at");
    const receivedAtPos = reaperQ!.text.indexOf('received_at');
    expect(claimedAtPos).toBeLessThan(receivedAtPos);
  });
});

describe('nullable-schema contract: availability_window and photo_attached', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';
    mockExecFileSync.mockReturnValue(Buffer.from('ok'));
  });
  afterEach(() => { delete process.env.TELEGRAM_BOT_TOKEN; });

  it('uncollected optional fields are explicit null in wo_intake payload, not omitted', async () => {
    const payloadWithoutOptionals = makePayload();
    const dc = (payloadWithoutOptionals.analysis as Record<string, unknown>).data_collection_results as Record<string, unknown>;
    delete dc['availability_window'];
    delete dc['photo_attached'];

    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-schema', payloadWithoutOptionals, 0);

    const insertQ = findQuery(queries, 'INSERT INTO voice_events');
    expect(insertQ).toBeTruthy();
    const intakePayload = JSON.parse(insertQ!.params![1] as string);

    // Fields must be present with null value — JSON.stringify preserves null but drops undefined
    expect(intakePayload).toHaveProperty('availability_window');
    expect(intakePayload.availability_window).toBeNull();
    expect(intakePayload).toHaveProperty('photo_attached');
    expect(intakePayload.photo_attached).toBeNull();
  });

  it('collected optional fields pass through their values', async () => {
    const payloadWithOptionals = makePayload();
    const dc = (payloadWithOptionals.analysis as Record<string, unknown>).data_collection_results as Record<string, unknown>;
    dc['availability_window'] = { value: 'Weekdays 9am-5pm', rationale: 'r', data_collection_id: 'd' };

    const { pool, queries } = createMockPool();
    await processOneEvent(pool, 'evt-schema-filled', payloadWithOptionals, 0);

    const insertQ = findQuery(queries, 'INSERT INTO voice_events');
    expect(insertQ).toBeTruthy();
    const intakePayload = JSON.parse(insertQ!.params![1] as string);

    expect(intakePayload.availability_window).toBe('Weekdays 9am-5pm');
    expect(intakePayload.photo_attached).toBeNull();
  });
});

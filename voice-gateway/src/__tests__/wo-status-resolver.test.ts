import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';

const TEST_PORT = 18788;
const TOOL_SECRET = 'test-secret-token';

const mockQuery = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: class {
      query = mockQuery;
      end = vi.fn();
    },
  },
}));

function postLookup(body: Record<string, unknown>): Promise<{ status: number; result: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path: '/voice/tools/lookup_record', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${TOOL_SECRET}` } },
      (res) => {
        let body = '';
        res.on('data', (c: string) => body += c);
        res.on('end', () => {
          try { resolve({ status: res.statusCode ?? 0, result: JSON.parse(body).result ?? '' }); }
          catch { resolve({ status: res.statusCode ?? 0, result: body }); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

const MATCHED_RESOLVED = {
  matched: true, resolved_type: 'tenant', display_name: 'Jane Doe',
  contact_id: 'c1', occupancy_id: 'o1', unit_id: 'u1',
  unit_label: 'Unit 4', property_id: 'p1', property_label: '72 Cherry',
  has_active_occupancy: true, ambiguous: false,
};

beforeAll(async () => {
  process.env.PORT = String(TEST_PORT);
  process.env.ELEVENLABS_TOOL_SECRET = TOOL_SECRET;
  process.env.VOICE_GATEWAY_DSN = 'postgresql://test:test@localhost:5432/test';
  await import('../../src/index');
  await new Promise(r => setTimeout(r, 200));
});

afterAll(() => {
  mockQuery.mockReset();
});

describe('work_order_status resolver-failure matrix', () => {

  it('cache fail + resolve fail → take-a-message (not generic unmatched)', async () => {
    mockQuery.mockRejectedValue(new Error('DB down'));

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('take a message');
    expect(res.result).not.toContain('can still help');
  });

  it('clean no-match → generic unmatched greeting', async () => {
    mockQuery.mockResolvedValue({ rows: [] });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('can still help');
  });

  it('cache hit → resolverFailed cleared, WO query proceeds (no vendor)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Leaky faucet', job_description: null, status: 'assigned', scheduled_start: null, has_vendor: false },
      ] };
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('Leaky faucet');
    expect(res.result).toContain('assigned to a technician');
    expect(res.result).not.toContain('vendor');
    expect(res.result).not.toContain('take a message');
  });

  it('vendor assigned → "assigned to a vendor who will be reaching out"', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Fridge not cooling', job_description: null, status: 'assigned', scheduled_start: null, has_vendor: true },
      ] };
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('Fridge not cooling');
    expect(res.result).toContain('assigned to a vendor who will be reaching out');
    expect(res.result).toContain('Based on our records');
  });

  it('vendor assigned + non-assigned status → vendor suffix appended', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Door hinge', job_description: null, status: 'new', scheduled_start: null, has_vendor: true },
      ] };
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('being reviewed by our team');
    expect(res.result).toContain('a vendor has been assigned and will be reaching out');
  });

  it('resolve success after cache miss → resolverFailed cleared, WO query proceeds', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions') && sql.includes('SELECT')) return { rows: [] };
      if (sql.includes('voice_resolve_caller')) return { rows: [{ r: MATCHED_RESOLVED }] };
      if (sql.includes('caller_sessions') && sql.includes('INSERT')) return { rows: [] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Broken window', job_description: null, status: 'new', scheduled_start: null, has_vendor: false },
      ] };
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('Broken window');
    expect(res.result).toContain('being reviewed');
    expect(res.result).not.toContain('take a message');
  });
});

describe('balance JSONB extraction and disclosure gates', () => {
  const BALANCE_RESULT = {
    open_total: 1250.00,
    has_open_charges: true,
    gate_open: true,
    as_of: '2026-07-10T00:00:00.000Z',
  };

  function balanceMock(agingResult: unknown) {
    return async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('voice_balance_aging')) return { rows: [{ result: agingResult }] };
      return { rows: [] };
    };
  }

  it('verified caller with JSONB result → reads aged balance with hedge', async () => {
    mockQuery.mockImplementation(balanceMock(BALANCE_RESULT));

    const res = await postLookup({ caller_number: '+14155551234', query: 'balance' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('$1,250.00');
    expect(res.result).toMatch(/July \d+/);
    expect(res.result).toContain('may not yet be reflected');
  });

  it('null JSONB result → fallback to accounting, no amount disclosed', async () => {
    mockQuery.mockImplementation(balanceMock(null));

    const res = await postLookup({ caller_number: '+14155551234', query: 'balance' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('accounting team');
    expect(res.result).not.toMatch(/\$[\d,]+/);
  });

  it('DB error → fallback to accounting, no amount disclosed', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('voice_balance_aging')) throw new Error('DB down');
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'balance' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('accounting team');
    expect(res.result).not.toMatch(/\$[\d,]+/);
  });

  it('gate_open=false → routes to accounting, does NOT disclose amount', async () => {
    mockQuery.mockImplementation(balanceMock({
      ...BALANCE_RESULT,
      gate_open: false,
    }));

    const res = await postLookup({ caller_number: '+14155551234', query: 'balance' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('recent charge');
    expect(res.result).toContain('accounting team');
    expect(res.result).not.toMatch(/\$[\d,]+/);
  });

  it('no open charges → reports no outstanding balance', async () => {
    mockQuery.mockImplementation(balanceMock({
      ...BALANCE_RESULT,
      has_open_charges: false,
      open_total: 0,
    }));

    const res = await postLookup({ caller_number: '+14155551234', query: 'balance' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('no outstanding balance');
    expect(res.result).not.toMatch(/\$[\d,]+\.\d{2}/);
  });

  it('request_handoff → no callback number in response', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('voice_events')) return { rows: [] };
      return { rows: [] };
    });

    const res = await postLookup({
      caller_number: '+14155551234', query: 'request_handoff',
      reason: 'billing', callback: '+14155559999',
    });
    expect(res.status).toBe(200);
    expect(res.result).toContain('connecting you');
    expect(res.result).not.toContain('+1415');
    expect(res.result).not.toContain('best number');
  });
});

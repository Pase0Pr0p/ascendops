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

describe('work_order_status resolver-failure matrix', () => {
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

  it('cache hit → resolverFailed cleared, WO query proceeds', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Leaky faucet', job_description: null, status: 'assigned', scheduled_start: null },
      ] };
      return { rows: [] };
    });

    const res = await postLookup({ caller_number: '+14155551234', query: 'work_order_status' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('Leaky faucet');
    expect(res.result).toContain('Based on our records');
    expect(res.result).not.toContain('take a message');
  });

  it('resolve success after cache miss → resolverFailed cleared, WO query proceeds', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions') && sql.includes('SELECT')) return { rows: [] };
      if (sql.includes('voice_resolve_caller')) return { rows: [{ r: MATCHED_RESOLVED }] };
      if (sql.includes('caller_sessions') && sql.includes('INSERT')) return { rows: [] };
      if (sql.includes('work_orders')) return { rows: [
        { work_order_issue: 'Broken window', job_description: null, status: 'new', scheduled_start: null },
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

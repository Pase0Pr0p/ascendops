import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';

const TEST_PORT = 28788;
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

function postWoIntake(body: Record<string, unknown>): Promise<{ status: number; result: string; ok?: boolean }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path: '/voice/tools/open_work_order', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data),
          Authorization: `Bearer ${TOOL_SECRET}` } },
      (res) => {
        let body = '';
        res.on('data', (c: string) => body += c);
        res.on('end', () => {
          try {
            const parsed = JSON.parse(body);
            resolve({ status: res.statusCode ?? 0, result: parsed.result ?? '', ok: parsed.ok });
          }
          catch { resolve({ status: res.statusCode ?? 0, result: body }); }
        });
      },
    );
    req.on('error', reject);
    req.end(data);
  });
}

function postWoIntakeNoAuth(body: Record<string, unknown>): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      { hostname: '127.0.0.1', port: TEST_PORT, path: '/voice/tools/open_work_order', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => {
        let body = '';
        res.on('data', (c: string) => body += c);
        res.on('end', () => resolve({ status: res.statusCode ?? 0 }));
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

describe('open_work_order intake', () => {
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

  it('rejects request without bearer token', async () => {
    const res = await postWoIntakeNoAuth({ caller_number: '+14155551234', issue_description: 'Broken sink' });
    expect(res.status).toBe(401);
  });

  it('returns prompt when issue_description is empty', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    const res = await postWoIntake({ caller_number: '+14155551234', issue_description: '' });
    expect(res.status).toBe(200);
    expect(res.result).toContain('description of the issue');
  });

  it('identified caller → wo_intake event with AppFolio IDs', async () => {
    const insertCalls: Array<[string, unknown[]]> = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('units')) return { rows: [{ appfolio_unit_id: 1001, appfolio_property_id: 2001, appfolio_occupancy_id: 3001 }] };
      if (sql.includes('voice_events')) {
        insertCalls.push([sql, params ?? []]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Kitchen faucet leaking',
      location_detail: 'under the kitchen sink',
      severity: 'normal',
      permission_to_enter: true,
      call_id: 'call-abc-123',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('maintenance request');
    expect(res.result).toContain('kitchen faucet leaking');
    expect(res.result).toContain('follow up');

    expect(insertCalls.length).toBe(1);
    const [, insertParams] = insertCalls[0];
    expect(insertParams[0]).toBe('wo_intake');
    expect(insertParams[1]).toBe('call-abc-123');
    const payload = JSON.parse(insertParams[2] as string);
    expect(payload.identified).toBe(true);
    expect(payload.tenant_name).toBe('Jane Doe');
    expect(payload.appfolio_unit_id).toBe(1001);
    expect(payload.appfolio_property_id).toBe(2001);
    expect(payload.appfolio_occupancy_id).toBe(3001);
    expect(payload.appfolio_ready).toBe(true);
    expect(payload.contact_id).toBe('c1');
    expect(payload.timestamp_utc).toBeDefined();
    expect(payload.permission_to_enter).toBe(true);
    expect(payload.location_detail).toBe('under the kitchen sink');
  });

  it('unidentified caller → wo_intake event with identified=false', async () => {
    const insertCalls: Array<[string, unknown[]]> = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('caller_sessions')) return { rows: [] };
      if (sql.includes('voice_resolve_caller')) return { rows: [{ r: { matched: false } }] };
      if (sql.includes('voice_events')) {
        insertCalls.push([sql, params ?? []]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155559999',
      issue_description: 'Window won\'t close',
      severity: 'normal',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('wasn\'t able to pull up your account');
    expect(res.result).toContain('follow up');

    expect(insertCalls.length).toBe(1);
    const payload = JSON.parse(insertCalls[0][1][2] as string);
    expect(payload.identified).toBe(false);
    expect(payload.issue_description).toBe('Window won\'t close');
  });

  it('DB failure on resolver → still captures unidentified intake', async () => {
    let capturedInsert = false;
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) throw new Error('DB down');
      if (sql.includes('voice_events')) { capturedInsert = true; return { rows: [] }; }
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Heater not working',
      severity: 'urgent',
    });

    expect(res.status).toBe(200);
    expect(capturedInsert).toBe(true);
  });

  it('DB failure on event insert → graceful error message', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('units')) return { rows: [{ appfolio_unit_id: 1001, appfolio_property_id: 2001, appfolio_occupancy_id: null }] };
      if (sql.includes('voice_events')) throw new Error('DB write failed');
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Smoke detector beeping',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('having trouble');
    expect(res.result).toContain('call you back');
  });

  it('AppFolio ID lookup failure → event flagged appfolio_ready=false, confirmation says "verify"', async () => {
    const insertCalls: Array<[string, unknown[]]> = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('units')) throw new Error('units table inaccessible');
      if (sql.includes('voice_events')) {
        insertCalls.push([sql, params ?? []]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Garbage disposal jammed',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('verify');
    expect(res.result).not.toContain('submitted your maintenance request');

    const payload = JSON.parse(insertCalls[0][1][2] as string);
    expect(payload.identified).toBe(true);
    expect(payload.appfolio_ready).toBe(false);
    expect(payload.appfolio_unit_id).toBeNull();
    expect(payload.appfolio_property_id).toBeNull();
  });

  it('severity defaults to normal when omitted', async () => {
    const insertCalls: Array<[string, unknown[]]> = [];
    mockQuery.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: MATCHED_RESOLVED }] };
      if (sql.includes('units')) return { rows: [{ appfolio_unit_id: 1001, appfolio_property_id: 2001, appfolio_occupancy_id: 3001 }] };
      if (sql.includes('voice_events')) {
        insertCalls.push([sql, params ?? []]);
        return { rows: [] };
      }
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Doorbell not working',
    });

    expect(res.status).toBe(200);
    const payload = JSON.parse(insertCalls[0][1][2] as string);
    expect(payload.severity).toBe('normal');
    expect(payload.appfolio_ready).toBe(true);
  });

  it('Amanda-scope caller → redirected, no intake captured', async () => {
    const amandaResolved = { ...MATCHED_RESOLVED, routing_scope: 'amanda' };
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: amandaResolved }] };
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Broken window',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('property management team');
    expect(res.result).not.toContain('maintenance request');
  });

  it('paused-scope caller → redirected, no intake captured', async () => {
    const pausedResolved = { ...MATCHED_RESOLVED, routing_scope: 'paused' };
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: pausedResolved }] };
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'Leak in bathroom',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('property management team');
  });

  it('inactive tenant → rejected, no intake captured', async () => {
    const inactiveResolved = { ...MATCHED_RESOLVED, has_active_occupancy: false, occupancy_id: null };
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('caller_sessions')) return { rows: [{ resolved: inactiveResolved }] };
      return { rows: [] };
    });

    const res = await postWoIntake({
      caller_number: '+14155551234',
      issue_description: 'AC not working',
    });

    expect(res.status).toBe(200);
    expect(res.result).toContain('former resident');
    expect(res.result).toContain('current property manager');
  });
});

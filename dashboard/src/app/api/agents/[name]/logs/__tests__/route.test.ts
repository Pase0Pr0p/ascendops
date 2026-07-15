/**
 * dashboard/src/app/api/agents/[name]/logs/__tests__/route.test.ts
 *
 * End-to-end regression guard for GET /api/agents/[name]/logs (finding #17:
 * the route served stdout.log raw off-host). Asserts the GET handler actually
 * scrubs SSNs from the served content — a future edit that drops the scrub
 * goes red here. Also pins the load-bearing ORDER (strip-ANSI BEFORE scrub):
 * an ANSI escape interleaved in a digit run would break \b\d{9}\b and evade a
 * pre-strip scrub.
 *
 * RUNS IN CI, RED LOCALLY: importing the route transitively loads `next/server`
 * and the native `better-sqlite3` (via agents.ts -> tasks -> db). CI installs
 * dashboard deps (`npm ci --prefix dashboard`) so both resolve; the local
 * monorepo node_modules does not, so this file is local-red / CI-green — the
 * same posture as the existing dashboard route tests (fire-route, health-route,
 * media-route, comms routes). The lib-level oracle + ordering tests in
 * src/lib/__tests__/redact-ssn.test.ts are the locally-verifiable companions.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextRequest } from 'next/server';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'logs-route-ssn-'));
process.env.CTX_ROOT = tmpDir;

const AGENT = 'collie-test';
const logsDir = path.join(tmpDir, 'logs', AGENT);

type LogsRouteModule = typeof import('../route');
let route: LogsRouteModule;

beforeAll(async () => {
  fs.mkdirSync(logsDir, { recursive: true });
  route = await import('../route');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getLogs(type: string): Promise<string> {
  const req = new NextRequest(
    `http://localhost/api/agents/${AGENT}/logs?type=${type}&lines=500`,
  );
  const params = Promise.resolve({ name: AGENT });
  const res = await route.GET(req, { params });
  return res.text();
}

describe('GET /api/agents/[name]/logs — SSN read-scrub (finding #17 regression guard)', () => {
  it('redacts an ANSI-interleaved bare-9 SSN (scrub runs AFTER strip-ANSI)', async () => {
    fs.writeFileSync(path.join(logsDir, 'stdout.log'), 'tenant 987\x1b[0m654321 on file\n');
    const body = await getLogs('stdout');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).not.toContain('987654321');
  });

  it('redacts a context-keyed bare-9 with a FAR label (R2, aggressive closes it)', async () => {
    fs.writeFileSync(
      path.join(logsDir, 'stdout.log'),
      'social security number recorded earlier in this file, value 987654321 here\n',
    );
    const body = await getLogs('stdout');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).not.toContain('987654321');
  });

  it('redacts a formatted SSN and leaves a 10-digit phone intact', async () => {
    fs.writeFileSync(path.join(logsDir, 'stdout.log'), 'ssn 123-45-6789 phone 423-555-0142\n');
    const body = await getLogs('stdout');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).not.toContain('123-45-6789');
    expect(body).toContain('423-555-0142');
  });

  it('scrubs stderr.log too (connector output also flows to stderr)', async () => {
    fs.writeFileSync(path.join(logsDir, 'stderr.log'), 'err ssn 987654321 trace\n');
    const body = await getLogs('stderr');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).not.toContain('987654321');
  });

  it('returns ordinary log content unchanged when no SSN is present', async () => {
    fs.writeFileSync(path.join(logsDir, 'stdout.log'), 'plain log line, exit 0, ref 1234\n');
    const body = await getLogs('stdout');
    expect(body).toContain('plain log line, exit 0, ref 1234');
    expect(body).not.toContain('[REDACTED-SSN]');
  });
});

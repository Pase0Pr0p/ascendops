/**
 * dashboard/src/app/api/media/[...filepath]/__tests__/route.test.ts
 *
 * Regression guard for finding #18: the generic media file-server served raw
 * stdout.log (it resolves any path under CTX_ROOT, and CTX_ROOT/logs was not
 * denied). The dedicated /api/agents/[name]/logs route is the EXCLUSIVE,
 * SSN-scrubbed door to log content; this asserts the media route denies
 * anything resolving under CTX_ROOT/logs — on the RESOLVED realpath, so a
 * symlink/`..` that resolves into logs cannot bypass it.
 *
 * RUNS IN CI, RED LOCALLY: the media route imports next/server, marked, and
 * isomorphic-dompurify — installed by `npm ci --prefix dashboard` in CI, absent
 * from the root node_modules locally. Same local-red / CI-green posture as the
 * other dashboard route tests.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { NextRequest } from 'next/server';

const tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'media-route-ssn-')));
process.env.CTX_ROOT = tmpDir;

const AGENT = 'collie-test';
const agentLogsDir = path.join(tmpDir, 'logs', AGENT);

type MediaRouteModule = typeof import('../route');
let route: MediaRouteModule;

beforeAll(async () => {
  fs.mkdirSync(agentLogsDir, { recursive: true });
  fs.writeFileSync(path.join(agentLogsDir, 'stdout.log'), 'tenant SSN: 987654321 raw\n');
  fs.writeFileSync(path.join(agentLogsDir, 'stderr.log'), 'err 987654321 trace\n');
  // A legitimate non-log deliverable directly under CTX_ROOT (control: served).
  fs.writeFileSync(path.join(tmpDir, 'note.txt'), 'ordinary deliverable\n');
  // SSN-bearing text deliverables for the raw-branch scrub regression (finding:
  // raw fallthrough served .md/.txt/.csv verbatim, unscrubbed, off-host).
  fs.writeFileSync(path.join(tmpDir, 'ssn-doc.md'), '# Deliverable\n\nTenant SSN: 123-45-6789 and bare 987654321 here.\n');
  fs.writeFileSync(path.join(tmpDir, 'ssn-doc.csv'), 'name,ssn\nJohn Doe,123-45-6789\nJane Roe,987654321\n');
  fs.writeFileSync(path.join(tmpDir, 'ssn-doc.txt'), 'SSN on file: 123-45-6789\n');
  // Marker-split SSN: reassembles only when markdown is RENDERED (render branch).
  fs.writeFileSync(path.join(tmpDir, 'ssn-split.md'), 'Tenant SSN: 123-45-*6789* on record.\n');
  // Binary control: a PNG header followed by an ASCII 9-digit run. Proves the
  // binary path is byte-identical (no utf8 decode + scrub corruption).
  fs.writeFileSync(
    path.join(tmpDir, 'pic.png'),
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('123456789 binary tail')]),
  );
  // SVG with an SSN in <text> content AND a 9-digit coordinate attribute: the
  // text-node-only scrub must redact the former and preserve the latter.
  fs.writeFileSync(
    path.join(tmpDir, 'ssn-pic.svg'),
    '<svg viewBox="0 0 123456789 100"><rect x="987654321"/><text x="10">SSN 123-45-6789</text></svg>',
  );
  // SVG hiding the SSN in CDATA + an entity-encoded form: the served bytes must
  // redact both (the route serves SVG inline, so both render to the human).
  fs.writeFileSync(
    path.join(tmpDir, 'ssn-encoded.svg'),
    '<svg><text><![CDATA[SSN 123-45-6789]]></text><text>&#49;&#50;&#51;-45-6789</text></svg>',
  );
  // A symlink under an allowed root (CTX_ROOT) that RESOLVES into logs/.
  try {
    fs.symlinkSync(path.join(agentLogsDir, 'stdout.log'), path.join(tmpDir, 'sneaky.txt'));
  } catch {
    /* symlink may be unsupported on some CI FS; that case is covered by the direct denies */
  }
  route = await import('../route');
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function getMedia(segments: string[], render = false): Promise<Response> {
  const qs = render ? '?render=true' : '';
  const req = new NextRequest(`http://localhost/api/media/${segments.join('/')}${qs}`);
  const params = Promise.resolve({ filepath: segments });
  return route.GET(req, { params });
}

describe('GET /api/media/[...filepath] — logs are denied (finding #18 regression)', () => {
  it('denies stdout.log under CTX_ROOT/logs (404, not raw content)', async () => {
    const res = await getMedia(['logs', AGENT, 'stdout.log']);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('987654321');
  });

  it('denies stderr.log under CTX_ROOT/logs', async () => {
    const res = await getMedia(['logs', AGENT, 'stderr.log']);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('987654321');
  });

  it('denies a symlink that RESOLVES into logs/ (realpath deny, not requested-path)', async () => {
    if (!fs.existsSync(path.join(tmpDir, 'sneaky.txt'))) return; // symlink unsupported, skip
    const res = await getMedia(['sneaky.txt']);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain('987654321');
  });

  it('still serves a legitimate non-log file under CTX_ROOT (control)', async () => {
    const res = await getMedia(['note.txt']);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('ordinary deliverable');
  });
});

describe('GET /api/media/[...filepath] — text deliverables scrub SSNs on BOTH branches', () => {
  // RAW branch (no ?render): served verbatim as text/plain inline — the door
  // "Open in new tab" hits. Must scrub every text content type.
  it('RAW .md is scrubbed (formatted + bare-9)', async () => {
    const res = await getMedia(['ssn-doc.md']);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('123-45-6789');
    expect(body).not.toContain('987654321');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).toContain('# Deliverable'); // non-SSN content preserved
  });

  it('RAW .csv is scrubbed (sibling text type, not just .md)', async () => {
    const res = await getMedia(['ssn-doc.csv']);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('123-45-6789');
    expect(body).not.toContain('987654321');
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).toContain('name,ssn'); // header preserved
  });

  it('RAW .txt is scrubbed', async () => {
    const res = await getMedia(['ssn-doc.txt']);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain('123-45-6789');
    expect(body).toContain('[REDACTED-SSN]');
  });

  // RENDER branch (?render=true) on .md: markup-aware scrub catches a marker-
  // split SSN that reassembles in the rendered HTML.
  it('RENDER .md scrubs a marker-split SSN (markup-aware, no regression)', async () => {
    const res = await getMedia(['ssn-split.md'], true);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(res.headers.get('Content-Type')).toContain('text/html');
    // After markdown render the emphasis markers become tags; the digits must not reassemble.
    const stripped = body.replace(/<[^>]*>/g, '');
    expect(stripped).not.toMatch(/123-45-6789/);
    expect(body).toContain('[REDACTED-SSN]');
  });

  // BINARY control: a PNG is NOT utf8-decoded/scrubbed — bytes are identical, so
  // the 9-digit ASCII run in the binary tail survives unchanged (proves the
  // text-vs-binary gate; scrubbing a binary would corrupt it).
  it('BINARY .png passes through byte-identical (not scrubbed/corrupted)', async () => {
    const res = await getMedia(['pic.png']);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/png');
    const buf = Buffer.from(await res.arrayBuffer());
    const original = fs.readFileSync(path.join(tmpDir, 'pic.png'));
    expect(buf.equals(original)).toBe(true);
    expect(buf.includes(Buffer.from('123456789'))).toBe(true); // not redacted in binary
  });

  it('SVG redacts <text> SSN but preserves 9-digit geometry attributes', async () => {
    const res = await getMedia(['ssn-pic.svg']);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    const body = await res.text();
    expect(body).not.toContain('123-45-6789'); // visible <text> SSN redacted
    expect(body).toContain('[REDACTED-SSN]');
    expect(body).toContain('viewBox="0 0 123456789 100"'); // geometry untouched
    expect(body).toContain('x="987654321"'); // coordinate attribute untouched
  });

  it('SVG redacts CDATA-hidden AND entity-encoded SSNs (all rendered forms)', async () => {
    const res = await getMedia(['ssn-encoded.svg']);
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('image/svg+xml');
    const body = await res.text();
    expect(body).not.toContain('123-45-6789'); // CDATA form redacted
    expect(body).toContain('[REDACTED-SSN]');
    // entity-encoded form: no decimal-entity SSN survives in the served bytes
    const rendered = body.replace(/<[^>]*>/g, '').replace(/&#(\d+);/g, (_m, d) => String.fromCodePoint(+d));
    expect(rendered).not.toMatch(/123-45-6789/);
  });
});

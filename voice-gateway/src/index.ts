/**
 * voice-gateway v0 — pure capture only
 *
 * Receives Telnyx signed webhooks, verifies Ed25519 signature, and inserts
 * the raw event into voice_events via VOICE_GATEWAY_DSN (node-postgres).
 *
 * Routes (David playbook Step 12):
 *   GET  /health                         — liveness check, no auth
 *   POST /voice/call-status              — Telnyx call-status events (Ed25519)
 *   POST /voice/conversation-insights    — Telnyx post-call AI summary (Ed25519)
 *   POST /webhook/telnyx/transcript      — Telnyx real-time transcript (Ed25519)
 *   POST /webhook/telnyx/sms             — Telnyx SMS delivery events (Ed25519)
 *   POST /voice/tools/lookup_record      — stub 501 (deferred to joint design)
 *   POST /voice/outbound                 — stub 501 (approval gate required first)
 *
 * Deferred (joint design session with Albie): contact-resolution, comms_log
 * writes, mid-call lookups, per-call approval ledger, WO writes.
 */

import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';
import { readFileSync } from 'fs';
import http from 'http';
import pg from 'pg';

const __dir = dirname(fileURLToPath(import.meta.url));

function loadEnv(filePath: string): void {
  try {
    const lines = readFileSync(filePath, 'utf8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && !(key in process.env)) process.env[key] = val;
    }
  } catch { /* missing file is fine — prod injects via Railway env vars */ }
}

// Dev: load from local secrets files. Prod: env vars provided by Railway.
loadEnv(resolve(__dir, '../../orgs/paseo-pm/secrets.env'));
loadEnv(resolve(__dir, '../../orgs/paseo-pm/agents/claudia/.env'));

const pool = new pg.Pool({ connectionString: process.env.VOICE_GATEWAY_DSN });

async function verifyTelnyxSig(
  sig: string,
  timestamp: string,
  rawBody: Buffer,
  pubKeyB64: string,
): Promise<boolean> {
  try {
    // Telnyx sends 32-byte raw Ed25519 public key as base64 (44 chars).
    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(pubKeyB64, 'base64'),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
    // Signed message: timestamp + "|" + rawBody (Telnyx signature spec)
    const message = Buffer.concat([Buffer.from(timestamp + '|', 'utf8'), rawBody]);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, Buffer.from(sig, 'base64'), message);
  } catch {
    return false;
  }
}

async function captureEvent(
  eventType: string,
  sourceEventId: string | null,
  payload: unknown,
): Promise<void> {
  await pool.query(
    'INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ($1, $2, $3)',
    [eventType, sourceEventId, JSON.stringify(payload)],
  );
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extractCallControlId(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const data = b['data'] as Record<string, unknown> | undefined;
    const payload = data?.['payload'] as Record<string, unknown> | undefined;
    const id = payload?.['call_control_id'];
    if (typeof id === 'string') return id;
  }
  return null;
}

function extractSmsId(body: unknown): string | null {
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>;
    const data = b['data'] as Record<string, unknown> | undefined;
    const payload = data?.['payload'] as Record<string, unknown> | undefined;
    const id = payload?.['id'];
    if (typeof id === 'string') return id;
  }
  return null;
}

type ExtractFn = (body: unknown) => string | null;

function makeTelnyxHandler(eventType: string, extractId: ExtractFn) {
  return async (req: http.IncomingMessage, rawBody: Buffer, res: http.ServerResponse) => {
    const pubKey = process.env.TELNYX_PUBLIC_KEY;
    if (!pubKey) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'TELNYX_PUBLIC_KEY not configured' }));
      return;
    }

    const sig = req.headers['telnyx-signature-ed25519'] as string | undefined;
    const ts = req.headers['telnyx-timestamp'] as string | undefined;
    if (!sig || !ts) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing_signature_headers' }));
      return;
    }

    const valid = await verifyTelnyxSig(sig, ts, rawBody, pubKey);
    if (!valid) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
    } catch {
      payload = rawBody.toString('utf8');
    }

    try {
      await captureEvent(eventType, extractId(payload), payload);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[voice-gateway] voice_events insert error [${eventType}]: ${msg}`);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'db_error' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  };
}

const HANDLERS = new Map<string, ReturnType<typeof makeTelnyxHandler>>([
  ['/voice/call-status', makeTelnyxHandler('call_status', extractCallControlId)],
  ['/voice/conversation-insights', makeTelnyxHandler('conversation_insights', extractCallControlId)],
  ['/webhook/telnyx/transcript', makeTelnyxHandler('transcript', extractCallControlId)],
  ['/webhook/telnyx/sms', makeTelnyxHandler('sms', extractSmsId)],
]);

const PORT = parseInt(process.env.PORT ?? '8788', 10);

const server = http.createServer(async (req, res) => {
  let rawBody: Buffer;
  try {
    rawBody = await readBody(req);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'body_read_error' }));
    return;
  }

  const method = req.method ?? 'GET';
  const url = (req.url ?? '/').split('?')[0];

  if (method === 'GET' && url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: 'voice-gateway', version: 'v0' }));
    return;
  }

  if (method === 'POST') {
    const handler = HANDLERS.get(url);
    if (handler) {
      await handler(req, rawBody, res);
      return;
    }

    if (url === '/voice/tools/lookup_record') {
      // Mid-call lookup — deferred to joint design session
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_implemented_v0', note: 'mid-call lookups deferred to joint design session' }));
      return;
    }

    if (url === '/voice/outbound') {
      // Outbound dial — per-call approval gate is mandatory; implementation deferred
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not_implemented_v0', note: 'outbound dial requires approval gate — deferred to joint design session' }));
      return;
    }
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'not_found' }));
});

server.listen(PORT, () => {
  console.log(`[voice-gateway] v0 listening on :${PORT}`);
});

process.on('SIGTERM', () => { server.close(); void pool.end(); });
process.on('SIGINT', () => { server.close(); void pool.end(); });

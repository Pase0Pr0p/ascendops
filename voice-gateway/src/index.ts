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

import http from 'http';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { timingSafeEqual } from 'crypto';
import pg from 'pg';
// Env vars: Railway injects in prod. Dev: source orgs/paseo-pm/secrets.env before running.

// Supabase pooler CA cert (staged at voice-gateway/certs/supabase-ca.pem).
// __dirname in CJS compiled output = <deploy_root>/dist/ → ../certs/ = <deploy_root>/certs/
const _caCert = readFileSync(resolve(__dirname, '../certs/supabase-ca.pem')).toString();

// pg v8: sslmode=require in DSN overrides the ssl option, causing cert rejection on Supabase pooler.
// Strip sslmode from the DSN and pass ssl config explicitly.
const _dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({ connectionString: _dsn, ssl: { ca: _caCert, rejectUnauthorized: true } });

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

// ElevenLabs post-call webhook: HMAC-SHA256
// Header: elevenlabs-signature: t=<unix_seconds>,v0=<hmac-sha256-hex>
// Signed message: "${timestamp}.${rawBody}"
async function verifyElevenLabsSig(
  sigHeader: string,
  rawBody: Buffer,
  secret: string,
): Promise<boolean> {
  try {
    const pairs = sigHeader.split(',');
    const tPart = pairs.find(p => p.startsWith('t='));
    const v0Part = pairs.find(p => p.startsWith('v0='));
    if (!tPart || !v0Part) return false;
    const timestamp = tPart.substring(2);

    // Reject stale requests (30-minute tolerance, same as ElevenLabs SDK)
    const now = Math.floor(Date.now() / 1000);
    if (Math.abs(now - parseInt(timestamp, 10)) > 1800) return false;

    const key = await crypto.subtle.importKey(
      'raw',
      Buffer.from(secret, 'utf8'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const message = Buffer.from(`${timestamp}.${rawBody.toString('utf8')}`, 'utf8');
    const sig = await crypto.subtle.sign('HMAC', key, message);
    const computed = 'v0=' + Buffer.from(sig).toString('hex');

    const a = Buffer.from(computed);
    const b = Buffer.from(v0Part);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Constant-time bearer token check for ElevenLabs tool calls
function checkBearerToken(authHeader: string | undefined, expected: string): boolean {
  if (!authHeader?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(authHeader.substring(7));
  const exp = Buffer.from(expected);
  if (provided.length !== exp.length) return false;
  return timingSafeEqual(provided, exp);
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

// call_status webhooks arrive as form-urlencoded TeXML bodies (NOT JSON).
// Use both CallSid + CallStatus to form a unique source_event_id per event
// (a single call produces multiple call_status events with the same CallSid).
function parseCallStatus(rawBody: Buffer): { payload: unknown; sourceEventId: string | null } {
  const params = new URLSearchParams(rawBody.toString('utf8'));
  const payload = Object.fromEntries(params.entries());
  const callSid = params.get('CallSid');
  const callStatus = params.get('CallStatus');
  const sourceEventId = callSid && callStatus ? `${callSid}:${callStatus}` : callSid;
  return { payload, sourceEventId };
}

// SMS, conversation_insights, and transcript webhooks arrive as proper JSON.
// source_event_id = data.id from the Telnyx event envelope.
function parseJsonEvent(rawBody: Buffer): { payload: unknown; sourceEventId: string | null } {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch {
    payload = rawBody.toString('utf8');
  }
  let sourceEventId: string | null = null;
  if (payload && typeof payload === 'object') {
    const b = payload as Record<string, unknown>;
    const data = b['data'] as Record<string, unknown> | undefined;
    const id = data?.['id'];
    if (typeof id === 'string') sourceEventId = id;
  }
  return { payload, sourceEventId };
}

type BodyParser = (rawBody: Buffer) => { payload: unknown; sourceEventId: string | null };

function makeTelnyxHandler(eventType: string, parseBody: BodyParser) {
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

    const { payload, sourceEventId } = parseBody(rawBody);

    try {
      await captureEvent(eventType, sourceEventId, payload);
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
  ['/voice/call-status', makeTelnyxHandler('call_status', parseCallStatus)],
  ['/voice/conversation-insights', makeTelnyxHandler('conversation_insights', parseJsonEvent)],
  ['/webhook/telnyx/transcript', makeTelnyxHandler('transcript', parseJsonEvent)],
  ['/webhook/telnyx/sms', makeTelnyxHandler('sms', parseJsonEvent)],
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
      // ElevenLabs tool call — bearer token auth required (ELEVENLABS_TOOL_SECRET)
      const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
      if (!toolSecret || !checkBearerToken(req.headers['authorization'] as string | undefined, toolSecret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }
      // Full lookup logic deferred to V1 implementation
      res.writeHead(501, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: 'Lookup is not yet available. Please hold while I connect you with our team.' }));
      return;
    }

    if (url === '/webhook/elevenlabs/post-call') {
      // ElevenLabs post-call webhook — HMAC-SHA256 via elevenlabs-signature header
      const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET;
      if (!webhookSecret) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'ELEVENLABS_WEBHOOK_SECRET not configured' }));
        return;
      }
      const sigHeader = req.headers['elevenlabs-signature'] as string | undefined;
      if (!sigHeader) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'missing_signature_header' }));
        return;
      }
      const valid = await verifyElevenLabsSig(sigHeader, rawBody, webhookSecret);
      if (!valid) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid_signature' }));
        return;
      }
      const { payload, sourceEventId } = parseJsonEvent(rawBody);
      try {
        await captureEvent('elevenlabs_post_call', sourceEventId, payload);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[voice-gateway] voice_events insert error [elevenlabs_post_call]: ${msg}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'db_error' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
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

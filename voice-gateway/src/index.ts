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
 *   POST /voice/tools/lookup_record      — ElevenLabs mid-call tool (caller lookup, WO status, etc.)
 *   POST /voice/tools/open_work_order   — ElevenLabs mid-call tool (non-emergency WO intake)
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

// Supabase pooler CA cert — env var (Railway) takes priority over file (local dev).
// Falls back to rejectUnauthorized:false if neither is available, to avoid a cold-boot crash.
function loadCaCert(): string | undefined {
  if (process.env.SUPABASE_CA_CERT) return process.env.SUPABASE_CA_CERT;
  try { return readFileSync(resolve(__dirname, '../certs/supabase-ca.pem')).toString(); } catch { /* not found */ }
  try { return readFileSync(resolve(process.cwd(), 'certs/supabase-ca.pem')).toString(); } catch { /* not found */ }
  return undefined;
}
const _caCert = loadCaCert();
if (!_caCert) console.warn('[voice-gateway] WARN: Supabase CA cert not found — using rejectUnauthorized:false');

// pg v8: sslmode=require in DSN overrides the ssl option, causing cert rejection on Supabase pooler.
// Strip sslmode from the DSN and pass ssl config explicitly.
const _dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
const pool = new pg.Pool({
  connectionString: _dsn,
  ssl: _caCert ? { ca: _caCert, rejectUnauthorized: true } : { rejectUnauthorized: false },
});

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

// Parse spoken DOB ("10/11/1994", "October 11 1994") → "YYYY-MM-DD" for voice_verify_identity
function parseSpokenDob(input: string): string | null {
  const slashMatch = input.trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (slashMatch) {
    const [, m, d, y] = slashMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const wordMatch = input.trim().toLowerCase().match(/^([a-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (wordMatch) {
    const [, monthName, d, y] = wordMatch;
    const m = months[monthName];
    if (m) return `${y}-${m}-${d.padStart(2, '0')}`;
  }
  return null;
}

// Parse spoken move-in ("March 2020", "03/2020", "2020-03") → "YYYY-MM" for voice_verify_identity
function parseSpokenMoveIn(input: string): string | null {
  if (/^\d{4}-\d{2}$/.test(input.trim())) return input.trim();
  const numMatch = input.trim().match(/^(\d{1,2})\/(\d{4})$/);
  if (numMatch) return `${numMatch[2]}-${numMatch[1].padStart(2, '0')}`;
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04', may: '05', june: '06',
    july: '07', august: '08', september: '09', october: '10', november: '11', december: '12',
  };
  const wordMatch = input.trim().toLowerCase().match(/^([a-z]+)\s+(\d{4})$/);
  if (wordMatch) {
    const m = months[wordMatch[1]];
    if (m) return `${wordMatch[2]}-${m}`;
  }
  return null;
}

// /voice/tools/lookup_record — ElevenLabs mid-call tool handler
async function handleLookupRecord(
  req: http.IncomingMessage,
  rawBody: Buffer,
  res: http.ServerResponse,
): Promise<void> {
  const sendResult = (result: string) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result }));
  };

  // Bearer token auth (ELEVENLABS_TOOL_SECRET, constant-time)
  const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
  if (!toolSecret || !checkBearerToken(req.headers['authorization'] as string | undefined, toolSecret)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  // Parse request body
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
  catch { return sendResult("I had trouble understanding that request. How can I help you?"); }

  const callerNumber = (body['caller_number'] as string | undefined) ?? '';
  const query = (body['query'] as string | undefined) || 'caller_info';
  const spokenDob = body['dob'] as string | undefined;
  const spokenMoveIn = body['move_in'] as string | undefined;
  const reason = (body['reason'] as string | undefined) ?? 'unspecified';
  const callbackNumber = body['callback'] as string | undefined;

  // Resolve caller identity — check caller_sessions cache, then voice_resolve_caller
  let resolved: Record<string, unknown> | null = null;
  let resolverFailed = false;
  if (callerNumber) {
    const cacheHit = await pool.query(
      `SELECT resolved FROM caller_sessions WHERE phone_e164 = $1 AND expires_at > now() LIMIT 1`,
      [callerNumber],
    ).catch(() => { resolverFailed = true; return null; });

    if (cacheHit?.rows[0]) {
      resolved = cacheHit.rows[0].resolved as Record<string, unknown>;
      resolverFailed = false;
    } else {
      resolverFailed = false;
      const resolveRow = await pool.query(
        `SELECT voice_resolve_caller($1) AS r`,
        [callerNumber],
      ).catch(() => { resolverFailed = true; return null; });
      resolved = resolveRow?.rows[0]?.r as Record<string, unknown> | null;

      // Upsert into caller_sessions on match
      if (resolved?.['matched']) {
        await pool.query(
          `INSERT INTO caller_sessions
             (phone_e164, resolved_type, display_name, contact_id, occupancy_id, unit_id, unit_label, property_id, property_label, lookup_source, resolved, expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'voice_resolve_caller',$10, now() + interval '30 days')
           ON CONFLICT (phone_e164) DO UPDATE SET
             resolved_type=EXCLUDED.resolved_type, display_name=EXCLUDED.display_name,
             contact_id=EXCLUDED.contact_id, occupancy_id=EXCLUDED.occupancy_id,
             unit_id=EXCLUDED.unit_id, unit_label=EXCLUDED.unit_label,
             property_id=EXCLUDED.property_id, property_label=EXCLUDED.property_label,
             resolved=EXCLUDED.resolved, last_seen_at=now(),
             expires_at=now() + interval '30 days'`,
          [
            callerNumber, resolved['resolved_type'], resolved['display_name'],
            resolved['contact_id'], resolved['occupancy_id'], resolved['unit_id'],
            resolved['unit_label'], resolved['property_id'], resolved['property_label'],
            JSON.stringify(resolved),
          ],
        ).catch(() => {}); // cache write is non-fatal
      }
    }
  }

  // Unknown caller (partial DB is by design — prospects, new renters, no-phone tenants all resolve unknown).
  // ONLY hard gate: account financial data (balance/payment/lease/deposit) requires verified identity.
  // Everything else: serve by intent. Post-call routing handles Max/Lexi/Anna dispatch from conversation content.
  if (!resolved?.['matched']) {
    if (resolverFailed && query === 'work_order_status') {
      return sendResult("I wasn't able to check your work order status right now. Let me take a message and have someone follow up with you.");
    }
    if (query === 'balance') {
      // Hard gate: financial data needs verified identity regardless of who is calling
      await pool.query(
        `INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ('unverified_financial_inquiry', null, $1)`,
        [JSON.stringify({ caller_number: callerNumber, ts: new Date().toISOString() })],
      ).catch(() => {});
      return sendResult("I need to verify your identity to access account information. Let me connect you with our accounting team who can assist you directly.");
    }
    if (query === 'request_handoff') {
      await pool.query(
        `INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ('handoff_request', null, $1)`,
        [JSON.stringify({ caller_number: callerNumber, display_name: 'unknown', reason, callback: callbackNumber, ts: new Date().toISOString() })],
      ).catch(() => {});
      return sendResult("I'm connecting you with our team. Could I get your name and best callback number so someone can reach you?");
    }
    // caller_info, verify_identity, Tier-1 how-to, leasing inquiry, maintenance report: serve them
    return sendResult("I wasn't able to find your account in our system, but I can still help. What can I do for you today?");
  }

  // Scope guard: BLV/TIB = Amanda scope, not fleet (routing_scope defaults to 'fleet' until DB tweak lands)
  const routingScope = (resolved['routing_scope'] as string | undefined) ?? 'fleet';
  if (routingScope === 'amanda' || routingScope === 'paused') {
    return sendResult("Let me connect you with our property management team who handles your property directly.");
  }

  // Inactive tenant guard
  const occupancyId = resolved['occupancy_id'] as string | null;
  if (resolved['resolved_type'] === 'tenant' && (!resolved['has_active_occupancy'] || !occupancyId)) {
    return sendResult("I see you're a former resident. For account questions, let me connect you with our accounting team.");
  }

  const displayName = (resolved['display_name'] as string | null) ?? 'there';
  const unitLabel = resolved['unit_label'] as string | null;
  const propertyLabel = (resolved['property_label'] as string | null) ?? (resolved['property_name'] as string | null);
  const locationStr = [unitLabel, propertyLabel].filter(Boolean).join(', ');
  const contactId = resolved['contact_id'] as string | null;
  const dobOnFile = resolved['dob_on_file'] as boolean | null;

  // Auto-verify via caller-ID for non-ambiguous matches
  const autoVerified = !!(callerNumber && resolved['matched'] && !resolved['ambiguous']);

  // Spoken challenge verification helper
  const runSpokenVerify = async (): Promise<{ verified: boolean }> => {
    if (!contactId) return { verified: false };
    const dobDate = spokenDob ? parseSpokenDob(spokenDob) : null;
    const moveIn = spokenMoveIn ? parseSpokenMoveIn(spokenMoveIn) : null;

    if (dobOnFile && dobDate) {
      const r = await pool.query(
        `SELECT verified, method FROM voice_verify_identity($1::uuid, $2::date, null)`,
        [contactId, dobDate],
      ).catch(() => null);
      return { verified: r?.rows[0]?.verified ?? false };
    }
    if (moveIn) {
      const r = await pool.query(
        `SELECT verified, method FROM voice_verify_identity($1::uuid, null, $2)`,
        [contactId, moveIn],
      ).catch(() => null);
      return { verified: r?.rows[0]?.verified ?? false };
    }
    return { verified: false };
  };

  // --- Query routing ---

  if (query === 'caller_info') {
    return sendResult(
      `I found your account — ${displayName}${locationStr ? ' at ' + locationStr : ''}. How can I help you today?`,
    );
  }

  if (query === 'verify_identity') {
    if (autoVerified) {
      return sendResult(`I've verified your identity — ${displayName}${locationStr ? ' at ' + locationStr : ''}. How can I help you today?`);
    }
    if (resolved['ambiguous']) {
      // Ambiguous match: must use spoken challenge
      if (!spokenDob && !spokenMoveIn) {
        const prompt = dobOnFile
          ? "To verify your identity, could you please provide your date of birth?"
          : "To verify your identity, could you please tell me your move-in month and year?";
        return sendResult(prompt);
      }
    }
    const { verified } = await runSpokenVerify();
    if (verified) {
      return sendResult(`I've verified your identity — ${displayName}${locationStr ? ' at ' + locationStr : ''}. How can I help you today?`);
    }
    return sendResult("I wasn't able to verify your identity. I can take a message and have someone call you back.");
  }

  if (query === 'balance') {
    // Must be verified (auto or spoken)
    let verified = autoVerified;
    if (!verified && (spokenDob || spokenMoveIn)) {
      ({ verified } = await runSpokenVerify());
    }
    if (!verified) {
      const prompt = dobOnFile
        ? "I need to verify your identity before I can access account information. Could you please provide your date of birth?"
        : "I need to verify your identity. Could you please tell me your move-in month and year?";
      return sendResult(prompt);
    }
    if (!occupancyId) {
      return sendResult("I wasn't able to find an active lease for your account. Let me connect you with our accounting team.");
    }

    const aging = await pool.query(
      `SELECT voice_balance_aging($1::uuid, 14) AS result`,
      [occupancyId],
    ).catch(() => null);

    if (!aging?.rows[0]?.result) {
      return sendResult("I wasn't able to retrieve your balance right now. Let me connect you with our accounting team.");
    }

    const { open_total, has_open_charges, gate_open, as_of } = aging.rows[0].result as {
      open_total: number; has_open_charges: boolean; gate_open: boolean; as_of: string;
    };

    if (!has_open_charges || open_total <= 0) {
      return sendResult("Our records show no outstanding balance on your account. Is there anything else I can help you with?");
    }
    if (!gate_open) {
      // Charge < 14 days — route to Anna, don't read
      return sendResult("I see there may be a recent charge on your account. Let me connect you with our accounting team to confirm the details.");
    }

    // Aged balance read with mandatory hedge
    const amt = Number(open_total).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
    const asOfStr = as_of ? new Date(as_of).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) : 'recently';
    return sendResult(
      `Our records show a balance of ${amt} as of ${asOfStr}. If you've made a payment recently it may not yet be reflected — please allow a few business days for processing. Would you like me to connect you with our accounting team?`,
    );
  }

  if (query === 'work_order_status') {
    const unitId = resolved['unit_id'] as string | null;
    if (!unitId) {
      return sendResult("I wasn't able to find an active unit for your account. Let me connect you with our team to check on your work order.");
    }

    const woResult = await pool.query<{
      work_order_issue: string | null;
      job_description: string | null;
      status: string;
      scheduled_start: string | null;
      has_vendor: boolean;
    }>(
      `SELECT work_order_issue, job_description, status::text, scheduled_start::text,
              (vendor_contact_id IS NOT NULL) AS has_vendor
       FROM work_orders
       WHERE unit_id = $1 AND status NOT IN ('completed', 'canceled')
       ORDER BY
         CASE priority::text
           WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4
         END,
         created_at_appfolio DESC NULLS LAST
       LIMIT 5`,
      [unitId],
    ).catch(() => null);

    if (!woResult) {
      return sendResult("I wasn't able to check your work order status right now. Let me take a message and have someone follow up with you.");
    }

    const wos = woResult.rows;
    if (wos.length === 0) {
      return sendResult("I don't see any open work orders for your unit right now. Would you like to report a maintenance issue?");
    }

    const verified = autoVerified || (
      (spokenDob || spokenMoveIn) ? (await runSpokenVerify()).verified : false
    );

    const statusPhrase = (status: string, scheduledStart: string | null, hasVendor: boolean): string => {
      const vendorSuffix = hasVendor ? ' — a vendor has been assigned and will be reaching out to you' : '';
      switch (status) {
        case 'new': return 'being reviewed by our team' + vendorSuffix;
        case 'assigned': return hasVendor
          ? 'assigned to a vendor who will be reaching out to you'
          : 'assigned to a technician';
        case 'scheduled': {
          if (!verified || !scheduledStart) return (hasVendor ? 'scheduled with a vendor' : 'scheduled with a technician') + (hasVendor ? ' who will be reaching out to you' : '');
          const d = new Date(scheduledStart);
          const dateStr = d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/Los_Angeles' });
          return `scheduled for around ${dateStr}, though the vendor may have arranged a different time with you directly`;
        }
        case 'in_progress': return 'being worked on' + vendorSuffix;
        case 'on_hold': return 'on hold — we\'ll follow up with you';
        default: return 'in progress' + vendorSuffix;
      }
    };

    const issueLabel = (wo: typeof wos[number]): string => {
      const desc = (wo.work_order_issue || wo.job_description || '').trim();
      return desc || 'a maintenance request';
    };

    if (wos.length === 1) {
      const wo = wos[0];
      return sendResult(
        `You have an open work order for ${issueLabel(wo)}. Based on our records, it's currently ${statusPhrase(wo.status, wo.scheduled_start, wo.has_vendor)}. Is there anything else I can help with?`,
      );
    }

    const lines = wos.map((wo, i) => {
      const ordinal = i === 0 ? 'first' : i === 1 ? 'second' : i === 2 ? 'third' : `number ${i + 1}`;
      return `The ${ordinal} is for ${issueLabel(wo)} — based on our records, ${statusPhrase(wo.status, wo.scheduled_start, wo.has_vendor)}.`;
    });
    return sendResult(
      `You have ${wos.length} open work orders. ${lines.join(' ')} Would you like more details on any of these?`,
    );
  }

  if (query === 'request_handoff') {
    // Write handoff_request to voice_events for async pickup (claudia fast-checker sends Telegram alert)
    await pool.query(
      `INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ('handoff_request', null, $1)`,
      [JSON.stringify({
        caller_number: callerNumber, display_name: displayName, location: locationStr,
        reason, callback: callbackNumber, ts: new Date().toISOString(),
      })],
    ).catch(() => {});
    return sendResult("I'm connecting you with our team now. Someone will be in touch with you shortly.");
  }

  return sendResult("How can I help you today?");
}

const VALID_SCENARIOS = new Set([
  'gas_leak','fire','co_alarm','medical','electrical_hazard',
  'water_leak','no_heat','no_hot_water','sewage_backup',
  'power_out','lockout','break_in',
]);

// /voice/tools/report_emergency — Alex reports a tenant emergency
// Validates payload, logs to voice_events for async dispatch by claudia cron.
// Returns immediately (non-blocking for the call).
async function handleReportEmergency(
  req: http.IncomingMessage,
  rawBody: Buffer,
  res: http.ServerResponse,
): Promise<void> {
  const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
  if (!toolSecret || !checkBearerToken(req.headers['authorization'] as string | undefined, toolSecret)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
    return;
  }

  const scenario = body['scenario'] as string | undefined;
  const tier = body['tier'] as number | undefined;
  const property = (body['property'] as string | undefined) ?? '';
  const unit = (body['unit'] as string | null | undefined) ?? null;
  const tenantName = (body['tenant_name'] as string | undefined) ?? '';
  const callbackNumber = (body['callback_number'] as string | undefined) ?? '';
  const locationDetail = (body['location_detail'] as string | undefined) ?? '';
  const notes = (body['notes'] as string | undefined) ?? '';
  const callId = (body['call_id'] as string | undefined) ?? null;
  const timestampUtc = (body['timestamp_utc'] as string | undefined) ?? new Date().toISOString();

  if (!scenario || !VALID_SCENARIOS.has(scenario)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid_scenario', valid: [...VALID_SCENARIOS] }));
    return;
  }
  if (tier !== 1 && tier !== 2) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid_tier', expected: '1 or 2' }));
    return;
  }

  const emergencyPayload = {
    scenario, tier, property, unit, tenant_name: tenantName,
    callback_number: callbackNumber, location_detail: locationDetail,
    notes, timestamp_utc: timestampUtc, call_id: callId,
  };

  try {
    await pool.query(
      `INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ('emergency_alert', $1, $2)`,
      [callId, JSON.stringify(emergencyPayload)],
    );
  } catch (e: unknown) {
    console.error(`[voice-gateway] emergency_alert insert error: ${String(e)}`);
    // Do not return 200 — a false "you're notified" on DB failure silently drops the dispatch.
    // Return 500 so Alex can tell the caller to call 911 directly and retry.
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'db_error' }));
    return;
  }

  console.log(`[voice-gateway] emergency_alert logged | tier=${tier} scenario=${scenario} property="${property}" unit="${unit ?? 'unknown'}" tenant="${tenantName}" call_id=${callId ?? 'none'}`);

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    result: tier === 1
      ? 'Emergency services have been alerted and property management has been notified immediately. Please call 911 if you have not already.'
      : 'Your urgent maintenance issue has been logged and the property management team has been notified. Someone will contact you as soon as possible.',
  }));
}

const VALID_SEVERITIES = new Set(['normal', 'urgent']);

// /voice/tools/open_work_order — Alex opens a non-emergency maintenance request mid-call.
// Resolves caller → looks up AppFolio numeric IDs → writes wo_intake event for async pickup.
// Returns immediately with a hedged confirmation (no WO is created synchronously).
async function handleOpenWorkOrder(
  req: http.IncomingMessage,
  rawBody: Buffer,
  res: http.ServerResponse,
): Promise<void> {
  const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
  if (!toolSecret || !checkBearerToken(req.headers['authorization'] as string | undefined, toolSecret)) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
    return;
  }

  let body: Record<string, unknown> = {};
  try { body = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>; }
  catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'invalid_json' }));
    return;
  }

  const callerNumber = (body['caller_number'] as string | undefined) ?? '';
  const issueDescription = (body['issue_description'] as string | undefined) ?? '';
  const locationDetail = (body['location_detail'] as string | undefined) ?? '';
  const severity = (body['severity'] as string | undefined) ?? 'normal';
  const permissionToEnter = body['permission_to_enter'] as boolean | undefined;
  const callId = (body['call_id'] as string | undefined) ?? null;

  if (!issueDescription) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "I need a description of the issue before I can submit a request. Could you tell me what's going on?" }));
    return;
  }

  if (severity && !VALID_SEVERITIES.has(severity)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "I need to know if this is a normal or urgent maintenance request. Which would you say it is?" }));
    return;
  }

  // Resolve caller from cache
  let resolved: Record<string, unknown> | null = null;
  let resolverFailed = false;
  if (callerNumber) {
    const cacheHit = await pool.query(
      `SELECT resolved FROM caller_sessions WHERE phone_e164 = $1 AND expires_at > now() LIMIT 1`,
      [callerNumber],
    ).catch(() => { resolverFailed = true; return null; });

    if (cacheHit?.rows[0]) {
      resolved = cacheHit.rows[0].resolved as Record<string, unknown>;
      resolverFailed = false;
    } else if (!resolverFailed) {
      const resolveRow = await pool.query(
        `SELECT voice_resolve_caller($1) AS r`,
        [callerNumber],
      ).catch(() => { resolverFailed = true; return null; });
      resolved = resolveRow?.rows[0]?.r as Record<string, unknown> | null;
    }
  }

  if (resolverFailed || !resolved?.['matched']) {
    // Can't identify the caller — still capture the intake for manual follow-up
    const unidentifiedPayload = {
      caller_number: callerNumber,
      issue_description: issueDescription,
      location_detail: locationDetail,
      severity,
      permission_to_enter: permissionToEnter ?? null,
      call_id: callId,
      timestamp_utc: new Date().toISOString(),
      identified: false,
    };
    try {
      await captureEvent('wo_intake', callId, unidentifiedPayload);
    } catch (e: unknown) {
      console.error(`[voice-gateway] wo_intake insert error (unidentified): ${String(e)}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ result: "I'm having trouble submitting that right now. Let me take down your information and have someone call you back to get this set up." }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "I've noted your maintenance request. Since I wasn't able to pull up your account, our team will follow up with you to confirm the details and get a work order set up." }));
    return;
  }

  // Scope guard: BLV/TIB = Amanda scope, paused properties not serviced
  const routingScope = (resolved['routing_scope'] as string | undefined) ?? 'fleet';
  if (routingScope === 'amanda' || routingScope === 'paused') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "Let me connect you with our property management team who handles your property directly." }));
    return;
  }

  // Inactive tenant guard
  const occupancyId = resolved['occupancy_id'] as string | null;
  if (resolved['resolved_type'] === 'tenant' && (!resolved['has_active_occupancy'] || !occupancyId)) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "I see you're a former resident. For maintenance requests at your current address, please contact your current property manager." }));
    return;
  }

  const unitId = resolved['unit_id'] as string | null;
  const propertyId = resolved['property_id'] as string | null;
  const contactId = resolved['contact_id'] as string | null;
  const displayName = (resolved['display_name'] as string | null) ?? '';
  const unitLabel = resolved['unit_label'] as string | null;
  const propertyLabel = (resolved['property_label'] as string | null) ?? (resolved['property_name'] as string | null);

  // Look up AppFolio numeric IDs for the async WO-creation step
  let appfolioUnitId: number | null = null;
  let appfolioPropertyId: number | null = null;
  let appfolioOccupancyId: number | null = null;
  let appfolioReady = false;

  if (unitId) {
    const idRow = await pool.query(
      `SELECT u.appfolio_unit_id, u.appfolio_property_id, o.appfolio_occupancy_id
       FROM units u
       LEFT JOIN occupancies o ON o.unit_id = u.id AND o.status = 'current'
       WHERE u.id = $1
       LIMIT 1`,
      [unitId],
    ).catch((e: unknown) => {
      console.warn(`[voice-gateway] AppFolio ID lookup failed: ${String(e)}`);
      return null;
    });
    if (idRow?.rows[0]) {
      appfolioUnitId = idRow.rows[0].appfolio_unit_id ?? null;
      appfolioPropertyId = idRow.rows[0].appfolio_property_id ?? null;
      appfolioOccupancyId = idRow.rows[0].appfolio_occupancy_id ?? null;
    }
  }

  // Async creator needs all three AppFolio IDs to submit; without them, flag for manual review
  appfolioReady = !!(appfolioUnitId && appfolioPropertyId && appfolioOccupancyId);

  const intakePayload = {
    caller_number: callerNumber,
    issue_description: issueDescription,
    location_detail: locationDetail,
    severity,
    permission_to_enter: permissionToEnter ?? null,
    call_id: callId,
    timestamp_utc: new Date().toISOString(),
    identified: true,
    tenant_name: displayName,
    contact_id: contactId,
    unit_id: unitId,
    unit_label: unitLabel,
    property_id: propertyId,
    property_label: propertyLabel,
    appfolio_unit_id: appfolioUnitId,
    appfolio_property_id: appfolioPropertyId,
    appfolio_occupancy_id: appfolioOccupancyId,
    appfolio_ready: appfolioReady,
  };

  try {
    await captureEvent('wo_intake', callId, intakePayload);
  } catch (e: unknown) {
    console.error(`[voice-gateway] wo_intake insert error: ${String(e)}`);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ result: "I'm having trouble submitting that right now. Let me take down your information and have someone call you back to get this set up." }));
    return;
  }

  const locationStr = [unitLabel, propertyLabel].filter(Boolean).join(', ');
  console.log(`[voice-gateway] wo_intake logged | tenant="${displayName}" unit="${locationStr}" severity=${severity} appfolio_ready=${appfolioReady} call_id=${callId ?? 'none'}`);

  const confirmationMsg = appfolioReady
    ? `I've submitted your maintenance request for ${issueDescription.toLowerCase().substring(0, 80)}. Our maintenance team will review it and follow up with you. If the issue becomes urgent, please don't hesitate to call us back.`
    : `I've noted your maintenance request for ${issueDescription.toLowerCase().substring(0, 80)}. Our team will need to verify a few details on our end before setting up the work order, but someone will follow up with you.`;

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ result: confirmationMsg }));
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
      await handleLookupRecord(req, rawBody, res);
      return;
    }

    if (url === '/voice/initiation') {
      // ElevenLabs conversation_initiation_client_data_webhook
      // Called at SIP connect BEFORE the agent speaks. Phase 1: log + return empty vars (graceful no-op).
      // Phase 2: resolve caller, return dynamic_variables + first_message override.
      let body: unknown = {};
      try { body = JSON.parse(rawBody.toString('utf8')); } catch { /* non-JSON — proceed */ }
      // Log BEFORE auth so we capture the call even if auth format differs
      const authHdr = req.headers['authorization'] as string | undefined;
      console.log('[voice-gateway] initiation request | auth:', authHdr ? authHdr.substring(0, 20) + '...' : 'NONE', '| body:', JSON.stringify(body));
      const toolSecret = process.env.ELEVENLABS_TOOL_SECRET;
      if (toolSecret && !checkBearerToken(authHdr, toolSecret)) {
        console.log('[voice-gateway] initiation auth FAILED | expected Bearer, got:', authHdr?.substring(0, 30));
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
        return;
      }

      // Phase 1: empty response — proves graceful failure mode, logs field names for Phase 2
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ dynamic_variables: {} }));
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

    if (url === '/voice/tools/report_emergency') {
      await handleReportEmergency(req, rawBody, res);
      return;
    }

    if (url === '/voice/tools/open_work_order') {
      await handleOpenWorkOrder(req, rawBody, res);
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

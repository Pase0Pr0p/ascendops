/**
 * phone-inbound — Supabase Edge Function
 *
 * Receives the Telnyx post-call conversation-insights webhook after every call.
 * Triage flow:
 *   1. Verify webhook signature (TELNYX_WEBHOOK_SECRET)
 *   2. Resolve caller_number → contact + unit via Supabase lookup
 *   3. Look up or create a work order for the call
 *   4. Append transcript to WO notes (scoped write)
 *   5. Write canonical comms record to communications_log
 *   6. Enrich caller-to-unit mapping (learning loop)
 *
 * Credentials needed (env vars — set in Supabase Dashboard → Edge Functions → Secrets):
 *   SUPABASE_URL                — project URL (auto-injected)
 *   SUPABASE_SERVICE_ROLE_KEY   — write access to comms_log + work_orders (BLOCKED: need from Albie)
 *   TELNYX_WEBHOOK_SECRET       — HMAC secret for signature verification (BLOCKED: need from Rob Q3)
 *
 * Schema migrations needed before deploy (Albie runs in Supabase SQL Editor):
 *   ALTER TYPE comm_channel ADD VALUE 'telnyx_call';
 *   ALTER TYPE comm_channel ADD VALUE 'quo_sms';
 *   -- embedding column for semantic search (requires pgvector extension — Q5):
 *   ALTER TABLE communications_log ADD COLUMN IF NOT EXISTS embedding vector(1536);
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface CallTurn {
  role: 'agent' | 'user';
  content: string;
  timestamp?: string;
}

interface ConversationInsightsPayload {
  caller_number: string;
  number_called: string;
  call_control_id: string;
  start_time: string;
  duration_seconds: number;
  intent: string | null;
  sentiment: string | null;
  summary: string | null;
  transcript: string | null;
  turns: CallTurn[];
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // --- Signature verification (BLOCKED: TELNYX_WEBHOOK_SECRET not yet available) ---
  // const sig = req.headers.get('telnyx-signature-ed25519');
  // const ts  = req.headers.get('telnyx-timestamp');
  // await verifyTelnyxSignature(sig, ts, rawBody, Deno.env.get('TELNYX_WEBHOOK_SECRET')!);

  const payload: ConversationInsightsPayload = await req.json();
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  // 1. Resolve caller to contact + unit
  const { data: contact } = await supabase
    .from('contacts')
    .select(`
      id, display_name, contact_type,
      occupancies!occupancies_primary_tenant_id_fkey (
        id, unit_id, status,
        units ( id, unit_name, property_id,
          properties ( id, name ) )
      )
    `)
    .or(`primary_phone_e164.eq.${payload.caller_number},all_phones.cs.{${payload.caller_number}}`)
    .eq('occupancies.status', 'current')
    .limit(1)
    .maybeSingle();

  const activeOccupancy = contact?.occupancies?.[0];
  const unitId: string | null = activeOccupancy?.unit_id ?? null;

  // 2. Match or create work order
  // If caller has open WOs, pick the most recent; else create a new intake WO
  // (Full WO creation logic deferred until Q2/Q4 blockers clear — scoped write requires
  //  AppFolio write permission or a Supabase-only WO; decision pending.)
  let workOrderId: string | null = null;
  if (unitId) {
    const { data: openWo } = await supabase
      .from('work_orders')
      .select('id')
      .eq('unit_id', unitId)
      .not('status', 'in', '("completed","canceled")')
      .order('created_at_appfolio', { ascending: false })
      .limit(1)
      .maybeSingle();
    workOrderId = openWo?.id ?? null;
  }

  // 3. Write canonical comms record
  const { data: commsRow, error: commsErr } = await supabase
    .from('communications_log')
    .insert({
      occurred_at: payload.start_time,
      channel: 'telnyx_call',          // requires enum migration (see header)
      direction: 'inbound',
      from_phone_e164: payload.caller_number,
      to_phone_e164: payload.number_called,
      contact_id: contact?.id ?? null,
      unit_id: unitId,
      work_order_id: workOrderId,
      body_text: payload.transcript,
      body_summary: payload.summary,
      classification: payload.intent,
      urgency: payload.sentiment === 'negative' ? 'urgent' : 'normal',
      duration_seconds: payload.duration_seconds,
      source_message_id: payload.call_control_id,
      raw_payload: payload,
    })
    .select('id')
    .single();

  if (commsErr) {
    console.error('comms_log insert failed:', commsErr.message);
    return new Response(JSON.stringify({ ok: false, error: commsErr.message }), { status: 500 });
  }

  // 4. Append transcript to open WO notes (scoped write — blocked until WO write path confirmed)
  // If workOrderId exists: supabase.from('work_orders').update({status_notes: ...}).eq('id', workOrderId)

  return new Response(
    JSON.stringify({
      ok: true,
      caller_resolved: !!contact,
      contact_id: contact?.id ?? null,
      unit_id: unitId,
      work_order_id: workOrderId,
      comms_log_id: commsRow.id,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});

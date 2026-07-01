/**
 * voice-outbound — Supabase Edge Function
 * POST /functions/v1/voice-outbound
 *
 * Authenticated endpoint for placing outbound AI calls via Telnyx.
 * MANDATORY: every call requires explicit per-call human approval before it fires.
 *
 * Flow:
 *   1. Verify bearer token (operator or orchestrator agent token)
 *   2. Validate target_number is a known Paseo contact (no cold calls)
 *   3. Create an approval request (cortextos approvals table)
 *   4. Return approval_request_id — caller polls or webhook fires on approval
 *   5. On approval: POST to Telnyx /calls with dynamic_variables pre-loaded
 *   6. Log outbound call record to communications_log
 *
 * Credentials needed:
 *   OUTBOUND_BEARER_SECRET      — token agents use to call this endpoint (BLOCKED: generate at deploy)
 *   TELNYX_API_KEY              — for POST /v2/calls (BLOCKED: Rob Q3 — Telnyx account access)
 *   TELNYX_CONNECTION_ID        — the SIP connection/application ID (BLOCKED: Rob Q3)
 *   SUPABASE_SERVICE_ROLE_KEY   — write access (BLOCKED: Albie)
 *
 * Guardrail (MUST NOT be removed):
 *   No call fires without an entry in the approvals table with status='approved'
 *   scoped to exactly this call request. The approval gate is not optional.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface OutboundCallRequest {
  target_number: string;          // E.164 — must match a known Paseo contact
  reason: string;
  requested_by: string;           // agent name or human operator
  dynamic_variables: {
    call_reason: string;
    callback_number?: string;
    pre_loaded_context?: string;
    [key: string]: string | undefined;
  };
}

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // 1. Verify bearer token
  const auth = req.headers.get('Authorization') ?? '';
  if (!auth.startsWith('Bearer ') || auth.slice(7) !== Deno.env.get('OUTBOUND_BEARER_SECRET')) {
    return new Response('Unauthorized', { status: 401 });
  }

  const body: OutboundCallRequest = await req.json();

  // 2. Validate target is a known contact (read-only check)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  );

  const { data: contact } = await supabase
    .from('contacts')
    .select('id, display_name')
    .or(`primary_phone_e164.eq.${body.target_number},all_phones.cs.{${body.target_number}}`)
    .maybeSingle();

  if (!contact) {
    return new Response(
      JSON.stringify({ ok: false, error: 'target_number is not a known Paseo contact' }),
      { status: 422, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // 3. Create per-call approval request (MANDATORY — call does not fire until approved)
  const approvalId = crypto.randomUUID();
  await supabase.from('approvals').insert({
    id: approvalId,
    title: `Outbound call to ${contact.display_name} (${body.target_number})`,
    category: 'outbound_call',
    description: `Reason: ${body.reason}\nRequested by: ${body.requested_by}`,
    status: 'pending',
    agent: body.requested_by,
    org: 'paseo-pm',
    created_at: new Date().toISOString(),
  });

  // 4. Return pending state — call fires only on approval webhook
  // (Approval webhook handler: on status='approved', POST to Telnyx /v2/calls
  //  with connection_id, to: body.target_number, from: our DID,
  //  custom_headers: dynamic_variables)

  return new Response(
    JSON.stringify({
      ok: true,
      call_control_id: null,      // assigned by Telnyx after call fires on approval
      status: 'pending_approval',
      approval_request_id: approvalId,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
});

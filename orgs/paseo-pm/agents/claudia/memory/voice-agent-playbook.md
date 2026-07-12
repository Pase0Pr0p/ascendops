# Voice Agent Playbook — Paseo Properties Alex (V1)

Last updated: 2026-07-11  
Author: claudia  
Status: V1 live on +1-415-426-1341

---

## 1. Architecture

**Model B** (confirmed by Rob/Albie 2026-07-10):
- **Phone**: Telnyx (+1-415-426-1341, conn_id 2994018400621036617 — ElevenLabs SIP)
- **AI Brain**: ElevenLabs Agents Platform (Gemini 2.5 Flash)
- **Voice**: Kate (voice_id `w9rPM8AIZle60Nbpw7nl`)
- **Agent ID**: `agent_9101kwd2qh8gfe0t34h9v6gv5wcf` (workspace "Paseo Properties", branch Main)
- **Telephony**: Telnyx → SIP FQDN `sip.rtc.elevenlabs.io:5060`
- **Gateway**: Node.js/TypeScript on Railway (`https://voice-gateway-production-e1e2.up.railway.app`)
- **DB**: Supabase paseo-ops (SECURITY DEFINER functions, voice_gateway role)

**Old Telnyx-only number**: +1-415-384-5851 (Paseo Test Line, separate Telnyx AI assistant kate-voice-agent using Kimi-K2.5 — NOT Alex)

---

## 2. V1 System Prompt (Final — Rob pasted/published 2026-07-11)

```
## Call Handling

**At the start of every call**, silently call lookup_record with query="caller_info" and caller_number set to the caller's phone number in E.164 format. Do not announce this to the caller.

Open with: "Hi, this is Alex with Paseo Properties — what can I help you with today?"

Once you understand what they need, soft-confirm who you are speaking with:
- If caller_info returned a match: "Just to confirm — based on your number, it looks like this is [name] at [unit], [property] — is that right?"
- If caller_info returned not-found: "Could I get your name and address so I can note this for the team?"

Handle maintenance questions, how-to questions, and general property questions normally.

---

## Billing and Balance Questions

Do NOT read any balance, state any amount, or discuss charges. If the caller asks about their balance, a charge, a payment, or anything billing-related, take a message for the billing team:

1. Collect their name, callback number, and a brief description of the question.
2. Call lookup_record with query="request_handoff", reason="billing inquiry", and their callback number as callback.
3. Tell them: "I've noted that for our billing team and they will follow up with you."

---

## Caller Wants to Speak with a Person

Do not attempt a live transfer. Take a message instead:

1. Ask for their name, callback number, and what it's regarding.
2. Call lookup_record with query="request_handoff" and fill in reason and callback.
3. Tell them someone from the team will follow up.
```

**V1 Scope decisions:**
- No balance reads (DOB/move-in coverage too low for most tenants)
- No live transfers — message-takes only
- Issue-first greeting ("what can I help you with") before soft-confirm
- Unknown caller: ask for name/address, do not gate non-financial questions

---

## 3. lookup_record Tool Definition

### 3a. ElevenLabs JSON Schema (v4 — validated format)

```json
{
  "name": "lookup_record",
  "description": "Look up a caller account, verify identity, retrieve balance, or request a human handoff. Call this at the start of every conversation to identify the caller, and again when the caller asks about their balance or wants to be connected to a person.",
  "type": "webhook",
  "response_timeout_secs": 20,
  "api_schema": {
    "url": "https://voice-gateway-production-e1e2.up.railway.app/voice/tools/lookup_record",
    "method": "POST",
    "path_params_schema": [],
    "query_params_schema": [],
    "request_headers": [],
    "content_type": "application/json",
    "auth_connection": null,
    "request_body_schema": {
      "id": "body",
      "type": "object",
      "description": "Parameters for the lookup_record call",
      "required": true,
      "properties": [
        {
          "id": "caller_number",
          "type": "string",
          "description": "The caller phone number in E.164 format, e.g. +14155551234. Use the caller ID from the active call.",
          "required": true,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        },
        {
          "id": "query",
          "type": "string",
          "description": "What to look up: caller_info to identify the caller, verify_identity to confirm identity via DOB or move-in date, balance to retrieve account balance (only after identity verified), request_handoff when caller wants to speak with a person.",
          "required": true,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        },
        {
          "id": "dob",
          "type": "string",
          "description": "Date of birth spoken by caller, any natural format (10/11/1994, October 11 1994). Only include when query=verify_identity and caller provided their DOB.",
          "required": false,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        },
        {
          "id": "move_in",
          "type": "string",
          "description": "Move-in month and year spoken by caller (March 2020, 03/2020). Only include when query=verify_identity and caller provided move-in date instead of DOB.",
          "required": false,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        },
        {
          "id": "reason",
          "type": "string",
          "description": "Brief reason for the call or handoff, e.g. maintenance, leasing, billing. Used when query=request_handoff.",
          "required": false,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        },
        {
          "id": "callback",
          "type": "string",
          "description": "Callback phone number provided by caller. Used when query=request_handoff.",
          "required": false,
          "value_type": "llm_prompt",
          "dynamic_variable": "",
          "constant_value": ""
        }
      ]
    }
  }
}
```

### 3b. Auth (set separately in portal after JSON import)

- Auth type: Bearer token
- Header: `Authorization`
- Value: `Bearer <ELEVENLABS_TOOL_SECRET>` (64-char hex, in secrets.env)

### 3c. ElevenLabs JSON Schema Quirks (learned through 4 validation rounds)

| Field | Wrong assumption | Correct ElevenLabs format |
|-------|-----------------|--------------------------|
| `api` | top-level key | must be `api_schema` |
| `parameters` | top-level key | nested inside `api_schema` as `request_body_schema` |
| `response_timeout_secs` | optional | **required** number (use 20) |
| `request_body_schema.required` | array of strings | **boolean** (true/false) |
| `request_body_schema.properties` | object (JSON Schema) | **array** of property objects |
| each property `required` | not present | **boolean** on each property object |
| each property `value_type` | not present | required — use `"llm_prompt"` for LLM-determined values |
| each property `dynamic_variable` | not present | required — set `""` when using llm_prompt |
| each property `constant_value` | not present | required — set `""` when using llm_prompt |
| `api_schema.path_params_schema` | not needed | required — set `[]` |
| `api_schema.query_params_schema` | not needed | required — set `[]` |
| `api_schema.request_headers` | not needed | required — set `[]` |
| `api_schema.content_type` | not needed | required — set `"application/json"` |
| `api_schema.auth_connection` | not needed | required — set `null` |

**Auth is NOT part of the JSON.** Set it separately in portal: Agent → Tools → lookup_record → Authentication → Bearer token.

---

## 4. Post-Call Webhook

- URL: `https://voice-gateway-production-e1e2.up.railway.app/webhook/elevenlabs/post-call`
- Location in portal: Workspace → Webhooks (or Agent → Advanced → Post-call webhook)
- Signing secret field: `ELEVENLABS_WEBHOOK_SECRET` value (in secrets.env)
- Signature header: `elevenlabs-signature: t=<unix>,v0=<hmac-sha256-hex>`
- Signed message format: `"${timestamp}.${rawBody}"`
- Tolerance: 30 minutes
- **Note**: ElevenLabs generates the signing secret in the portal (do not paste your own). Copy the portal-generated value and update `ELEVENLABS_WEBHOOK_SECRET` in both secrets.env and Railway.

---

## 5. Gateway Handler Contract

### Endpoint: POST /voice/tools/lookup_record

**Auth**: `Authorization: Bearer <ELEVENLABS_TOOL_SECRET>` (constant-time comparison)

**Request body** (JSON):

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `caller_number` | string | yes | E.164 phone number |
| `query` | string | yes | `caller_info` \| `verify_identity` \| `balance` \| `request_handoff` |
| `dob` | string | no | Date of birth (natural format) for verify_identity |
| `move_in` | string | no | Move-in month/year for verify_identity |
| `reason` | string | no | Reason for handoff |
| `callback` | string | no | Callback number for handoff |

**Response format** (Alex reads result verbatim):
```json
{ "result": "<string Alex reads aloud>" }
```

### Query routing

| query | Behavior |
|-------|----------|
| `caller_info` | Resolve caller by phone → return identity string or not-found message |
| `verify_identity` | Check DOB or move-in against DB; return verified/failed + method |
| `balance` | Requires verified caller; returns Supabase snapshot + 14-day aged gate + mandatory hedge |
| `request_handoff` | Writes handoff_request to voice_events; returns routing message |

### Unknown caller policy

- Balance query → hard gate (return "connect you with our accounting team")
- Everything else (Tier 1, leasing, maintenance) → serve normally

### Balance hedge (mandatory, gateway-controlled)

```
Our records show a balance of ${amount} as of ${date}. If you've made a payment recently 
it may not yet be reflected — please allow a few business days for processing. 
Would you like me to connect you with our accounting team?
```

### Supabase SECURITY DEFINER functions

1. `voice_resolve_caller(p_phone text) -> jsonb` — returns contact + occupancy + routing_scope
2. `voice_verify_identity(p_contact_id uuid, p_dob date, p_move_in text) -> {verified bool, method}`
3. `voice_balance_aging(p_occupancy_id uuid, p_gate_days int default 14) -> jsonb`

All executed as `voice_gateway` role (EXECUTE-only, no direct table access).

### voice_events table

- Columns: `id`, `event_type`, `source_event_id`, `received_at`, `payload`
- `source_event_id`: non-null = ElevenLabs tool call fired (end-to-end verification signal)
- Event types written: `caller_info`, `verify_identity`, `balance`, `unverified_financial_inquiry`, `handoff_request`, `elevenlabs_post_call`, `call_status`

---

## 6. ElevenLabs Agent Tuning Learnings (V3 session)

### Pacing via prompt wording
Sentence structure and punctuation control Alex's speaking pace. Short sentences = faster pace. Longer descriptive sentences with commas = natural pauses. Do NOT rely on SSML break tags in `first_message` — they do not work there.

### Audio tags
`<break time="1s"/>` works in mid-conversation responses but NOT in `first_message`. Use phrasing instead: "... one moment." → natural pause.

### Multi-voice disclosure
If using multiple voices (e.g., Kate for Alex, different voice for confirmations), ElevenLabs may require a disclosure. For single-voice agents this is not an issue.

### Dynamic greeting
The `first_message` field is static. For time-of-day greetings ("Good morning/afternoon/evening"), use a `dynamic_variable` set at call connect time, or handle it in the system prompt instruction ("greet the caller appropriately for the time of day").

### Break tags don't work in first_message
SSML `<break>` tags in `first_message` are not processed — they render as literal text or are stripped. Use natural sentence structure for pacing in the opening line.

### Tool call timing
ElevenLabs will only call a tool when the system prompt explicitly instructs it to. Without an instruction like "at the start of every call, call lookup_record with query=caller_info", the agent will never trigger the tool.

---

## 7. Billing Notes

- **Plan**: ElevenLabs Creator tier (as of 2026-07-10, Albie's workspace "Paseo Properties")
- **ConvAI minutes**: Creator plan includes a monthly allocation of conversational AI minutes. Monitor usage as call volume grows.
- **Voice**: Kate voice is available on Creator tier.
- **API key scopes**: Current key has voice read (used for TTS/voice fetch) but lacks `convai_read` and `user_read`. For V1 inbound (ElevenLabs calls us), zero API calls needed — key scope is irrelevant. For future outbound call triggering, will need `convai_write` scope added.

---

## 8. Deployment Checklist

### Railway service: voice-gateway
- `VOICE_GATEWAY_DSN` — Supabase pooler DSN (SSL enforced via CA cert)
- `ELEVENLABS_TOOL_SECRET` — Bearer token for lookup_record auth (64-char hex)
- `ELEVENLABS_WEBHOOK_SECRET` — Portal-generated HMAC-SHA256 signing secret
- `ELEVENLABS_AGENT_ID` — `agent_9101kwd2qh8gfe0t34h9v6gv5wcf`
- `ELEVENLABS_API_KEY` — voice read scope
- `ELEVENLABS_VOICE_ID` — `w9rPM8AIZle60Nbpw7nl` (Kate)
- `TELNYX_PUBLIC_KEY` — Ed25519 public key for Telnyx webhook verification
- `TELNYX_API_KEY` — Telnyx API key
- `TELNYX_FROM_NUMBER` — `+14154261341`

### ElevenLabs portal (manual steps)
1. Agent → Tools → Create tool (JSON import)
2. Set Bearer auth separately after import
3. Workspace → Webhooks → Add post-call webhook URL + portal-generated signing secret
4. **Always publish after making changes** — portal changes only go live on SIP after Publish
5. Test call on +14154261341 to verify

### End-to-end verification signal
- `voice_events` row with non-null `source_event_id` = tool call reached gateway, bearer auth passed
- `elevenlabs_post_call` event type = post-call webhook verified and logged

---

## 9. Operational Notes

### Number routing
- `+14154261341` — Production line, routed to ElevenLabs SIP (conn_id 2994018400621036617)
- `+14153845851` — Paseo Test Line, routed to Telnyx AI Assistant (kate-voice-agent, Kimi-K2.5, separate system)
- **Telnyx webhooks fire to our gateway for both numbers** — voice_events will have Telnyx call_status rows regardless of which number is dialed

### Wrong-number gotcha (2026-07-10)
Team spent hours testing the wrong number (+415-426-1341 vs +415-384-5851). Always confirm which number maps to which SIP connection in Telnyx portal before a test session.

### Publish-before-test rule
Any portal change (voice, tool, prompt, speed, webhook) only takes effect after clicking Publish. Test calls that don't reflect recent changes → check if Publish was done.

### V2 scope (future, not V1)
- Identity verification (verify_identity) with DOB/move-in challenge
- Balance reads for verified callers (with mandatory hedge)
- Approval gate for outbound calls (/voice/outbound 501 stub, needs per-call approval design)
- Outbound call triggering (requires convai_write API key scope)

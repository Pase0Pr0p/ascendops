# Voice Agent V1 Design

**Status:** Draft for joint session with Albie / laptop-Claude  
**Author:** claudia  
**Inputs:** Rob session 2026-07-10 (via chief), v0 live capture data  
**Last revised:** 2026-07-10 (post-chief review — platform question, identity data, Tier 2 balance, scope guard)

---

## DECISION ZERO: Platform Choice (First Albie Agenda Item)

**This is unresolved and reshapes Components 1 and 3.**

Two configs currently exist:
- **v0 / Telnyx AI Assistant**: Kimi-K2.5 + Telnyx Ultra voice, wired to the gateway via TeXML. Tool calls hit `/voice/tools/lookup_record` on this gateway. KB is external.
- **Rob's ElevenLabs config**: ElevenLabs Agents Platform + Gemini 2.5 Flash. ElevenLabs has its own native Tools, Knowledge Base, and webhooks — the wiring for `lookup_record`, KB ingestion, and post-call routing all differ from the Telnyx model.

**Impact:** The LOGIC in this doc (tiers, routing map, approval ledger, escalation) is platform-agnostic and carries either way. But the *wiring* changes:

| Component | Telnyx model | ElevenLabs model |
|-----------|-------------|-----------------|
| Mid-call lookup | AI calls `/voice/tools/lookup_record` on this gateway | AI calls an ElevenLabs Tool endpoint (may be same URL or different) |
| Knowledge base | Shared cortextos KB (external HTTP) | ElevenLabs native KB — Albie loads articles there |
| Post-call webhook | `conversation_insights` → gateway → bus | ElevenLabs post-call webhook → gateway → bus |

**Decision needed from Albie:** Which platform hosts the agent going forward? One or both? This is the session opener.

---

## AppFolio Identity-Field Audit (Completed 2026-07-10)

**Why this matters:** Tier 2 identity verification can only use data we actually hold per tenant. Individual AppFolio tenant records were sampled to establish field coverage before finalizing the verification challenge design.

### Field Coverage

| Field | Coverage | Notes |
|-------|----------|-------|
| Caller-ID match (inbound number = phone on file) | ~78% | Primary verification signal — automatic, no spoken challenge |
| Phone on file | 78% | July 2 inventory, n=302 current tenants. Below 90% sole-challenge threshold |
| Email | 79% | July 2 inventory, n=302. Below 90% threshold |
| Date of Birth (DOB) | ~65–70% estimated | Present on 2/3 sampled residential tenants; absent on commercial entities; not universal for residential |
| Move-in date | ~100% | All active tenants. WEAK SECRET — not suitable as sole challenge |
| Unit address | ~100% | All active tenants. WEAK SECRET — publicly searchable |
| Emergency contact | Present (header only) | Content empty on all sampled records; not usable |
| SSN | Not stored | AppFolio does not hold SSN for property management tenants |

### Verification Design: Caller-ID-First

**Finding:** No single field clears the 90%+ threshold for a sole spoken challenge. Caller-ID match is the strongest signal we have and requires no friction from the caller.

**Recommended approach:**

1. **Primary — Caller-ID match:** If the inbound number matches a phone on file → caller is treated as verified automatically, no spoken challenge. Covers ~78% of tenant calls.

2. **Fallback spoken challenge (remaining ~22% + unmatched):** Unit address (to anchor identity) + DOB. DOB is used because it is the most secret field we hold, even at ~65–70% coverage. If DOB is not on file for this tenant, fall back to move-in month + year (100% coverage, weaker secret, but still a barrier).

3. **Unknown callers (no phone on file match):** AI collects name + unit, asks DOB or move-in month/year. Lower-confidence path — still routes to accounting ("you have a balance, routing to accounting team") rather than reading account data.

**Security note (chief confirmed):** Caller-ID can be spoofed. This is proportionate for V1 because Tier 2 now routes rather than reads — the maximum harm from a spoofed caller-ID is they learn "you have a balance," not the balance amount.

### Closes

- Decision 3 (identity verification method) → **RESOLVED**
- Eliminates SSN, email-challenge, and emergency-contact from the design
- DOB gap (~30–35%) handled by move-in date fallback; not a blocking issue for launch

---

## What V0 Does (Baseline)

- Telnyx AI assistant (Kimi-K2.5 + Ultra voice) answers +14154261341
- Ed25519-verified webhooks: `call_status`, `conversation_insights`, `transcript`, `sms` → `voice_events` table
- All routes that could write or dial are 501 stubs with approval-gate notes
- No caller lookup, no routing, no downstream agent notifications

---

## V1 Scope

V1 adds four capabilities on top of v0 capture:

1. **Caller-ID lookup** — resolve the caller's phone number against AppFolio before or during the call
2. **Scope-tiered conversation** — AI handles calls according to a 4-tier policy; never reveals account data to unverified callers
3. **Post-call routing** — classify call intent and route output to the right agent via the bus
4. **Outbound approval gate** — any outbound dial requires an explicit human approval ledger entry

---

## Component 1: Caller-ID Lookup

**Trigger:** `call_status` webhook fires with `CallStatus=ringing` (or `initiated`), containing `From` (caller number).

**Flow:**
1. Gateway receives `call_status`, extracts `From`
2. Queries AppFolio (via `appfolio-browser-read.ts lookup-tenant`) OR a future Supabase contacts cache for the phone number
3. Writes a `caller_lookup` row to `voice_events` with `{ phone, resolved_type, name, unit, property }` before the AI picks up
4. The AI assistant can then call `/voice/tools/lookup_record` mid-call to get the pre-resolved identity

**`/voice/tools/lookup_record` request shape (from Telnyx AI tool call):**
```json
{
  "call_control_id": "...",
  "caller_number": "+14155551234",
  "query": "caller_info"
}
```

**Response shape:**
```json
{
  "found": true,
  "type": "tenant",
  "name": "Echo Rock",
  "unit": "45 Camino Alto - 204",
  "property": "45 Camino Alto",
  "verified": false,
  "tier_2_fields_redacted": true
}
```

**Unknown callers:** return `{ found: false, type: "unknown" }`. AI greets generically and collects name + unit.

**Open decision for Albie:** Do we pre-lookup on `ringing` (fast, but adds latency to every call via AppFolio browser) or lazy-lookup on first tool call from the AI (slower mid-call but only on demand)? Recommendation: pre-lookup async, cache in `voice_events`, serve from cache on tool call.

---

## Component 2: Scope-Tiered Conversation Policy

Rob's 4-tier policy (non-negotiable, must be enforced in AI system prompt + gateway):

| Tier | Scope | Identity Required | Notes |
|------|-------|-------------------|-------|
| 1 | Safe how-to: portal navigation, password reset steps, maintenance reporting instructions, office hours | None | AI handles freely |
| 2 | Account-specific: balance, payment history, lease dates, deposit amount | **Must verify identity first** | AI asks for verification (unit address + last 4 of DOB, or similar); never reveal Tier 2 data to unverified caller |
| 3 | Human-required: disputes, payment arrangements, credit promises, negotiations | Human handoff | AI takes a message + routes immediately to the right agent |
| 4 | Prohibited: take a payment, promise a credit, legal/lease interpretation, anything binding | Never | AI declines and routes to human |

**Identity verification flow (Tier 2) — caller-ID-first (see Audit section for field coverage):**
- **Step 1 — automatic:** Gateway checks if the inbound number matches a phone on file (`caller_sessions` lookup). If yes → verified, no spoken challenge needed.
- **Step 2 — spoken fallback (unmatched / unknown callers):** AI asks for unit address + DOB. If DOB not on file for this tenant → fall back to move-in month + year. Gateway `/voice/tools/lookup_record` accepts `{ query: "verify_identity", unit: "...", dob: "...", move_in: "..." }` and returns `{ verified: true/false }`.
- **If verified:** AI does NOT read the balance. Response: "I can see there is a balance on your account — let me connect you with our accounting team." (Routes to Anna.) This avoids the reliability gap: our recorded balance can lag reality (uncollected payments, checks in transit), so a read-out number can be misleading even if technically accurate.
- **If verification fails:** AI offers to take a message and have someone call back.

**System prompt additions needed:**
- The 4-tier policy in full
- Instruction to call `lookup_record` with `query=verify_identity` before reading any account data
- Instruction to call `lookup_record` with `query=route` when Tier 3/4 intent is detected

**Knowledge base:** AI pulls from the shared KB (Max maintenance playbook + AppFolio help articles). Gateway doesn't hardcode any knowledge — KB is the source.

---

## Component 3: Post-Call Routing

**Trigger:** `conversation_insights` webhook fires after call ends. Contains: transcript summary, detected intents, call outcome.

**Classification → agent routing:**

| Intent | Route to | Mechanism |
|--------|----------|-----------|
| Maintenance request | Max (maintenance-coordinator) | `cortextos bus send-message maintenance-coordinator` with caller, unit, issue summary |
| Leasing inquiry | Lexi (leasing-coordinator) | Bus message with caller contact + inquiry details |
| Renewal question | Robin (renewals-coordinator) | Bus message with caller, unit, lease context |
| Billing / accounting | Anna (agent-accounting-coordinator) | Bus message with caller, unit, balance |
| Non-routine / decision required | chief → Rob | Bus message to chief marked as `escalation`, chief creates a tracked task, reminder fires if unacknowledged within N hours |

**Last path (Rob's priority):** Non-routine items **must not sit silently**. Chief creates a task and schedules a follow-up ping. If Rob hasn't acknowledged within 4 hours (during day), chief sends a reminder. This is the path Rob cares most about.

**Portfolio scope guard:** Before routing, the classifier checks the property against the portfolio scope. Belvedere/Tiburon properties (Amanda Arriola scope) and any paused-work slots must NOT be routed to Max/Robin/Lexi/Anna. These route to chief only, flagged as out-of-scope for agent handling, so Amanda's portfolio is never inadvertently pulled into the fleet workflow.

**Bus message shape (example — maintenance):**
```
[VOICE CALL ROUTED] Maintenance request
From: Echo Rock, 45 Camino Alto - 204
Caller number: +14155551234
Summary: Reported HVAC not cooling, unit 204. Called 2026-07-10 at 11:32 AM.
call_id: <source_event_id>
```

**Implementation:** gateway reads `conversation_insights` payload from `voice_events` (post-insert trigger or background worker) and dispatches bus messages.

**Open decision for Albie:** Dispatch timing — should routing happen synchronously in the `conversation_insights` handler (fast but adds latency to the webhook ack), or async via a background worker polling `voice_events`? Recommendation: async worker, ack webhook immediately, worker processes within 30s.

---

## Component 4: Human Handoff (Mid-Call)

**When:** AI detects Tier 3/4 intent mid-call.

**Flow:**
1. AI tells caller: "Let me connect you with our team. Can I take your name and best callback number?"
2. AI calls `/voice/tools/lookup_record` with `{ query: "request_handoff", reason: "payment_dispute", caller_name: "...", callback: "..." }`
3. Gateway sends Telegram to Rob/Albie: "CALL HANDOFF NEEDED — Echo Rock, 45 Camino Alto 204 — payment dispute — callback: +1415xxx. Call in progress now."
4. Gateway optionally initiates a warm transfer via Telnyx (if Rob is available) or AI takes a message and ends the call gracefully

**Live transfer vs. callback:** Live transfer is complex (Telnyx Transfer command requires the receiving party to pick up). Recommendation for V1: **callback model only** — AI takes message, sends immediate Telegram alert, no live transfer. Live transfer is V2.

---

## Component 5: Outbound Approval Gate

**Rule:** No outbound dial without an explicit per-call approval entry in `outbound_approvals` table.

**Table schema:**
```sql
CREATE TABLE outbound_approvals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requested_by TEXT NOT NULL,       -- agent name (e.g. 'renewals-coordinator')
  target_number TEXT NOT NULL,
  target_name TEXT,
  reason TEXT NOT NULL,
  requested_at TIMESTAMPTZ DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | denied
  approved_by TEXT,                 -- 'rob' | 'albie'
  approval_token TEXT UNIQUE,       -- single-use token for Telegram callback
  decided_at TIMESTAMPTZ,
  call_placed_at TIMESTAMPTZ
);
```

**Flow:**
1. Agent (e.g. Robin) sends bus message: "Request outbound call to +14155551234 (Echo Rock) — delinquency follow-up"
2. Gateway creates `outbound_approvals` row, sends Telegram to Rob with approve/deny inline buttons (callback_data = `approve:<token>` or `deny:<token>`)
3. Rob taps Approve → Telegram callback → `/webhook/telnyx/approval-callback` → gateway dials via Telnyx, updates row
4. Rob taps Deny → row updated, requesting agent notified via bus

**Token TTL:** 24 hours. Expired tokens return `{ ok: false, error: 'token_expired' }` — Rob gets a follow-up Telegram if the request expires unanswered.

**Gateway route:** `POST /voice/outbound` (currently 501) becomes the approval-check endpoint — only proceeds if a valid approval token exists for this number+reason within TTL.

---

## New DB Tables Required

| Table | Purpose |
|-------|---------|
| `outbound_approvals` | Per-call approval ledger |
| `caller_sessions` | Caller lookup cache (phone → resolved identity, TTL 30 days) |

`voice_events` stays as-is — all call data already captured there.

---

## New Gateway Routes (V1 additions)

| Route | Method | Description |
|-------|--------|-------------|
| `/voice/tools/lookup_record` | POST | Mid-call caller lookup + identity verify + handoff request |
| `/voice/outbound` | POST | Outbound dial — checks approval table, places call via Telnyx |
| `/webhook/telnyx/approval-callback` | POST | Telegram button callback for approve/deny |

---

## Open Decisions for Albie Session

**Decision Zero (opens the session):**
- **Platform:** ElevenLabs + Gemini 2.5 Flash vs. Telnyx AI Assistant vs. both? Determines wiring for Components 1 and 3.

**Decisions 1–6 (once platform is settled):**
1. **Caller lookup latency:** pre-lookup on `ringing` vs. lazy on first tool call?
2. **Post-call routing dispatch:** synchronous in webhook handler vs. async worker?
3. **Identity verification method:** **RESOLVED** — see Audit section. Caller-ID match is primary (~78% coverage, automatic); DOB spoken fallback for unmatched callers (~65–70% coverage); move-in month/year as final fallback (100%, weaker). No SSN, no email challenge.
4. **Outbound approval UX:** Telegram inline buttons (recommended) or a web portal?
5. **Knowledge base ownership:** who loads / maintains the shared KB? Max for maintenance articles; Albie for AppFolio help?
6. **Scope of V1 routing:** route to all 5 agents on day 1, or start with Max (maintenance) + chief escalation only?

---

## What V1 Does NOT Include

- Live call transfer (V2)
- Taking payments (Tier 4, never)
- Lease interpretation (Tier 4, never)
- Outbound without approval gate (permanent constraint)

---

## Implementation Order (suggested)

1. `/voice/tools/lookup_record` — unblocks the AI from being identity-blind mid-call
2. Scope tier policy in AI system prompt — prevents Tier 2 leaks immediately
3. Post-call routing from `conversation_insights` — gets work orders to Max and escalations to chief
4. `outbound_approvals` table + Telegram approval flow
5. Caller session cache (optimization, not day-1 blocker)

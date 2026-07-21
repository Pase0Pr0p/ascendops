# ElevenLabs Wiring Instructions for Albie

Two changes in one sitting: (1) review and publish the updated Alex prompt, (2) wire the post-call webhook.

---

## Step 1: Update Alex Prompt

The current live prompt still tells Alex to "Call open_work_order" but that tool was already removed. The merged prompt fixes this and switches to captured-not-created language (Alex collects details conversationally, tells the caller "I'll send this to the maintenance team for review").

**What's preserved:** Your graceful-deferral paragraph (defer on info not in tool response, offer callback, never assert negatives), billing redirect to handoff, all personality/tone/safety sections, lookup_record flow.

**How to apply:**
1. Open ElevenLabs dashboard → Agents → "Paseo Properties"
2. Go to Agent tab → System Prompt
3. Replace the entire prompt text with the contents of the ```` ```  ```` block in `voice-gateway/alex-prompt-merged-staging.md`
4. Save (do NOT publish yet — review first, then publish when ready for the test call)

---

## Step 2: Wire Post-Call Webhook

The post-call processor needs ElevenLabs to send conversation data after each call ends. The gateway endpoint is built and deployed but ElevenLabs isn't sending to it yet.

**Webhook URL:**
```
https://voice-gateway-production-e1e2.up.railway.app/webhook/elevenlabs/post-call
```

**Webhook Secret (for HMAC-SHA256 signing):**
In `orgs/paseo-pm/secrets.env`, the value `ELEVENLABS_WEBHOOK_SECRET` (starts with `wsec_fac...`, 69 characters). This is the same secret the gateway uses to verify incoming webhooks. ElevenLabs signs the payload with this secret; the gateway verifies the signature.

**How to apply:**
1. Open ElevenLabs dashboard → Agents → "Paseo Properties"
2. Go to Agent tab → scroll to "Post-call webhook" (or Settings → Webhooks, depending on UI version)
3. Set the webhook URL to the URL above
4. Set the webhook secret to the value from secrets.env
5. Save

**Verification:** After both changes are saved + published, make a test call to the maintenance number. After the call ends, the gateway should receive a POST at `/webhook/elevenlabs/post-call` and insert a `voice_events` row with `event_type = 'elevenlabs_post_call'`. Check: `SELECT count(*) FROM voice_events WHERE event_type = 'elevenlabs_post_call' AND received_at > now() - interval '1 hour';`

---

## What data_collection fields are already set

All 10 fields are already configured in the ElevenLabs agent — no changes needed:
- caller_name, unit_number, property_address, maintenance_issue_description
- is_emergency, severity, permission_to_enter, location_detail
- availability_window, troubleshooting_notes

These are extracted by ElevenLabs from the conversation transcript post-call and included in the webhook payload.

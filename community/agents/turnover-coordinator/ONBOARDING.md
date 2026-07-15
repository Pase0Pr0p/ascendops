# Onboarding — Turnover Coordinator

Welcome. This is your first boot. Complete every step before starting normal operations. Total time: about 15–20 minutes. The customer (the property manager) drives this conversation in Telegram; you ask the questions, save the answers, and create the `.onboarded` marker at the end.

> All commands below use `ascendops`. If `ascendops` is not in PATH, substitute `cortextos` — they are the same binary.

---

## Step 0: Confirm Telegram is wired up

Before this script runs, the customer needs a Telegram bot with `BOT_TOKEN`, `CHAT_ID`, and `ALLOWED_USER` saved into the agent's `.env`. If `${CTX_TELEGRAM_CHAT_ID}` is set and you can send a test message, skip to Step 1.

Otherwise, direct the customer:

```
Before I can talk to you here, I need a Telegram bot. Three quick steps:

1. Open @BotFather in Telegram, send /newbot, follow the prompts. Copy the BOT_TOKEN.
2. Open your new bot, send /start.
3. From your terminal, run:
     curl -s "https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates" \
       | jq '.result[-1].message.chat.id'
   That prints your numeric chat id.

Then edit orgs/<org>/agents/{{agent_name}}/.env and set:
  BOT_TOKEN=<paste>
  CHAT_ID=<paste>
  ALLOWED_USER=<your Telegram username>

Restart me (cortextos restart {{agent_name}}) and message me here again.
```

---

## Step 1: Greet and collect the basics

Send:
```
Hi — I'm your new Turnover Coordinator. I manage the make-ready pipeline from move-out possession through inspection, scope + punch list, trade coordination, QC, and rent-ready certification.

We've got about 15 minutes of setup. I'll ask a series of questions and write answers into my config as we go. Ready?

First: what's your name, and what's the name of your property management company?
```

Save name → `USER.md`. Save company → `IDENTITY.md` (replace `{{company_name}}`) and `SYSTEM.md`.

---

## Step 2: Portfolio shape + turnover volume

Ask:
```
How many units do you typically turn per month? Rough breakdown — single family / multifamily / mixed? What city or metro?

And what's your current average days-to-rent-ready from possession? Even a rough number helps me know what target to set.
```

Set `{{turn_target_days}}` in `IDENTITY.md`, `SOUL.md`, and `config.json`. A reasonable starting point for most portfolios is 10 days. Update as the portfolio's data emerges.

Write `unit-roster.md` with the breakdown. Ingest to KB:
```bash
ascendops bus kb-ingest ./unit-roster.md --org $CTX_ORG --scope shared
```

Save region to `SYSTEM.md`.

---

## Step 3: Deployed alongside other agents?

Ask:
```
Are you running me alongside a maintenance coordinator agent or a leasing coordinator agent?

1. Alongside a maintenance coordinator — maintenance coordinator handles inbound work orders; I take over at move-out trigger.
2. Alongside a leasing coordinator — I certify and hand the unit to leasing for re-listing.
3. Both.
4. Neither — I'm standalone. I'll use vendor-coordination directly for trade dispatch.
```

Save to `SYSTEM.md`. This determines routing logic: with a maintenance coordinator, incoming make-ready triggers route here from that agent; without one, use vendor-coordination directly.

---

## Step 4: PM software stack

Ask:
```
Which property management software do you use for tracking turns and melds? Common ones:
  1. AppFolio
  2. Buildium
  3. Rent Manager
  4. Yardi / Yardi Breeze
  5. Propertyware
  6. Something else (tell me the name)
  7. None yet — spreadsheets for now
```

For each PM platform, collect any relevant credentials needed to read possession dates, upload completion records, or mark units rent-ready. Write credentials to `.env`. Save the chosen platform to `SYSTEM.md`.

---

## Step 5: Inspection service

Ask:
```
How do you handle move-out inspections? Common setups:
  1. Third-party inspection service (e.g. zInspector, Inspectify, Seek Now) — findings delivered digitally
  2. In-house inspector — findings uploaded manually (photos + checklist)
  3. Property manager walks the unit personally

If third-party: do they deliver a structured report I can ingest, or do you forward photos and notes manually?
```

If API or structured export: collect credentials and export format. Write to `.env`. Note in `SYSTEM.md`.
If manual: note that Stage 1 exit depends on the PM forwarding findings to the agent. Document the expected format.

Save to `SYSTEM.md`.

---

## Step 6: Trade roster + vendor coordination

Ask:
```
For trade dispatch during make-ready, do you have a standing vendor list? I need to know:

1. Who handles general repairs?
2. Who handles paint?
3. Who handles flooring / carpet?
4. Who handles cleaning?
5. Who handles re-key?
6. Are any of these in-house techs rather than external vendors?

If you have a vendor roster spreadsheet or doc, paste or upload it and I'll ingest it.
```

Write `vendor-roster.md` with the trade list. Ingest to KB:
```bash
ascendops bus kb-ingest ./vendor-roster.md --org $CTX_ORG --scope private
```

Save to `SYSTEM.md`.

---

## Step 7: Thresholds and SLAs

Ask:
```
Thresholds I need from you:

1. Inspection SLA: how many hours after possession do I expect inspection findings? (default: 48h)
2. Scope SLA: how many hours after receiving findings should the punch list be ready for your review? (default: 24h)
3. Stale-stage alert: how many days without progress on a stage before I draft an escalation to you? (default: 2 days)
4. Approval threshold: what spend amount requires your explicit approval before a vendor starts work? (common: $200)
5. Turn target: what is your target possession-to-rent-ready in days? (default: 10 days)
```

Save to `IDENTITY.md` (replace `{{inspection_sla_hours}}`, `{{scope_sla_hours}}`, `{{stale_stage_alert_days}}`, `{{approval_threshold}}`, `{{turn_target_days}}`), `SOUL.md` (same fields), and `config.json` (numeric fields).

---

## Step 8: Working hours + timezone

Ask:
```
What timezone are you in, and what are your normal business hours? Outside those hours I go into quiet mode — no external drafts pushed, internal tracking only.

(Common: America/New_York, 8 AM – 6 PM Mon–Fri)
```

Save to `config.json` (timezone + day_mode_start + day_mode_end). Replace template fields in `IDENTITY.md` + `SOUL.md`.

---

## Step 9: Standing rules

Ask:
```
Any standing rules I should bake in up front?
  - Units that should NEVER be certified without a specific extra check (e.g. pool units, units with prior mold history)
  - Wear-vs-damage policies specific to your portfolio (e.g. carpet replace at X years regardless of condition)
  - Specific vendors you never want dispatched (blacklist)
  - Any scope items that always require your personal approval regardless of cost

Or just say "defaults are fine".
```

Save to `SOUL.md` Custom Rules section.

---

## Step 10: Property manager identity confirmation

Ask:
```
Last thing: confirm your role for the record. Owner, property manager, operations manager? What should I call you in messages — first name only is fine?
```

Save:
- `USER.md` — full Role / Preferences / Communication Style sections
- `IDENTITY.md` — replace `{{property_manager_name}}`

---

## Step 11: Finalize

1. Replace any remaining `{{...}}` placeholders across all bootstrap files.
2. Update `MEMORY.md` with "Onboarded YYYY-MM-DD" entry.
3. Create the `.onboarded` marker:
   ```bash
   touch "${CTX_ROOT}/state/${CTX_AGENT_NAME}/.onboarded"
   ```
4. Log the event:
   ```bash
   ascendops bus log-event action onboarding_complete info \
     --meta '{"agent":"'$CTX_AGENT_NAME'","company":"<company>","platform":"<pm_platform>","persona":"turnover-coordinator"}'
   ```
5. Send the completion message:
   ```
   Setup done. Here's what's configured:

   Company: <company>
   Portfolio: <units> units in <region>, ~<N>/month turns
   PM platform: <platform>
   Inspection service: <service or manual>
   Trade roster: <N vendors + <N> in-house techs>
   Deployed alongside: <maintenance coordinator / leasing coordinator / standalone>
   Inspection SLA: <N>h, Scope SLA: <N>h, Stale alert: <N> days
   Approval threshold: $<amount>
   Turn target: <N> days possession-to-rent-ready
   Working hours: <start>–<end> <timezone>

   I'll check in every 4 hours and manage the turnover pipeline as moves come in. Forward me a possession confirmation or a completed inspection report to get started. Message me any time.
   ```

6. Resume the normal session-start protocol per AGENTS.md.

---

## If onboarding is interrupted

Re-read this file from the top on next boot. Skip steps whose answers are already filled in (`IDENTITY.md` no longer has the placeholder, `.env` has the keys, etc.) and resume on the first unanswered step. Do not re-ask anything you already know.

The `.onboarded` marker is only created at Step 11. Anything short of that = resume onboarding.

---

## Troubleshooting

- **PM software has no API** — fall back to manual possession confirmation + a `[HUMAN]` task for inspection upload. Document in `SYSTEM.md`.
- **No structured inspection report** — note that findings arrive as a photo dump + text notes. Build the punch list from that input. Remind the PM that a structured report speeds Stage 1 exit.
- **Vendor roster is incomplete** — use whatever is available. Flag missing trades as `[HUMAN]` tasks to source vendors before the first turn that needs them.

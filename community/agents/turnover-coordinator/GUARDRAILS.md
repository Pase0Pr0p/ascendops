# Guardrails

Read this file on every session start. Full reference: `.claude/skills/guardrails-reference/SKILL.md`

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. The dashboard tracks staleness. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it's significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. Context you don't write down is context the next session loses. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Un-ACK'd messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that doesn't go through the bus is invisible to the system. |

## Specialist Agent Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Task assigned to me | "I'll get to it later" | ACK and start within one heartbeat cycle. Stale tasks make you look broken. |
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

## Turnover-Specific Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Vendor says job is done | "Good enough, I'll mark it complete" | Reported-done is NOT verified-done. Require photo or documented outcome before marking any must-fix complete. |
| Re-key scheduled at same time as other trades | "Re-key can happen anytime in the sequence" | Re-key is ALWAYS last. Non-negotiable. Reschedule if needed. |
| Starting Stage 3 without PM punch list approval | "The scope is obvious, I'll proceed" | Stop. PM must approve the punch list before any trade dispatch. Stage 3 requires PM-approved scope. |
| Wear-vs-damage classification is ambiguous | "I'll just call it normal wear" | Flag as UNCLEAR for PM decision. Never decide a chargeback outcome yourself. |
| Stage has had no progress for 2+ days | "It's probably still moving" | Draft a stale-stage escalation to PM immediately. Silence is not progress. |
| All must-fix items done except one minor item | "Close enough for certification" | Never certify with an open must-fix. Either resolve it or get PM explicit approval to defer with a documented reason. |
| About to certify rent-ready | "The vendor confirmed everything is done" | Run the certify gate: every must-fix verified with evidence + re-key verified. No shortcuts. |
| Vendor quote or PO needed | "It's within the normal range" | Every spend above {{approval_threshold}} requires PM approval before work proceeds. Draft the approval request. |
| Tempted to send a message to a resident or vendor | "It's just a quick update" | Draft it and route for approval. No external message goes without approval. |
| Leasing coordinator asks if unit is ready | "I think it's basically done" | Only respond with a certified completion record. No informal "almost ready" signals. |

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check — did I hit any guardrails this cycle? If yes, log it:
   ```bash
   ascendops bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row below.

---

## Adding Guardrails

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

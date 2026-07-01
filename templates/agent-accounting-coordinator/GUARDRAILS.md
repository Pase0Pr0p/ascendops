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
| Blocked on something | "I'll wait and see" | Create a blocker task or escalate to the orchestrator immediately. Silent blockers are invisible. |
| Work finished | "Orchestrator will notice" | Complete the task and log the event now. Unlogged completions don't exist. |

## Accounting-Specific Patterns (MONEY SAFETY)

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Any action moves money | "The amount ties out, so I can proceed" | STOP. Create an approval. A human releases funds. Tie-out is necessary, not sufficient. |
| Vendor payment batch is ready | "The work was vetted, so payment can go out" | Draft the batch with backup and route the approval. The maintenance side confirms work; a human approves money. |
| Owner draw / statement is clean | "It's generated, so the draw can be sent" | Draft only. Owner-draw disbursement and owner-statement send are both human-approved. |
| Deposit return is calculated | "This is just returning money owed" | Draft the return + itemization, track the statutory deadline, and route the approval before any disbursement or send. |
| Reconciliation breaks | "It's probably a timing difference" | Verify the source rows, flag the exact break, and STOP. Never auto-correct a ledger. A flagged break is a correct outcome. |
| Ledger correction seems obvious | "I can post the adjustment and explain it" | STOP. Ledger adjustments are money-adjacent and approval-gated. |
| Owner / resident-facing financial document is ready | "It's only a statement, not money movement" | Draft-first. A human approves before any external send. |
| Data source is missing or stale | "I can infer from the last export" | Do not infer. Mark the number unsupported and request the source. |
| Reconciliation is off by pennies | "It's small enough to ignore" | Penny-off discipline applies. Surface every unexplained break. |
| Static discrepancy already reported | "I'll keep pinging until it's fixed" | Re-ping only when amount, source, risk, or deadline changes. Otherwise keep it logged. |
| Collections-looking output is requested | "I can message residents who are late" | Emit delinquency FACTS only. Collections conversations route to the property manager / resident relations. |
| Setting or quoting a rent number | "I'll just use the standard amount" | Not your call. Rent / pricing belongs to the property manager. Surface the ledger facts, not a price. |

---

## Copilot-First Approval Gate

Any money-gated (Ring 3) action MUST:

1. Create or use a visible task.
2. Create an approval through `.claude/skills/approvals/SKILL.md`.
3. Block the task on the approval.
4. Notify the property manager / approver.
5. Resume only when the approval decision lands.

No exceptions for "routine", "small", "obvious", or "already approved last time".

---

## How to Use

1. **On boot**: Read this table. Internalize the patterns.
2. **During work**: When you notice yourself thinking a red flag thought, stop and follow the required action.
3. **On heartbeat**: Self-check — did I hit any guardrails this cycle? If yes, log it:
   ```bash
   ascendops bus log-event action guardrail_triggered info --meta '{"guardrail":"<which one>","context":"<what happened>"}'
   ```
4. **When you discover a new pattern**: Add a new row below. The file improves over time.

---

## Adding Guardrails

If you catch yourself almost skipping something important that isn't in the table, add it.

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

# Guardrails

Read this file on every session start. Full reference: .claude/skills/guardrails-reference/SKILL.md

---

## Red Flag Table

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Heartbeat cycle fires | "I'll skip this one, I just updated recently" | Always update heartbeat on schedule. No exceptions. |
| Starting work | "This is too small for a task entry" | Every significant piece of work gets a task. If it takes more than 10 minutes, it is significant. |
| Completing work | "I'll update memory later" | Write to memory now. Later means never. |
| Inbox check | "I'll check messages after I finish this" | Process inbox now. Unacknowledged messages redeliver and block other agents. |
| Bus script available | "I'll handle this directly instead of using the bus" | Use the bus script. Work that does not go through the bus is invisible to the system. |

## Renewals-Specific Patterns

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| Rent recommendation ready | "This can be the offer amount" | Stop. It is a recommendation only. Route to the property manager for final pricing approval. |
| Resident-facing renewal draft | "The draft is clear, I can send it" | Do not send. Hand the approved package to the executor for sending. |
| Late or NSF threshold met | "The script says NonRenewal, so that is the decision" | Treat it as NonRenewal guidance for manager review. Do not issue or draft a legal notice unless asked. |
| High risk band without threshold trigger | "High means automatic NonRenewal" | Use MonthToMonth or NonRenewal caution language and ask for manager decision. |
| Market rent is far above current rent | "Recommend the full market jump" | Apply the configured increase cap unless the manager explicitly changes the knob. |
| Missing rent, payment, or inspection data | "I can infer enough" | Mark the data gap and narrow the recommendation. Do not fill facts from assumptions. |
| Assisted-housing flag present | "This is just another renewal" | Add a stage-one escalation flag so the executor preserves required process and timing. |
| Pet on file but screening incomplete | "It can wait until after signature" | Flag the pet-screening gap before offer execution. |
| Static row already reviewed | "I'll re-run it to be thorough" | Do not re-process static rows. Reopen only when source data, manager decision, or intake-window status changes. |
| Executor asks for final wording | "I should chase the resident directly" | Provide the draft and handoff notes. The executor sends, chases, and captures signature. |

---

## How to Use

1. On boot: read this table.
2. During work: when you notice a red flag thought, stop and follow the required action.
3. On heartbeat: self-check for any guardrails triggered this cycle.
4. When you discover a new pattern: add a new row below.

## Adding Guardrails

| Trigger | Red Flag Thought | Required Action |
|---------|-----------------|-----------------|
| [situation] | "[what you almost told yourself]" | [what you must do instead] |

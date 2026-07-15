---
name: weekly-review
description: "Weekly comprehensive synthesis. Run Sunday evening or when user requests. Reviews week's accomplishments across all agents, evaluates performance, plans next week."
triggers: ["weekly review", "weekly check-in", "end of week", "week summary", "run weekly review", "weekly briefing"]
---

# Weekly Review

> Comprehensive weekly check-in covering all agents' output, goals progress, orchestrator self-evaluation, and next-week planning.

**When:** Sunday evening (configured in cron) or when user requests.
**Duration:** ~15-30 minutes including user interaction.
**Output:** Memory log, actionable insights, next week plan.

---

## Phase 1: Data Aggregation

```bash
# All agent heartbeats
cortextos bus read-all-heartbeats

# All tasks this week
cortextos bus list-tasks
cortextos bus list-tasks --status completed

# This week's memory files (last 7 days)
for i in 0 1 2 3 4 5 6; do
  DATE=$(date -v-${i}d +%Y-%m-%d 2>/dev/null || date -d "$i days ago" +%Y-%m-%d)
  echo "=== $DATE ==="
  cat memory/${DATE}.md 2>/dev/null || echo "(no entry)"
done

# Goals and priorities
cat GOALS.md
cat $CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/goals.json

# Inbox
cortextos bus check-inbox
```

---

## Phase 1B: Forge Weekly-Heavy Build Assembly (MANDATORY)

Run the forge weekly-heavy hook before presenting the weekly review. This hook assembles the week's skill-drift candidates into specs and change-sets for your orchestrator/the owner gating; it does not auto-merge or runtime-activate anything.

Inputs:
- `forge_candidate` events logged during daily-light passes or instant-on-miss moments.
- `docs/ephemeral/forge-runs/candidates.md` if present.
- Any skill drift surfaced by the owner corrections, PR review loops, or under-fired skills this week.

**Plumbing guard:** if `$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs` does not exist (the forge plumbing has not landed in this runtime yet), write `FORGE WEEKLY BUILD: skipped (forge plumbing not deployed)` and skip the rest of 1B - do not error. Resume automatically once the plumbing is present.

Read the accumulated queue first - it merges the events since the last build marker with the pending run-log entries, deduped and grouped by create-vs-edit verdict:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" queue
```

If the queue is empty, write `FORGE WEEKLY BUILD: queue empty - no build` and skip the rest of 1B. Otherwise invoke the forge skill in build mode:

```
/forge --build
```

Gate every spec'd skill in the change-set through the combined load gate (real-YAML parse + discoverable + ship features + references resolve from the target home; the trigger-fire smoke stays manual in the target agent's context). Pass `--target-home` as the skill's OWN tracked source home (its role-template `.claude/skills` dir, or `community/skills` for a shareable skill) - NOT the repo root: the reference check resolves names relative to that home, so the repo root would false-green a ref that exists anywhere in the monorepo but is absent from the skill's actual home:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-load-gate.mjs" <skill-dir> --target-home "<the skill's tracked source home, e.g. templates/<role>/.claude/skills or community/skills>"
```

After the gated change-set is assembled and handed to the gate, archive the consumed queue so next week starts clean:

```bash
node "$CTX_FRAMEWORK_ROOT/scripts/forge-candidates.mjs" consume --build-id "build-$(date -u +%Y-%m-%d)"
```

Output a `FORGE WEEKLY BUILD` section with:
- `SKILLS TO SHIP` - new skill specs ready for source PR.
- `SKILLS TO SHARPEN` - existing skills with proposed diffs.
- `SKIP / WATCHLIST` - candidates that are not yet proven by a real incident or should wait.
- For every item: tied incident, proposed hard rule, tracked source home, runtime activation target, validation gate, and dev-side owner.

Hard stop: do not merge, edit live runtime, or auto-activate from this weekly hook. The weekly hook produces the spec/change-set for the gate; dev-side implementation and two-step registration happen only after approval.

---

## Phase 2: Present Review to User

Format into a comprehensive review and send as chunked Telegram messages:

```bash
cortextos bus send-telegram $CTX_TELEGRAM_CHAT_ID "<message chunk>"
```

### Review Template

```markdown
# Weekly Review - Week of [DATE]

---

## AGENT PERFORMANCE

| Agent | Status | Tasks Completed | Key Wins | Issues |
|-------|--------|----------------|----------|--------|
| [agent] | [heartbeat age] | X | [wins] | [gaps] |

Fleet Health:
- Agents online: X/N
- Agents stale (>5h): [list]
- Coordination events this week: X

---

## PRODUCTIVITY

Tasks this week (all agents combined):
- Completed: X
- In progress: Y
- Blocked: Z

Overnight work:
- Tasks dispatched: X
- Tasks completed: X

---

## GOALS PROGRESS

| Goal | Progress | Status |
|------|----------|--------|
| [north star goal] | [qualitative progress] | [on track / behind / blocked] |

---

## ORCHESTRATOR SELF-EVALUATION

| Dimension | Score (1-10) | Notes |
|-----------|-------------|-------|
| Usefulness | X | [why] |
| Proactivity | X | [why] |
| Coordination | X | [why] |
| Communication | X | [why] |
| Learning | X | [why] |
| **Total** | X/50 | |

What went well: [bullets]
What to improve: [bullets]
Key learnings: [bullets]

---

## SYSTEM IMPROVEMENT PROPOSALS

Based on this week's patterns:

[P1] [Category]: [Name]
- Problem observed: [specific pattern]
- Proposed solution: [concrete action]
- Assign to: [agent]
- Expected impact: [what changes]

[P2] ...

Agent gaps (capabilities needed):
- Missing: [capability]
- Proposed: [new skill or new agent]

---

## NEXT WEEK

Top priorities:
1. [priority]
2. [priority]
3. [priority]

Agent focus next week:
- [agent]: [priority work]

System improvements queued:
- [improvement 1]
- [improvement 2]
```

---

## Phase 3: Interactive Discussion

After sending the review, ask the user:
1. What went well this week in your view?
2. What was challenging or frustrating?
3. Any changes to priorities for next week?
4. Any new agents or capabilities needed?

---

## Phase 4: Update State

```bash
# Log event
cortextos bus log-event action briefing_sent info --meta '{"type":"weekly_review"}'

# Update heartbeat
cortextos bus update-heartbeat "weekly review complete - next week planned"

# Write to memory
TODAY=$(date -u +%Y-%m-%d)
cat >> "memory/$TODAY.md" << MEMEOF

## Weekly Review - $(date -u +%H:%M:%S)

### Summary
- Total tasks completed this week: X (all agents)
- Agents active: X/N
- Self-eval total: X/50
- Top priorities next week: [list]

### Key Insights
- [insight 1]
- [insight 2]

### System Improvements Queued
- [improvement 1]
MEMEOF

# Update MEMORY.md with persistent learnings
# Add any new patterns, preferences, or system behaviors discovered this week
```

---

## Custom Metrics

<!-- Added during onboarding - user-specific tracking preferences -->
<!-- Format: add bullet points below, each with the metric name and how to measure it -->

<!-- Example:
- **Platform MRR**: screenshot from your SaaS platform settings, extract MRR number
- **GitHub PRs merged this week**: gh pr list --state merged --json mergedAt | count those in last 7 days
- **Content pieces published**: count from alex agent completed tasks tagged content
-->

---

## Manual Trigger

```
"Run weekly review" → read .claude/skills/weekly-review/SKILL.md and execute
```

---

*This is the single source of truth for weekly review.*

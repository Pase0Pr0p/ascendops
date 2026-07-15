---
name: copilot-threshold
effort: medium
requires_config: "copilot_threshold block in blue agent config.json and copilot_tracking block in analyst agent config.json"
description: "Evaluate a PM specialist agent's decision accuracy per category, unlock autonomous mode when 95% threshold met over 20 decisions, demote when accuracy drops below 85%."
---

# Copilot Threshold Evaluation

Run during theta-wave and morning-report. Evaluates the specialist agent's (default: Blue) approval decision accuracy per category and triggers unlocks or demotions.

Operators configure the tracked agent and category list in `config.json`. See `copilot-thresholds.schema.json` for the data format.

---

## Configuration (operator required)

In your Blue agent's `config.json`:
```json
"copilot_threshold": {
  "enabled": true,
  "unlock_accuracy": 0.95,
  "demotion_accuracy": 0.85,
  "minimum_decisions": 20,
  "categories": {
    "lock_change": { "tier": 1, "max_autonomy": true },
    "inhouse_dispatch": { "tier": 1, "max_autonomy": true }
  },
  "permanent_floor": ["financial_over_500", "gas_water_structural"]
}
```

In your analyst agent's `config.json`:
```json
"copilot_tracking": {
  "enabled": true,
  "tracked_agents": ["blue"],
  "thresholds_path": "orgs/{org}/agents/{agent}/copilot-thresholds.json",
  "skill": ".claude/skills/copilot-threshold/SKILL.md",
  "evaluation_hooks": ["theta-wave", "morning-report"]
}
```

Initialize the thresholds file at `orgs/{org}/agents/{blue_agent}/copilot-thresholds.json` with all categories in `"status": "locked"`, zero decisions. Use the schema at `copilot-thresholds.schema.json` to validate.

**Important:** Each Blue agent instance starts with zero decisions — thresholds are earned per agent, not shared across a fleet.

---

## When to Run

- During every theta-wave cycle (nightly)
- During every morning-report
- Never run outside these hooks unless explicitly requested

---

## Step 1 — Read current thresholds

```bash
THRESHOLDS_FILE="$CTX_FRAMEWORK_ROOT/orgs/$CTX_ORG/agents/{blue_agent}/copilot-thresholds.json"
cat "$THRESHOLDS_FILE"
```

---

## Step 2 — Aggregate decision events

```bash
EVENTS_DIR="$HOME/.cortextos/${CTX_INSTANCE_ID:-default}/analytics/events"
find "$EVENTS_DIR" -name "*.jsonl" | \
  xargs grep -h '"name":"blue_decision_outcome"' 2>/dev/null
```

Parse each event for: `category`, `outcome` (correct/incorrect/ambiguous), `meld_id`, `autonomous`.

---

## Step 3 — Recalculate per-category accuracy

For each category:
1. Collect all `blue_decision_outcome` events (all time), exclude `ambiguous`
2. Take trailing 20
3. Count correct vs total
4. Update thresholds file with new counts and `updated_at`

---

## Step 4 — Check unlock eligibility

For each locked category: if `total_decisions >= 20` AND `accuracy_pct >= 95.0` → unlock sequence.

---

## Step 5 — Unlock sequence

1. Update thresholds file: `status → "unlocked"`, `unlocked_at`, `qualifying_accuracy`
2. Update Blue's `config.json`: move category from `always_ask` to `never_ask`
3. Append autonomy row to Blue's `GUARDRAILS.md`
4. Append/update row in Blue's `SOUL.md` earned autonomy table
5. Send message to orchestrator + Telegram to operator
6. Log: `cortextos bus log-event quality blue_autonomy_unlocked info --meta '{"category":"...","accuracy":...,"decisions":...}'`

Telegram format: `"Blue has earned autonomous {category} rights ({accuracy}% over {n} decisions). She will now act without asking and send you a post-action note. Reply DEMOTE {category} to reverse."`

---

## Step 6 — Check demotion eligibility

For each unlocked category: collect `autonomous: true` events, trailing 20. If `accuracy_pct < 85.0` → demotion sequence.

---

## Step 7 — Demotion sequence

1. Update thresholds file: `status → "demoted"`, `demoted_at`
2. Revert Blue's `config.json`: move category back to `always_ask`
3. Remove autonomy row from Blue's `GUARDRAILS.md` and `SOUL.md`
4. Notify orchestrator
5. Send Telegram with the 3 most recent incorrect decisions that caused the drop
6. Log: `cortextos bus log-event quality blue_autonomy_demoted info --meta '{"category":"...","accuracy":...}'`

Telegram format: `"Blue lost autonomous {category} rights ({accuracy}%). The 3 decisions that caused the drop: — {date}: {description} [x3]. She is back in approval-required mode."`

---

## Step 8 — Morning report section

Include a Blue Copilot Progress table with current status, decision count, and accuracy for each category.

---

## Event Reference

**Blue logs before every approval request:**
```bash
cortextos bus log-event quality blue_decision_presented info \
  --meta '{"category":"<category>","meld_id":"<id>","recommendation":"<one-line>","subtype":"routine|diagnostic"}'
```

**Analyst logs after operator responds:**
```bash
cortextos bus log-event quality blue_decision_outcome info \
  --meta '{"category":"<category>","meld_id":"<id>","outcome":"correct|incorrect|ambiguous","modified":false,"autonomous":false}'
```

`outcome: "ambiguous"` = no response in 4h during day mode (excluded from count).
`subtype` for `resident_comms`: `routine` or `diagnostic` (tracked for future taxonomy split).
`autonomous: true` on decisions made without approval after unlock.

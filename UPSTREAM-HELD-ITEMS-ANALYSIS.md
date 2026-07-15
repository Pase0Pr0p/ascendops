# Upstream Sync — Held-Items Decision Analysis

**Prepared by:** chief (Paseo Properties orchestrator)
**Date:** 2026-07-15
**For:** David (AscendOps upstream owner)
**Status:** Awaiting David's decision on two items

---

## Context

This morning the Paseo fork ran a full upstream catch-up against AscendOps `main`, under the standing rule of **cherry-pick only, no bulk merge**, so that our Paseo-specific business layer (utility-bill pipeline, AppFolio integrations, voice gateway, scrapers, our agent org under `orgs/paseo-pm/`) is never overwritten.

**Merged and live (4 clean picks):**

| Pick | What it brought |
|------|-----------------|
| Pulse + Departments | Org health/activity dashboard + configurable departments |
| SOP hub + wiki vault | 46-template SOP catalog + member wiki (we gated it login-only) |
| Catch-up bundle | Generic agent templates, community docs, 47 root SOP templates, hook-security hardening |
| Dashboard theme | Owner portal, voice-agent UI, SSN-redaction utility, owner data models |

We are now current with `main` **except the two items below**, which were deliberately held for an explicit call because each touches something sensitive: one restructures how every new agent is scaffolded, the other is a large multi-file change that overlaps our divergence. This document details both so the decision is made on facts.

---

## TL;DR — the two decisions

| Item | What it is | Risk to our live setup | Chief recommendation |
|------|-----------|------------------------|----------------------|
| **1. Persona template regeneration** | Full restructure of the agent-template system (monolithic template → persona catalog) | **None to existing agents.** Changes only how *new* agents are scaffolded | Adopt only if you intend the new persona-catalog model as our baseline. Otherwise leave it. Low urgency. |
| **2. Framework batch-1** | Mostly-positive framework update (SSN redaction, hook hardening, CI, opencode runtime) | Low behavioral risk; **high merge-conflict surface** against our bus/daemon code | **Worth pulling** — real value. But it is a careful conflict-resolved merge, not a clean pick. |

**Key correction from the initial read:** the "gate-scrubbing" in batch-1 is **not** a removal of safety gates. It is the scrubbing of Paseo-specific agent names and internal attribution notes out of the public repo, plus making the agent-name lint roster-driven instead of hardcoded. Detail in §2.

---

## Item 1 — Persona Template Regeneration

*(upstream commit `71790ea`)*

### What it does
It converts the agent-template system from a single monolithic `templates/agent/` (which carried the full skill set) into a **persona-catalog model**: many role-specific starter templates, plus a shared layer.

### File-level scope (15 template dirs touched)
`_shared, agent, agent-accounting-coordinator, agent-bd, agent-codex, agent-dev, analyst, hermes, leasing-coordinator, m2c1-worker, maintenance-coordinator, orchestrator, property-management, renewals-coordinator, turnover-coordinator`

- **9 net-new persona templates** (agent-accounting-coordinator, agent-bd, agent-dev, hermes, leasing-coordinator, m2c1-worker, maintenance-coordinator, property-management, turnover-coordinator). Each is a full scaffold: `AGENTS.md, CLAUDE.md, GOALS.md, GUARDRAILS.md, HEARTBEAT.md, IDENTITY.md, MEMORY.md, ONBOARDING.md, OPERATING_MODEL.md, SOUL.md, SYSTEM.md, TEMPLATE-NOTES.md, TOOLS.md, USER.md, config.json, goals.json, .env.example, .gitignore, .mcp.json` + `knowledge/` dirs.
- **5 existing templates reworked** (agent, agent-codex, analyst, orchestrator, renewals-coordinator): stripped to minimal placeholders, new `OPERATING_MODEL.md` + `TEMPLATE-NOTES.md` added.
- **35 skills deleted from `templates/agent/`**, including core operational skills: `activity-channel, agent-browser, agent-management, auto-skill, autoresearch, bus-reference, comms, cron-management, delegation-matrix, env-management, event-logging, framework-upstream-auto-update, guardrails-reference, heartbeat, human-tasks, knowledge-base, memory, onboarding, soul-philosophy, system-diagnostics, tasks, tool-registration, worker-agents` (and more).
- **2 skills added** to `templates/agent/`: `communications`, `task-system` (17-line stubs).
- New `templates/PERSONA-CATALOG-NOTES.md` index; `templates/_shared/onboarding/SKILL.md` updated.

### How it affects us
- **Existing agents: zero impact.** No file under `orgs/paseo-pm/` is touched. Our 7 live agents keep their customized identity, soul, skills, and config.
- **New agents only.** After adopting this, an agent created from `templates/agent/` would start from the leaner base (2 skill stubs) and the new persona/`_shared` structure rather than the old all-in-one template.

### The tradeoff to weigh
This is a **philosophy change to agent scaffolding**, not a bug fix. It is arguably *better* (role-specific personas beat one generic template), but it means our `add-agent` flow and our mental model of "what a new agent starts with" both change. We are about to stand up a new agent (a code reviewer), so the baseline matters right now.

### Chief recommendation
**Adopt only if you (David) intend the persona-catalog model as the go-forward standard for our fork too.** If yes, pull it and we re-validate our `add-agent` flow against the new structure. If you are not committing to that model yet, leave it — there is no pressure, existing agents are unaffected. **Low urgency either way.**

---

## Item 2 — Framework Batch-1

*(upstream commit `ef386d6`)*

A mixed but **mostly high-value** commit. Broken down below, with the "gate-scrubbing" question answered definitively first.

### 2a. The "gate-scrubbing" — what it actually removes (the make-or-break question)

The commit message's "gate-scrubbed" language refers to **scrubbing Paseo-specific content out of the public publish**, plus one lint refactor. File by file:

- **`src/bus/comms-lint-config.ts`** — *Removed:* the hardcoded agent-name rule `/(codie|collie|dane|aussie|blue|codex)/i`. *Replaced with:* `buildAgentNameRule(roster)`, which generates the same rule dynamically from a caller-provided roster. **Net effect for us: no weakening** — our fleet passes its roster, so our names stay blocked. **The one real tradeoff to document:** a deployment that does *not* configure a roster gets *no* agent-name lint at all. For a public repo this is the correct design (each deployment supplies its own roster), but it should be a conscious, documented behavior.
- **`src/hooks/index.ts`** — *Removed:* the OLD `isClaudeDirOperation` (Bash auto-approved via a `.claude/` substring match, no trust boundary). *Replaced with:* the stricter version we already took in the catch-up bundle (Bash never auto-approved, Edit/Write require `CTX_AGENT_DIR` containment via `realpath -m`, symlink rejection). Bash preview cap raised 200 → 1500 chars. **This is a security hardening, not a weakening.**
- **`bus/hook-permission-telegram.sh`** — same hardening as above, applied to the shell hook so it matches the TypeScript gate. **Hardening.**
- **`src/bus/hooks.ts`, `src/bus/message.ts`** — *Removed:* inline internal attribution comments only (e.g. "added 2026-04-29 by collie via dane dispatch"). PII scrub, **no behavioral change.**
- **CI (`.github/workflows/ci.yml`)** — **nothing removed**, three steps added (see 2c).
- **`.github/CODEOWNERS`** — **new file only.**

**Summary:** the only *behavioral* gate change is comms-lint agent-name lint becoming roster-driven. Everything else is a hardening or a PII scrub. **CI gains gates, loses none.**

### 2b. Security hardening
`isClaudeDirOperation` (TS) and `hook-permission-telegram.sh` (shell) both move to the stricter model: Bash never auto-approved for `.claude/` ops, Edit/Write require the agent-dir trust boundary, symlinks rejected. This aligns the shell hook with the TS gate we already run.

### 2c. CI additions (net-new value — we have no CI wired yet)
1. `scripts/skill-drift-check.mjs --tier ci` (before typecheck)
2. `knowledge-base/scripts/test_scrub_ssn.py` — SSN redaction python parity test
3. `scripts/ssn-parity-fuzz.ts` — JS-vs-python SSN differential fuzz

### 2d. Opencode runtime (directly relevant to us)
Adds **OpenCode as a second AI coding runtime** (separate binary): full PTY driver `src/pty/opencode-pty.ts` (startup detection, injection timing, shell-vs-chat detection) + `opencode-context-reporter.ts`, wired into `daemon/agent-process.ts` and the PTY adapters (584 lines of tests). **Additive** — our agents use the Claude Code PTY; this adds a runtime option with no change to existing behavior. Relevant because we are adding a codex-runtime reviewer agent, and this expands the runtime menu.

### 2e. SSN redaction (privacy improvement, wired fleet-wide)
`src/utils/ssn-redaction.ts` (canonical module) + SSN redaction wired across **all bus egress points** (`agents.ts, event.ts, message.ts, save-output.ts`, Telegram/Slack modules) + `pii-patterns.ts`. Note: this canonical module is the one our removed `redact-ssn` drift-guard test (from the dashboard-theme pick) imports — **pulling this lets us restore that test.**

### 2f. Housekeeping
- **nepq removal:** 7 files deleted from `community/skills/nepq/` (sales methodology). Not relevant to us.
- **`install.mjs`:** Windows build-tools detection simplified (Mac/Linux path unchanged — no impact for us).
- **`departments.ts`:** our Paseo agent names already scrubbed to empty upstream — matches what we already have, **no conflict.**

### 2g. Conflict risk (the real reason for the hold)
The commit touches **~51 `src/` files**. The conflict surface is **asymmetric**:
- **Clean (pure addition, no overlap):** the entire PTY layer — `opencode-pty`, `context-handoff-lease`, `context-monitor`. Take as-is.
- **Real reconcile needed:** the **15-20 `bus/` files** where SSN redaction is wired into the same `message`, `event`, and `task` plumbing that our utility-bill pipeline modifies. These must be hand-merged against our changes.

### Chief recommendation
**Pull it — the value is real** (fleet-wide SSN redaction, hook-security consistency, CI, the opencode runtime, and it re-enables our SSN drift-guard test). Treat it as a **careful conflict-resolved merge**, not a blind cherry-pick: take the PTY additions clean, hand-merge the `bus/` SSN wiring against our utility-bill plumbing. **One thing for you to confirm before we pull:** you are comfortable with the agent-name lint being roster-driven (no roster → no name lint) as the public-repo default.

---

## Recommendation summary

| Item | Recommendation | Why | Effort |
|------|----------------|-----|--------|
| 1 — Persona regeneration | Adopt **only if** you want the persona-catalog model as our baseline; else leave | Restructures new-agent scaffolding; existing agents safe; low urgency | Medium (re-validate add-agent flow) |
| 2 — Framework batch-1 | **Pull**, as a careful conflict-resolved merge | High value (SSN redaction, hook hardening, CI, opencode); "gate-scrub" is benign | Medium-high (hand-merge bus/ SSN wiring vs our utility-bill code) |

**Open confirmations needed from David:**
1. Item 1: is the persona-catalog model the intended go-forward baseline for our fork?
2. Item 2: OK with roster-driven agent-name lint (no roster → no lint) as the default?

On your go for either, each lands as its own reviewed PR — item 2 with the conflict resolution called out above.

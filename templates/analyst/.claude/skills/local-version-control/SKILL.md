---
name: local-version-control
description: "Daily git snapshots of agent workspace changes. Stages files with safety checks, reviews diff for PII, commits with descriptive message. Never pushes automatically."
triggers: ["auto-commit", "git snapshot", "commit changes", "version control"]
---

# Local Version Control

Daily snapshot of all agent workspace changes. Runs via auto-commit.sh with a two-layer safety review.

## Scope (worktree-aware)

This skill operates EXCLUSIVELY at the canonical framework root (`$CTX_FRAMEWORK_ROOT`) and snapshots **agent state files only** - `memory/`, `MEMORY.md`, `GOALS.md`, `config.json`, and the agent dir's tracked-by-canonical files. Worktree-tree code work is NOT auto-committed here - it ships via the PR workflow (feature branch on the agent's worktree + `gh pr create`). Every bash block in this skill starts with `cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"` to guarantee correct cwd; each shell invocation in an agent session is a fresh shell. Running this skill from a per-agent worktree would either commit to the wrong tree or miss the canonical agent state files entirely.

## When to Run

- Daily cron (configured via `cortextos bus add-cron`)
- After major agent work sessions
- Before any destructive operations

## Workflow

### Step 1: Run auto-commit.sh

```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
RESULT=$(cortextos bus auto-commit)
```

This stages files with safety checks:
- Blocks .env files and credentials
- Blocks files over 10MB
- Blocks binary/temp files
- Respects .gitignore rules

### Step 2: Review the staged diff

```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
git diff --cached
```

Check for:
- PII: names, emails, phone numbers in memory files
- Secrets: tokens, API keys, passwords
- Large diffs that look wrong
- Files that should not be committed

If anything looks sensitive, unstage it:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
git reset HEAD <file>
```

### Step 3: Commit

Generate a descriptive commit message summarizing what changed:
```bash
cd "${CTX_FRAMEWORK_ROOT:?CTX_FRAMEWORK_ROOT must be set}"
git commit -m "daily: <summary of changes>"
```

### Step 4: Do NOT push

Auto-commit never pushes. The user or orchestrator decides when to push.

## Config

Requires `ecosystem.local_version_control.enabled: true` in config.json.

## Safety

- Never commits .env files
- Never commits files matching credential patterns
- Always reviews diff before committing
- Never pushes automatically

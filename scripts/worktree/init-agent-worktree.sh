#!/bin/bash
# init-agent-worktree.sh
# Idempotent: create the per-agent git worktree if it doesn't exist yet.
# Part of worktree-isolation pattern
# (orgs/ascendops/docs/durable/worktree-isolation-design-2026-05-23.md).
#
# Usage:
#   init-agent-worktree.sh [<agent>]
#
# Defaults agent to $CTX_AGENT_NAME. Resolves worktree path from
# $CTX_AGENT_WORKTREE or computes $CTX_ROOT/state/agents/$agent/worktree.
# Framework root is $CTX_FRAMEWORK_ROOT.
#
# Exits 0 if worktree exists or was created. Exits non-zero on failure.

set -uo pipefail

AGENT="${1:-${CTX_AGENT_NAME:-}}"
if [ -z "$AGENT" ]; then
  echo "init-agent-worktree.sh: AGENT required (positional arg or CTX_AGENT_NAME env)" >&2
  exit 2
fi

FRAMEWORK_ROOT="${CTX_FRAMEWORK_ROOT:-}"
if [ -z "$FRAMEWORK_ROOT" ] || [ ! -d "$FRAMEWORK_ROOT/.git" ]; then
  echo "init-agent-worktree.sh: CTX_FRAMEWORK_ROOT must be a git repo (got '$FRAMEWORK_ROOT')" >&2
  exit 2
fi

CTX_ROOT_VAL="${CTX_ROOT:-$HOME/.cortextos/default}"
WORKTREE="${CTX_AGENT_WORKTREE:-$CTX_ROOT_VAL/state/agents/$AGENT/worktree}"

# Idempotency: a worktree path is "valid" if .git exists as a file (linked
# worktree marker) or as a directory (the canonical repo itself).
if [ -e "$WORKTREE/.git" ]; then
  echo "init-agent-worktree.sh: worktree already exists at $WORKTREE"
  exit 0
fi

# Ensure parent dir exists, then create the worktree on a per-agent default
# branch based on origin/main. We CANNOT reuse 'main' directly because git
# worktree add refuses to reuse a branch that's already checked out elsewhere
# (the canonical CTX_FRAMEWORK_ROOT is typically on main — see design §4.2
# where Dane stays on canonical). Instead each agent gets its own base branch
# 'agent/{agent}-base' tracking origin/main, which the refresh script keeps
# in sync. (Codex bot P1 catch on PR #53, 2026-05-23.)
mkdir -p "$(dirname "$WORKTREE")"
echo "init-agent-worktree.sh: creating worktree for agent=$AGENT at $WORKTREE"
BASE_BRANCH="agent/$AGENT-base"

# If the base branch already exists (e.g. from a prior init that was cleaned
# up but the branch ref stayed), use it; otherwise create new from origin/main.
if git -C "$FRAMEWORK_ROOT" rev-parse --verify "refs/heads/$BASE_BRANCH" >/dev/null 2>&1; then
  git -C "$FRAMEWORK_ROOT" worktree add "$WORKTREE" "$BASE_BRANCH"
else
  # Fetch origin/main first so the new branch tracks the latest.
  git -C "$FRAMEWORK_ROOT" fetch origin main
  git -C "$FRAMEWORK_ROOT" worktree add -b "$BASE_BRANCH" "$WORKTREE" origin/main
fi

# Symlink node_modules from the canonical tree so tests (vitest) can run in the worktree
# without a separate npm install. Deps stay in sync automatically.
for subdir in "" "dashboard/"; do
  src="$FRAMEWORK_ROOT/${subdir}node_modules"
  dst="$WORKTREE/${subdir}node_modules"
  if [ -d "$src" ] && [ ! -e "$dst" ]; then
    ln -sfn "$src" "$dst"
    echo "init-agent-worktree.sh: symlinked ${subdir}node_modules"
  fi
done

#!/usr/bin/env bash
# Prevent npm run build from clobbering production dist on feature branches.
# The daemon loads dist/daemon.js into memory at startup; a feature-branch
# build silently overwrites it, and the next restart reverts the deploy.

if [ "$CI" = "true" ] || [ -n "$GITHUB_ACTIONS" ]; then
  echo "prebuild-guard: CI environment detected, allowing build (ephemeral runner, no shared dist)."
  exit 0
fi

BRANCH=$(git branch --show-current 2>/dev/null)

if [ "$ALLOW_FEATURE_BUILD" = "1" ]; then
  echo "WARNING: ALLOW_FEATURE_BUILD=1 — building from branch '${BRANCH:-detached HEAD}' instead of main. Production dist will be overwritten."
  exit 0
fi

if [ -z "$BRANCH" ] || [ "$BRANCH" != "main" ]; then
  echo "ERROR: npm run build is only allowed on main (current: '${BRANCH:-detached HEAD}')."
  echo "  For feature-branch type-checking: npx tsc --noEmit"
  echo "  To override (DANGER): ALLOW_FEATURE_BUILD=1 npm run build"
  exit 1
fi

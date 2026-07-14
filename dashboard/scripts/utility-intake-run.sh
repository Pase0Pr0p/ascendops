#!/bin/bash
# Wrapper for utility-intake-run.ts. Sources secrets.env and claudia .env,
# then runs the TypeScript script via npx tsx.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/../.." && pwd)"
DASHBOARD="$REPO/dashboard"
AGENT_ENV="$REPO/orgs/paseo-pm/agents/claudia/.env"
SECRETS_ENV="$REPO/orgs/paseo-pm/secrets.env"

# Load secrets (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, GOOGLE_UTILITY_BILLS_SUBJECT, ALBIE_TELEGRAM_CHAT_ID, etc.)
if [[ -f "$SECRETS_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$SECRETS_ENV"
  set +a
fi

# Load agent .env for BOT_TOKEN
if [[ -f "$AGENT_ENV" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$AGENT_ENV"
  set +a
fi

# Absolutize SA key path so resolve(cwd, path) works after cd into dashboard/
if [[ -n "${GOOGLE_CONTACTS_SA_KEY_PATH:-}" && ! "${GOOGLE_CONTACTS_SA_KEY_PATH}" = /* ]]; then
  export GOOGLE_CONTACTS_SA_KEY_PATH="$REPO/$GOOGLE_CONTACTS_SA_KEY_PATH"
fi

cd "$DASHBOARD"
exec npx tsx scripts/utility-intake-run.ts

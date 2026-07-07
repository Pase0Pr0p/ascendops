# OAuth Rotation Skill

Manage Claude Max token utilization and rotate credentials when thresholds are met.

---

## Current state (as of 2026-07-07)

| Command | Status | Notes |
|---|---|---|
| `check-usage-api` | **LIVE** | Daemon runs every 15 min; reads from secrets.env |
| `list-oauth-accounts` | WIRED | Returns "No accounts.json" until bootstrap |
| `refresh-oauth-token` | WIRED | Needs accounts.json with stored refresh_token |
| `rotate-oauth` | WIRED | Needs accounts.json with 2+ accounts seeded |
| GitHub PAT rotation | MANUAL | No bus command yet; see manual procedure below |

---

## Commands

### check-usage-api — LIVE TODAY

Fetch Claude Max utilization from the Anthropic usage API. 3-minute TTL cache.

```bash
cortextos bus check-usage-api               # human-readable
cortextos bus check-usage-api --json        # JSON
cortextos bus check-usage-api --force       # bypass cache
cortextos bus check-usage-api --account <name> # specific account (needs accounts.json)
```

The daemon (fast-checker) calls this every 15 minutes automatically. On tier transitions it:
- Sends a Telegram alert directly
- Posts an inbox message so the agent acts on it next wake

Tiers: high ≥ 85% (5h or 7d), critical ≥ 95%.

**Env-var note:** `CLAUDE_CODE_OAUTH_TOKEN` is stripped from Bash subshells by Claude Code for security. The bus command reads the token from `orgs/<org>/secrets.env` as a fallback — this is why `check-usage-api` works without accounts.json.

### list-oauth-accounts — wired, needs bootstrap

```bash
cortextos bus list-oauth-accounts
```

Lists all accounts in `state/oauth/accounts.json` with utilization and expiry. Returns "No accounts.json found" until the bootstrap is done.

### refresh-oauth-token — wired, needs accounts.json

```bash
cortextos bus refresh-oauth-token                    # refresh active account
cortextos bus refresh-oauth-token --account <name>   # refresh specific account
```

Exchanges the stored `refresh_token` for a new access token. **Refresh tokens are one-time use** — the command writes `accounts.json` atomically before returning to avoid losing the new token on a crash.

Requires `accounts.json` with a `refresh_token` stored for the target account.

### rotate-oauth — wired, needs 2+ accounts

```bash
cortextos bus rotate-oauth                         # rotate if thresholds met
cortextos bus rotate-oauth --force                 # force regardless of utilization
cortextos bus rotate-oauth --agent claudia         # update only one agent's .env
cortextos bus rotate-oauth --reason "manual"       # logged reason
cortextos bus rotate-oauth --json                  # JSON output
```

Two-phase write:
1. Updates `accounts.json` (active account + rotation log)
2. Writes the new `CLAUDE_CODE_OAUTH_TOKEN` to all agent `.env` files

Rotation thresholds: 5h ≥ 85% OR 7d ≥ 80%.

---

## Bootstrap procedure (supervised window only — requires operator)

The multi-account rotation commands need `state/oauth/accounts.json`. This is a one-time setup per Claude account you want in the rotation pool.

**What the operator needs to provide:**
- The `refresh_token` for each Claude Max account to add
- Run `claude setup-token` on an interactive session to get a fresh token pair

**What to create** at `~/.cortextos/<instance>/state/oauth/accounts.json`:

```json
{
  "active": "primary",
  "accounts": {
    "primary": {
      "label": "Primary Max account",
      "access_token": "<access_token from claude setup-token>",
      "refresh_token": "<refresh_token>",
      "expires_at": 0,
      "last_refreshed": "<ISO-8601 timestamp>",
      "five_hour_utilization": 0,
      "seven_day_utilization": 0
    }
  },
  "rotation_log": []
}
```

After creating the file, `list-oauth-accounts` will show the account and `check-usage-api` will start tracking utilization against it.

---

## GitHub PAT rotation — manual procedure (no bus command yet)

`GH_TOKEN` and `GITHUB_TOKEN` in `secrets.env` are fine-grained PATs with a fixed expiry set on GitHub.

**When a PAT expires or is about to expire:**

1. The operator generates a new fine-grained PAT on GitHub (Settings → Developer settings → Fine-grained tokens)
   - Required permissions: Contents (read/write), Pull requests (read/write), Metadata (read)
   - Target: `<owner>/<repo>`
2. Update `orgs/<org>/secrets.env`:
   ```
   GH_TOKEN=<new token>
   GITHUB_TOKEN=<new token>
   ```
3. Restart the fleet so agents pick up the new token (soft-restart each agent, scout first to verify)

A `update-github-token` bus command is planned but not yet built (deferred to a supervised window).

---

## Rotation log

When rotations occur, they are appended to `accounts.json`'s `rotation_log` array (capped at 50 entries). Each entry records timestamp, from/to accounts, reason, and utilization at time of rotation.

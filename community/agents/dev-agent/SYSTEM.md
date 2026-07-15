# System

## Environment Variables
Set in `.env` during onboarding:
- `BOT_TOKEN` — Telegram bot token from @BotFather
- `CTX_TELEGRAM_CHAT_ID` — Owner's Telegram chat ID
- `ALLOWED_USER` — Telegram username allowed to send commands

PM platform credentials are stored separately:
- AppFolio: `~/.snapcli/appfolio.json` (captured via SafariDriver)
- PropertyMeld: `MELD_CLIENT_ID` / `MELD_CLIENT_SECRET` env vars

## Org Structure
- Orchestrator: `dane` (or your orchestrator agent name)
- This agent reports to the orchestrator for task assignment
- Files upstream PRs to `grandamenium/cortextos` for framework changes
- Files adapter PRs to `noogalabs/snapcli` for adapter changes

## Key Paths
- cortextos framework: `~/cortextos/`
- snapcli adapters: `~/projects/snapcli/` or `~/projects/cli-anything-*/`
- Credential files: `~/.snapcli/` — never committed to git
- Daily memory: `memory/YYYY-MM-DD.md`
- Nightly review artifacts: `~/cortextos/reviews/`

## Upstream PR Rules
1. One branch per PR, branched off `grandamenium/main`
2. 1–5 files max per PR
3. Build must pass: `npm run build && npm test`
4. Always merge to local main after filing — don't wait for James

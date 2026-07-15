# Goals

## Focus
Build and maintain reliable CLI adapters for every PM platform the org uses, so agents can query live data without a browser.

## Goals

### Core Responsibilities
1. **Build CLI adapters** — AppFolio, PropertyMeld, and any new PM platforms. Each adapter gets: session capture, probe command, and at least 3 data commands.
2. **Maintain sessions** — monitor session expiry, re-capture when needed, alert orchestrator if an adapter goes dark.
3. **File upstream PRs** — every cortextos framework fix goes upstream. Isolated branches, 1–5 files, clean tests.
4. **Review code** — run local-ultrareview on yesterday's commits each night. Surface critical issues to the orchestrator.
5. **Automate leasing data** — lease renewals, delinquency, vacancies, guest cards — all queryable by other agents without a browser.

### Standing Instructions
- Every adapter must have a working `probe` command before it is considered complete
- Credentials are always stored with `chmod 600` and never committed to git
- All framework fixes go upstream before being used locally
- Codex writes, an agent reviews — do not skip the review step

## Bottleneck
(none — add blockers here as they arise)

## Updated
{{current_timestamp}}

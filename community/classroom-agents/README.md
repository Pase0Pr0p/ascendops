# Classroom Downloadable Agents

The curated, member-facing agent templates offered for download in the classroom. A member downloads one, drops it into their install's `templates/` folder, runs `cortextos add-agent`, and onboards it. Each agent is copilot-first: it reads, verifies, and drafts, and never takes an external or money action without human approval.

This folder is the **source of truth**. The Skool classroom is a publish target, not the source.

## What is here

- `accounting-agent-template/`, accounting / AP-AR copilot (7 domain skills: AR rent posting, AP vendor payments, owner draws, owner-statement drafting, security-deposit accounting, trust compliance, trust reconciliation)
- `leasing-coordinator-agent-template/`, leasing + renewals copilot (4 domain skills: applicant screening, lease abstraction, renewals coordination, fair-housing guard). Renewals is folded into the leasing agent.
- `maintenance-coordinator-agent-template/`, maintenance copilot (5 domain skills: intake triage, vendor coordination, inspection-media-to-findings, make-ready scheduling, turnover coordination)

## The clean shape (every bundle)

- **Domain skills only.** Each bundle carries the work skills for its role plus the standard rule-skills, nothing else.
- **No bundled connectors.** Property-management connectors (Property Meld, browser automation, the cli-anything tooling) are NOT bundled. They are pulled through the community MCP at setup. A connector skill in a bundle fails the gate.
- **No our-specific data.** No company names, internal paths, real person names, or live credentials. Bundles are generic by templating.
- **Placeholder-templated.** Members replace these before going live:
  - Core (every bundle): `{{agent_name}}`, `{{company_name}}`, `{{operator_name}}`, `{{owner_name}}`, `{{timezone}}`
  - Sibling-agent names (only where an agent references another): `{{leasing_agent_name}}`, `{{maintenance_agent_name}}`, `{{accounting_agent_name}}`
- **Copilot-first.** Every external send, money movement, or binding decision is approval-gated (a `## Hard Gate` in the relevant skill).

## Member setup (what the classroom page tells them)

1. Download the agent zip from the classroom.
2. Unzip it into your install's `templates/` folder.
3. `cortextos add-agent my-<role> --template <bundle-dir-name>`
4. Put the agent's Telegram bot token + chat id in its `.env`, then `cortextos start my-<role>`.
5. Message it on Telegram and send `/onboarding`.
6. Replace the `{{placeholders}}` in the bootstrap files with your own before connecting any live system.

To connect property-management tools and the shared community skills, add the community MCP (see the community-knowledge / community-brain skill). Connectors come through there, not bundled in the agent.

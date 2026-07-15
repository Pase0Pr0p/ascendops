---
name: gmail
effort: low
description: "Read and draft emails via you@example.com Gmail. Use for checking PM notifications, drafting vendor emails, and monitoring inbox for property-related messages. All outbound emails require David's approval before sending."
triggers: ["email", "gmail", "inbox", "send email", "draft email", "check email", "vendor email", "tenant email", "PM email", "property meld email"]
---

# Gmail Skill

Access you@example.com via the `gws` CLI. Already authenticated with OAuth2 refresh token.

## Read inbox

```bash
# Unread summary (sender, subject, date)
gws gmail +triage

# Search for specific emails
gws gmail users messages list --user-id me --q "from:propertymeld.com" --format json
gws gmail users messages list --user-id me --q "subject:emergency" --format json

# Read a specific message
gws gmail users messages get --user-id me --id <message_id> --format json
```

## Send email

**APPROVAL REQUIRED** — never send without David's explicit approval.

```bash
# Draft and send (only after approval)
gws gmail +send --to "vendor@example.com" --subject "Subject" --body "Body text"

# With CC
gws gmail +send --to "vendor@example.com" --cc "you@example.com" --subject "Subject" --body "Body"
```

## Workflow

1. **Reading:** Free to read inbox at any time for PM notifications, vendor responses, tenant messages
2. **Drafting:** Write the draft, send to an agent for routing to David for approval
3. **Sending:** Only after David approves via Telegram. Always CC you@example.com on vendor comms.
4. **Night mode:** Read only. Queue drafts for morning review. No sending.

## Mark message as processed

After acting on a Gmail watch message, apply the `blue-processed` label (ID: `Label_72`) instead of marking read. IMAP clients re-mark read messages unread within seconds; the label persists correctly.

```bash
# Mark a message as processed (required after every Gmail watch action)
gws gmail users messages modify --params '{"userId":"me","id":"<MESSAGE_ID>"}' --json '{"addLabelIds":["Label_72"]}' --format json
```

Gmail watch query filters on `-label:blue-processed` so labeled messages won't re-appear.

## Useful searches

- Property Meld notifications: `from:propertymeld.com`
- Emergency melds: `from:propertymeld.com subject:emergency`
- Vendor responses: `from:<vendor_email>`
- Unread only: `is:unread`
- Last 24h: `newer_than:1d`

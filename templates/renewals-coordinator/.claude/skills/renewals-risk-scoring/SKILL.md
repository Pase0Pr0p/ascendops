---
name: renewals-risk-scoring
description: "Use this skill whenever a batch of lease renewals needs risk scoring, rent recommendation, escalation review, or pipeline QA before an executor sends approved offers. Run the generic scoring helper on rent roll, payment, and optional human-review rows; produce decision briefs; recommend but never price or send."
triggers: ["renewal scoring", "renewal risk", "rent recommendation", "renewal decision brief", "renewal pipeline QA", "lease expiry", "nonrenewal review", "month to month"]
context: fork
model: sonnet
---

# Renewals Risk Scoring

This coordinator is a research-and-recommendation engine. It is copilot-first and draft-first: analyze the renewal queue, score risk, recommend a capped rent, draft the owner and resident materials, and hand the approved package to the executor. It recommends, never prices, never sends.

## Boundary

Renewals analysis and recommendation are owned here. The executor, usually the leasing coordinator or property manager, sends the approved offer, chases non-responses, captures the signature, and updates final execution status.

Do not send resident communications. Do not call a recommendation final pricing. Do not issue legal notices.

## Generic Renewal Flow

1. Intake leases about 90 days before expiry from the renewals tracker or lease source.
2. Join rent, payment, and human-review data by property, unit, and tenant.
3. Score risk and assign Low, Medium, or High.
4. Check compliance and escalation flags: key missing, assisted-housing flag, pet-screening gap, inspection findings, violations, do-not-renew flag.
5. Draft a decision brief for the property manager with proposed rent, risk band, recommendation, rationale, and data gaps.
6. Escalate pricing, Month-to-Month, and NonRenewal decisions to the property manager.
7. After approval, draft owner and tenant documents for the executor.
8. Track the renewal through sent, response, and signature status based on executor updates.

Batch escalations where practical. Do not re-process static rows unless a source row changed, a decision changed, or the lease moved into the intake window.

## Helper Script

The helper is pure Python 3 stdlib and has no network or third-party dependencies.

Run synthetic demo data:

```bash
python3 .claude/skills/renewals-risk-scoring/renewals_score.py --demo
python3 .claude/skills/renewals-risk-scoring/renewals_score.py --demo --json
```

Run CSV inputs:

```bash
python3 .claude/skills/renewals-risk-scoring/renewals_score.py \
  --rent-roll rent_roll.csv \
  --delinquency delinquency.csv \
  --human human_review.csv \
  --today 2026-07-01 \
  --json
```

## Field Contract

Delinquency rows:
- tenant_name
- unit
- property_id
- late_count_12mo
- nsf_count_12mo
- outstanding_balance
- last_payment_date
- section8

Rent roll rows:
- tenant_name
- unit
- property_id
- current_rent
- market_rent
- lease_expiry
- bed_bath_sqft
- section8

Optional human rows:
- tenant_name
- unit
- property_id
- key_on_file
- pet_on_file
- pet_screening_status
- do_not_renew_flag
- violations_summary
- inspection_status
- inspection_findings
- manager_comp_rent

Join key: normalized property_id, unit, tenant_name. A tenant with no delinquency row is treated as clean: zero late payments, zero NSF events, and zero outstanding balance.

## Outputs

Each record includes:
- risk_score
- risk_band
- proposed_rent
- cma_rationale
- agent_recommendation: Renew, MonthToMonth, or NonRenewal
- recommendation_rationale
- stage1_escalations
- in_intake_window

Use these outputs to prepare the manager decision brief. The script output is an analytical recommendation, not approved pricing.

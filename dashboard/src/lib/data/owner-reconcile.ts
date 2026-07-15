// Owner-statement reconciliation harness (master plan §8.3 — the "provably
// correct" guard that blocks owner exposure).
//
// The one number an owner can independently check is their AppFolio owner
// statement, so we prove ours against it. For a closed statement period we
// compare aggregateOwnerFinancials' period totals (via ownerPeriodTotals) to
// the statement's income / expense / net, at a $0.01 tolerance, itemizing every
// mismatch. Green = reconciled; red = a stop-ship for that owner (the portal
// publisher refuses to publish a red owner's bundle — §8.3).
//
// This module is PURE comparison logic — no I/O — and is fully unit-tested
// against a SYNTHETIC owner-statement fixture. All KPI math stays in
// owner-aggregate.ts (§8.1); reconciliation only diffs.
//
// ─────────────────────────────────────────────────────────────────────────
// TODO (live wiring — session-blocked, CC §5.0 report discovery):
//   Pulling the real AppFolio owner-statement report and mapping its period
//   totals into OwnerStatementTotals is NOT done here. It needs a live AppFolio
//   session + owner-statement report discovery (the report family exists; the
//   exact report id / column shape must be captured per CC §5.0 Path A). Once
//   discovered, a small owner_reconcile pull builds OwnerStatementTotals from
//   the statement rows and feeds reconcileOwnerStatement below; the comparison
//   logic here does not change. See also config/owner-recon-known-deltas.json
//   (§8.3) for legitimate persistent deltas — explained, visible, never hidden.
// ─────────────────────────────────────────────────────────────────────────

import {
  ownerPeriodTotals,
  round2,
  type OwnerFinancialsSnapshot,
  type OwnerPeriodTotals,
} from './owner-aggregate';
import type { ResolvedScope } from './pulse-scope';

/** §8.3 reconciliation tolerance: $0.01. */
export const RECON_TOLERANCE = 0.01;

/**
 * The owner-statement side of the comparison — the totals AppFolio's owner
 * statement reports for one closed period. In the live wiring these are parsed
 * from the statement report; in tests they come from a synthetic fixture.
 */
export interface OwnerStatementTotals {
  owner_id: string;
  /** Human label for the closed period, e.g. '2026-06'. */
  period: string;
  /** Inclusive 'YYYY-MM' bounds the statement covers. Default: period..period. */
  from?: string;
  to?: string;
  income: number;
  expenses: number;
  net: number;
  /** Optional per-GL-category totals, enabling line-itemized deltas. */
  by_category?: Record<string, number>;
}

export interface ReconLineDelta {
  /** 'income' | 'expenses' | 'net' | 'category:<name>'. */
  field: string;
  ours: number;
  statement: number;
  /** ours − statement (signed). */
  delta: number;
}

export interface OwnerReconResult {
  owner_id: string;
  period: string;
  status: 'green' | 'red';
  tolerance: number;
  ours: { income: number; expenses: number; net: number };
  statement: { income: number; expenses: number; net: number };
  /** Only the lines whose |delta| exceeds tolerance. Empty ⇒ green. */
  deltas: ReconLineDelta[];
}

/**
 * Pure comparison: our period totals vs an owner statement's, $0.01 tolerance,
 * itemized. Compares income / expenses / net, plus per-category when BOTH sides
 * provide a by_category map. Any line over tolerance flips the status to red.
 */
export function reconcileTotals(
  ours: OwnerPeriodTotals,
  statement: OwnerStatementTotals,
  tolerance: number = RECON_TOLERANCE
): OwnerReconResult {
  const deltas: ReconLineDelta[] = [];
  const check = (field: string, o: number, s: number) => {
    const delta = round2(o - s);
    if (Math.abs(delta) > tolerance) {
      deltas.push({ field, ours: round2(o), statement: round2(s), delta });
    }
  };

  check('income', ours.income, statement.income);
  check('expenses', ours.expenses, statement.expenses);
  check('net', ours.net, statement.net);

  if (ours.by_category && statement.by_category) {
    const cats = new Set([...Object.keys(ours.by_category), ...Object.keys(statement.by_category)]);
    for (const c of [...cats].sort()) {
      check(`category:${c}`, ours.by_category[c] ?? 0, statement.by_category[c] ?? 0);
    }
  }

  return {
    owner_id: statement.owner_id,
    period: statement.period,
    status: deltas.length === 0 ? 'green' : 'red',
    tolerance,
    ours: { income: round2(ours.income), expenses: round2(ours.expenses), net: round2(ours.net) },
    statement: {
      income: round2(statement.income),
      expenses: round2(statement.expenses),
      net: round2(statement.net),
    },
    deltas,
  };
}

/**
 * Convenience end-to-end: compute OUR totals for the statement's period+scope
 * from the snapshot, then reconcile. The `scope` is the owner's ResolvedScope
 * (same one the owner dashboard renders through) so the two are provably the
 * same numbers.
 */
export function reconcileOwnerStatement(
  snap: Pick<OwnerFinancialsSnapshot, 'records'>,
  scope: ResolvedScope,
  statement: OwnerStatementTotals,
  tolerance: number = RECON_TOLERANCE
): OwnerReconResult {
  const from = statement.from ?? statement.period;
  const to = statement.to ?? statement.period;
  const ours = ownerPeriodTotals(snap, scope, { from, to });
  return reconcileTotals(ours, statement, tolerance);
}

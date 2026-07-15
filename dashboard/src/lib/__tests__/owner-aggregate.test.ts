// §8.1 / §8.3 owner-financials invariant + reconciliation tests (shard OV-2).
// Mirrors pulse-aggregate.test.ts: the core assertion is that
// aggregateOwnerFinancials(records, ALL_SCOPE) deep-equals the OV-1 generator's
// own `live` block — so a scoped owner view can never silently diverge from the
// company-wide headline (master plan risk #3, the NOI category-map drift trap).
//
// Fixtures are synthetic (no real financial data, §6.6) and their `live` block
// is HAND-COMPUTED, not produced by this code — the invariant is not circular.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  aggregateOwnerFinancials,
  ownerPeriodTotals,
  financialsCoverage,
  ALL_SCOPE,
  OWNER_NA_REASONS,
  type OwnerFinancialsSnapshot,
} from '@/lib/data/owner-aggregate';
import {
  reconcileOwnerStatement,
  reconcileTotals,
  type OwnerStatementTotals,
} from '@/lib/data/owner-reconcile';
import {
  parseScopeParam,
  resolveScope,
  type ResolvedScope,
} from '@/lib/data/pulse-scope';
import type { EntityRegistry } from '@/lib/data/pulse';

import ownerFixtureJson from '@/lib/data/__fixtures__/pulse-slice/owner-financials.json';
import ownerStatementJson from '@/lib/data/__fixtures__/pulse-slice/owner-statement.json';
import entitiesJson from '@/lib/data/__fixtures__/pulse-slice/entities.json';

type OwnerSnap = OwnerFinancialsSnapshot;
const owner = ownerFixtureJson as unknown as OwnerSnap;
const statement = ownerStatementJson as unknown as OwnerStatementTotals;
const registry = entitiesJson as unknown as EntityRegistry;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function mustResolve(param: string): ResolvedScope {
  const { resolved, warning } = resolveScope(parseScopeParam(param), registry);
  expect(warning).toBeNull();
  return resolved;
}

// The `live` block excludes ledger + na (raw feed / per-scope signal).
function liveOf(agg: ReturnType<typeof aggregateOwnerFinancials>) {
  const { ledger, na, ...live } = agg;
  void ledger;
  void na;
  return live;
}

// ---------------------------------------------------------------------------
// THE INVARIANT (§8.1): aggregate(records, ALL) === generator's live block
// ---------------------------------------------------------------------------
describe('§8.1 invariant — aggregateOwnerFinancials(ALL_SCOPE) deep-equals the generator live block', () => {
  it('reproduces every live field from records alone', () => {
    const agg = aggregateOwnerFinancials(owner, ALL_SCOPE);
    expect(liveOf(agg)).toEqual(owner.live);
    expect(agg.na).toEqual({});
  });

  it('NOI identity holds: noi_ttm === income_ttm − expenses_ttm', () => {
    const agg = aggregateOwnerFinancials(owner, ALL_SCOPE);
    expect(agg.noi_ttm).toBe(agg.income_ttm - agg.expenses_ttm);
  });

  it('excludes owner_draw / debt_service / expense_capex from NOI but keeps them in by_category', () => {
    const agg = aggregateOwnerFinancials(owner, ALL_SCOPE);
    // The three excluded rows total $7,300 and would wreck NOI if summed in.
    expect(agg.by_category['Owner Distribution']).toEqual({ class: 'owner_draw', amount: 1500 });
    expect(agg.by_category['Mortgage Interest']).toEqual({ class: 'debt_service', amount: 800 });
    expect(agg.by_category['Roof Replacement']).toEqual({ class: 'expense_capex', amount: 5000 });
    // ... yet NOI opex is only the operating + passthrough classes.
    expect(agg.expenses_ttm).toBe(1315);
  });

  it('excludes GL rows OUTSIDE the trailing-12-month window (the 9999 drift guard)', () => {
    // The 2025-07 Rent row (amount 9999) is one month before the window start.
    // A naive "sum all income" would report 24499 instead of 14500.
    const agg = aggregateOwnerFinancials(owner, ALL_SCOPE);
    expect(agg.income_ttm).toBe(14500);
    expect(agg.monthly_series).toHaveLength(12);
    expect(agg.monthly_series[0].month).toBe('2025-08');
    expect(agg.monthly_series.at(-1)!.month).toBe('2026-07');
  });

  // Anti-circularity: numbers must come from RECORDS, not copied from `live`.
  it('numbers are computed from records, never copied from live', () => {
    const tampered = clone(owner);
    tampered.live.income_ttm = 999_999;
    tampered.live.noi_ttm = 999_999;
    tampered.live.by_property['101'].noi_ttm = 999_999;
    const agg = aggregateOwnerFinancials(tampered, ALL_SCOPE);
    expect(agg.income_ttm).toBe(14500);
    expect(agg.noi_ttm).toBe(13185);
    expect(agg.by_property['101'].noi_ttm).toBe(8010);
  });
});

// ---------------------------------------------------------------------------
// Owner + property scopes (union-of-properties semantics, §6.2)
// ---------------------------------------------------------------------------
describe('owner / property scoping', () => {
  it('owner:o_1 = union of Moss Dr + Buckley Ave (excludes Cedar Ct)', () => {
    const agg = aggregateOwnerFinancials(owner, mustResolve('owner:o_1'));
    expect(agg.na).toEqual({});
    expect(agg.income_ttm).toBe(13000); // 9000 + 4000
    expect(agg.expenses_ttm).toBe(1240); // 990 + 250
    expect(agg.noi_ttm).toBe(11760);
    expect(Object.keys(agg.by_property).sort()).toEqual(['101', '102']);
    // Cedar Ct (103, owner o_2) is out of scope entirely.
    expect(agg.by_category['Rent Income'].amount).toBe(13000);
  });

  it('property:103 slices to Cedar Ct alone', () => {
    const agg = aggregateOwnerFinancials(owner, mustResolve('property:103'));
    expect(agg.income_ttm).toBe(1500);
    expect(agg.expenses_ttm).toBe(75);
    expect(agg.noi_ttm).toBe(1425);
    expect(Object.keys(agg.by_property)).toEqual(['103']);
  });

  it('ledger is scope-filtered and newest-first', () => {
    const all = aggregateOwnerFinancials(owner, ALL_SCOPE).ledger;
    expect(all.map((l) => l.date)).toEqual(['2026-07-14', '2026-07-10', '2026-07-03', '2026-06-05']);
    const o1 = aggregateOwnerFinancials(owner, mustResolve('owner:o_1')).ledger;
    // Cedar Ct (103) line drops; the o_1 lines remain, newest-first.
    expect(o1.map((l) => l.property_id)).toEqual([101, 101, 102]);
  });
});

// ---------------------------------------------------------------------------
// Resident scope — n/a by design (§8.1 honesty)
// ---------------------------------------------------------------------------
describe('resident scope', () => {
  it('is n/a WITH a reason and carries no numbers', () => {
    const agg = aggregateOwnerFinancials(owner, mustResolve('resident:casey-lane--1102-moss-dr-unit-a'));
    expect(agg.na.owner_financials).toBe(OWNER_NA_REASONS.resident);
    expect(agg.income_ttm).toBe(0);
    expect(agg.expenses_ttm).toBe(0);
    expect(agg.noi_ttm).toBe(0);
    expect(agg.by_category).toEqual({});
    expect(agg.by_property).toEqual({});
    expect(agg.ledger).toEqual([]);
    // A zeroed 12-month series, never a fabricated number.
    expect(agg.monthly_series).toHaveLength(12);
    expect(agg.monthly_series.every((m) => m.income === 0 && m.expenses === 0 && m.noi === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §8.3 reconciliation harness — our period totals vs the owner statement
// ---------------------------------------------------------------------------
describe('§8.3 owner-statement reconciliation', () => {
  const scope = mustResolve('owner:o_1');

  it('period totals for owner:o_1 / 2026-06 match the statement inputs', () => {
    const ours = ownerPeriodTotals(owner, scope, { from: '2026-06', to: '2026-06' });
    expect(ours).toEqual({
      income: 5000,
      expenses: 800,
      net: 4200,
      by_category: {
        'Rent Income': 5000,
        'Repairs & Maintenance': 550,
        'Property Tax': 250,
        'Owner Distribution': 1500,
        'Mortgage Interest': 800,
      },
    });
  });

  it('reconciles GREEN when our aggregate matches the statement to the cent', () => {
    const result = reconcileOwnerStatement(owner, scope, statement);
    expect(result.status).toBe('green');
    expect(result.deltas).toEqual([]);
    expect(result.owner_id).toBe('o_1');
    expect(result.period).toBe('2026-06');
    expect(result.tolerance).toBe(0.01);
  });

  it('goes RED and itemizes the delta when the statement drifts (a category off)', () => {
    const drifted = clone(statement);
    drifted.expenses = 812.5; // +12.50 vs our 800
    drifted.by_category!['Repairs & Maintenance'] = 562.5; // +12.50
    const result = reconcileOwnerStatement(owner, scope, drifted);
    expect(result.status).toBe('red');
    // Both the expenses total AND the offending category are surfaced.
    expect(result.deltas).toContainEqual({
      field: 'expenses',
      ours: 800,
      statement: 812.5,
      delta: -12.5,
    });
    expect(result.deltas).toContainEqual({
      field: 'category:Repairs & Maintenance',
      ours: 550,
      statement: 562.5,
      delta: -12.5,
    });
  });

  it('stays GREEN for a sub-cent difference (within $0.01 tolerance)', () => {
    const nearly = clone(statement);
    nearly.net = 4200.005; // half a cent off
    const result = reconcileTotals(
      ownerPeriodTotals(owner, scope, { from: '2026-06', to: '2026-06' }),
      nearly
    );
    expect(result.status).toBe('green');
    expect(result.deltas).toEqual([]);
  });

  it('flags a delta of exactly more than a cent as RED', () => {
    const off = clone(statement);
    off.income = 5000.02; // 2 cents over
    const result = reconcileOwnerStatement(owner, scope, off);
    expect(result.status).toBe('red');
    expect(result.deltas).toContainEqual({ field: 'income', ours: 5000, statement: 5000.02, delta: -0.02 });
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT against a REAL snapshot (auto-activates at OV-1 hookup)
// ---------------------------------------------------------------------------
// .pulse-data is gitignored (real financial data) and today's OV-1 generator
// does not exist yet, so this skips. The moment pulse_owner_financials.py emits
// owner-financials.json with records, this check turns ON in every `npm test` —
// the acceptance gate for the live hookup. Red ⇒ the Python emission and the TS
// math disagree; fix one to match the other, NEVER copy `live` through.
describe('§8.1 invariant — REAL .pulse-data owner-financials (skipped until OV-1 lands)', () => {
  const readReal = (): OwnerSnap | null => {
    try {
      const dir = fileURLToPath(new URL('../../../.pulse-data/', import.meta.url));
      return JSON.parse(fs.readFileSync(dir + 'owner-financials.json', 'utf-8')) as OwnerSnap;
    } catch {
      return null;
    }
  };
  const real = readReal();
  it.skipIf(!real?.records?.length)('real snapshot ALL-scope equals its live block', () => {
    const snap = real as OwnerSnap;
    const { ledger, na, ...live } = aggregateOwnerFinancials(snap, ALL_SCOPE);
    void ledger;
    void na;
    expect(live).toEqual(snap.live);
  });

  it('G1 records-era real owner-financials snapshot must carry records or an explicit records gap', () => {
    if (!real?.generated_at || real.generated_at < '2026-07-01') return;
    const hasRecords = Array.isArray(real.records);
    const hasWhy = Boolean(
      (real.needs_verification as Record<string, { why?: string }> | undefined)?.records?.why,
    );
    expect(hasRecords || hasWhy, 'owner-financials is records-era but has no records or records-gap why').toBe(true);
  });
});

// --------------------------------------------------------------------------- #
// OV-1: coverage label driven off needs_verification.window (labeling, not math)
// The *_ttm figures are calendar-YTD until a true trailing-12 source lands; the
// label must reflect that (never show calendar-YTD as bare "TTM") and auto-revert.
// --------------------------------------------------------------------------- #
describe('OV-1 financialsCoverage — label reflects the real window, no bare TTM on YTD', () => {
  it('flags YTD + surfaces the why when needs_verification.window is present', () => {
    const cov = financialsCoverage({
      needs_verification: {
        window: { why: 'twelve_month_cash_flow returns calendar-year-only data on this account' },
      },
    });
    expect(cov.label).toBe('YTD');
    expect(cov.label).not.toBe('TTM'); // never present calendar-YTD as TTM
    expect(cov.caveat).toContain('calendar-year-only');
  });

  it('honors an explicit window.label/coverage when the generator provides one', () => {
    expect(financialsCoverage({ needs_verification: { window: { label: 'H1 2026' } } }).label).toBe('H1 2026');
    expect(financialsCoverage({ needs_verification: { window: { coverage: 'last 7 mo' } } }).label).toBe('last 7 mo');
  });

  it('reverts to TTM (no caveat) when the window flag is absent — degrades cleanly', () => {
    expect(financialsCoverage({ needs_verification: {} })).toEqual({ label: 'TTM', caveat: null });
    expect(financialsCoverage({})).toEqual({ label: 'TTM', caveat: null });
    expect(financialsCoverage(null)).toEqual({ label: 'TTM', caveat: null });
    expect(financialsCoverage(undefined)).toEqual({ label: 'TTM', caveat: null });
  });

  it('has a coverage-accurate fallback caveat when the window flag is present but has no why', () => {
    const cov = financialsCoverage({ needs_verification: { window: {} } });
    expect(cov.label).toBe('YTD');
    expect(cov.caveat).toBeTruthy();
  });

  it('carries NO em-dash in any owner-facing string (populated + fallback branches)', () => {
    const withWhy = financialsCoverage({
      needs_verification: { window: { why: 'source report is calendar-year — verify' } },
    });
    const fallback = financialsCoverage({ needs_verification: { window: {} } });
    for (const c of [withWhy, fallback]) {
      expect(c.caveat).not.toContain('—'); // em-dash
      expect(c.label).not.toContain('—');
    }
  });
});

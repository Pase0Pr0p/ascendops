// THE owner-financials aggregation module (master plan §8.1 — the single-math
// rule for the owner/asset dashboard, the sibling of pulse-aggregate.ts).
//
// ALL owner KPI math lives HERE and only here. The internal owner view AND the
// future owner-portal publisher call these same functions, so the two surfaces
// cannot diverge (§8.1). The board recomputes every displayed owner number —
// company-wide and owner/property-scoped — through aggregateOwnerFinancials
// when the snapshot carries `records`. The OV-1 generator keeps computing its
// own `live` block precisely so the invariant test can cross-check:
//
//     aggregateOwnerFinancials(snapshot, ALL_SCOPE)  ⊇  snapshot.live
//     (deep-equals on every `live` field; ledger + na are not part of `live`)
//
// If they diverge, either the records are incomplete or the TS math differs
// from the Python math — both are lies waiting to surface under a filter.
// (Enforced in dashboard/src/lib/__tests__/owner-aggregate.test.ts.)
//
// Honesty rules encoded here (inherited from pulse-aggregate.ts):
//  - Owner financials are property/portfolio-grained. A RESIDENT scope has no
//    meaningful financial slice (GL rows are per-property, not per-tenant), so
//    it returns an `na` entry with a reason and carries no numbers — never a
//    misleading property total wearing a resident's name.
//  - Records that cannot be attributed to a property (property_id null) are
//    EXCLUDED from any narrower slice but counted under ALL, matching the
//    generator's own company-wide aggregate. In practice OV-1 fails loud on
//    unmapped rows, so this is a defensive floor.
//  - Only the trailing 12 months anchored on the snapshot `today` feed the TTM
//    totals; out-of-window GL rows are excluded (never silently summed in).

import { type ResolvedScope } from './pulse-scope';
export { ALL_SCOPE } from './pulse-scope';

/** Card-key -> one-line human reason a card is not computable for this scope. */
export type NaMap = Record<string, string>;

// ---------------------------------------------------------------------------
// OV-1 record contract (per master plan §5 OV-1 emit shape). Mirrors the
// per-row facts the pulse_owner_financials.py generator emits alongside `live`.
// ---------------------------------------------------------------------------

/**
 * GL classification, assigned by the generator from the reviewed
 * config/owner-gl-category-map.json (§4.5-NOI). Every GL category maps to
 * exactly one class; unmapped categories fail the generator loud, never reach
 * here. NOI counts income minus the OPERATING-expense classes only.
 */
export type GlClass =
  | 'income'
  | 'expense_operating'
  | 'expense_capex'
  | 'debt_service'
  | 'owner_draw'
  | 'passthrough_tax'
  | 'passthrough_insurance';

/** One property-month-category GL rollup row. */
export interface OwnerGlRecord {
  kind: 'gl_month';
  property_id: number | null;
  property_name: string | null;
  /** Attribution month, 'YYYY-MM'. */
  month: string;
  /** Verbatim GL category name (the by_category key). */
  category: string;
  class: GlClass;
  amount: number;
}

/** One transaction-ledger line (§3.4-4 "checking account" feed, last ~13mo). */
export interface OwnerLedgerLine {
  property_id: number | null;
  property_name?: string | null;
  /** 'YYYY-MM-DD'. */
  date: string;
  type: 'rent_received' | 'expense';
  category: string;
  description: string;
  amount: number;
}

/** Per-month income/expenses/noi point (the §3.4-2/3.4-3 chart series). */
export interface MonthlyPoint {
  month: string;
  income: number;
  expenses: number;
  noi: number;
}

/** Per-category TTM rollup (the §3.4-3 breakdown; ALL classes, not just NOI). */
export interface CategoryRollup {
  class: GlClass;
  amount: number;
}

/** Per-property TTM rollup (the §3.2 property cards). */
export interface PropertyRollup {
  property_name: string | null;
  income_ttm: number;
  expenses_ttm: number;
  noi_ttm: number;
}

/**
 * The `live` block the generator emits AND the block aggregateOwnerFinancials
 * reproduces under ALL scope. Ledger + na are intentionally NOT here: the
 * ledger is a raw passthrough feed, na is a per-scope honesty signal — neither
 * is a company-wide KPI the invariant cross-checks.
 */
export interface OwnerFinancialsLive {
  income_ttm: number;
  expenses_ttm: number;
  noi_ttm: number;
  monthly_series: MonthlyPoint[];
  by_category: Record<string, CategoryRollup>;
  by_property: Record<string, PropertyRollup>;
}

export interface OwnerFinancialsSnapshot {
  lane?: string;
  generated_at?: string;
  /** 'YYYY-MM-DD' the generator ran — the TTM window anchor. */
  today: string;
  live: OwnerFinancialsLive;
  records: OwnerGlRecord[];
  ledger?: OwnerLedgerLine[];
  needs_verification?: Record<string, unknown>;
  coming_soon?: Record<string, unknown>;
}

export type OwnerAggregateResult = OwnerFinancialsLive & {
  ledger: OwnerLedgerLine[];
  na: NaMap;
};

/** Coverage of the owner financial figures (income/expenses/NOI). */
export interface FinancialsCoverage {
  /** Card label suffix. 'TTM' only when a true trailing-12 source is verified;
   *  otherwise the ACTUAL coverage (e.g. 'YTD'), so an owner is never shown a
   *  calendar-year-to-date figure labeled 'TTM' (OV-1). */
  label: string;
  /** Owner-facing caveat when the window is NOT a true trailing-12, else null. */
  caveat: string | null;
}

/**
 * Coverage label + caveat for the owner financial cards, DRIVEN OFF the
 * generator's `needs_verification.window`. `owner_financials.py` windows to a
 * trailing-12 mathematically, but when the source report returns calendar-year
 * data the figures are effectively calendar-YTD, and the generator records that
 * at `needs_verification.window` (with a `.why`). When that flag is present the
 * cards relabel to the real coverage and surface the reason; when it is absent
 * (a true-TTM source landed) they revert to 'TTM' automatically. This never
 * renames the internal `_ttm` fields — it is a labeling/disclosure fix only.
 */
export function financialsCoverage(
  snapshot: { needs_verification?: Record<string, unknown> } | null | undefined,
): FinancialsCoverage {
  const nv = snapshot?.needs_verification;
  const win =
    nv && typeof nv === 'object' ? (nv as Record<string, unknown>).window : undefined;
  if (!win || typeof win !== 'object') {
    return { label: 'TTM', caveat: null };
  }
  const w = win as Record<string, unknown>;
  const label =
    (typeof w.label === 'string' && w.label.trim()) ||
    (typeof w.coverage === 'string' && w.coverage.trim()) ||
    'YTD';
  const why = typeof w.why === 'string' && w.why.trim() ? w.why.trim() : null;
  // Strip em-dashes from the (generator-produced) reason so no owner-facing
  // string carries one, per the owner-truth string rules.
  const caveat = (
    why ?? 'Shown for the calendar year to date, not a full trailing 12 months.'
  ).replace(/—/g, '-');
  return { label, caveat };
}

export const OWNER_NA_REASONS = {
  resident:
    'Owner financials are property/portfolio-grained (GL is per-property, not per-tenant), not defined for a single resident.',
} as const;

// --- classification: which classes feed NOI --------------------------------
// NOI (TTM) = Σ income − Σ operating expenses, where operating expenses are
// every non-income expense EXCEPT owner draws, debt service, and capex (§4.5).
// Property taxes + insurance paid through the PM ARE in the AppFolio ledger and
// therefore inside NOI — which is exactly why §4.4's NCF math must not subtract
// them a second time (the double-count trap).
const NOI_OPEX_CLASSES: ReadonlySet<GlClass> = new Set<GlClass>([
  'expense_operating',
  'passthrough_tax',
  'passthrough_insurance',
]);

/** Classes deliberately kept OUT of NOI (still shown in by_category, per §3). */
export const NON_NOI_CLASSES: ReadonlySet<GlClass> = new Set<GlClass>([
  'owner_draw',
  'debt_service',
  'expense_capex',
]);

// --- money + month math ----------------------------------------------------
/** Cent-precision round (owner financials reconcile to $0.01, not whole $). */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/** 'YYYY-MM-DD' | 'YYYY-MM…' -> 'YYYY-MM'. */
function monthOf(ymd: string): string {
  return ymd.slice(0, 7);
}

/** Shift a 'YYYY-MM' key by whole months (delta may be negative). */
function addMonths(ym: string, delta: number): string {
  const [y, m] = ym.split('-').map(Number);
  const idx = y * 12 + (m - 1) + delta;
  const ny = Math.floor(idx / 12);
  const nm = (idx % 12) + 1;
  return `${ny}-${String(nm).padStart(2, '0')}`;
}

/**
 * The 12 'YYYY-MM' keys of the trailing-twelve-months window ending at (and
 * including) the snapshot `today`'s month, ordered oldest -> newest. This is
 * the single definition of "TTM" for the whole owner dashboard.
 */
export function ttmMonths(today: string): string[] {
  const anchor = monthOf(today);
  const out: string[] = [];
  for (let i = 11; i >= 0; i--) out.push(addMonths(anchor, -i));
  return out;
}

// --- scope matching (identical semantics to pulse-aggregate.ts) ------------
type Match = 'in' | 'out' | 'unmapped';

function matchByProperty(propertyId: number | null, scope: ResolvedScope): Match {
  if (scope.kind === 'all') return 'in';
  if (propertyId == null) return 'unmapped';
  if (scope.kind === 'properties') return scope.ids.includes(propertyId) ? 'in' : 'out';
  return propertyId === scope.property_id ? 'in' : 'out';
}

function emptyLive(today: string): OwnerFinancialsLive {
  return {
    income_ttm: 0,
    expenses_ttm: 0,
    noi_ttm: 0,
    monthly_series: ttmMonths(today).map((month) => ({ month, income: 0, expenses: 0, noi: 0 })),
    by_category: {},
    by_property: {},
  };
}

// ---------------------------------------------------------------------------
// THE aggregate — every owner KPI over a scope, off raw gl_month records.
// ---------------------------------------------------------------------------
export function aggregateOwnerFinancials(
  snap: Pick<OwnerFinancialsSnapshot, 'today' | 'records'> & { ledger?: OwnerLedgerLine[] },
  scope: ResolvedScope
): OwnerAggregateResult {
  const na: NaMap = {};

  // Resident scope carries no financial meaning — n/a with a reason, no numbers.
  if (scope.kind === 'resident') {
    na.owner_financials = OWNER_NA_REASONS.resident;
    return { ...emptyLive(snap.today), ledger: [], na };
  }

  const months = ttmMonths(snap.today);
  const window = new Set(months);
  const inWindow = (m: string) => window.has(m);
  const inScope = (pid: number | null) => matchByProperty(pid, scope) === 'in';

  const recs = snap.records.filter(
    (r) => r.kind === 'gl_month' && inWindow(r.month) && inScope(r.property_id)
  );

  let rawIncome = 0;
  let rawOpex = 0;
  const byMonth = new Map<string, { income: number; expenses: number }>();
  const byCat = new Map<string, { class: GlClass; amount: number }>();
  const byProp = new Map<number, { property_name: string | null; income: number; opex: number }>();

  for (const r of recs) {
    const isIncome = r.class === 'income';
    const isOpex = NOI_OPEX_CLASSES.has(r.class);

    // by_category surfaces EVERY class (incl. capex/debt/draws) so the §3.4-3
    // breakdown is complete; only income + operating classes feed the KPIs.
    const bc = byCat.get(r.category) ?? { class: r.class, amount: 0 };
    bc.amount += r.amount;
    byCat.set(r.category, bc);

    if (!isIncome && !isOpex) continue; // excluded-from-NOI class: breakdown only

    if (isIncome) rawIncome += r.amount;
    else rawOpex += r.amount;

    const mm = byMonth.get(r.month) ?? { income: 0, expenses: 0 };
    if (isIncome) mm.income += r.amount;
    else mm.expenses += r.amount;
    byMonth.set(r.month, mm);

    if (r.property_id != null) {
      const bp = byProp.get(r.property_id) ?? { property_name: r.property_name, income: 0, opex: 0 };
      if (isIncome) bp.income += r.amount;
      else bp.opex += r.amount;
      byProp.set(r.property_id, bp);
    }
  }

  const monthly_series: MonthlyPoint[] = months.map((month) => {
    const mm = byMonth.get(month) ?? { income: 0, expenses: 0 };
    return {
      month,
      income: round2(mm.income),
      expenses: round2(mm.expenses),
      noi: round2(mm.income - mm.expenses),
    };
  });

  const by_category: Record<string, CategoryRollup> = {};
  for (const [cat, v] of byCat) by_category[cat] = { class: v.class, amount: round2(v.amount) };

  const by_property: Record<string, PropertyRollup> = {};
  for (const [pid, v] of byProp) {
    by_property[String(pid)] = {
      property_name: v.property_name,
      income_ttm: round2(v.income),
      expenses_ttm: round2(v.opex),
      noi_ttm: round2(v.income - v.opex),
    };
  }

  // Ledger: raw feed passthrough, scope-filtered, newest-first. Not TTM-windowed
  // (OV-1 already caps it to ~13 months) and not part of the §8.1 invariant.
  const ledger = (snap.ledger ?? [])
    .filter((l) => matchByProperty(l.property_id, scope) === 'in')
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  return {
    income_ttm: round2(rawIncome),
    expenses_ttm: round2(rawOpex),
    noi_ttm: round2(rawIncome - rawOpex),
    monthly_series,
    by_category,
    by_property,
    ledger,
    na,
  };
}

// ---------------------------------------------------------------------------
// Period totals — the same math over an arbitrary inclusive 'YYYY-MM' range.
// The reconciliation harness (owner-reconcile.ts, §8.3) is its consumer: a
// single closed owner-statement period is a one-month range. Kept HERE so the
// §8.1 single-module rule holds — reconciliation does diffing, not KPI math.
// ---------------------------------------------------------------------------
export interface OwnerPeriodTotals {
  income: number;
  expenses: number;
  net: number;
  by_category: Record<string, number>;
}

export function ownerPeriodTotals(
  snap: Pick<OwnerFinancialsSnapshot, 'records'>,
  scope: ResolvedScope,
  period: { from: string; to: string } // inclusive 'YYYY-MM' bounds
): OwnerPeriodTotals {
  // Zero-padded 'YYYY-MM' compares correctly as a string.
  const inRange = (m: string) => m >= period.from && m <= period.to;
  const inScope = (pid: number | null) => matchByProperty(pid, scope) === 'in';

  const recs = snap.records.filter(
    (r) => r.kind === 'gl_month' && inRange(r.month) && inScope(r.property_id)
  );

  let rawIncome = 0;
  let rawOpex = 0;
  const byCat = new Map<string, number>();
  for (const r of recs) {
    byCat.set(r.category, (byCat.get(r.category) ?? 0) + r.amount);
    if (r.class === 'income') rawIncome += r.amount;
    else if (NOI_OPEX_CLASSES.has(r.class)) rawOpex += r.amount;
  }

  const by_category: Record<string, number> = {};
  for (const [cat, amt] of byCat) by_category[cat] = round2(amt);

  return {
    income: round2(rawIncome),
    expenses: round2(rawOpex),
    net: round2(rawIncome - rawOpex),
    by_category,
  };
}

// ===========================================================================
// ASSET METRICS (AL-2 feed / AL-4 wiring) — the RentCast AVM value + market-rent
// estimates. The generator (pulse_asset_metrics.py) emits FACTS only (values,
// ranges); every owner KPI derived from them lives HERE (the §8.1 single-math
// rule, same as the GL math above). Provenance class for every asset number is
// `estimate` (§8.2): third-party / modeled, ALWAYS rendered with provider +
// as-of + range, never presented as a current fact, amber when stale.
//
// Scope: value/rent are property-grained, so a RESIDENT scope has no asset
// meaning (n/a with a reason). Portfolio value sums ONLY the in-scope properties
// that carry an estimate; every in-scope property WITHOUT one lands in an
// explicit `unvalued` bucket — never silently dropped from a "portfolio" sum
// (§4.5-V). EQUITY is deliberately NOT computed here: it needs owner-supplied
// loan data we do not have yet (AL-1), and missing loan data ≠ zero debt.
// ===========================================================================

/** One property's AVM value + market-rent estimate — a fact row, no KPIs. */
export interface AssetMetricsRecord {
  property_id: number | string;
  property_name: string | null;
  /** AVM point value; null when the vendor returned no value for the address. */
  value: number | null;
  value_range: [number | null, number | null];
  rent_estimate: number | null;
  rent_range: [number | null, number | null];
  provider: string; // e.g. 'rentcast'
  as_of: string; // 'YYYY-MM-DD'
  granularity: 'unit' | 'property';
}

/** A property the feed could NOT value, with the machine reason (§4.5-V). */
export interface AssetMetricsUnvalued {
  property_id: number | string;
  reason: string;
}

/** The .pulse-data/asset-metrics.json snapshot (records + unvalued + budget). */
export interface AssetMetricsSnapshot {
  lane?: string;
  provider?: string;
  generated_at?: string;
  today?: string;
  records: AssetMetricsRecord[];
  unvalued?: AssetMetricsUnvalued[];
  budget?: unknown;
}

/** Estimate provenance carried on every asset-derived owner number (§8.2). */
export interface AssetProvenance {
  provider: string;
  as_of: string;
  /** True when as_of is older than STALE_ESTIMATE_DAYS vs the reference date. */
  stale: boolean;
}

/** One property's asset view for a card (§3.2) — every field an `estimate`. */
export interface PropertyAssetView {
  property_id: number;
  property_name: string | null;
  value: number | null;
  value_range: [number | null, number | null];
  rent_estimate: number | null;
  rent_range: [number | null, number | null];
  granularity: 'unit' | 'property';
  provenance: AssetProvenance;
}

export interface OwnerAssetsResult {
  /** Σ value of ONLY the in-scope properties that HAVE an estimate (§4.5-V). */
  portfolio_value: number;
  /** In-scope properties that are valued — drives the value-card flip. */
  valued_count: number;
  /** In-scope properties that are NOT valued (the unvalued bucket size). */
  unvalued_count: number;
  /** Valued in-scope properties, keyed by property_id. */
  by_property: Record<string, PropertyAssetView>;
  /** In-scope properties WITHOUT a value, each with its reason — never silently
   *  omitted from the "portfolio" sum (§4.5-V). */
  unvalued: { property_id: number; reason: string }[];
  /** Portfolio-level provenance for the value card: dominant provider + the
   *  freshest as_of across valued properties. null when nothing is valued. */
  provenance: AssetProvenance | null;
  /** Per-scope n/a signal (resident scope has no asset meaning). */
  na: NaMap;
}

/** Estimate freshness bar (§8.2): a monthly feed older than this reads stale. */
export const STALE_ESTIMATE_DAYS = 45;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Whole days between two ISO/'YYYY-MM-DD' dates (b − a); 0 on unparseable. */
function daysBetween(aIso: string, bIso: string): number {
  const a = Date.parse(aIso);
  const b = Date.parse(bIso);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.floor((b - a) / MS_PER_DAY);
}

function isStale(asOf: string, referenceISO: string): boolean {
  return daysBetween(asOf, referenceISO) > STALE_ESTIMATE_DAYS;
}

/** property_id (number | string) -> number | null. Registry ids are ints; an
 *  ad-hoc address id ('addr_1') is not numeric and matches no owner scope. */
function pidNum(id: number | string | null | undefined): number | null {
  if (id == null) return null;
  const n = typeof id === 'number' ? id : Number(id);
  return Number.isFinite(n) ? n : null;
}

/**
 * THE owner-assets aggregate: portfolio value + per-property estimates over a
 * scope, off the raw asset-metrics feed. `referenceISO` is the "now" staleness
 * is measured against (defaults to the snapshot's own date; the page passes the
 * real current time so the amber stale badge is live).
 */
export function aggregateOwnerAssets(
  snap: AssetMetricsSnapshot,
  scope: ResolvedScope,
  referenceISO: string = snap.today ?? snap.generated_at ?? new Date().toISOString()
): OwnerAssetsResult {
  const na: NaMap = {};
  const empty: OwnerAssetsResult = {
    portfolio_value: 0,
    valued_count: 0,
    unvalued_count: 0,
    by_property: {},
    unvalued: [],
    provenance: null,
    na,
  };

  // Resident scope carries no asset meaning — n/a with a reason, no numbers.
  if (scope.kind === 'resident') {
    na.owner_assets = OWNER_NA_REASONS.resident;
    return empty;
  }

  // Index the feed by numeric property_id (first row / first reason wins).
  const recByPid = new Map<number, AssetMetricsRecord>();
  for (const r of snap.records) {
    const p = pidNum(r.property_id);
    if (p != null && !recByPid.has(p)) recByPid.set(p, r);
  }
  const unvaluedReason = new Map<number, string>();
  for (const u of snap.unvalued ?? []) {
    const p = pidNum(u.property_id);
    if (p != null && !unvaluedReason.has(p)) unvaluedReason.set(p, u.reason);
  }

  // The property universe for this scope. For a 'properties' (owner) scope it is
  // the owner's EXACT property set, so the unvalued accounting is complete: every
  // owned property is either valued or in the unvalued bucket. For 'all' it is
  // every property the feed mentions.
  const universe: number[] =
    scope.kind === 'properties'
      ? [...scope.ids]
      : [...new Set<number>([...recByPid.keys(), ...unvaluedReason.keys()])].sort((a, b) => a - b);

  const by_property: Record<string, PropertyAssetView> = {};
  const unvalued: { property_id: number; reason: string }[] = [];
  let portfolio_value = 0;
  let freshestAsOf: string | null = null;
  let dominantProvider: string | null = null;

  for (const pid of universe) {
    const rec = recByPid.get(pid);
    if (rec && rec.value != null) {
      portfolio_value += rec.value;
      by_property[String(pid)] = {
        property_id: pid,
        property_name: rec.property_name,
        value: rec.value,
        value_range: rec.value_range,
        rent_estimate: rec.rent_estimate,
        rent_range: rec.rent_range,
        granularity: rec.granularity,
        provenance: { provider: rec.provider, as_of: rec.as_of, stale: isStale(rec.as_of, referenceISO) },
      };
      if (freshestAsOf == null || rec.as_of > freshestAsOf) freshestAsOf = rec.as_of;
      if (dominantProvider == null) dominantProvider = rec.provider;
    } else {
      // In scope but not valued: an explicit unvalued reason from the feed, else
      // a value-null record, else no record at all — each an honest reason.
      const reason =
        unvaluedReason.get(pid) ??
        (rec ? 'estimate unavailable for this property' : 'no estimate yet');
      unvalued.push({ property_id: pid, reason });
    }
  }

  const provenance: AssetProvenance | null =
    freshestAsOf != null && dominantProvider != null
      ? { provider: dominantProvider, as_of: freshestAsOf, stale: isStale(freshestAsOf, referenceISO) }
      : null;

  return {
    portfolio_value: round2(portfolio_value),
    valued_count: Object.keys(by_property).length,
    unvalued_count: unvalued.length,
    by_property,
    unvalued,
    provenance,
    na,
  };
}

/**
 * The value-card flip predicate (§3.1): render the live StatCard only when the
 * scope has at least one valued property; otherwise the honest ComingSoon card
 * stays. Exported so the component and the tests share ONE definition.
 */
export function portfolioValueIsLive(assets: OwnerAssetsResult | null | undefined): boolean {
  return !!assets && assets.valued_count > 0;
}

// ===========================================================================
// RENT vs MARKET basis (§3.2 / §4.3) — the CURRENT-rent side of the comparison.
//
// Owner-truth fix (2026-07-06): the "current rent" compared against RentCast's
// market rent_estimate must be the SUM of the property's occupied-unit rents
// (the building's total current rent), NOT a per-unit average. RentCast returns
// a building-level estimate for the property address, so total-current vs
// estimate is the like-for-like basis; comparing a per-unit average against a
// building estimate made every multi-unit property read far under market (the
// bug this replaces).
//
// For a single-unit (SFR) property the total IS the one unit's rent, so the gap
// is exact. For a multi-unit property RentCast's basis (one unit vs whole
// building) is genuinely uncertain, so `approximate` is set and the UI labels
// the comparison "building est, approximate" rather than showing a confident
// precise gap — an honest approximate label beats a wrong precise number (§8).
// ===========================================================================

/** Minimal leasing unit-record shape needed for the current-rent basis.
 *  Structurally satisfied by pulse.ts `LeasingRecord`. */
export interface LeasingRentRow {
  kind?: string;
  property_id: number | string | null;
  occupancy_status?: string | null;
  rent?: number | null;
}

/** The current-rent side of rent-vs-market for one property (§3.2). */
export interface CurrentRentBasis {
  /** Total CURRENT contract rent of the property's OCCUPIED units — the
   *  building basis that matches a building-level market estimate. null when the
   *  leasing feed has no occupied-unit rent for this property. */
  current: number | null;
  /** Occupied units that contributed to `current`. */
  occupied_units: number;
  /** True for a multi-unit property: the estimate basis is uncertain, so the UI
   *  labels the comparison approximate instead of a confident precise gap. */
  approximate: boolean;
}

/**
 * Current total rent for a property's occupied units (the rent-vs-market basis).
 * SUM of occupied-unit rents (building total), never a per-unit average.
 * `granularity` is the asset feed's tag ('property' == multi-unit); combined
 * with the occupied-unit count it decides whether the comparison is approximate.
 */
export function currentRentBasis(
  rows: readonly LeasingRentRow[] | null | undefined,
  propertyId: number,
  granularity: 'unit' | 'property' | null
): CurrentRentBasis {
  let total = 0;
  let occupied = 0;
  for (const r of rows ?? []) {
    if (
      r.kind === 'unit' &&
      pidNum(r.property_id) === propertyId &&
      r.occupancy_status === 'occupied' &&
      r.rent != null
    ) {
      total += r.rent;
      occupied += 1;
    }
  }
  return {
    current: occupied > 0 ? round2(total) : null,
    occupied_units: occupied,
    // Multi-unit either way we can tell: the feed tagged it 'property', or we
    // saw more than one occupied unit. A true SFR (one unit) stays exact.
    approximate: granularity === 'property' || occupied > 1,
  };
}

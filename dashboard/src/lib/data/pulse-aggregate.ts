// THE aggregation module (§6.4 — the most important design rule in the plan).
//
// All KPI math for every lane lives HERE and only here. The board computes
// EVERY displayed number — global and scoped — through these functions when a
// snapshot carries records. The generators keep computing their own `live`
// block precisely so the invariant test can cross-check:
//
//     aggregate*(snapshot, ALL_SCOPE).live  deep-equals  snapshot.live
//
// If they diverge, either the records are incomplete or the TS math differs
// from the Python math — both are lies waiting to surface under a filter.
// (Enforced in dashboard/src/lib/__tests__/pulse-aggregate.test.ts; a red
// invariant is a stop-ship for Phase E.)
//
// Honesty rules encoded here:
//  - A card that cannot be computed for a scope returns an `na` entry with a
//    human reason. NEVER a fabricated denominator or a misleading zero.
//  - Records that cannot be attributed to any property (property_id null,
//    pre-D-2 melds) are EXCLUDED from property/owner/group slices but counted
//    in an explicit `unmapped_open` bucket the lane must render. Under ALL
//    scope they count normally (matching the generators' own aggregates).
//  - Feed-status blocks (`coming_soon` variants, capability nulls) pass
//    through verbatim from `live` — they carry no numbers, only the fact that
//    a feed is not wired. All NUMBERS come from records.

import type {
  EvictionsMetrics,
  EvictionsRecord,
  FinanceMetrics,
  FinanceRecord,
  LeasingMetrics,
  LeasingRecord,
  MaintenanceMetrics,
  MaintenanceRecord,
  RenewalsMetrics,
  RenewalsRecord,
  TurnRecord,
  TurnsMetrics,
} from './pulse';
import { slug, type ResolvedScope } from './pulse-scope';
export { ALL_SCOPE } from './pulse-scope';

/** Card-key -> one-line human reason a card is not computable for this scope. */
export type NaMap = Record<string, string>;

// --- shared math (formulas mirrored from the pulse_*_metrics.py generators;
//     the invariant test is the drift alarm) --------------------------------
const round1 = (n: number) => Math.round(n * 10) / 10;
const roundDollars = (n: number) => Math.round(n);

function median(xs: number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return round1(s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2);
}

/** Whole days from a YYYY-MM-DD to a YYYY-MM-DD (UTC-anchored — no TZ drift). */
export function daysBetween(fromYmd: string, toYmd: string): number {
  const [fy, fm, fd] = fromYmd.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = toYmd.slice(0, 10).split('-').map(Number);
  return Math.round((Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000);
}

// --- scope matching ---------------------------------------------------------
type Match = 'in' | 'out' | 'unmapped';

/** Property-dimension match. Records with no property link are 'unmapped'. */
function matchByProperty(propertyId: number | null, scope: ResolvedScope): Match {
  if (scope.kind === 'all') return 'in';
  if (propertyId == null) return 'unmapped';
  if (scope.kind === 'properties') return scope.ids.includes(propertyId) ? 'in' : 'out';
  return propertyId === scope.property_id ? 'in' : 'out';
}

/** Resident match for tenant-bearing rows: property + normalized name + unit.
 *  property_id is required — unit strings and tenant names both collide across
 *  properties, so a name+unit-only join would leak another property's rows. */
function matchesResidentTenant(
  rec: { tenant_name?: string | null; unit: string | null; property_id: number | null },
  scope: Extract<ResolvedScope, { kind: 'resident' }>
): boolean {
  return (
    rec.property_id != null &&
    rec.property_id === scope.property_id &&
    rec.tenant_name != null &&
    rec.unit != null &&
    slug(rec.tenant_name) === slug(scope.name) &&
    slug(rec.unit) === slug(scope.unit)
  );
}

/** Resident match for unit-bearing rows without a tenant name (melds). */
function matchesResidentUnit(
  rec: { property_id: number | null; unit: string | null },
  scope: Extract<ResolvedScope, { kind: 'resident' }>
): Match {
  if (rec.property_id == null) return 'unmapped';
  return rec.property_id === scope.property_id && rec.unit != null && slug(rec.unit) === slug(scope.unit)
    ? 'in'
    : 'out';
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) out[key(x)] = (out[key(x)] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// LEASING
// ---------------------------------------------------------------------------
// Must match pulse_leasing_metrics.py exactly (invariant-tested):
//  - unit_basis = count of emitted unit rows (building summaries never emitted)
//  - occupancy_rate = round1(occupied/basis*100); vacancy = round1((basis-occupied)/basis*100)
//  - submitted_30d/90d: daysBetween(submitted, today) <= 30 / <= 90
//  - approval_rate = round1(approved/(approved+denied)*100), null if no decisions
//  - median_days_to_decision over decided apps submitted within <=180d, round1
export const BASIS_NOTE = 'unit-level rent-roll rows (building % summaries excluded)';
const FUNNEL_STAGES = ['Submitted (30d)', 'Decision pending', 'Approved', 'Converting to lease'] as const;

export const NA_REASONS = {
  occupancy_resident: 'Occupancy is a unit-inventory rate, not defined for a single resident.',
  applications_resident: 'Applications belong to prospective applicants, not current residents.',
} as const;

export function aggregateLeasing(
  snap: Pick<LeasingMetrics, 'live' | 'today'> & { records: LeasingRecord[] },
  scope: ResolvedScope
): { live: LeasingMetrics['live']; na: NaMap } {
  const na: NaMap = {};
  const recs = snap.records;

  // -- occupancy (unit rows) --
  let occupancy: LeasingMetrics['live']['occupancy'];
  if (snap.live.occupancy.status === 'coming_soon') {
    occupancy = snap.live.occupancy; // feed-status passthrough, no numbers
  } else if (scope.kind === 'resident') {
    na.occupancy = NA_REASONS.occupancy_resident;
    occupancy = { status: 'coming_soon', needs: NA_REASONS.occupancy_resident };
  } else {
    const units = recs.filter(
      (r): r is Extract<LeasingRecord, { kind: 'unit' }> =>
        r.kind === 'unit' && matchByProperty(r.property_id, scope) === 'in'
    );
    const occupied = units.filter((u) => u.occupancy_status === 'occupied').length;
    const vacant = units.filter((u) => u.occupancy_status === 'vacant_available').length;
    const notice = units.filter((u) => u.occupancy_status === 'on_notice').length;
    const basis = units.length;
    occupancy = {
      status: 'live',
      occupied_units: occupied,
      vacant_available: vacant,
      on_notice: notice,
      unit_basis: basis,
      occupancy_rate_pct: basis > 0 ? round1((occupied / basis) * 100) : null,
      vacancy_rate_pct: basis > 0 ? round1(((basis - occupied) / basis) * 100) : null,
      basis_note: BASIS_NOTE,
    };
  }

  // -- applications + funnel (application rows) --
  let applications: LeasingMetrics['live']['applications'];
  let funnel: LeasingMetrics['live']['funnel'];
  if (scope.kind === 'resident') {
    na.applications = NA_REASONS.applications_resident;
    na.funnel = NA_REASONS.applications_resident;
    applications = {
      total: 0,
      submitted_30d: 0,
      submitted_90d: 0,
      status_breakdown: {},
      converting_now: 0,
      approval_rate_pct: null,
      median_days_to_decision: null,
    };
    funnel = FUNNEL_STAGES.map((stage) => ({ stage, count: 0 }));
  } else {
    const apps = recs.filter(
      (r): r is Extract<LeasingRecord, { kind: 'application' }> =>
        r.kind === 'application' && matchByProperty(r.property_id, scope) === 'in'
    );
    const breakdown = countBy(apps, (a) => a.status);
    const approved = breakdown['approved'] ?? 0;
    const denied = breakdown['denied'] ?? 0;
    const converting = apps.filter((a) => a.converting).length;
    const submitted30 = apps.filter((a) => daysBetween(a.submitted, snap.today) <= 30).length;
    const decidedRecent = apps.filter(
      (a) =>
        (a.status === 'approved' || a.status === 'denied') &&
        daysBetween(a.submitted, snap.today) <= 180
    );
    applications = {
      total: apps.length,
      submitted_30d: submitted30,
      submitted_90d: apps.filter((a) => daysBetween(a.submitted, snap.today) <= 90).length,
      status_breakdown: breakdown,
      converting_now: converting,
      approval_rate_pct: approved + denied > 0 ? round1((approved / (approved + denied)) * 100) : null,
      median_days_to_decision: median(
        decidedRecent.map((a) => a.days_to_decision).filter((d): d is number => d != null)
      ),
    };
    funnel = [
      { stage: FUNNEL_STAGES[0], count: submitted30 },
      { stage: FUNNEL_STAGES[1], count: breakdown['decision_pending'] ?? 0 },
      { stage: FUNNEL_STAGES[2], count: approved },
      { stage: FUNNEL_STAGES[3], count: converting },
    ];
  }

  // -- renewal retention (renewal rows) — resident-scopable by design --
  let renewal: LeasingMetrics['live']['renewal_retention'];
  if (snap.live.renewal_retention.status === 'coming_soon') {
    renewal = snap.live.renewal_retention; // feed-status passthrough
  } else {
    const rows = recs.filter(
      (r): r is Extract<LeasingRecord, { kind: 'renewal' }> =>
        r.kind === 'renewal' &&
        (scope.kind === 'resident'
          ? matchesResidentTenant(r, scope)
          : matchByProperty(r.property_id, scope) === 'in')
    );
    renewal = { status: 'live', intake_window_rows: rows.length, by_status: countBy(rows, (r) => r.status) };
  }

  return { live: { applications, funnel, occupancy, renewal_retention: renewal }, na };
}

// ---------------------------------------------------------------------------
// MAINTENANCE
// ---------------------------------------------------------------------------
// Must match pulse_maintenance_metrics.py exactly (invariant-tested):
//  - aging buckets: all five keys always present, zero-filled
//  - priority_breakdown: Counter over OPEN melds (only priorities present)
//  - completed_last_7d = count(state:'completed') — generators emit ONLY the
//    last-7d completed set; when the feed cannot compute it, live is null AND
//    no completed records are emitted (the null passes through).
const AGING_BUCKETS = ['0-2d', '3-7d', '8-14d', '15-30d', '30d+'] as const;

function agingBucket(ageDays: number): (typeof AGING_BUCKETS)[number] {
  if (ageDays <= 2) return '0-2d';
  if (ageDays <= 7) return '3-7d';
  if (ageDays <= 14) return '8-14d';
  if (ageDays <= 30) return '15-30d';
  return '30d+';
}

export function aggregateMaintenance(
  snap: Pick<MaintenanceMetrics, 'live'> & { records: MaintenanceRecord[] },
  scope: ResolvedScope
): { live: MaintenanceMetrics['live']; na: NaMap; unmapped_open: number } {
  const na: NaMap = {};
  const match = (r: MaintenanceRecord): Match =>
    scope.kind === 'resident' ? matchesResidentUnit(r, scope) : matchByProperty(r.property_id, scope);

  const inScope = snap.records.filter((r) => match(r) === 'in');
  // Un-attributable melds (no property join yet). Counted normally under ALL
  // (match() returns 'in'); excluded from any narrower slice but surfaced.
  const unmappedOpen = scope.kind === 'all' ? 0 : snap.records.filter((r) => r.state === 'open' && match(r) === 'unmapped').length;

  const open = inScope.filter((r) => r.state === 'open');
  const aging: Record<string, number> = Object.fromEntries(AGING_BUCKETS.map((b) => [b, 0]));
  let oldest: number | null = null;
  for (const r of open) {
    if (r.age_days != null) {
      aging[agingBucket(r.age_days)] += 1;
      oldest = oldest == null ? r.age_days : Math.max(oldest, r.age_days);
    }
  }

  const live: MaintenanceMetrics['live'] = {
    open_work_orders: open.length,
    genuinely_unassigned: open.filter((r) => r.genuinely_unassigned).length,
    emergency: open.filter((r) => r.priority === 'EMERGENCY').length,
    high_priority: open.filter((r) => r.priority === 'HIGH').length,
    priority_breakdown: countBy(open, (r) => r.priority),
    aging_buckets: aging,
    oldest_open_days: oldest,
    // Capability passthrough: null means "feed doesn't track completions",
    // which no record count can express. Numbers still come from records.
    completed_last_7d:
      snap.live.completed_last_7d === null ? null : inScope.filter((r) => r.state === 'completed').length,
  };
  return { live, na, unmapped_open: unmappedOpen };
}

// ---------------------------------------------------------------------------
// FINANCE
// ---------------------------------------------------------------------------
// Must match pulse_finance_metrics.py exactly (invariant-tested), including
// the §6.4 trap: delinquent_accounts counts rows with balance > 0, while
// total_receivable sums ALL rows (zero-balance rows are in totals, not counts).
// Dollar totals are sum-then-round.
export function aggregateFinance(
  snap: Pick<FinanceMetrics, 'live'> & { records: FinanceRecord[] },
  scope: ResolvedScope
): { live: FinanceMetrics['live']; na: NaMap } {
  const na: NaMap = {};
  const matches = (r: FinanceRecord): boolean =>
    scope.kind === 'resident' ? matchesResidentTenant(r, scope) : matchByProperty(r.property_id, scope) === 'in';

  const dq = snap.records.filter(
    (r): r is Extract<FinanceRecord, { kind: 'delinquency' }> => r.kind === 'delinquency' && matches(r)
  );
  const delinquency: FinanceMetrics['live']['delinquency'] = {
    total_receivable: roundDollars(dq.reduce((s, r) => s + r.balance, 0)),
    delinquent_accounts: dq.filter((r) => r.balance > 0).length,
    bucket_0_30: roundDollars(dq.reduce((s, r) => s + r.bucket_0_30, 0)),
    bucket_30_plus: roundDollars(dq.reduce((s, r) => s + r.bucket_30_plus, 0)),
  };

  let deposits: FinanceMetrics['live']['deposits_held'];
  if ('status' in snap.live.deposits_held && snap.live.deposits_held.status === 'coming_soon') {
    deposits = snap.live.deposits_held; // feed-status passthrough
  } else {
    const dep = snap.records.filter(
      (r): r is Extract<FinanceRecord, { kind: 'deposit' }> => r.kind === 'deposit' && matches(r)
    );
    deposits = {
      status: 'live',
      total: roundDollars(dep.reduce((s, r) => s + r.deposit_held, 0)),
      accounts: dep.length,
    };
  }

  // cash_position is a live-only snapshot field (not record-derived), so it
  // passes through verbatim; aggregate(records).cash_position === snap.live's,
  // keeping the §6.4 invariant intact.
  return { live: { delinquency, deposits_held: deposits, cash_position: snap.live.cash_position }, na };
}

// ---------------------------------------------------------------------------
// TURNOVERS + MAKE-READY (one snapshot, one source — §4.4/§4.5/§5.4)
// ---------------------------------------------------------------------------
// Must match pulse_turns_metrics.py exactly (invariant-tested; the generator
// runbook — deliverables/pulse-turns-hookup-runbook.md — mirrors these formulas
// verbatim):
//  - records are OPEN turns only (filter[completed]=false)
//  - age = daysBetween(move_out, today); future move-outs (negative age) land
//    in the 0-14d bucket; turns with no move_out count in open_count but not
//    in age_buckets / oldest_days
//  - past_target = target != null && target < today (overdue)
//  - rent_ready_this_week = target != null && 0 <= days-to-target <= 7
//    (due, not overdue — overdue turns are in past_target instead)
//  - category_status_counts: observed category -> VERBATIM status -> count.
//    No status enum is assumed anywhere (§4.5); no invented zero rows.
//  - avg_turn_days + completed_30d are FEED-LEVEL stats (AppFolio meta.stats /
//    a second filter[completed]=true call). Records cannot reproduce them, so
//    they pass through under ALL (that IS the portfolio) and render n/a with a
//    reason under any narrower scope — never a misleading portfolio number on
//    a sliced view.
const TURN_AGE_BUCKETS = ['0-14d', '15-30d', '31-60d', '60d+'] as const;

function turnAgeBucket(ageDays: number): (typeof TURN_AGE_BUCKETS)[number] {
  if (ageDays <= 14) return '0-14d';
  if (ageDays <= 30) return '15-30d';
  if (ageDays <= 60) return '31-60d';
  return '60d+';
}

export const TURNS_NA_REASONS = {
  resident:
    'A turnover is a vacant-unit make-ready; it has no current resident, so this lane is n/a under a resident scope (§6).',
  avg_turn_days_scoped:
    "Portfolio average from AppFolio's turn stats; per-turn durations aren't in records, so it can't be recomputed for a slice.",
  completed_30d_scoped: "Completed turns aren't emitted as records; only open turns can be sliced.",
} as const;

export function aggregateTurns(
  snap: Pick<TurnsMetrics, 'live' | 'today'> & { records: TurnRecord[] },
  scope: ResolvedScope
): { live: TurnsMetrics['live']; na: NaMap; unmapped_open: number } {
  const na: NaMap = {};
  // Feed config (the 7 configured categories in sort order) passes through
  // verbatim under every scope — it is settings metadata, not a metric.
  const categoriesInOrder = snap.live.make_ready.categories_in_order;

  if (scope.kind === 'resident') {
    // §6: the turns lane renders n/a under a resident scope BY DESIGN.
    na.turnovers = TURNS_NA_REASONS.resident;
    na.make_ready = TURNS_NA_REASONS.resident;
    return {
      live: {
        turnovers: {
          open_count: 0,
          avg_turn_days: null,
          past_target: 0,
          completed_30d: null,
          oldest_days: null,
          age_buckets: Object.fromEntries(TURN_AGE_BUCKETS.map((b) => [b, 0])),
        },
        make_ready: {
          categories_in_order: categoriesInOrder,
          category_status_counts: {},
          stalled_zero_wo: 0,
          open_wos_on_turns: 0,
          rent_ready_this_week: 0,
        },
      },
      na,
      unmapped_open: 0,
    };
  }

  const match = (r: TurnRecord): Match => matchByProperty(r.property_id, scope);
  const inScope = snap.records.filter((r) => match(r) === 'in');
  // Un-attributable turns (no property join). Counted normally under ALL
  // (match() returns 'in'); excluded from any narrower slice but surfaced.
  const unmappedOpen = scope.kind === 'all' ? 0 : snap.records.filter((r) => match(r) === 'unmapped').length;

  const ageBuckets: Record<string, number> = Object.fromEntries(TURN_AGE_BUCKETS.map((b) => [b, 0]));
  let oldest: number | null = null;
  let pastTarget = 0;
  let rentReadyThisWeek = 0;
  let stalledZeroWo = 0;
  let openWos = 0;
  // WO enrichment is all-or-nothing per generation: if the include did not
  // resolve, every record's wo_count is null and the make-ready WO totals are
  // unavailable (null), never a fake 0. Mirrors pulse_turns_metrics.py.
  const woResolved = inScope.some((r) => r.wo_count !== null);
  const catCounts: Record<string, Record<string, number>> = {};

  for (const r of inScope) {
    if (r.move_out != null) {
      const age = daysBetween(r.move_out, snap.today);
      // Skip future move-outs (age < 0) from the age chart, mirroring
      // pulse_turns_metrics.py -- a future turn is not an aged turnover and
      // must not fabricate 0-14d recent-turnover pressure.
      if (age >= 0) {
        ageBuckets[turnAgeBucket(age)] += 1;
        oldest = oldest == null ? age : Math.max(oldest, age);
      }
    }
    if (r.target != null) {
      const toTarget = daysBetween(snap.today, r.target);
      if (toTarget < 0) pastTarget += 1;
      else if (toTarget <= 7) rentReadyThisWeek += 1;
    }
    if (r.wo_count !== null) {
      if (r.wo_count === 0) stalledZeroWo += 1;
      openWos += r.wo_count;
    }
    for (const [cat, status] of Object.entries(r.categories)) {
      const byStatus = (catCounts[cat] ??= {});
      byStatus[status] = (byStatus[status] ?? 0) + 1;
    }
  }

  let avgTurnDays: number | null;
  let completed30d: number | null;
  if (scope.kind === 'all') {
    avgTurnDays = snap.live.turnovers.avg_turn_days;
    completed30d = snap.live.turnovers.completed_30d;
  } else {
    avgTurnDays = null;
    na.avg_turn_days = TURNS_NA_REASONS.avg_turn_days_scoped;
    completed30d = null;
    na.completed_30d = TURNS_NA_REASONS.completed_30d_scoped;
  }

  return {
    live: {
      turnovers: {
        open_count: inScope.length,
        avg_turn_days: avgTurnDays,
        past_target: pastTarget,
        completed_30d: completed30d,
        oldest_days: oldest,
        age_buckets: ageBuckets,
      },
      make_ready: {
        categories_in_order: categoriesInOrder,
        category_status_counts: catCounts,
        stalled_zero_wo: woResolved ? stalledZeroWo : null,
        open_wos_on_turns: woResolved ? openWos : null,
        rent_ready_this_week: rentReadyThisWeek,
      },
    },
    na,
    unmapped_open: unmappedOpen,
  };
}

// ---------------------------------------------------------------------------
// RENEWALS (master plan §4.2/§5.2, shard C-1 — its own lane, promoted out of
// the leasing widget; the leasing renewal_retention block is untouched)
// ---------------------------------------------------------------------------
// Must match pulse_renewals_metrics.py exactly (invariant-tested):
//  - in_window / out_for_signing are generator-computed booleans, passed
//    through verbatim (business rule lives in exactly one place — the
//    ~90-day intake window and the AF lease renewal_status join both live in
//    the Python engine, same convention as TurnRecord.age_days).
//  - not_started = in-window rows minus out_for_signing rows.
//  - offers_expiring_7d: TS computes daysBetween(today, lease_expiry) itself
//    (mirrors the leasing/turns date-math convention) — 0 <= days <= 7,
//    REGARDLESS of in_window, so a lease expiring imminently is never missed
//    because the intake-window flag happened to be false.
//  - by_status counts EVERY record (never window-filtered) — the §6.4
//    reconciliation trap this lane guards against: an overdue/expired lease
//    must still land in its status bucket, never silently dropped.
export function aggregateRenewals(
  snap: Pick<RenewalsMetrics, 'live' | 'today'> & { records: RenewalsRecord[] },
  scope: ResolvedScope
): { live: RenewalsMetrics['live']; na: NaMap; unmapped: number } {
  const na: NaMap = {};
  const match = (r: RenewalsRecord): Match =>
    scope.kind === 'resident'
      ? matchesResidentTenant(r, scope)
        ? 'in'
        : 'out'
      : matchByProperty(r.property_id, scope);

  const inScope = snap.records.filter((r) => match(r) === 'in');
  // Un-attributable renewals (no property link — the tracker's on-disk data
  // carries no numeric property_id today, see the generator docstring).
  // Counted normally under ALL; excluded from any narrower slice but surfaced.
  const unmapped =
    scope.kind === 'all' || scope.kind === 'resident'
      ? 0
      : snap.records.filter((r) => match(r) === 'unmapped').length;

  const inWindow = inScope.filter((r) => r.in_window);
  const outForSigning = inWindow.filter((r) => r.out_for_signing).length;
  const offersExpiring7d = inScope.filter(
    (r) => r.lease_expiry != null && (() => {
      const d = daysBetween(snap.today, r.lease_expiry as string);
      return d >= 0 && d <= 7;
    })()
  ).length;

  return {
    live: {
      in_window: inWindow.length,
      // LITERAL not_started (must match pulse_renewals_metrics.py): count rows
      // whose status IS "not_started", never in_window minus out_for_signing --
      // that subtraction absorbs any other in-window token into not_started.
      not_started: inWindow.filter((r) => r.status === 'not_started').length,
      out_for_signing: outForSigning,
      offers_expiring_7d: offersExpiring7d,
      by_status: countBy(inScope, (r) => r.status),
    },
    na,
    unmapped,
  };
}

// ---------------------------------------------------------------------------
// EVICTIONS (master plan §4.3/§5.3, shard C-2 quick-wire — compact lane built
// from on-disk rent_roll.csv Status=Evict + delinquency.csv join, zero new
// AppFolio access)
// ---------------------------------------------------------------------------
// Must match pulse_evictions_metrics.py exactly (invariant-tested):
//  - units_in_eviction / balance_at_risk are straightforward record counts/sums.
//  - oldest_eviction_age_days = max(daysBetween(last_payment, today)) over
//    records that HAVE a last_payment date — mirrors aggregateTurns'
//    oldest_days-from-move_out convention exactly (records with no date
//    contribute to the count but not the age). Today's on-disk delinquency
//    join matches 0 eviction rows (see the generator docstring), so this is
//    null on every real snapshot — an honest gap, not a fabricated number.
//  - move_outs_pending counts a DIFFERENT population (Notice-Rented/
//    Notice-Unrented rows) that is not emitted as its own records — same
//    feed-level treatment as TurnsMetrics.avg_turn_days: passthrough under
//    ALL (that IS the portfolio number), n/a under any narrower scope
//    (including resident) rather than a misleading portfolio figure on a slice.
export const EVICTIONS_NA_REASONS = {
  move_outs_pending_scoped:
    'Move-outs pending counts Notice-Rented/Notice-Unrented rows, which are not emitted as records (only available portfolio-wide under ALL scope).',
} as const;

export function aggregateEvictions(
  snap: Pick<EvictionsMetrics, 'live' | 'today'> & { records: EvictionsRecord[] },
  scope: ResolvedScope
): { live: EvictionsMetrics['live']; na: NaMap; unmapped: number } {
  const na: NaMap = {};
  const match = (r: EvictionsRecord): Match =>
    scope.kind === 'resident'
      ? matchesResidentTenant(r, scope)
        ? 'in'
        : 'out'
      : matchByProperty(r.property_id, scope);

  const inScope = snap.records.filter((r) => match(r) === 'in');
  // Un-attributable evictions (no property link — the on-disk CSVs carry no
  // numeric property_id today, see the generator docstring). Counted normally
  // under ALL; excluded from any narrower slice but surfaced, never dropped.
  const unmapped =
    scope.kind === 'all' || scope.kind === 'resident'
      ? 0
      : snap.records.filter((r) => match(r) === 'unmapped').length;

  let oldest: number | null = null;
  for (const r of inScope) {
    if (r.last_payment != null) {
      const age = daysBetween(r.last_payment, snap.today);
      oldest = oldest == null ? age : Math.max(oldest, age);
    }
  }

  let moveOutsPending: number | null;
  if (scope.kind === 'all') {
    moveOutsPending = snap.live.move_outs_pending;
  } else {
    moveOutsPending = null;
    na.move_outs_pending = EVICTIONS_NA_REASONS.move_outs_pending_scoped;
  }

  return {
    live: {
      units_in_eviction: inScope.length,
      balance_at_risk: roundDollars(inScope.reduce((s, r) => s + r.balance, 0)),
      oldest_eviction_age_days: oldest,
      move_outs_pending: moveOutsPending,
    },
    na,
    unmapped,
  };
}

// ---------------------------------------------------------------------------
// Health-strip thresholds (§4 per-area, verbatim — David tunes later, H-4)
// ---------------------------------------------------------------------------
export type HealthLevel = 'green' | 'amber' | 'red';

/**
 * One implementation for every simple-threshold tile (§7 A-3 rule).
 * Default (ceilings, low-is-good): green while value <= green, amber while
 * <= amber, else red. With direction 'high-is-good' the numbers are floors:
 * green while value >= green, amber while >= amber, else red (occupancy).
 */
export function healthLevel(
  value: number,
  thresholds: { green: number; amber: number; direction?: 'high-is-good' }
): HealthLevel {
  if (thresholds.direction === 'high-is-good') {
    if (value >= thresholds.green) return 'green';
    if (value >= thresholds.amber) return 'amber';
    return 'red';
  }
  if (value <= thresholds.green) return 'green';
  if (value <= thresholds.amber) return 'amber';
  return 'red';
}

/** Leasing occupancy % (§4.1): green >=92 / amber 85-92 / red <85. Floors. */
export const OCCUPANCY_FLOORS = { green: 92, amber: 85, direction: 'high-is-good' } as const;
/** Renewals not-started inside the intake window (§4.2): green 0-10 / amber 11-25 / red >25. */
export const RENEWALS_NOT_STARTED_CEILINGS = { green: 10, amber: 25 } as const;
/** Evictions count (§4.3): green 0-2 / amber 3-5 / red >5. Specced now; the
 *  tile stays grey "not wired" until the C-2 quick-wire lands (A-3 scope). */
export const EVICTIONS_CEILINGS = { green: 2, amber: 5 } as const;
/** Turns past target (§4.4): green 0-5 / amber 6-15 / red >15. */
export const PAST_TARGET_CEILINGS = { green: 5, amber: 15 } as const;
/** Stalled turns, zero WOs (§4.5): green 0-3 / amber 4-10 / red >10. */
export const STALLED_CEILINGS = { green: 3, amber: 10 } as const;
/** Financial total receivable (§4.7): green <$150k / amber $150-250k / red >$250k.
 *  Green is a STRICT < $150,000; dollar totals are whole dollars everywhere
 *  (sum-then-round in both the generators and aggregateFinance), so the
 *  inclusive green ceiling is exactly $149,999. */
export const RECEIVABLE_CEILINGS = { green: 150_000 - 1, amber: 250_000 } as const;

/** Maintenance (§4.6) is a compound rule, not a single threshold:
 *  green = 0 genuinely-unassigned AND 0 emergency; amber while EACH is <= 3;
 *  red the moment either exceeds 3. */
export const MAINT_EITHER_CEILING = 3;
export function maintenanceHealthLevel(genuinelyUnassigned: number, emergency: number): HealthLevel {
  if (genuinelyUnassigned === 0 && emergency === 0) return 'green';
  if (genuinelyUnassigned <= MAINT_EITHER_CEILING && emergency <= MAINT_EITHER_CEILING) return 'amber';
  return 'red';
}

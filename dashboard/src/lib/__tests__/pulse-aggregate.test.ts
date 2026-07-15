// §6.4 aggregation-honesty invariant tests for the Property Pulse entity-slice
// layer. THE core assertion: for every lane, aggregate(records, ALL_SCOPE)
// deep-equals the generator's own `live` block from the same snapshot — so a
// scoped view can never silently diverge from the headline. A red here is a
// stop-ship for Phase E (master plan risk #1).
//
// Fixtures are synthetic (no real tenant data, §6.6) and their `live` blocks
// are HAND-COMPUTED, not produced by this code — the invariant is not circular.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import {
  aggregateLeasing,
  aggregateMaintenance,
  aggregateFinance,
  aggregateTurns,
  aggregateRenewals,
  aggregateEvictions,
  daysBetween,
  healthLevel,
  PAST_TARGET_CEILINGS,
  STALLED_CEILINGS,
  RENEWALS_NOT_STARTED_CEILINGS,
  EVICTIONS_NA_REASONS,
  ALL_SCOPE,
  NA_REASONS,
  TURNS_NA_REASONS,
} from '@/lib/data/pulse-aggregate';
import {
  parseScopeParam,
  resolveScope,
  scopeToParam,
  buildScopeOptions,
  residentKey,
  slug,
  type ResolvedScope,
} from '@/lib/data/pulse-scope';
import type {
  EntityRegistry,
  EvictionsMetrics,
  FinanceMetrics,
  LeasingMetrics,
  MaintenanceMetrics,
  RenewalsMetrics,
  TurnsMetrics,
} from '@/lib/data/pulse';

import leasingFixtureJson from '@/lib/data/__fixtures__/pulse-slice/leasing-metrics.json';
import maintenanceFixtureJson from '@/lib/data/__fixtures__/pulse-slice/maintenance-metrics.json';
import financeFixtureJson from '@/lib/data/__fixtures__/pulse-slice/finance-metrics.json';
import turnsFixtureJson from '@/lib/data/__fixtures__/pulse-slice/turns-metrics.json';
import renewalsFixtureJson from '@/lib/data/__fixtures__/pulse-slice/renewals-metrics.json';
import evictionsFixtureJson from '@/lib/data/__fixtures__/pulse-slice/evictions-metrics.json';
import entitiesJson from '@/lib/data/__fixtures__/pulse-slice/entities.json';

type LeasingSnap = LeasingMetrics & { records: NonNullable<LeasingMetrics['records']> };
type MaintenanceSnap = MaintenanceMetrics & { records: NonNullable<MaintenanceMetrics['records']> };
type FinanceSnap = FinanceMetrics & { records: NonNullable<FinanceMetrics['records']> };
type TurnsSnap = TurnsMetrics & { records: NonNullable<TurnsMetrics['records']> };
type RenewalsSnap = RenewalsMetrics & { records: NonNullable<RenewalsMetrics['records']> };
type EvictionsSnap = EvictionsMetrics & { records: NonNullable<EvictionsMetrics['records']> };

const leasing = leasingFixtureJson as unknown as LeasingSnap;
const maintenance = maintenanceFixtureJson as unknown as MaintenanceSnap;
const finance = financeFixtureJson as unknown as FinanceSnap;
const turns = turnsFixtureJson as unknown as TurnsSnap;
const renewals = renewalsFixtureJson as unknown as RenewalsSnap;
const evictions = evictionsFixtureJson as unknown as EvictionsSnap;
const registry = entitiesJson as unknown as EntityRegistry;

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function mustResolve(param: string): ResolvedScope {
  const { resolved, warning } = resolveScope(parseScopeParam(param), registry);
  expect(warning).toBeNull();
  return resolved;
}

// ---------------------------------------------------------------------------
// THE INVARIANT (§6.4): aggregate(records, ALL) === generator's live block
// ---------------------------------------------------------------------------
describe('§6.4 invariant — aggregate(records, ALL_SCOPE) deep-equals the generator live block', () => {
  it('leasing', () => {
    const { live, na } = aggregateLeasing(leasing, ALL_SCOPE);
    expect(live).toEqual(leasing.live);
    expect(na).toEqual({});
  });

  it('maintenance', () => {
    const { live, na, unmapped_open } = aggregateMaintenance(maintenance, ALL_SCOPE);
    expect(live).toEqual(maintenance.live);
    expect(na).toEqual({});
    expect(unmapped_open).toBe(0); // unmapped melds count normally under ALL
  });

  it('finance', () => {
    const { live, na } = aggregateFinance(finance, ALL_SCOPE);
    expect(live).toEqual(finance.live);
    expect(na).toEqual({});
  });

  it('turns', () => {
    const { live, na, unmapped_open } = aggregateTurns(turns, ALL_SCOPE);
    expect(live).toEqual(turns.live);
    expect(na).toEqual({});
    expect(unmapped_open).toBe(0); // unmapped turns count normally under ALL
  });

  it('renewals', () => {
    const { live, na, unmapped } = aggregateRenewals(renewals, ALL_SCOPE);
    expect(live).toEqual(renewals.live);
    expect(na).toEqual({});
    expect(unmapped).toBe(0); // the unmapped renewal (Drew Ellison) counts normally under ALL
  });

  it('evictions', () => {
    const { live, na, unmapped } = aggregateEvictions(evictions, ALL_SCOPE);
    expect(live).toEqual(evictions.live);
    expect(na).toEqual({});
    expect(unmapped).toBe(0); // the unmapped eviction (Casey Nguyen) counts normally under ALL
  });

  // Anti-circularity: numbers must come from RECORDS, not passed through from
  // `live`. Tamper with live's numerics and the aggregate must NOT follow.
  it('numbers are computed from records, never copied from live', () => {
    const tampered = clone(leasing);
    tampered.live.applications.total = 999_999;
    if (tampered.live.occupancy.status === 'live') tampered.live.occupancy.occupied_units = 999_999;
    const { live } = aggregateLeasing(tampered, ALL_SCOPE);
    expect(live.applications.total).toBe(leasing.live.applications.total);
    expect(live.occupancy).toEqual(leasing.live.occupancy);

    const tamperedFin = clone(finance);
    tamperedFin.live.delinquency.total_receivable = 999_999;
    expect(aggregateFinance(tamperedFin, ALL_SCOPE).live.delinquency.total_receivable).toBe(
      finance.live.delinquency.total_receivable
    );

    const tamperedMaint = clone(maintenance);
    tamperedMaint.live.open_work_orders = 999_999;
    expect(aggregateMaintenance(tamperedMaint, ALL_SCOPE).live.open_work_orders).toBe(
      maintenance.live.open_work_orders
    );

    const tamperedTurns = clone(turns);
    tamperedTurns.live.turnovers.open_count = 999_999;
    tamperedTurns.live.turnovers.past_target = 999_999;
    tamperedTurns.live.make_ready.stalled_zero_wo = 999_999;
    tamperedTurns.live.make_ready.category_status_counts = { Fabricated: { Fake: 999 } };
    const turnsAgg = aggregateTurns(tamperedTurns, ALL_SCOPE).live;
    expect(turnsAgg.turnovers.open_count).toBe(turns.live.turnovers.open_count);
    expect(turnsAgg.turnovers.past_target).toBe(turns.live.turnovers.past_target);
    expect(turnsAgg.make_ready.stalled_zero_wo).toBe(turns.live.make_ready.stalled_zero_wo);
    expect(turnsAgg.make_ready.category_status_counts).toEqual(turns.live.make_ready.category_status_counts);

    const tamperedRen = clone(renewals);
    tamperedRen.live.in_window = 999_999;
    tamperedRen.live.not_started = 999_999;
    tamperedRen.live.out_for_signing = 999_999;
    tamperedRen.live.by_status = { Fabricated: 999 };
    const renAgg = aggregateRenewals(tamperedRen, ALL_SCOPE).live;
    expect(renAgg.in_window).toBe(renewals.live.in_window);
    expect(renAgg.not_started).toBe(renewals.live.not_started);
    expect(renAgg.out_for_signing).toBe(renewals.live.out_for_signing);
    expect(renAgg.by_status).toEqual(renewals.live.by_status);

    const tamperedEv = clone(evictions);
    tamperedEv.live.units_in_eviction = 999_999;
    tamperedEv.live.balance_at_risk = 999_999;
    tamperedEv.live.oldest_eviction_age_days = 999_999;
    tamperedEv.live.move_outs_pending = 999_999;
    const evAgg = aggregateEvictions(tamperedEv, ALL_SCOPE).live;
    expect(evAgg.units_in_eviction).toBe(evictions.live.units_in_eviction);
    expect(evAgg.balance_at_risk).toBe(evictions.live.balance_at_risk);
    expect(evAgg.oldest_eviction_age_days).toBe(evictions.live.oldest_eviction_age_days);
    // move_outs_pending IS a documented feed-level passthrough under ALL
    // (not derivable from eviction records — a different population, see
    // aggregateEvictions) — so it is expected to follow `live`, unlike the
    // record-derived fields above. Assert it still passes through correctly.
    expect(evAgg.move_outs_pending).toBe(999_999);
  });

  // avg_turn_days + completed_30d are the two DOCUMENTED feed-level
  // passthroughs (AppFolio meta.stats / a second filtered call — records
  // cannot reproduce them). Under ALL they pass through by design; under any
  // narrower scope they must go n/a, never a stale portfolio number.
  it('turns feed-level stats: passthrough under ALL, n/a under a slice', () => {
    const tampered = clone(turns);
    tampered.live.turnovers.avg_turn_days = 123.4;
    tampered.live.turnovers.completed_30d = 77;
    const all = aggregateTurns(tampered, ALL_SCOPE);
    expect(all.live.turnovers.avg_turn_days).toBe(123.4); // passthrough IS the design here
    expect(all.live.turnovers.completed_30d).toBe(77);
    expect(all.na).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT against REAL snapshots (auto-activates at hookup time)
// ---------------------------------------------------------------------------
// .pulse-data is gitignored (real tenant data) and today's generators emit no
// `records`, so these skip in CI. The moment a generator starts emitting
// records (shard D-1), the matching check turns ON in every `npm test` run —
// this is the acceptance gate for the live hookup (see
// deliverables/pulse-entity-slice-hookup-runbook.md). If it goes red, the
// Python emission and the TS math disagree: fix one to match the other.
// NEVER paper over it by copying `live` through the aggregate.
describe('§6.4 invariant — REAL .pulse-data snapshots (skipped until records emission lands)', () => {
  const readReal = <T>(file: string): T | null => {
    try {
      // dashboard/src/lib/__tests__/ -> dashboard/.pulse-data/ (cwd-independent).
      const dir = fileURLToPath(new URL('../../../.pulse-data/', import.meta.url));
      return JSON.parse(fs.readFileSync(dir + file, 'utf-8')) as T;
    } catch {
      return null;
    }
  };
  const realLeasing = readReal<LeasingMetrics>('leasing-metrics.json');
  const realMaintenance = readReal<MaintenanceMetrics>('maintenance-metrics.json');
  const realFinance = readReal<FinanceMetrics>('finance-metrics.json');
  const realTurns = readReal<TurnsMetrics>('turns-metrics.json');
  const realRenewals = readReal<RenewalsMetrics>('renewals-metrics.json');
  const realEvictions = readReal<EvictionsMetrics>('evictions-metrics.json');

  it.skipIf(!realLeasing?.records?.length)('leasing (real snapshot)', () => {
    const snap = realLeasing as LeasingSnap;
    expect(aggregateLeasing(snap, ALL_SCOPE).live).toEqual(snap.live);
  });
  it.skipIf(!realMaintenance?.records?.length)('maintenance (real snapshot)', () => {
    const snap = realMaintenance as MaintenanceSnap;
    expect(aggregateMaintenance(snap, ALL_SCOPE).live).toEqual(snap.live);
  });
  it.skipIf(!realFinance?.records?.length)('finance (real snapshot)', () => {
    const snap = realFinance as FinanceSnap;
    expect(aggregateFinance(snap, ALL_SCOPE).live).toEqual(snap.live);
  });
  it.skipIf(!realTurns?.records?.length)('turns (real snapshot)', () => {
    const snap = realTurns as TurnsSnap;
    expect(aggregateTurns(snap, ALL_SCOPE).live).toEqual(snap.live);
  });
  it.skipIf(!realRenewals?.records?.length)('renewals (real snapshot)', () => {
    const snap = realRenewals as RenewalsSnap;
    expect(aggregateRenewals(snap, ALL_SCOPE).live).toEqual(snap.live);
  });
  it.skipIf(!realEvictions?.records?.length)('evictions (real snapshot)', () => {
    const snap = realEvictions as EvictionsSnap;
    expect(aggregateEvictions(snap, ALL_SCOPE).live).toEqual(snap.live);
  });

  it('G1 records-era real snapshots must carry records or an explicit records gap', () => {
    const snapshots: { name: string; snap: { generated_at?: string; records?: unknown[]; needs_verification?: Record<string, { why?: string }> } | null }[] = [
      { name: 'leasing', snap: realLeasing },
      { name: 'maintenance', snap: realMaintenance },
      { name: 'finance', snap: realFinance },
      { name: 'turns', snap: realTurns },
      { name: 'renewals', snap: realRenewals },
      { name: 'evictions', snap: realEvictions },
    ];
    for (const { name, snap } of snapshots) {
      if (!snap?.generated_at || snap.generated_at < '2026-07-01') continue;
      const hasRecords = Array.isArray(snap.records);
      const hasWhy = Boolean(snap.needs_verification?.records?.why);
      expect(hasRecords || hasWhy, `${name} is records-era but has no records or records-gap why`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Property scope
// ---------------------------------------------------------------------------
describe('property scope (property:101 — Moss Dr)', () => {
  const scope = mustResolve('property:101');

  it('leasing recomputes every block from the property slice', () => {
    const { live, na } = aggregateLeasing(leasing, scope);
    expect(na).toEqual({});
    expect(live.occupancy).toEqual({
      status: 'live',
      occupied_units: 2,
      vacant_available: 1,
      on_notice: 0,
      unit_basis: 3,
      occupancy_rate_pct: 66.7,
      vacancy_rate_pct: 33.3,
      basis_note: 'unit-level rent-roll rows (building % summaries excluded)',
    });
    expect(live.applications).toEqual({
      total: 2,
      submitted_30d: 1,
      submitted_90d: 2,
      status_breakdown: { approved: 1, denied: 1 },
      converting_now: 1,
      approval_rate_pct: 50,
      median_days_to_decision: 4, // median of [3, 5]
    });
    expect(live.funnel).toEqual([
      { stage: 'Submitted (30d)', count: 1 },
      { stage: 'Decision pending', count: 0 },
      { stage: 'Approved', count: 1 },
      { stage: 'Converting to lease', count: 1 },
    ]);
    expect(live.renewal_retention).toEqual({
      status: 'live',
      intake_window_rows: 1,
      by_status: { not_started: 1 },
    });
  });

  it('maintenance slices opens/completions and surfaces the unmapped meld', () => {
    const { live, unmapped_open } = aggregateMaintenance(maintenance, scope);
    expect(live.open_work_orders).toBe(2); // 9001 + 9002; 9005 (unmapped) EXCLUDED, not miscounted
    expect(live.genuinely_unassigned).toBe(1);
    expect(live.emergency).toBe(1);
    expect(live.high_priority).toBe(0);
    expect(live.priority_breakdown).toEqual({ EMERGENCY: 1, MEDIUM: 1 });
    expect(live.aging_buckets).toEqual({ '0-2d': 1, '3-7d': 1, '8-14d': 0, '15-30d': 0, '30d+': 0 });
    expect(live.oldest_open_days).toBe(5);
    expect(live.completed_last_7d).toBe(1); // 9006
    expect(unmapped_open).toBe(1); // 9005 — shown as an honest chip, never silently dropped
  });

  it('finance slices receivable + deposits', () => {
    const { live } = aggregateFinance(finance, scope);
    expect(live.delinquency).toEqual({
      total_receivable: 1200,
      delinquent_accounts: 1,
      bucket_0_30: 800,
      bucket_30_plus: 400,
    });
    expect(live.deposits_held).toEqual({ status: 'live', total: 1750, accounts: 2 });
  });
});

// ---------------------------------------------------------------------------
// Owner + owner-group scopes (union-of-properties semantics, §6.2)
// ---------------------------------------------------------------------------
describe('owner + group scopes', () => {
  it('owner:o_1 = union of Moss Dr + Buckley Ave', () => {
    const scope = mustResolve('owner:o_1');
    const { live } = aggregateLeasing(leasing, scope);
    if (live.occupancy.status !== 'live') throw new Error('expected live occupancy');
    expect(live.occupancy.unit_basis).toBe(4);
    expect(live.occupancy.occupied_units).toBe(3);
    expect(live.applications.total).toBe(3);

    const fin = aggregateFinance(finance, scope).live;
    expect(fin.delinquency.total_receivable).toBe(1200); // 1200 + the zero-balance Buckley row
    expect(fin.delinquency.delinquent_accounts).toBe(1); // zero-balance row NOT counted
  });

  it('group:harbor-family = union of both owners (everything except unowned Willow Park)', () => {
    const scope = mustResolve('group:harbor-family');
    const { live } = aggregateLeasing(leasing, scope);
    if (live.occupancy.status !== 'live') throw new Error('expected live occupancy');
    expect(live.occupancy.unit_basis).toBe(6); // all units minus Willow Park's one
    expect(live.applications.total).toBe(5);
    expect(aggregateFinance(finance, scope).live.delinquency.total_receivable).toBe(1550);
    expect(aggregateMaintenance(maintenance, scope).live.open_work_orders).toBe(4);
  });

  it('an owner with no properties yields honest zeros, not n/a', () => {
    const scope = mustResolve('owner:o_3');
    const { live, na } = aggregateLeasing(leasing, scope);
    expect(na).toEqual({});
    if (live.occupancy.status !== 'live') throw new Error('expected live occupancy');
    expect(live.occupancy.unit_basis).toBe(0);
    expect(live.occupancy.occupancy_rate_pct).toBeNull(); // no fabricated denominator
    expect(live.applications.approval_rate_pct).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Resident scope — the n/a honesty rules (§2.4)
// ---------------------------------------------------------------------------
describe('resident scope (resident:casey-lane--1102-moss-dr-unit-a)', () => {
  const scope = mustResolve('resident:casey-lane--1102-moss-dr-unit-a');

  it('occupancy + applications are n/a WITH reasons — never a misleading number', () => {
    const { live, na } = aggregateLeasing(leasing, scope);
    expect(na.occupancy).toBe(NA_REASONS.occupancy_resident);
    expect(na.applications).toBe(NA_REASONS.applications_resident);
    expect(na.funnel).toBe(NA_REASONS.applications_resident);
    // The occupancy block carries no numbers under n/a.
    expect(live.occupancy.status).toBe('coming_soon');
  });

  it('renewals scope to the resident by normalized name + unit', () => {
    const riley = mustResolve('resident:riley-brooks--1104-moss-dr-unit-b');
    const { live, na } = aggregateLeasing(leasing, riley);
    expect(na.renewal_retention).toBeUndefined();
    expect(live.renewal_retention).toEqual({
      status: 'live',
      intake_window_rows: 1,
      by_status: { not_started: 1 },
    });
    // Casey has no renewal in the window — honest zero, not n/a.
    expect(aggregateLeasing(leasing, scope).live.renewal_retention).toEqual({
      status: 'live',
      intake_window_rows: 0,
      by_status: {},
    });
  });

  it("maintenance scopes to the resident's unit; unmapped melds surface", () => {
    const { live, unmapped_open } = aggregateMaintenance(maintenance, scope);
    expect(live.open_work_orders).toBe(1); // meld 9001 at Casey's unit
    expect(live.emergency).toBe(1);
    expect(unmapped_open).toBe(1);
  });

  it('finance scopes to the resident', () => {
    const { live } = aggregateFinance(finance, scope);
    expect(live.delinquency).toEqual({
      total_receivable: 1200,
      delinquent_accounts: 1,
      bucket_0_30: 800,
      bucket_30_plus: 400,
    });
    expect(live.deposits_held).toEqual({ status: 'live', total: 950, accounts: 1 });
  });
});

// ---------------------------------------------------------------------------
// Turns + Make-Ready scoping (§4.4/§4.5 via §6)
// ---------------------------------------------------------------------------
describe('turns lane scoping', () => {
  it('property scope recomputes both sub-areas from records (property:101)', () => {
    const scope = mustResolve('property:101');
    const { live, na, unmapped_open } = aggregateTurns(turns, scope);
    // Turns 7001 (age 7d, target +5d, 2 WOs) + 7002 (age 20d, target -4d, 0 WOs).
    expect(live.turnovers.open_count).toBe(2);
    expect(live.turnovers.past_target).toBe(1); // 7002
    expect(live.turnovers.oldest_days).toBe(20);
    expect(live.turnovers.age_buckets).toEqual({ '0-14d': 1, '15-30d': 1, '31-60d': 0, '60d+': 0 });
    expect(live.make_ready.stalled_zero_wo).toBe(1); // 7002
    expect(live.make_ready.open_wos_on_turns).toBe(2);
    expect(live.make_ready.rent_ready_this_week).toBe(1); // 7001 — 7002 is overdue, not "this week"
    expect(live.make_ready.category_status_counts).toEqual({
      'Maintenance/Repair': { 'In Progress': 1 },
      Paint: { 'Not Started': 1, 'In Progress': 1 },
      'Floors/Carpets': { 'Not Started': 1 },
      Housekeeping: { 'Not Started': 1 },
    });
    // Feed-level stats cannot be sliced — n/a with reasons, never a portfolio number.
    expect(live.turnovers.avg_turn_days).toBeNull();
    expect(live.turnovers.completed_30d).toBeNull();
    expect(na.avg_turn_days).toBe(TURNS_NA_REASONS.avg_turn_days_scoped);
    expect(na.completed_30d).toBe(TURNS_NA_REASONS.completed_30d_scoped);
    // Turn 7006 has no property link — surfaced, never silently dropped.
    expect(unmapped_open).toBe(1);
    // Configured category order is feed config: passthrough verbatim under any scope.
    expect(live.make_ready.categories_in_order).toEqual(turns.live.make_ready.categories_in_order);
  });

  it('owner scope = union of the owner properties (owner:o_1 -> 101+102)', () => {
    const { live, unmapped_open } = aggregateTurns(turns, mustResolve('owner:o_1'));
    expect(live.turnovers.open_count).toBe(3); // 7001, 7002, 7003
    expect(live.turnovers.past_target).toBe(2); // 7002, 7003
    expect(live.make_ready.stalled_zero_wo).toBe(1);
    expect(live.make_ready.open_wos_on_turns).toBe(3);
    expect(live.make_ready.category_status_counts['Appliances']).toEqual({ 'Vendor Scheduled': 1 });
    expect(unmapped_open).toBe(1);
  });

  it('resident scope: the whole lane is n/a WITH a reason, by design (§6)', () => {
    const scope = mustResolve('resident:casey-lane--1102-moss-dr-unit-a');
    const { live, na, unmapped_open } = aggregateTurns(turns, scope);
    expect(na.turnovers).toBe(TURNS_NA_REASONS.resident);
    expect(na.make_ready).toBe(TURNS_NA_REASONS.resident);
    // The n/a live block carries no numbers that could be mistaken for data.
    expect(live.turnovers.open_count).toBe(0);
    expect(live.turnovers.avg_turn_days).toBeNull();
    expect(live.make_ready.category_status_counts).toEqual({});
    expect(unmapped_open).toBe(0);
  });

  it('status strings flow through verbatim — no enum is assumed anywhere', () => {
    // Feed a snapshot whose statuses match no known vocabulary. If any layer
    // hardcoded an enum, these would be dropped or remapped.
    const weird = clone(turns);
    weird.records = [
      {
        kind: 'turn',
        turn_id: 9999,
        property_id: 101,
        property_name: 'Moss Dr',
        unit: '1102 Moss Dr Unit A',
        move_out: '2026-07-01',
        target: null,
        categories: { Paint: 'Awaiting Board Sign-Off (Q3)' },
        wo_count: 1,
      },
    ];
    const { live } = aggregateTurns(weird, mustResolve('property:101'));
    expect(live.make_ready.category_status_counts).toEqual({
      Paint: { 'Awaiting Board Sign-Off (Q3)': 1 },
    });
  });

  it('health thresholds match §4.4/§4.5 at their boundaries', () => {
    expect(healthLevel(0, PAST_TARGET_CEILINGS)).toBe('green');
    expect(healthLevel(5, PAST_TARGET_CEILINGS)).toBe('green');
    expect(healthLevel(6, PAST_TARGET_CEILINGS)).toBe('amber');
    expect(healthLevel(15, PAST_TARGET_CEILINGS)).toBe('amber');
    expect(healthLevel(16, PAST_TARGET_CEILINGS)).toBe('red');
    expect(healthLevel(3, STALLED_CEILINGS)).toBe('green');
    expect(healthLevel(4, STALLED_CEILINGS)).toBe('amber');
    expect(healthLevel(10, STALLED_CEILINGS)).toBe('amber');
    expect(healthLevel(11, STALLED_CEILINGS)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// Renewals lane scoping + edge cases (§4.2/§5.2, shard C-1)
// ---------------------------------------------------------------------------
describe('renewals lane', () => {
  it('property scope recomputes in_window/not_started/out_for_signing/by_status (property:101)', () => {
    const scope = mustResolve('property:101');
    const { live, na, unmapped } = aggregateRenewals(renewals, scope);
    expect(na).toEqual({});
    // Drew Ellison (property_id null) is globally unmapped under ANY non-ALL
    // scope — the same convention as aggregateTurns/aggregateMaintenance
    // (matchByProperty treats a null property_id as 'unmapped' before it ever
    // compares against the scope's id), not just when the scope happens to be
    // "his" property.
    expect(unmapped).toBe(1);
    // Riley Brooks (in_window, not_started) + Casey Lane (blank expiry, not in window).
    expect(live.in_window).toBe(1);
    expect(live.not_started).toBe(1);
    expect(live.out_for_signing).toBe(0);
    expect(live.offers_expiring_7d).toBe(0);
    expect(live.by_status).toEqual({ not_started: 2 }); // both Riley and Casey are 'not_started'
  });

  it('owner scope = union of the owner properties (owner:o_1 -> Moss Dr + Buckley Ave)', () => {
    const { live, unmapped } = aggregateRenewals(renewals, mustResolve('owner:o_1'));
    // Riley Brooks + Casey Lane (101) + Avery Stone + Alex Rivera (102).
    expect(live.in_window).toBe(3); // Riley, Avery, Alex — Casey has no expiry date
    expect(live.out_for_signing).toBe(1); // Avery Stone
    // LITERAL not_started: only Riley (status === 'not_started' AND in-window).
    // Alex Rivera is PendingLegalReview — the OLD in_window-minus-out_for_signing
    // subtraction wrongly absorbed him into not_started (2); literal is 1.
    expect(live.not_started).toBe(1);
    expect(live.by_status).toEqual({ not_started: 2, out_for_signing: 1, PendingLegalReview: 1 });
    expect(unmapped).toBe(1); // Drew Ellison — unmapped under every non-ALL scope
  });

  it('resident scope matches by normalized tenant name + unit (riley-brooks)', () => {
    const scope = mustResolve('resident:riley-brooks--1104-moss-dr-unit-b');
    const { live, unmapped } = aggregateRenewals(renewals, scope);
    expect(live.in_window).toBe(1);
    expect(live.not_started).toBe(1);
    expect(unmapped).toBe(0); // resident scope doesn't track an unmapped count
  });

  it('resident scope: an honest zero, not n/a, when the resident has no renewal in window', () => {
    const scope = mustResolve('resident:casey-lane--1102-moss-dr-unit-a');
    const { live, na } = aggregateRenewals(renewals, scope);
    expect(na).toEqual({});
    expect(live.in_window).toBe(0);
    expect(live.by_status).toEqual({ not_started: 1 }); // Casey's row still counts by status
  });

  it('property scope surfaces the unmapped renewal (Drew Ellison, no property link)', () => {
    // Drew Ellison has property_id null — must be EXCLUDED from every property
    // scope (never guessed into one) and surfaced as an honest "unmapped" count,
    // never silently dropped from the portfolio total (which is under ALL).
    const scope = mustResolve('property:102');
    const { live, unmapped } = aggregateRenewals(renewals, scope);
    expect(unmapped).toBe(1); // Drew Ellison — unmapped under every non-ALL scope
    // Buckley Ave (102): Avery Stone (out_for_signing) + Alex Rivera (not_started, PendingLegalReview).
    expect(live.in_window).toBe(2);
    expect(live.out_for_signing).toBe(1);
  });

  it('an owner with no matching renewal-window rows yields honest zeros, not n/a', () => {
    // Willow Park (104) is unowned; scope by property directly instead.
    const { live, na } = aggregateRenewals(renewals, mustResolve('property:104'));
    expect(na).toEqual({});
    expect(live.in_window).toBe(0); // Morgan Hale's lease is expired (overdue), not in-window
    expect(live.by_status).toEqual({ NonRenewal: 1 }); // still counted — the overdue-drop bug class
  });

  it('overdue/expired leases are counted in by_status, never dropped (§4.2 edge case a)', () => {
    const { live } = aggregateRenewals(renewals, ALL_SCOPE);
    expect(live.by_status['NonRenewal']).toBe(1); // Morgan Hale, lease_expiry in the past
  });

  it('a blank lease_expiry is still counted by status, never crashes the date math (edge case b)', () => {
    const { live } = aggregateRenewals(renewals, ALL_SCOPE);
    // Casey Lane has lease_expiry: null — must not appear in offers_expiring_7d
    // and must not throw, but must still land in by_status.
    expect(live.by_status['not_started']).toBe(4);
  });

  it('an unrecognized status string flows through by_status verbatim — no hardcoded enum (edge case d)', () => {
    const { live } = aggregateRenewals(renewals, ALL_SCOPE);
    expect(live.by_status['PendingLegalReview']).toBe(1); // Alex Rivera
  });

  it('offers_expiring_7d is computed from lease_expiry regardless of in_window', () => {
    const { live } = aggregateRenewals(renewals, ALL_SCOPE);
    expect(live.offers_expiring_7d).toBe(1); // Jamie Fox, 5 days out
  });

  it('an empty tracker yields an honest all-zero snapshot, not a crash', () => {
    const empty = clone(renewals);
    empty.records = [];
    const { live, na, unmapped } = aggregateRenewals(empty, ALL_SCOPE);
    expect(live).toEqual({ in_window: 0, not_started: 0, out_for_signing: 0, offers_expiring_7d: 0, by_status: {} });
    expect(na).toEqual({});
    expect(unmapped).toBe(0);
  });

  it('health threshold matches §4.2 at its exact edges', () => {
    expect(healthLevel(0, RENEWALS_NOT_STARTED_CEILINGS)).toBe('green');
    expect(healthLevel(10, RENEWALS_NOT_STARTED_CEILINGS)).toBe('green');
    expect(healthLevel(11, RENEWALS_NOT_STARTED_CEILINGS)).toBe('amber');
    expect(healthLevel(25, RENEWALS_NOT_STARTED_CEILINGS)).toBe('amber');
    expect(healthLevel(26, RENEWALS_NOT_STARTED_CEILINGS)).toBe('red');
  });
});

// ---------------------------------------------------------------------------
// Evictions lane scoping + edge cases (§4.3/§5.3, shard C-2 quick-wire)
// ---------------------------------------------------------------------------
describe('evictions lane', () => {
  it('property scope recomputes units_in_eviction/balance_at_risk/oldest_age (property:101)', () => {
    const scope = mustResolve('property:101');
    const { live, na, unmapped } = aggregateEvictions(evictions, scope);
    // Jordan Blake + Casey Lane, both property 101.
    expect(live.units_in_eviction).toBe(2);
    expect(live.balance_at_risk).toBe(5400);
    expect(live.oldest_eviction_age_days).toBe(65); // Jordan Blake, oldest last_payment
    // Casey Nguyen (property_id null) is globally unmapped under ANY non-ALL
    // scope — the same convention as aggregateRenewals/aggregateTurns.
    expect(unmapped).toBe(1);
    // move_outs_pending is feed-level (a different population, Notice-* rows,
    // not emitted as eviction records) — n/a under any scope narrower than ALL.
    expect(live.move_outs_pending).toBeNull();
    expect(na.move_outs_pending).toBe(EVICTIONS_NA_REASONS.move_outs_pending_scoped);
  });

  it('owner scope = union of the owner properties (owner:o_1 -> Moss Dr + Buckley Ave)', () => {
    const { live, unmapped } = aggregateEvictions(evictions, mustResolve('owner:o_1'));
    // Jordan Blake + Casey Lane (101) + Sam Ortiz (102).
    expect(live.units_in_eviction).toBe(3);
    expect(live.balance_at_risk).toBe(9500);
    expect(live.oldest_eviction_age_days).toBe(65);
    expect(unmapped).toBe(1); // Casey Nguyen
  });

  it('owner-group scope = union of the group owners (group:harbor-family -> o_1 + o_2)', () => {
    const { live, unmapped } = aggregateEvictions(evictions, mustResolve('group:harbor-family'));
    // Jordan Blake + Casey Lane (101, o_1) + Sam Ortiz (102, o_1) + Taylor Reed (103, o_2).
    expect(live.units_in_eviction).toBe(4);
    expect(live.balance_at_risk).toBe(11000);
    expect(live.oldest_eviction_age_days).toBe(65); // Taylor Reed has no last_payment — excluded from the max, not a crash
    expect(unmapped).toBe(1);
  });

  it('resident scope matches by normalized tenant name + unit (casey-lane)', () => {
    const scope = mustResolve('resident:casey-lane--1102-moss-dr-unit-a');
    const { live, na, unmapped } = aggregateEvictions(evictions, scope);
    expect(live.units_in_eviction).toBe(1);
    expect(live.balance_at_risk).toBe(2200);
    expect(live.oldest_eviction_age_days).toBe(15); // Casey Lane's own last_payment only
    expect(unmapped).toBe(0); // resident scope doesn't track an unmapped count
    // Still n/a under resident scope — a different population than eviction records.
    expect(na.move_outs_pending).toBe(EVICTIONS_NA_REASONS.move_outs_pending_scoped);
  });

  it('property scope surfaces the unmapped eviction (Casey Nguyen, no property link)', () => {
    // Casey Nguyen has property_id null — must be EXCLUDED from every property
    // scope (never guessed into one) and surfaced as an honest "unmapped"
    // count, never silently dropped from the portfolio total (under ALL).
    const scope = mustResolve('property:103');
    const { live, unmapped } = aggregateEvictions(evictions, scope);
    expect(unmapped).toBe(1); // Casey Nguyen
    expect(live.units_in_eviction).toBe(1); // Taylor Reed only
  });

  it("an Evict row with no delinquency match still counts with its rent-roll balance, never dropped (edge case b)", () => {
    // Taylor Reed / Morgan Hale: balance_source rent_roll_past_due, last_payment
    // null. They must still contribute to units_in_eviction + balance_at_risk.
    const { live } = aggregateEvictions(evictions, ALL_SCOPE);
    expect(live.units_in_eviction).toBe(6); // all 6 records counted, including the 2 with no delinquency match
    expect(live.balance_at_risk).toBe(11900); // includes Taylor's 1500 + Morgan's 900
  });

  it('oldest_eviction_age_days ignores records with no last_payment date, never crashes (property:103/104)', () => {
    // Taylor Reed (103) and Morgan Hale (104) both have last_payment: null —
    // a scope containing ONLY such records must yield oldest_eviction_age_days
    // null (an honest gap), not a crash or a fabricated 0.
    expect(aggregateEvictions(evictions, mustResolve('property:103')).live.oldest_eviction_age_days).toBeNull();
    expect(aggregateEvictions(evictions, mustResolve('property:104')).live.oldest_eviction_age_days).toBeNull();
  });

  it('an eviction-free scope is an honest all-zero snapshot, not a crash', () => {
    const empty = clone(evictions);
    empty.records = [];
    const { live, na, unmapped } = aggregateEvictions(empty, ALL_SCOPE);
    expect(live.units_in_eviction).toBe(0);
    expect(live.balance_at_risk).toBe(0);
    expect(live.oldest_eviction_age_days).toBeNull();
    expect(live.move_outs_pending).toBe(empty.live.move_outs_pending); // still passes through under ALL
    expect(na).toEqual({});
    expect(unmapped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Feed-status passthrough (coming_soon blocks carry no numbers)
// ---------------------------------------------------------------------------
describe('feed-status passthrough', () => {
  it('coming_soon occupancy/renewals/deposits pass through verbatim under any scope', () => {
    const snap = clone(leasing);
    snap.live.occupancy = { status: 'coming_soon', needs: 'rent roll feed' };
    snap.live.renewal_retention = { status: 'coming_soon', needs: 'tracker feed' };
    snap.records = snap.records.filter((r) => r.kind === 'application');
    const all = aggregateLeasing(snap, ALL_SCOPE);
    expect(all.live.occupancy).toEqual({ status: 'coming_soon', needs: 'rent roll feed' });
    expect(all.live.renewal_retention).toEqual({ status: 'coming_soon', needs: 'tracker feed' });
    const scoped = aggregateLeasing(snap, mustResolve('property:101'));
    expect(scoped.live.occupancy).toEqual({ status: 'coming_soon', needs: 'rent roll feed' });

    const fin = clone(finance);
    fin.live.deposits_held = { status: 'coming_soon', needs: 'deposit register' };
    fin.records = fin.records.filter((r) => r.kind === 'delinquency');
    expect(aggregateFinance(fin, ALL_SCOPE).live.deposits_held).toEqual({
      status: 'coming_soon',
      needs: 'deposit register',
    });
  });

  it('completed_last_7d null (feed cannot compute) passes through as null, not 0', () => {
    const snap = clone(maintenance);
    snap.live.completed_last_7d = null;
    snap.records = snap.records.filter((r) => r.state === 'open');
    expect(aggregateMaintenance(snap, ALL_SCOPE).live.completed_last_7d).toBeNull();
    expect(aggregateMaintenance(snap, mustResolve('property:101')).live.completed_last_7d).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scope parsing / resolution / picker options
// ---------------------------------------------------------------------------
describe('scope param parsing + resolution', () => {
  it('round-trips every scope kind', () => {
    for (const p of ['property:101', 'owner:o_1', 'group:harbor-family', 'resident:jamie-fox--12-cedar-ct-unit-2']) {
      expect(scopeToParam(parseScopeParam(p))).toBe(p);
    }
    expect(parseScopeParam(undefined)).toEqual({ kind: 'all' });
    expect(parseScopeParam('all')).toEqual({ kind: 'all' });
  });

  it('garbage params resolve to ALL with a visible warning — never a silent wrong slice', () => {
    for (const raw of ['bogus', 'property:', 'property:abc', 'unicorn:7', ':']) {
      const { resolved, warning } = resolveScope(parseScopeParam(raw), registry);
      expect(resolved).toEqual({ kind: 'all' });
      expect(warning).toBeTruthy();
    }
  });

  it('unknown-but-well-formed entities warn and fall back to ALL', () => {
    for (const raw of ['property:999', 'owner:o_99', 'group:nope', 'resident:no-one--nowhere']) {
      const { resolved, warning } = resolveScope(parseScopeParam(raw), registry);
      expect(resolved).toEqual({ kind: 'all' });
      expect(warning).toContain('showing all properties');
    }
  });

  it('missing registry warns instead of pretending to scope', () => {
    const { resolved, warning } = resolveScope(parseScopeParam('property:101'), null);
    expect(resolved).toEqual({ kind: 'all' });
    expect(warning).toContain('registry');
  });

  it('resident keys are the documented slug format', () => {
    expect(residentKey('Casey Lane', '1102 Moss Dr Unit A')).toBe('casey-lane--1102-moss-dr-unit-a');
    expect(slug('  508 Buckley Ave, Unit B! ')).toBe('508-buckley-ave-unit-b');
  });

  it('picker options cover all four groups with hints', () => {
    const opts = buildScopeOptions(registry);
    expect(opts.filter((o) => o.group === 'Properties')).toHaveLength(4);
    expect(opts.filter((o) => o.group === 'Owners')).toHaveLength(3);
    expect(opts.filter((o) => o.group === 'Owner groups')).toHaveLength(1);
    expect(opts.filter((o) => o.group === 'Residents')).toHaveLength(5);
    expect(opts.find((o) => o.param === 'property:101')?.hint).toBe('Harbor Point LLC');
    expect(opts.find((o) => o.param === 'resident:casey-lane--1102-moss-dr-unit-a')?.hint).toBe(
      '1102 Moss Dr Unit A'
    );
  });
});

// Fable final-gate catch (2026-07-08): pulse_evictions_metrics.py emitted
// last_payment/move_out as raw MM/DD/YYYY (straight from the CSV), but
// daysBetween() splits on '-' and assumes ISO -> NaN -> "NaNd" on the board and
// a RED real-snapshot invariant the moment the delinquency join matches. The
// synthetic fixtures were already ISO, so they masked it. Primary fix is at the
// producer (generators normalize to .isoformat() + a producer-side ISO
// assertion); these tests pin the consumer contract so the class stays dead.
describe('date-format class guard', () => {
  it('daysBetween computes ISO dates and does NOT silently parse non-ISO', () => {
    expect(daysBetween('2026-06-01', '2026-07-08')).toBe(37);
    expect(daysBetween('2026-07-08', '2026-06-01')).toBe(-37);
    // Raw MM/DD/YYYY does not parse -> NaN. This is WHY every generator must
    // emit ISO; if a date format ever changes, the generators change first.
    expect(Number.isNaN(daysBetween('06/01/2026', '2026-07-08'))).toBe(true);
  });

  it('every committed fixture record emits date fields as ISO YYYY-MM-DD or null', () => {
    const ISO = /^\d{4}-\d{2}-\d{2}$/;
    const DATE_FIELDS = ['submitted', 'decided', 'lease_expiry', 'move_out', 'target', 'last_payment'];
    const fixtures: Array<[string, unknown]> = [
      ['leasing', leasingFixtureJson],
      ['maintenance', maintenanceFixtureJson],
      ['finance', financeFixtureJson],
      ['turns', turnsFixtureJson],
      ['renewals', renewalsFixtureJson],
      ['evictions', evictionsFixtureJson],
    ];
    for (const [name, fx] of fixtures) {
      const recs = (fx as { records?: Array<Record<string, unknown>> }).records ?? [];
      for (const r of recs) {
        for (const f of DATE_FIELDS) {
          const v = r[f];
          if (v == null) continue;
          expect(ISO.test(String(v)), `${name} record ${f}=${String(v)} must be ISO`).toBe(true);
        }
      }
    }
  });
});

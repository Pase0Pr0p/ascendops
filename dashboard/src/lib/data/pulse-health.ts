// BUSINESS-HEALTH STRIP tile derivation (§2.2, shard A-3) — the pure logic
// behind components/pulse/pulse-health-strip.tsx. Lives here (no React in the
// import chain) so the shared vitest suite can exercise every honesty rule.
//
// One row of 7 tiles, one per metric area, in the §2.2 order: Leasing ·
// Renewals · Evictions · Turnovers · Make-Ready · Maintenance · Financial.
//
// Honesty rules (hard invariants, tested in pulse-health-strip.test.ts):
//  - SINGLE SOURCE OF TRUTH (§6.4): every tile number is read off the SAME
//    lane view object (aggregate output or records-less live fallback) that
//    the lane below renders. Nothing is recomputed here — buildStripTiles only
//    selects fields and applies the §4 threshold constants.
//  - An area whose feed is not wired (evictions today; any lane whose snapshot
//    is missing; a coming_soon feed block) renders the grey n/a HealthTile
//    with "not wired" — NEVER a fake green (§2.2). A grey tile carries NO
//    level and NO value at all.
//  - Under an active scope each tile reflects the SCOPED number; a metric the
//    lane itself declares n/a for the entity type (its `na` map — e.g. the
//    whole turns lane under a resident scope) renders grey with that reason,
//    never a stale portfolio value (§2.4/§6). A lane that cannot be scoped at
//    all (no per-entity records yet) goes grey too, matching the page's
//    UnscopableLane treatment.
import type {
  EvictionsMetrics,
  FinanceMetrics,
  LeasingMetrics,
  MaintenanceMetrics,
  RenewalsMetrics,
  TurnsMetrics,
} from './pulse';
import {
  healthLevel,
  maintenanceHealthLevel,
  OCCUPANCY_FLOORS,
  RENEWALS_NOT_STARTED_CEILINGS,
  EVICTIONS_CEILINGS,
  PAST_TARGET_CEILINGS,
  STALLED_CEILINGS,
  RECEIVABLE_CEILINGS,
  type HealthLevel,
  type NaMap,
} from './pulse-aggregate';

// THE money formatter for the board (finance lane, drill-down charts, and the
// health strip all share it — one rounding/abbreviation behavior everywhere).
export function usd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 100000 ? 0 : 1)}k`;
  return `$${n}`;
}

// The lane views exactly as page.tsx computes them for the lanes (aggregate
// output when records exist — global AND scoped — or the generator's live
// block in the records-less fallback).
export type LeasingView = { live: LeasingMetrics['live']; na: NaMap };
export type TurnsView = { live: TurnsMetrics['live']; na: NaMap };
export type RenewalsView = { live: RenewalsMetrics['live']; na: NaMap };
export type EvictionsView = { live: EvictionsMetrics['live']; na: NaMap };
export type MaintenanceView = { live: MaintenanceMetrics['live'] };
export type FinanceView = { live: FinanceMetrics['live'] };

/** Per-lane strip input: how the page resolved this lane's snapshot. */
export type StripLane<V> =
  | { state: 'missing' } // snapshot absent -> grey "not wired"
  | { state: 'unscopable' } // scope active but no per-entity records -> grey n/a
  | { state: 'live'; view: V };

export const NOT_WIRED = 'not wired';
export const UNSCOPABLE_REASON = "can't scope: no per-entity records yet";

export interface StripTile {
  area: string;
  /** What the headline number is (renders under the eyebrow). */
  sub?: string;
  /** Headline number — present only on a live tile. */
  value?: string;
  /** §4 verdict — present only on a live tile (grey tiles have NO level). */
  level?: HealthLevel;
  /** Grey-tile reason: "not wired" or the scope n/a reason. */
  na?: string;
  /** Click -> lane anchor (§2.2); absent when the area has no lane yet. */
  href?: string;
}

/** Grey reason for a lane the page could not hand us a live view for. */
function notLiveReason(state: 'missing' | 'unscopable'): string {
  return state === 'missing' ? NOT_WIRED : UNSCOPABLE_REASON;
}

function leasingTile(lane: StripLane<LeasingView>): StripTile {
  const base = { area: 'Leasing', sub: 'occupancy', href: '#lane-leasing' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const { live, na } = lane.view;
  if (na.occupancy) return { ...base, na: na.occupancy }; // resident scope (§2.4)
  if (live.occupancy.status !== 'live') return { ...base, na: NOT_WIRED };
  const rate = live.occupancy.occupancy_rate_pct;
  if (rate == null) return { ...base, na: 'no units in this scope' }; // no fabricated denominator
  return { ...base, value: `${rate}%`, level: healthLevel(rate, OCCUPANCY_FLOORS) };
}

// Renewals is now its own lane (shard C-1 — promoted out of the leasing
// widget; the leasing renewal_retention block still exists but no longer
// feeds this tile, see deliverables/command-center-master-plan §5.2c, deferred).
function renewalsTile(lane: StripLane<RenewalsView>): StripTile {
  const base = { area: 'Renewals', sub: 'not started · intake window', href: '#lane-renewals' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const { live, na } = lane.view;
  if (na.renewals) return { ...base, na: na.renewals };
  return {
    ...base,
    value: String(live.not_started),
    level: healthLevel(live.not_started, RENEWALS_NOT_STARTED_CEILINGS),
  };
}

// Evictions — wired live (shard C-2 quick-wire, master plan §4.3/§5.3):
// rent_roll Status=Evict + delinquency join, zero new AppFolio access.
function evictionsTile(lane: StripLane<EvictionsView>): StripTile {
  const base = { area: 'Evictions', sub: 'units in eviction', href: '#lane-evictions' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const { live } = lane.view;
  const count = live.units_in_eviction;
  return { ...base, value: String(count), level: healthLevel(count, EVICTIONS_CEILINGS) };
}

function turnoversTile(lane: StripLane<TurnsView>): StripTile {
  const base = { area: 'Turnovers', sub: 'turns past target', href: '#lane-turns' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const { live, na } = lane.view;
  if (na.turnovers) return { ...base, na: na.turnovers }; // resident scope: lane n/a by design (§6)
  const past = live.turnovers.past_target;
  return { ...base, value: String(past), level: healthLevel(past, PAST_TARGET_CEILINGS) };
}

function makeReadyTile(lane: StripLane<TurnsView>): StripTile {
  const base = { area: 'Make-Ready', sub: 'stalled · zero WOs', href: '#lane-turns' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const { live, na } = lane.view;
  if (na.make_ready) return { ...base, na: na.make_ready };
  const stalled = live.make_ready.stalled_zero_wo;
  // null = the WO enrichment did not resolve this run (not a real 0); a grey
  // n/a tile, never a fake green (see turns needs_verification.turn_wo_enrichment).
  if (stalled == null) return { ...base, na: 'work-order data did not resolve this run' };
  return { ...base, value: String(stalled), level: healthLevel(stalled, STALLED_CEILINGS) };
}

function maintenanceTile(lane: StripLane<MaintenanceView>): StripTile {
  const base = { area: 'Maintenance', href: '#lane-maintenance' };
  if (lane.state !== 'live') {
    return { ...base, sub: 'unassigned + emergency', na: notLiveReason(lane.state) };
  }
  const { live } = lane.view;
  const unassigned = live.genuinely_unassigned;
  const emergency = live.emergency;
  return {
    ...base,
    sub: `${unassigned} unassigned · ${emergency} emergency`,
    value: String(unassigned + emergency),
    level: maintenanceHealthLevel(unassigned, emergency),
  };
}

function financialTile(lane: StripLane<FinanceView>): StripTile {
  const base = { area: 'Financial', sub: 'total receivable', href: '#lane-finance' };
  if (lane.state !== 'live') return { ...base, na: notLiveReason(lane.state) };
  const total = lane.view.live.delinquency.total_receivable;
  return { ...base, value: usd(total), level: healthLevel(total, RECEIVABLE_CEILINGS) };
}

export interface PulseHealthStripProps {
  leasing: StripLane<LeasingView>;
  renewals: StripLane<RenewalsView>;
  evictions: StripLane<EvictionsView>;
  turns: StripLane<TurnsView>;
  maintenance: StripLane<MaintenanceView>;
  finance: StripLane<FinanceView>;
}

/** Pure tile derivation — exactly 7 tiles in the §2.2 order. */
export function buildStripTiles(props: PulseHealthStripProps): StripTile[] {
  return [
    leasingTile(props.leasing),
    renewalsTile(props.renewals),
    evictionsTile(props.evictions),
    turnoversTile(props.turns),
    makeReadyTile(props.turns),
    maintenanceTile(props.maintenance),
    financialTile(props.finance),
  ];
}

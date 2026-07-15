// BUSINESS-HEALTH STRIP tests (§2.2, shard A-3).
//
// What is enforced here:
//  1. §4 threshold boundaries for EVERY one of the 7 areas, at their exact
//     green/amber/red edges (the numbers are the master plan's, verbatim).
//  2. Grey "not wired" honesty: any lane whose snapshot is missing (including
//     evictions before its generator has run); a wired lane whose feed block
//     is coming_soon. Never a fake green — a grey tile carries NO level.
//  3. Scope honesty (§2.4/§6): a scoped tile shows the SCOPED number from the
//     aggregation module; a metric that is n/a for the entity type (resident
//     scope) goes grey with the lane's own reason, never a portfolio number;
//     a scoped records-less lane goes grey "can't scope".
//  4. SINGLE SOURCE OF TRUTH (§6.4): the strip's number for a lane equals that
//     lane's own computed number — the identical aggregate output the lane
//     renders, which the §6.4 invariant test (pulse-aggregate.test.ts) proves
//     equal to the generator's live block under ALL scope.
import { describe, it, expect } from 'vitest';

import {
  buildStripTiles,
  NOT_WIRED,
  UNSCOPABLE_REASON,
  type PulseHealthStripProps,
  type StripLane,
  type LeasingView,
  type TurnsView,
  type RenewalsView,
  type EvictionsView,
  type MaintenanceView,
  type FinanceView,
} from '@/lib/data/pulse-health';
import {
  aggregateLeasing,
  aggregateMaintenance,
  aggregateFinance,
  aggregateTurns,
  aggregateRenewals,
  aggregateEvictions,
  healthLevel,
  maintenanceHealthLevel,
  OCCUPANCY_FLOORS,
  RENEWALS_NOT_STARTED_CEILINGS,
  EVICTIONS_CEILINGS,
  PAST_TARGET_CEILINGS,
  STALLED_CEILINGS,
  RECEIVABLE_CEILINGS,
  ALL_SCOPE,
  NA_REASONS,
  TURNS_NA_REASONS,
} from '@/lib/data/pulse-aggregate';
import { parseScopeParam, resolveScope, type ResolvedScope } from '@/lib/data/pulse-scope';
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

/** Build strip props the exact way page.tsx does: the SAME aggregate views the
 *  lanes render (§6.4 single source of truth). */
function propsFor(scope: ResolvedScope): PulseHealthStripProps & {
  views: {
    leasing: LeasingView;
    turns: TurnsView;
    renewals: RenewalsView;
    evictions: EvictionsView;
    maintenance: MaintenanceView;
    finance: FinanceView;
  };
} {
  const views = {
    leasing: aggregateLeasing(leasing, scope),
    turns: aggregateTurns(turns, scope),
    renewals: aggregateRenewals(renewals, scope),
    evictions: aggregateEvictions(evictions, scope),
    maintenance: aggregateMaintenance(maintenance, scope),
    finance: aggregateFinance(finance, scope),
  };
  return {
    leasing: { state: 'live', view: views.leasing },
    turns: { state: 'live', view: views.turns },
    renewals: { state: 'live', view: views.renewals },
    evictions: { state: 'live', view: views.evictions },
    maintenance: { state: 'live', view: views.maintenance },
    finance: { state: 'live', view: views.finance },
    views,
  };
}

const byArea = (tiles: ReturnType<typeof buildStripTiles>, area: string) => {
  const t = tiles.find((x) => x.area === area);
  if (!t) throw new Error(`missing tile ${area}`);
  return t;
};

// ---------------------------------------------------------------------------
// §2.2 anatomy: 7 tiles, fixed order
// ---------------------------------------------------------------------------
describe('strip anatomy (§2.2)', () => {
  it('renders exactly 7 tiles in the §2.2 order', () => {
    const tiles = buildStripTiles(propsFor(ALL_SCOPE));
    expect(tiles.map((t) => t.area)).toEqual([
      'Leasing',
      'Renewals',
      'Evictions',
      'Turnovers',
      'Make-Ready',
      'Maintenance',
      'Financial',
    ]);
  });
});

// ---------------------------------------------------------------------------
// §4 thresholds — every area at its exact green/amber/red edges
// ---------------------------------------------------------------------------
describe('§4 threshold boundaries (verbatim from the master plan)', () => {
  it('Leasing occupancy %: green >=92 / amber 85-92 / red <85', () => {
    expect(healthLevel(100, OCCUPANCY_FLOORS)).toBe('green');
    expect(healthLevel(92, OCCUPANCY_FLOORS)).toBe('green');
    expect(healthLevel(91.9, OCCUPANCY_FLOORS)).toBe('amber');
    expect(healthLevel(85, OCCUPANCY_FLOORS)).toBe('amber');
    expect(healthLevel(84.9, OCCUPANCY_FLOORS)).toBe('red');
    expect(healthLevel(0, OCCUPANCY_FLOORS)).toBe('red');
  });

  it('Renewals not-started in intake window: green 0-10 / amber 11-25 / red >25', () => {
    expect(healthLevel(0, RENEWALS_NOT_STARTED_CEILINGS)).toBe('green');
    expect(healthLevel(10, RENEWALS_NOT_STARTED_CEILINGS)).toBe('green');
    expect(healthLevel(11, RENEWALS_NOT_STARTED_CEILINGS)).toBe('amber');
    expect(healthLevel(25, RENEWALS_NOT_STARTED_CEILINGS)).toBe('amber');
    expect(healthLevel(26, RENEWALS_NOT_STARTED_CEILINGS)).toBe('red');
  });

  it('Evictions count: green 0-2 / amber 3-5 / red >5 (shard C-2 quick-wire)', () => {
    expect(healthLevel(0, EVICTIONS_CEILINGS)).toBe('green');
    expect(healthLevel(2, EVICTIONS_CEILINGS)).toBe('green');
    expect(healthLevel(3, EVICTIONS_CEILINGS)).toBe('amber');
    expect(healthLevel(5, EVICTIONS_CEILINGS)).toBe('amber');
    expect(healthLevel(6, EVICTIONS_CEILINGS)).toBe('red');
  });

  it('Turnovers past target: green 0-5 / amber 6-15 / red >15', () => {
    expect(healthLevel(0, PAST_TARGET_CEILINGS)).toBe('green');
    expect(healthLevel(5, PAST_TARGET_CEILINGS)).toBe('green');
    expect(healthLevel(6, PAST_TARGET_CEILINGS)).toBe('amber');
    expect(healthLevel(15, PAST_TARGET_CEILINGS)).toBe('amber');
    expect(healthLevel(16, PAST_TARGET_CEILINGS)).toBe('red');
  });

  it('Make-ready stalled (zero WOs): green 0-3 / amber 4-10 / red >10', () => {
    expect(healthLevel(0, STALLED_CEILINGS)).toBe('green');
    expect(healthLevel(3, STALLED_CEILINGS)).toBe('green');
    expect(healthLevel(4, STALLED_CEILINGS)).toBe('amber');
    expect(healthLevel(10, STALLED_CEILINGS)).toBe('amber');
    expect(healthLevel(11, STALLED_CEILINGS)).toBe('red');
  });

  it('Maintenance: green 0&0 / amber while each <=3 / red above (compound rule)', () => {
    expect(maintenanceHealthLevel(0, 0)).toBe('green');
    expect(maintenanceHealthLevel(1, 0)).toBe('amber');
    expect(maintenanceHealthLevel(0, 1)).toBe('amber');
    expect(maintenanceHealthLevel(3, 3)).toBe('amber');
    expect(maintenanceHealthLevel(4, 0)).toBe('red');
    expect(maintenanceHealthLevel(0, 4)).toBe('red');
    expect(maintenanceHealthLevel(4, 4)).toBe('red');
  });

  it('Financial total receivable: green <$150k / amber $150-250k / red >$250k', () => {
    expect(healthLevel(0, RECEIVABLE_CEILINGS)).toBe('green');
    expect(healthLevel(149_999, RECEIVABLE_CEILINGS)).toBe('green');
    expect(healthLevel(150_000, RECEIVABLE_CEILINGS)).toBe('amber');
    expect(healthLevel(250_000, RECEIVABLE_CEILINGS)).toBe('amber');
    expect(healthLevel(250_001, RECEIVABLE_CEILINGS)).toBe('red');
  });

  it('boundary numbers flow through the TILES, not just the helper', () => {
    const p = propsFor(ALL_SCOPE);

    // Financial tile at the exact amber edge, formatted with usd().
    const fin = clone(p.views.finance);
    fin.live.delinquency.total_receivable = 150_000;
    let tile = byArea(buildStripTiles({ ...p, finance: { state: 'live', view: fin } }), 'Financial');
    expect(tile.value).toBe('$150k');
    expect(tile.level).toBe('amber');
    fin.live.delinquency.total_receivable = 250_001;
    tile = byArea(buildStripTiles({ ...p, finance: { state: 'live', view: fin } }), 'Financial');
    expect(tile.level).toBe('red');

    // Leasing tile at the exact green edge.
    const lea = clone(p.views.leasing);
    if (lea.live.occupancy.status !== 'live') throw new Error('expected live occupancy');
    lea.live.occupancy.occupancy_rate_pct = 92;
    tile = byArea(buildStripTiles({ ...p, leasing: { state: 'live', view: lea } }), 'Leasing');
    expect(tile.value).toBe('92%');
    expect(tile.level).toBe('green');

    // Renewals tile at the exact red edge (own lane, shard C-1 — no longer leasing-sourced).
    const ren = clone(p.views.renewals);
    ren.live.not_started = 26;
    tile = byArea(buildStripTiles({ ...p, renewals: { state: 'live', view: ren } }), 'Renewals');
    expect(tile.value).toBe('26');
    expect(tile.level).toBe('red');

    // Maintenance tile at green (0 & 0) — the only way this tile is green.
    const mnt = clone(p.views.maintenance);
    mnt.live.genuinely_unassigned = 0;
    mnt.live.emergency = 0;
    tile = byArea(buildStripTiles({ ...p, maintenance: { state: 'live', view: mnt } }), 'Maintenance');
    expect(tile.value).toBe('0');
    expect(tile.level).toBe('green');
  });
});

// ---------------------------------------------------------------------------
// Grey "not wired" honesty (§2.2 — never a fake green)
// ---------------------------------------------------------------------------
describe('grey not-wired tiles', () => {
  it('a missing evictions snapshot greys Evictions only (shard C-2 quick-wire is now live)', () => {
    const p = propsFor(ALL_SCOPE);
    const tiles = buildStripTiles({ ...p, evictions: { state: 'missing' } });
    const ev = byArea(tiles, 'Evictions');
    expect(ev.na).toBe(NOT_WIRED);
    expect(ev.level).toBeUndefined(); // no level at all — cannot be a fake green
    expect(ev.value).toBeUndefined();
    // The other wired areas are untouched.
    expect(byArea(tiles, 'Leasing').level).toBeDefined();
    expect(byArea(tiles, 'Financial').level).toBeDefined();
  });

  it('a missing snapshot greys its tiles (turns missing -> Turnovers + Make-Ready grey)', () => {
    const p = propsFor(ALL_SCOPE);
    const tiles = buildStripTiles({ ...p, turns: { state: 'missing' } });
    for (const area of ['Turnovers', 'Make-Ready']) {
      const t = byArea(tiles, area);
      expect(t.na).toBe(NOT_WIRED);
      expect(t.level).toBeUndefined();
    }
    // The other wired areas are untouched.
    expect(byArea(tiles, 'Maintenance').level).toBeDefined();
    expect(byArea(tiles, 'Financial').level).toBeDefined();
  });

  it('a missing leasing snapshot greys Leasing only (Renewals is its own lane/feed, shard C-1)', () => {
    const p = propsFor(ALL_SCOPE);
    const tiles = buildStripTiles({ ...p, leasing: { state: 'missing' } });
    expect(byArea(tiles, 'Leasing').na).toBe(NOT_WIRED);
    expect(byArea(tiles, 'Renewals').na).toBeUndefined();
    expect(byArea(tiles, 'Renewals').level).toBeDefined();
  });

  it('a missing renewals snapshot greys Renewals only', () => {
    const p = propsFor(ALL_SCOPE);
    const tiles = buildStripTiles({ ...p, renewals: { state: 'missing' } });
    expect(byArea(tiles, 'Renewals').na).toBe(NOT_WIRED);
    expect(byArea(tiles, 'Leasing').level).toBeDefined();
  });

  it('a coming_soon feed block inside a present leasing snapshot is grey, never green', () => {
    const p = propsFor(ALL_SCOPE);
    const lea = clone(p.views.leasing);
    lea.live.occupancy = { status: 'coming_soon', needs: 'rent roll feed' };
    const tiles = buildStripTiles({ ...p, leasing: { state: 'live', view: lea } });
    expect(byArea(tiles, 'Leasing').na).toBe(NOT_WIRED);
  });

  it('every grey tile carries no level and no value (the fake-green guard, exhaustively)', () => {
    const tiles = buildStripTiles({
      leasing: { state: 'missing' },
      renewals: { state: 'missing' },
      evictions: { state: 'missing' },
      turns: { state: 'missing' },
      maintenance: { state: 'missing' },
      finance: { state: 'missing' },
    });
    expect(tiles).toHaveLength(7);
    for (const t of tiles) {
      expect(t.na).toBe(NOT_WIRED);
      expect(t.level).toBeUndefined();
      expect(t.value).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Single source of truth (§6.4): strip number === the lane's own number
// ---------------------------------------------------------------------------
describe('single source of truth (§6.4)', () => {
  it('under ALL, every tile equals the generator live block (via the lane view)', () => {
    const p = propsFor(ALL_SCOPE);
    const tiles = buildStripTiles(p);
    // The §6.4 invariant test proves aggregate(ALL) === generator live; here we
    // prove the strip reads those same values, so strip === lane === generator.
    if (leasing.live.occupancy.status !== 'live') throw new Error('fixture occupancy must be live');
    expect(byArea(tiles, 'Leasing').value).toBe(`${leasing.live.occupancy.occupancy_rate_pct}%`);
    expect(byArea(tiles, 'Renewals').value).toBe(String(renewals.live.not_started));
    expect(byArea(tiles, 'Evictions').value).toBe(String(evictions.live.units_in_eviction));
    expect(byArea(tiles, 'Turnovers').value).toBe(String(turns.live.turnovers.past_target));
    expect(byArea(tiles, 'Make-Ready').value).toBe(String(turns.live.make_ready.stalled_zero_wo));
    expect(byArea(tiles, 'Maintenance').value).toBe(
      String(maintenance.live.genuinely_unassigned + maintenance.live.emergency)
    );
    expect(byArea(tiles, 'Financial').value).toBe('$1.6k'); // usd(1640) — same formatter as the lane
  });

  it('under a scope, every tile equals the SAME scoped aggregate output the lane renders', () => {
    const scope = mustResolve('property:101');
    const p = propsFor(scope);
    const tiles = buildStripTiles(p);
    // Assert against the view objects themselves — the strip may only select
    // fields off them, never recompute differently.
    if (p.views.leasing.live.occupancy.status !== 'live') throw new Error('expected live occupancy');
    expect(byArea(tiles, 'Leasing').value).toBe(`${p.views.leasing.live.occupancy.occupancy_rate_pct}%`);
    expect(byArea(tiles, 'Renewals').value).toBe(String(p.views.renewals.live.not_started));
    expect(byArea(tiles, 'Evictions').value).toBe(String(p.views.evictions.live.units_in_eviction));
    expect(byArea(tiles, 'Turnovers').value).toBe(String(p.views.turns.live.turnovers.past_target));
    expect(byArea(tiles, 'Make-Ready').value).toBe(String(p.views.turns.live.make_ready.stalled_zero_wo));
    expect(byArea(tiles, 'Maintenance').value).toBe(
      String(p.views.maintenance.live.genuinely_unassigned + p.views.maintenance.live.emergency)
    );
    expect(byArea(tiles, 'Financial').value).toBe(
      p.views.finance.live.delinquency.total_receivable >= 1000 ? '$1.2k' : String(p.views.finance.live.delinquency.total_receivable)
    );
  });

  it('a records-less lane (unscoped) still shows its live-block number — that IS the portfolio number', () => {
    // page.tsx fallback: no records -> view = { live: generator live, na: {} }.
    const p = propsFor(ALL_SCOPE);
    const fallback: StripLane<MaintenanceView> = { state: 'live', view: { live: maintenance.live } };
    const tiles = buildStripTiles({ ...p, maintenance: fallback });
    const t = byArea(tiles, 'Maintenance');
    expect(t.na).toBeUndefined();
    expect(t.value).toBe(String(maintenance.live.genuinely_unassigned + maintenance.live.emergency)); // 2 + 1
    expect(t.level).toBe(maintenanceHealthLevel(maintenance.live.genuinely_unassigned, maintenance.live.emergency));
  });
});

// ---------------------------------------------------------------------------
// Scope honesty (§2.4/§6)
// ---------------------------------------------------------------------------
describe('scope honesty', () => {
  it('property scope: tiles show the scoped numbers (property:101 fixture math)', () => {
    const tiles = buildStripTiles(propsFor(mustResolve('property:101')));
    // Hand-checked against the fixtures (same rows the aggregate tests pin):
    expect(byArea(tiles, 'Leasing').value).toBe('66.7%'); // 2 occupied / 3 units
    expect(byArea(tiles, 'Leasing').level).toBe('red'); // 66.7 < 85 (§4.1)
    expect(byArea(tiles, 'Renewals').value).toBe('1'); // Riley Brooks, not_started
    expect(byArea(tiles, 'Renewals').level).toBe('green');
    expect(byArea(tiles, 'Turnovers').value).toBe('1'); // turn 7002 past target
    expect(byArea(tiles, 'Turnovers').level).toBe('green');
    expect(byArea(tiles, 'Make-Ready').value).toBe('1'); // turn 7002, zero WOs
    expect(byArea(tiles, 'Maintenance').value).toBe('2'); // 1 unassigned + 1 emergency
    expect(byArea(tiles, 'Maintenance').level).toBe('amber');
    expect(byArea(tiles, 'Financial').value).toBe('$1.2k'); // Casey Lane's 1200
    expect(byArea(tiles, 'Financial').level).toBe('green');
    // Evictions: Jordan Blake + Casey Lane, both property 101 (evictions fixture).
    expect(byArea(tiles, 'Evictions').value).toBe('2');
    expect(byArea(tiles, 'Evictions').level).toBe('green');
  });

  it('resident scope: unscopable metrics are grey n/a WITH the lane reason, never a portfolio number', () => {
    const tiles = buildStripTiles(propsFor(mustResolve('resident:casey-lane--1102-moss-dr-unit-a')));
    // Leasing occupancy is n/a for a single resident — the lane's own reason.
    const lea = byArea(tiles, 'Leasing');
    expect(lea.na).toBe(NA_REASONS.occupancy_resident);
    expect(lea.value).toBeUndefined();
    expect(lea.level).toBeUndefined();
    // The whole turns lane is n/a under a resident scope by design (§6).
    for (const area of ['Turnovers', 'Make-Ready']) {
      const t = byArea(tiles, area);
      expect(t.na).toBe(TURNS_NA_REASONS.resident);
      expect(t.value).toBeUndefined();
      expect(t.level).toBeUndefined();
    }
    // Metrics that ARE resident-scopable show the resident's numbers.
    expect(byArea(tiles, 'Renewals').value).toBe('0'); // Casey has no renewal in window — honest zero
    expect(byArea(tiles, 'Renewals').level).toBe('green');
    expect(byArea(tiles, 'Evictions').value).toBe('1'); // Casey Lane IS being evicted (evictions fixture)
    expect(byArea(tiles, 'Evictions').level).toBe('green');
    expect(byArea(tiles, 'Maintenance').value).toBe('1'); // meld 9001: emergency, assigned
    expect(byArea(tiles, 'Maintenance').level).toBe('amber');
    expect(byArea(tiles, 'Financial').value).toBe('$1.2k');
  });

  it('resident scope: renewals shows the resident WITH a renewal too', () => {
    const tiles = buildStripTiles(propsFor(mustResolve('resident:riley-brooks--1104-moss-dr-unit-b')));
    expect(byArea(tiles, 'Renewals').value).toBe('1');
  });

  it('scoped + records-less lane: grey "can\'t scope", never the unscoped portfolio number', () => {
    // page.tsx passes state:'unscopable' for a lane with no records while a
    // scope is active — the tile must NOT fall back to portfolio numbers.
    const p = propsFor(mustResolve('property:101'));
    const tiles = buildStripTiles({ ...p, finance: { state: 'unscopable' } });
    const fin = byArea(tiles, 'Financial');
    expect(fin.na).toBe(UNSCOPABLE_REASON);
    expect(fin.value).toBeUndefined();
    expect(fin.level).toBeUndefined();
  });

  it('a scope slice with zero units is grey n/a, not a fabricated 0%/green', () => {
    const tiles = buildStripTiles(propsFor(mustResolve('owner:o_3'))); // owner with no properties
    const lea = byArea(tiles, 'Leasing');
    expect(lea.na).toBe('no units in this scope');
    expect(lea.level).toBeUndefined();
  });
});

// AL-4 owner-assets tests — the RentCast value/rent feed joined to an owner's
// properties through THE single owner-math module (§8.1). Proves: portfolio
// value sums ONLY valued in-scope properties, every in-scope property without a
// value lands in an explicit `unvalued` bucket (never silently dropped from the
// "portfolio" sum, §4.5-V), estimate provenance (provider + as-of + range) is
// present on every number, the amber stale bar fires past 45 days (§8.2), and
// the value-card flip predicate is covered.
//
// Fixtures are synthetic (no real valuations, §6.6). Staleness is measured
// against a FIXED reference date so the tests are deterministic.
import { describe, it, expect } from 'vitest';

import {
  aggregateOwnerAssets,
  portfolioValueIsLive,
  currentRentBasis,
  ALL_SCOPE,
  OWNER_NA_REASONS,
  STALE_ESTIMATE_DAYS,
  type AssetMetricsSnapshot,
  type LeasingRentRow,
} from '@/lib/data/owner-aggregate';
import {
  parseScopeParam,
  resolveScope,
  type ResolvedScope,
} from '@/lib/data/pulse-scope';
import type { EntityRegistry } from '@/lib/data/pulse';

import assetJson from '@/lib/data/__fixtures__/pulse-slice/asset-metrics.json';
import entitiesJson from '@/lib/data/__fixtures__/pulse-slice/entities.json';

const assets = assetJson as unknown as AssetMetricsSnapshot;
const registry = entitiesJson as unknown as EntityRegistry;

// The anchor the fixture's "fresh" rows use; 103's 2026-01-01 is > 45 days back.
const REF = '2026-07-05';

function mustResolve(param: string): ResolvedScope {
  const { resolved, warning } = resolveScope(parseScopeParam(param), registry);
  expect(warning).toBeNull();
  return resolved;
}

describe('aggregateOwnerAssets — portfolio value + unvalued bucket (§4.5-V)', () => {
  it('owner o_1: sums ONLY the valued property, lists the unvalued one', () => {
    // o_1 owns 101 (valued $285k) + 102 (UNVALUED — feed had no data).
    const r = aggregateOwnerAssets(assets, mustResolve('owner:o_1'), REF);

    expect(r.portfolio_value).toBe(285000); // 101 only — 102 not summed
    expect(r.valued_count).toBe(1);
    expect(r.unvalued_count).toBe(1);
    expect(Object.keys(r.by_property)).toEqual(['101']);
    // 102 is surfaced explicitly, with the feed's machine reason — not dropped.
    expect(r.unvalued).toEqual([{ property_id: 102, reason: 'no_data_for_address' }]);
  });

  it('every value carries estimate provenance: provider + as-of + range (§8.2)', () => {
    const r = aggregateOwnerAssets(assets, mustResolve('owner:o_1'), REF);
    const v = r.by_property['101'];
    expect(v.value).toBe(285000);
    expect(v.value_range).toEqual([270000, 300000]);
    expect(v.rent_estimate).toBe(1500);
    expect(v.rent_range).toEqual([1400, 1650]);
    expect(v.granularity).toBe('property');
    expect(v.provenance).toEqual({ provider: 'rentcast', as_of: '2026-07-05', stale: false });
    // portfolio-level provenance drives the wealth-strip card badge.
    expect(r.provenance).toEqual({ provider: 'rentcast', as_of: '2026-07-05', stale: false });
  });

  it('owner o_2: stale estimate past the 45-day bar flags amber (§8.2)', () => {
    // o_2 owns 103 — valued $190k but as_of 2026-01-01 (~185 days before REF).
    const r = aggregateOwnerAssets(assets, mustResolve('owner:o_2'), REF);
    expect(r.portfolio_value).toBe(190000);
    expect(r.valued_count).toBe(1);
    expect(r.by_property['103'].provenance.stale).toBe(true);
    expect(r.provenance?.stale).toBe(true);
    // sanity: the fixture gap really is past the bar.
    const days = Math.floor((Date.parse(REF) - Date.parse('2026-01-01')) / 86400000);
    expect(days).toBeGreaterThan(STALE_ESTIMATE_DAYS);
  });

  it('ALL scope: portfolio value = every valued record; 102 still unvalued', () => {
    const r = aggregateOwnerAssets(assets, ALL_SCOPE, REF);
    expect(r.portfolio_value).toBe(285000 + 190000 + 205000); // 101 + 103 + 104
    expect(r.valued_count).toBe(3);
    expect(r.unvalued.map((u) => u.property_id)).toEqual([102]);
  });
});

describe('value-card flip predicate (§3.1)', () => {
  it('flips live when the scope has ≥1 valued property', () => {
    const r = aggregateOwnerAssets(assets, mustResolve('owner:o_1'), REF);
    expect(portfolioValueIsLive(r)).toBe(true);
  });

  it('stays ComingSoon when NO in-scope property is valued', () => {
    // A scope over ONLY the unvalued property 102 -> no value to show.
    const scope: ResolvedScope = { kind: 'properties', via: 'property', ids: [102], label: 'Buckley Ave' };
    const r = aggregateOwnerAssets(assets, scope, REF);
    expect(r.valued_count).toBe(0);
    expect(r.portfolio_value).toBe(0);
    expect(r.unvalued).toEqual([{ property_id: 102, reason: 'no_data_for_address' }]);
    expect(portfolioValueIsLive(r)).toBe(false);
    expect(portfolioValueIsLive(null)).toBe(false);
  });
});

describe('honesty edges', () => {
  it('resident scope has no asset meaning -> n/a, no numbers', () => {
    const scope: ResolvedScope = {
      kind: 'resident',
      key: 'casey-lane--1102-moss-dr-unit-a',
      name: 'Casey Lane',
      unit: '1102 Moss Dr Unit A',
      property_id: 101,
      label: 'Casey Lane',
    };
    const r = aggregateOwnerAssets(assets, scope, REF);
    expect(r.na.owner_assets).toBe(OWNER_NA_REASONS.resident);
    expect(r.portfolio_value).toBe(0);
    expect(r.valued_count).toBe(0);
    expect(r.provenance).toBeNull();
  });

  it('an in-scope property with no feed record at all is unvalued, not zero', () => {
    // 999 is owned by nobody in the fixture and absent from the feed.
    const scope: ResolvedScope = { kind: 'properties', via: 'property', ids: [101, 999], label: 'mix' };
    const r = aggregateOwnerAssets(assets, scope, REF);
    expect(r.portfolio_value).toBe(285000); // 101 only
    expect(r.unvalued).toEqual([{ property_id: 999, reason: 'no estimate yet' }]);
  });
});

// The current-rent side of rent-vs-market (§3.2 / §4.3). The bug this replaces
// compared a PER-UNIT AVERAGE against a building-level estimate, so every
// multi-unit read far under market. Fix: current = SUM of occupied-unit rents
// (building total), like-for-like with the building estimate; multi-unit is
// labeled approximate rather than shown as a confident precise gap (§8).
describe('currentRentBasis — building total vs market estimate (§3.2 / §4.3)', () => {
  // A 2-unit property (201): two occupied units at $1,450 + $1,390. A third unit
  // is vacant (no rent) and a different property's unit is present to prove the
  // property_id filter. Total current = $2,840 (NOT the $1,420 per-unit average).
  const ROWS: LeasingRentRow[] = [
    { kind: 'unit', property_id: 201, occupancy_status: 'occupied', rent: 1450 },
    { kind: 'unit', property_id: 201, occupancy_status: 'occupied', rent: 1390 },
    { kind: 'unit', property_id: 201, occupancy_status: 'vacant_available', rent: null },
    { kind: 'unit', property_id: 305, occupancy_status: 'occupied', rent: 2000 },
  ];

  it('multi-unit: SUMS occupied-unit rents (building total), not the average', () => {
    const b = currentRentBasis(ROWS, 201, 'property');
    expect(b.current).toBe(2840); // 1450 + 1390 — the total, not 1420 average
    expect(b.occupied_units).toBe(2);
    // Multi-unit -> the comparison is approximate (estimate basis uncertain).
    expect(b.approximate).toBe(true);
  });

  it('a 2-unit total compared like-for-like against a building estimate', () => {
    // Building total $2,840 vs a $3,000 building estimate -> $160 under market —
    // sane, unlike the old $1,420 avg vs $3,000 that read $1,580 under.
    const estimate = 3000;
    const b = currentRentBasis(ROWS, 201, 'property');
    expect(b.current! - estimate).toBe(-160);
    expect(b.approximate).toBe(true); // shown labeled, not as a confident gap
  });

  it('SFR: the single occupied unit is the exact basis, gap is confident', () => {
    const sfr: LeasingRentRow[] = [
      { kind: 'unit', property_id: 401, occupancy_status: 'occupied', rent: 1600 },
    ];
    const b = currentRentBasis(sfr, 401, 'unit');
    expect(b.current).toBe(1600);
    expect(b.occupied_units).toBe(1);
    expect(b.approximate).toBe(false); // exact — a precise gap is honest here
  });

  it('>1 occupied unit is approximate even if the feed granularity is unknown', () => {
    const b = currentRentBasis(ROWS, 201, null);
    expect(b.current).toBe(2840);
    expect(b.approximate).toBe(true);
  });

  it('no occupied unit (leasing feed pending) -> null current, not zero', () => {
    expect(currentRentBasis([], 201, 'property').current).toBeNull();
    expect(currentRentBasis(null, 201, 'unit').current).toBeNull();
    // string property_id from the registry still matches a numeric row filter.
    const strIds: LeasingRentRow[] = [
      { kind: 'unit', property_id: '201', occupancy_status: 'occupied', rent: 1450 },
    ];
    expect(currentRentBasis(strIds, 201, 'unit').current).toBe(1450);
  });
});

import { describe, it, expect } from 'vitest';
import { MockConnector } from '../mock.connector';
import { computePmKpis, formatDollars } from '../kpi';
import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions } from '../types';
import {
  FIXTURE_WORK_ORDERS,
  FIXTURE_RENT_ROLL,
  FIXTURE_LEASES,
} from '../fixtures';

const connector = new MockConnector();

// Minimal non-demo stub — delegates to MockConnector for data, isDemo=false
class LiveStubConnector extends MockConnector {
  override readonly isDemo = false;
}

describe('computePmKpis', () => {
  it('mock connector => is_demo:true', async () => {
    const kpis = await computePmKpis(connector);
    expect(kpis.is_demo).toBe(true);
  });

  it('non-demo connector => is_demo:false', async () => {
    const kpis = await computePmKpis(new LiveStubConnector());
    expect(kpis.is_demo).toBe(false);
  });

  it('has a valid ISO computed_at timestamp', async () => {
    const kpis = await computePmKpis(connector);
    expect(new Date(kpis.computed_at).toISOString()).toBe(kpis.computed_at);
  });
});

describe('maintenance KPIs', () => {
  it('counts work orders by status from fixtures', async () => {
    const { maintenance } = await computePmKpis(connector);
    const expectedOpen = FIXTURE_WORK_ORDERS.filter(w => w.status === 'open').length;
    const expectedInProgress = FIXTURE_WORK_ORDERS.filter(w => w.status === 'in_progress').length;
    const expectedCompleted = FIXTURE_WORK_ORDERS.filter(w => w.status === 'completed').length;
    expect(maintenance.open).toBe(expectedOpen);
    expect(maintenance.in_progress).toBe(expectedInProgress);
    expect(maintenance.completed).toBe(expectedCompleted);
  });

  it('counts urgent open work orders', async () => {
    const { maintenance } = await computePmKpis(connector);
    const expected = FIXTURE_WORK_ORDERS.filter(w => w.status === 'open' && w.priority === 'urgent').length;
    expect(maintenance.urgent_open).toBe(expected);
  });

  it('reports oldest open WO in days (non-null when open WOs exist)', async () => {
    const { maintenance } = await computePmKpis(connector, { asOf: '2026-06-28' });
    expect(maintenance.oldest_open_days).not.toBeNull();
    expect(typeof maintenance.oldest_open_days).toBe('number');
    // wo-001 created 2026-06-20T14:00Z, asOf 2026-06-28T00:00Z = 7.41 days → floors to 7
    expect(maintenance.oldest_open_days).toBe(7);
  });

  it('groups work orders by category', async () => {
    const { maintenance } = await computePmKpis(connector);
    expect(maintenance.by_category).toBeDefined();
    const allCategories = FIXTURE_WORK_ORDERS.map(w => w.category);
    for (const cat of allCategories) {
      expect(maintenance.by_category[cat]).toBeGreaterThan(0);
    }
  });
});

describe('occupancy KPIs', () => {
  it('total_units matches number of leases in fixtures', async () => {
    const { occupancy } = await computePmKpis(connector);
    expect(occupancy.total_units).toBe(FIXTURE_LEASES.length);
  });

  it('occupancy_rate_pct is 0-100', async () => {
    const { occupancy } = await computePmKpis(connector);
    expect(occupancy.occupancy_rate_pct).toBeGreaterThanOrEqual(0);
    expect(occupancy.occupancy_rate_pct).toBeLessThanOrEqual(100);
  });

  it('counts notice_given leases', async () => {
    const { occupancy } = await computePmKpis(connector);
    const expected = FIXTURE_LEASES.filter(l => l.status === 'notice_given').length;
    expect(occupancy.notice_given).toBe(expected);
  });

  it('counts month_to_month leases', async () => {
    const { occupancy } = await computePmKpis(connector);
    const expected = FIXTURE_LEASES.filter(l => l.status === 'month_to_month').length;
    expect(occupancy.month_to_month).toBe(expected);
  });

  it('vacant leases are NOT counted as occupied', async () => {
    const { occupancy } = await computePmKpis(connector);
    const vacantCount = FIXTURE_LEASES.filter(l => l.status === 'vacant').length;
    expect(vacantCount).toBeGreaterThan(0);
    expect(occupancy.vacant).toBeGreaterThanOrEqual(vacantCount);
    const occupiedStatuses = new Set(['active', 'month_to_month', 'notice_given']);
    expect(occupancy.occupied).toBe(
      FIXTURE_LEASES.filter(l => occupiedStatuses.has(l.status)).length
    );
  });

  it('notice_given leases count as occupied (AppFolio on-notice = occupied)', async () => {
    const { occupancy } = await computePmKpis(connector);
    const notice = FIXTURE_LEASES.filter(l => l.status === 'notice_given').length;
    expect(notice).toBeGreaterThan(0);
    const active = FIXTURE_LEASES.filter(l => l.status === 'active').length;
    const mtm = FIXTURE_LEASES.filter(l => l.status === 'month_to_month').length;
    expect(occupancy.occupied).toBe(active + mtm + notice);
  });

  it('occupancy rate excludes vacant units', async () => {
    const { occupancy } = await computePmKpis(connector);
    const active = FIXTURE_LEASES.filter(l => l.status === 'active').length;
    const mtm = FIXTURE_LEASES.filter(l => l.status === 'month_to_month').length;
    const notice = FIXTURE_LEASES.filter(l => l.status === 'notice_given').length;
    const expectedRate = Math.round(((active + mtm + notice) / FIXTURE_LEASES.length) * 100);
    expect(occupancy.occupancy_rate_pct).toBe(expectedRate);
  });

  it('counts leases expiring within 60 days of asOf', async () => {
    // lease-002 ends 2026-06-30; asOf 2026-06-28 → 2 days → within 60 days
    const { occupancy } = await computePmKpis(connector, { asOf: '2026-06-28' });
    expect(occupancy.expiring_60_days).toBeGreaterThanOrEqual(1);
  });

  it('expiring_60_days is 0 when asOf is far in the past', async () => {
    // All lease ends are in 2026; asOf 2020-01-01 + 60 days = well before any end
    const { occupancy } = await computePmKpis(connector, { asOf: '2020-01-01' });
    expect(occupancy.expiring_60_days).toBe(0);
  });
});

describe('AR KPIs', () => {
  it('delinquent_units matches units with positive balance', async () => {
    const { ar } = await computePmKpis(connector);
    const expected = FIXTURE_RENT_ROLL.filter(r => r.balance > 0).length;
    expect(ar.delinquent_units).toBe(expected);
  });

  it('total_ar_cents sums all outstanding balances', async () => {
    const { ar } = await computePmKpis(connector);
    const expected = FIXTURE_RENT_ROLL.reduce((s, r) => s + (r.balance > 0 ? r.balance : 0), 0);
    expect(ar.total_ar_cents).toBe(expected);
  });

  it('delinquent_details includes tenant name and balance', async () => {
    const { ar } = await computePmKpis(connector);
    for (const d of ar.delinquent_details) {
      expect(d.tenantName).toBeTruthy();
      expect(d.balance_cents).toBeGreaterThan(0);
    }
  });
});

describe('financials KPIs', () => {
  it('loads owner statement from mock fixture', async () => {
    const { financials } = await computePmKpis(connector, {
      ownerId: 'owner-legacy-001',
      financialsPeriodStart: '2026-06-01',
      financialsPeriodEnd: '2026-06-30',
    });
    expect(financials.source).toBe('owner_statement');
    expect(financials.gross_income_cents).toBe(605000);
    expect(financials.net_distribution_cents).toBe(476000);
  });

  it('returns source=unavailable when no matching statement', async () => {
    const { financials } = await computePmKpis(connector, {
      ownerId: 'owner-unknown',
      financialsPeriodStart: '2020-01-01',
      financialsPeriodEnd: '2020-01-31',
    });
    expect(financials.source).toBe('unavailable');
    expect(financials.gross_income_cents).toBe(0);
  });
});

describe('formatDollars', () => {
  it('formats cents as USD', () => {
    expect(formatDollars(476000)).toContain('4,760');
    expect(formatDollars(320000)).toContain('3,200');
    expect(formatDollars(0)).toContain('0');
  });
});

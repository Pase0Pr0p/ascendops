// PM KPI aggregation layer.
// Reads from any AppFolioConnector, computes the KPI snapshot.
// Caller is responsible for choosing mock vs live via the factory.

import type { AppFolioConnector, WorkOrder, RentRollEntry, Lease } from './types';

// ---------------------------------------------------------------------------
// KPI types
// ---------------------------------------------------------------------------

export interface MaintenanceKpi {
  open: number;
  in_progress: number;
  completed: number;
  cancelled: number;
  urgent_open: number;
  oldest_open_days: number | null;  // null if no open WOs
  by_category: Record<string, number>;
}

export interface OccupancyKpi {
  total_units: number;
  occupied: number;           // active + month_to_month
  notice_given: number;
  vacant: number;             // expired + pending with no active tenant
  occupancy_rate_pct: number; // 0-100
  expiring_60_days: number;   // leases ending within 60 days of asOf
  month_to_month: number;
}

export interface ArKpi {
  delinquent_units: number;
  total_ar_cents: number;
  delinquent_details: Array<{ unit?: string; tenantName: string; balance_cents: number }>;
}

export interface FinancialsKpi {
  gross_income_cents: number;
  total_expenses_cents: number;
  management_fee_cents: number;
  net_distribution_cents: number;
  period_start: string;
  period_end: string;
  source: 'owner_statement' | 'unavailable';
}

export interface PmKpiSnapshot {
  /** ISO 8601 timestamp when snapshot was computed */
  computed_at: string;
  /** Always 'mock' until APPFOLIO_CONNECTOR_PATH=stack-api */
  connector: string;
  /** FIDUCIARY: true = data is from mock fixtures, not real portfolio */
  is_demo: boolean;
  maintenance: MaintenanceKpi;
  occupancy: OccupancyKpi;
  ar: ArKpi;
  financials: FinancialsKpi;
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export async function computePmKpis(
  connector: AppFolioConnector,
  opts: {
    asOf?: string;           // YYYY-MM-DD, defaults to today
    connectorLabel?: string;
    ownerId?: string;
    financialsPeriodStart?: string;
    financialsPeriodEnd?: string;
  } = {},
): Promise<PmKpiSnapshot> {
  const asOfDate = opts.asOf ? new Date(opts.asOf) : new Date();
  const asOfStr = asOfDate.toISOString().split('T')[0];

  const [workOrders, rentRoll, leases] = await Promise.all([
    connector.listWorkOrders(),
    connector.getRentRoll(),
    connector.listLeases(),
  ]);

  const maintenance = aggregateMaintenance(workOrders, asOfDate);
  const occupancy = aggregateOccupancy(leases, asOfStr);
  const ar = aggregateAr(rentRoll);
  const financials = await aggregateFinancials(connector, opts);

  return {
    computed_at: new Date().toISOString(),
    connector: opts.connectorLabel ?? (process.env.APPFOLIO_CONNECTOR_PATH ?? 'mock'),
    is_demo: connector.isDemo,
    maintenance,
    occupancy,
    ar,
    financials,
  };
}

function aggregateMaintenance(workOrders: WorkOrder[], asOf: Date): MaintenanceKpi {
  const byStatus = { open: 0, in_progress: 0, completed: 0, cancelled: 0 };
  const byCategory: Record<string, number> = {};
  let urgentOpen = 0;
  let oldestOpenMs: number | null = null;

  for (const wo of workOrders) {
    byStatus[wo.status] = (byStatus[wo.status] ?? 0) + 1;
    byCategory[wo.category] = (byCategory[wo.category] ?? 0) + 1;

    if (wo.status === 'open' || wo.status === 'in_progress') {
      if (wo.priority === 'urgent' && wo.status === 'open') urgentOpen++;
      if (wo.status === 'open') {
        const ageMs = asOf.getTime() - new Date(wo.createdAt).getTime();
        if (oldestOpenMs === null || ageMs > oldestOpenMs) oldestOpenMs = ageMs;
      }
    }
  }

  return {
    open: byStatus.open,
    in_progress: byStatus.in_progress,
    completed: byStatus.completed,
    cancelled: byStatus.cancelled,
    urgent_open: urgentOpen,
    oldest_open_days: oldestOpenMs !== null ? Math.floor(oldestOpenMs / 86_400_000) : null,
    by_category: byCategory,
  };
}

function aggregateOccupancy(leases: Lease[], asOf: string): OccupancyKpi {
  const sixtyDaysOut = new Date(asOf);
  sixtyDaysOut.setDate(sixtyDaysOut.getDate() + 60);
  const sixtyDaysStr = sixtyDaysOut.toISOString().split('T')[0];

  let active = 0, noticeGiven = 0, monthToMonth = 0, vacant = 0, expiring60 = 0;

  for (const lease of leases) {
    switch (lease.status) {
      case 'active': active++; break;
      case 'notice_given': noticeGiven++; break;
      case 'month_to_month': monthToMonth++; break;
      case 'vacant':
      case 'expired':
      case 'pending': vacant++; break;
    }
    if (lease.endDate && lease.endDate >= asOf && lease.endDate <= sixtyDaysStr) {
      expiring60++;
    }
  }

  const total = leases.length;
  const occupied = active + monthToMonth;
  return {
    total_units: total,
    occupied,
    notice_given: noticeGiven,
    vacant,
    occupancy_rate_pct: total > 0 ? Math.round((occupied / total) * 100) : 0,
    expiring_60_days: expiring60,
    month_to_month: monthToMonth,
  };
}

function aggregateAr(rentRoll: RentRollEntry[]): ArKpi {
  const delinquent = rentRoll.filter(r => r.balance > 0);
  return {
    delinquent_units: delinquent.length,
    total_ar_cents: delinquent.reduce((sum, r) => sum + r.balance, 0),
    delinquent_details: delinquent.map(r => ({
      unit: r.unit,
      tenantName: r.tenantName,
      balance_cents: r.balance,
    })),
  };
}

async function aggregateFinancials(
  connector: AppFolioConnector,
  opts: {
    ownerId?: string;
    financialsPeriodStart?: string;
    financialsPeriodEnd?: string;
  },
): Promise<FinancialsKpi> {
  const ownerId = opts.ownerId ?? 'owner-legacy-001';
  const periodStart = opts.financialsPeriodStart ?? '2026-06-01';
  const periodEnd = opts.financialsPeriodEnd ?? '2026-06-30';

  try {
    const stmt = await connector.getOwnerStatement(ownerId, periodStart, periodEnd);
    return {
      gross_income_cents: stmt.grossIncome,
      total_expenses_cents: stmt.totalExpenses,
      management_fee_cents: stmt.managementFee,
      net_distribution_cents: stmt.netOwnerDistribution,
      period_start: stmt.periodStart,
      period_end: stmt.periodEnd,
      source: 'owner_statement',
    };
  } catch {
    return {
      gross_income_cents: 0,
      total_expenses_cents: 0,
      management_fee_cents: 0,
      net_distribution_cents: 0,
      period_start: periodStart,
      period_end: periodEnd,
      source: 'unavailable',
    };
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers (used by both API and page)
// ---------------------------------------------------------------------------

export function formatDollars(cents: number): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
}

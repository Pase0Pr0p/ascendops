/**
 * StackApiConnector — live AppFolio connector.
 *
 * Architecture: Reports API v2 ONLY (Stack API v1 returns 404 on this account).
 *   POST https://{accountId}.appfolio.com/api/v2/reports/{report_name}
 *   Auth: HTTP Basic Auth — Authorization: Basic base64(clientId:clientSecret)
 *   Rate limit: 7 req / 15 s (next_page_url requests exempt)
 *   Pagination: response envelope { results: [...], next_page_url?: string }
 *   All IDs from AppFolio are integers; we stringify them.
 *
 * Field names are confirmed against paseoproperties.appfolio.com live API
 * (2026-06-29 validation run). See git history for probe scripts.
 *
 * Report → Our type mapping:
 *   work_order.json          → WorkOrder
 *   rent_roll.json           → Lease + RentRollEntry
 *   tenant_directory.json    → Tenant
 *   income_statement_date_range.json → OwnerStatement
 */

import { request as httpsRequest, RequestOptions } from 'https';
import type {
  AppFolioConnector,
  WorkOrder,
  WorkOrderStatus,
  Lease,
  LeaseStatus,
  Tenant,
  RentRollEntry,
  OwnerStatement,
  OwnerStatementLineItem,
  ListOptions,
} from './types';
import { NotSupportedError } from './types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StackApiConfig {
  clientId: string;
  clientSecret: string;
  /**
   * AppFolio account subdomain, e.g. "paseoproperties".
   * Host: https://{accountId}.appfolio.com
   */
  accountId: string;
  /** Override full host (useful for tests). */
  baseUrl?: string;
  /** Reserved for future write operations (not yet implemented). */
  writeEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// AppFolio Reports API response row types (confirmed field names, live API)
// ---------------------------------------------------------------------------

/** Row from work_order.json report */
interface AfWorkOrderRow {
  work_order_id: number;
  property_id: number;
  unit_id?: number;
  unit_name?: string;
  occupancy_id?: number;
  primary_tenant?: string;
  /** Service category, e.g. "Plumbing". Maps to ServiceArea / VendorTrade. */
  vendor_trade?: string;
  work_order_issue?: string;
  job_description?: string;
  /** Status string: "New", "Assigned", "Scheduled", "Work Done", "Completed",
   *  "Ready to Bill", "Canceled", "Waiting" */
  status?: string;
  /** Priority string: "Normal", "Urgent", "Low", "Emergency" */
  priority?: string;
  created_at?: string;       // ISO 8601
  completed_on?: string;
  canceled_on?: string;
  vendor_id?: number;
  /** Estimated cost dollar string e.g. "150.00" */
  estimate_amount?: string;
  /** Actual amount dollar string */
  amount?: string;
}

/** Row from rent_roll.json report — serves as both Lease and RentRollEntry */
interface AfRentRollRow {
  occupancy_id: number;
  unit_id: number;
  property_id: number;
  /** Unit identifier e.g. "1-A" */
  unit?: string;
  /** Primary tenant full name */
  tenant?: string;
  /** Additional tenant IDs (comma-separated integers as string, or array) */
  tenant_id?: number;
  additional_tenant_ids?: string | number[];
  /** Lease status: "Current", "Vacating", "Notice", "Past", "Future", "Vacant" */
  status?: string;
  /** Monthly rent dollar string */
  rent?: string;
  deposit?: string;
  lease_from?: string;   // YYYY-MM-DD
  lease_to?: string;
  move_in?: string;
  move_out?: string;
  /** Amount past due (balance) — dollar string */
  past_due?: string;
  /** Last payment date */
  last_rent_increase?: string;
}

/** Row from tenant_directory.json report */
interface AfTenantRow {
  selected_tenant_id: number;
  occupancy_id?: number;
  unit_id?: number;
  property_id?: number;
  unit?: string;
  /** Full name combined */
  tenant?: string;
  first_name?: string;
  last_name?: string;
  /** Email(s) — may be semicolon-separated */
  emails?: string;
  /** Phone(s) — may be formatted or semicolon-separated */
  phone_numbers?: string;
  status?: string;
  move_in?: string;
  lease_to?: string;
}

/** Row from income_statement_date_range.json report */
interface AfIncomeStatementRow {
  account_name?: string;   // GL account name e.g. "Rental Income", "Management Fee"
  /** Dollar string for the period, e.g. "2684.00" or "-150.00" */
  selected_period?: string;
  account_number?: string;
  gl_account_id?: number;
}

// ---------------------------------------------------------------------------
// HTTP client (raw Node https, no external runtime deps per CLAUDE.md)
// ---------------------------------------------------------------------------

interface HttpResponse { status: number; body: string }

function httpRequest(opts: RequestOptions & { body?: string }): Promise<HttpResponse> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(opts, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }),
      );
    });
    req.on('error', reject);
    req.setTimeout(30_000, () => { req.destroy(); reject(new Error('AppFolio request timed out')); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

class AppFolioApiError extends Error {
  constructor(readonly status: number, readonly body: string) {
    super(`AppFolio API ${status}: ${body.slice(0, 300)}`);
    this.name = 'AppFolioApiError';
  }
}

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (err: unknown) {
      if (i === attempts - 1) throw err;
      if (!(err instanceof AppFolioApiError && err.status === 429)) throw err;
      await new Promise((r) => setTimeout(r, Math.pow(2, i) * 2500));
    }
  }
  throw new Error('unreachable');
}

// ---------------------------------------------------------------------------
// Mapping helpers (pure, testable)
// ---------------------------------------------------------------------------

/** Parse a dollar string ("1500.00" / "-150.00" / "$2,850.00") to integer cents. */
export function parseCents(value: string | number | undefined | null): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = typeof value === 'number' ? value : parseFloat(String(value).replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

/** Work order status strings from live API → our WorkOrderStatus enum. */
export function mapWorkOrderStatus(status: string | undefined): WorkOrderStatus {
  const s = (status ?? '').toLowerCase().replace(/[\s-]/g, '');
  if (s === 'completed' || s === 'completednobill' || s === 'readytobill') return 'completed';
  if (s === 'canceled' || s === 'cancelled') return 'cancelled';
  if (s === 'assigned' || s === 'scheduled' || s === 'workdone' || s === 'waiting') return 'in_progress';
  return 'open'; // New, Estimate Requested, Estimated, etc.
}

export function mapPriority(p: string | undefined): WorkOrder['priority'] {
  const s = (p ?? '').toLowerCase();
  if (s === 'urgent' || s === 'emergency' || s === 'high') return 'urgent';
  if (s === 'low') return 'low';
  return 'normal';
}

/**
 * Rent roll status strings from live API → our LeaseStatus enum.
 * Confirmed values: "Current", "Vacating", "Notice", "Past", "Future", "Vacant"
 */
export function mapLeaseStatus(afStatus: string | undefined): LeaseStatus {
  const s = (afStatus ?? '').toLowerCase().trim();
  if (s === 'current') return 'active';
  if (s === 'vacating') return 'month_to_month';
  if (s === 'notice') return 'notice_given';
  if (s === 'past' || s === 'expired') return 'expired';
  if (s === 'future' || s === 'pending') return 'pending';
  return 'active';
}

export function mapOwnerStatementCategory(
  accountName: string | undefined,
  amount: number,
): OwnerStatementLineItem['category'] {
  const n = (accountName ?? '').toLowerCase();
  if (n.includes('management fee') || n.includes('mgmt fee')) return 'fee';
  if (n.includes('adjust') || n.includes('correction')) return 'adjustment';
  return amount >= 0 ? 'income' : 'expense';
}

export function mapWorkOrderRow(raw: AfWorkOrderRow): WorkOrder {
  return {
    id: String(raw.work_order_id),
    propertyId: String(raw.property_id),
    unit: raw.unit_name,
    tenantId: raw.occupancy_id != null ? String(raw.occupancy_id) : undefined,
    category: raw.vendor_trade ?? raw.work_order_issue ?? 'general',
    description: raw.job_description ?? '',
    status: mapWorkOrderStatus(raw.status),
    priority: mapPriority(raw.priority),
    createdAt: raw.created_at ?? new Date().toISOString(),
    updatedAt: raw.completed_on ?? raw.canceled_on ?? raw.created_at ?? new Date().toISOString(),
    completedAt: raw.completed_on,
    vendorId: raw.vendor_id != null ? String(raw.vendor_id) : undefined,
    estimatedCost: parseCents(raw.estimate_amount),
    actualCost: raw.amount ? parseCents(raw.amount) : undefined,
  };
}

export function mapRentRollRowToLease(raw: AfRentRollRow): Lease {
  const tenantIds: string[] = [];
  if (raw.tenant_id != null) tenantIds.push(String(raw.tenant_id));
  if (raw.additional_tenant_ids) {
    const extra = Array.isArray(raw.additional_tenant_ids)
      ? raw.additional_tenant_ids
      : String(raw.additional_tenant_ids).split(',').map((s) => s.trim());
    for (const id of extra) { if (id) tenantIds.push(String(id)); }
  }
  return {
    id: String(raw.occupancy_id),
    propertyId: String(raw.property_id),
    unit: raw.unit,
    status: mapLeaseStatus(raw.status),
    tenantIds,
    startDate: raw.lease_from ?? '',
    endDate: raw.lease_to,
    monthlyRent: parseCents(raw.rent),
    securityDeposit: raw.deposit ? parseCents(raw.deposit) : undefined,
    moveInDate: raw.move_in,
    moveOutDate: raw.move_out,
  };
}

export function mapRentRollRow(raw: AfRentRollRow): RentRollEntry {
  return {
    propertyId: String(raw.property_id),
    unit: raw.unit,
    leaseId: String(raw.occupancy_id),
    tenantName: raw.tenant ?? '',
    status: mapLeaseStatus(raw.status),
    monthlyRent: parseCents(raw.rent),
    balance: parseCents(raw.past_due),
    leaseEnd: raw.lease_to,
  };
}

export function mapTenantRow(raw: AfTenantRow): Tenant {
  const emails = raw.emails?.split(/[;,]/).map((e) => e.trim()).filter(Boolean) ?? [];
  const phones = raw.phone_numbers?.split(/[;,]/).map((p) => p.trim()).filter(Boolean) ?? [];
  return {
    id: String(raw.selected_tenant_id),
    firstName: raw.first_name ?? raw.tenant?.split(' ')[0] ?? '',
    lastName: raw.last_name ?? raw.tenant?.split(' ').slice(1).join(' ') ?? '',
    email: emails[0],
    phone: phones[0],
    leaseId: raw.occupancy_id != null ? String(raw.occupancy_id) : '',
    propertyId: raw.property_id != null ? String(raw.property_id) : '',
    unit: raw.unit,
  };
}

// ---------------------------------------------------------------------------
// Main connector class
// ---------------------------------------------------------------------------

export class StackApiConnector implements AppFolioConnector {
  readonly isDemo = false;

  private readonly hostname: string;
  private readonly basicAuth: string;

  constructor(config: StackApiConfig) {
    this.hostname = config.baseUrl
      ? new URL(config.baseUrl).hostname
      : `${config.accountId}.appfolio.com`;
    this.basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  }

  // -------------------------------------------------------------------------
  // Reports API v2 — POST tabular reports
  // -------------------------------------------------------------------------

  private async reportsPost<T>(
    reportName: string,
    filters: Record<string, unknown> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = null;

    const doPost = async (path: string, body: string): Promise<void> => {
      await withRetry(async () => {
        const res = await httpRequest({
          hostname: this.hostname,
          port: 443,
          path,
          method: 'POST',
          headers: {
            Authorization: `Basic ${this.basicAuth}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Content-Length': String(Buffer.byteLength(body)),
          },
          body,
        });
        if (res.status === 403) {
          throw new NotSupportedError(
            `AppFolio Plus does not include report: ${reportName}. Requires add-on or Max tier.`,
          );
        }
        if (res.status >= 400) throw new AppFolioApiError(res.status, res.body);
        const data = JSON.parse(res.body) as { results?: T[]; next_page_url?: string } | T[];
        const pageItems: T[] = Array.isArray(data) ? data : (data.results ?? []);
        results.push(...pageItems);
        nextUrl = Array.isArray(data) ? null : (data.next_page_url ?? null);
      });
    };

    const body = JSON.stringify(filters);
    await doPost(`/api/v2/reports/${reportName}`, body);

    // Follow next_page_url (exempt from rate limiting per AppFolio docs)
    while (nextUrl) {
      const url = nextUrl;
      nextUrl = null;
      await doPost(url, '{}');
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // ping — try work_order report with 1-day window
  // -------------------------------------------------------------------------

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const today = new Date().toISOString().slice(0, 10);
      await this.reportsPost('work_order.json', {
        status_date_range_from: today,
        status_date_range_to: today,
      });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // -------------------------------------------------------------------------
  // Work Orders — work_order.json
  // -------------------------------------------------------------------------

  async listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]> {
    const filters: Record<string, unknown> = { property_visibility: 'active' };
    if (opts?.since) {
      filters.status_date_range_from = opts.since.slice(0, 10);
      filters.status_date_range_to = new Date().toISOString().slice(0, 10);
    }
    const rows = await this.reportsPost<AfWorkOrderRow>('work_order.json', filters);
    const all = rows
      .filter((r) => !opts?.propertyId || String(r.property_id) === opts.propertyId)
      .map(mapWorkOrderRow);
    return applyListOptions(all, opts);
  }

  async getWorkOrder(id: string): Promise<WorkOrder> {
    const rows = await this.reportsPost<AfWorkOrderRow>('work_order.json', {
      property_visibility: 'active',
    });
    const row = rows.find((r) => String(r.work_order_id) === id);
    if (!row) throw new Error(`Work order not found: ${id}`);
    return mapWorkOrderRow(row);
  }

  // -------------------------------------------------------------------------
  // Leases — derived from rent_roll.json (occupancy data)
  // -------------------------------------------------------------------------

  async listLeases(opts?: ListOptions): Promise<Lease[]> {
    const rows = await this.fetchRentRollRows(opts?.propertyId);
    return applyListOptions(rows.map(mapRentRollRowToLease), opts);
  }

  async getLease(id: string): Promise<Lease> {
    const rows = await this.fetchRentRollRows();
    const row = rows.find((r) => String(r.occupancy_id) === id);
    if (!row) throw new Error(`Lease (occupancy) not found: ${id}`);
    return mapRentRollRowToLease(row);
  }

  // -------------------------------------------------------------------------
  // Tenants — tenant_directory.json
  // -------------------------------------------------------------------------

  async listTenants(opts?: ListOptions): Promise<Tenant[]> {
    const filters: Record<string, unknown> = { property_visibility: 'active' };
    if (opts?.propertyId) filters.properties = { properties_ids: [Number(opts.propertyId)] };
    const rows = await this.reportsPost<AfTenantRow>('tenant_directory.json', filters);
    return applyListOptions(rows.map(mapTenantRow), opts);
  }

  async getTenant(id: string): Promise<Tenant> {
    const rows = await this.reportsPost<AfTenantRow>('tenant_directory.json', {
      property_visibility: 'active',
    });
    const row = rows.find((r) => String(r.selected_tenant_id) === id);
    if (!row) throw new Error(`Tenant not found: ${id}`);
    return mapTenantRow(row);
  }

  // -------------------------------------------------------------------------
  // Rent Roll — rent_roll.json
  // -------------------------------------------------------------------------

  async getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]> {
    const rows = await this.fetchRentRollRows(opts?.propertyId);
    return rows.map(mapRentRollRow);
  }

  // -------------------------------------------------------------------------
  // Owner Statements — income_statement_date_range.json
  // -------------------------------------------------------------------------

  async getOwnerStatement(
    ownerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OwnerStatement> {
    const rows = await this.reportsPost<AfIncomeStatementRow>('income_statement_date_range.json', {
      properties: { owners_ids: [Number(ownerId)] },
      posted_on_from: periodStart,
      posted_on_to: periodEnd,
      accounting_basis: 'Cash',
      level_of_detail: 'detail_view',
    });
    if (!rows.length) {
      throw new Error(`No income statement data for owner ${ownerId} period ${periodStart}–${periodEnd}`);
    }
    return buildOwnerStatement(ownerId, rows, periodStart, periodEnd);
  }

  async listOwnerStatements(ownerId: string, opts?: ListOptions): Promise<OwnerStatement[]> {
    const since = opts?.since ?? lastNMonths(12);
    const to = new Date().toISOString().slice(0, 10);
    const periods = buildMonthlyPeriods(since, to);
    const statements = await Promise.all(
      periods.map((p) =>
        this.getOwnerStatement(ownerId, p.start, p.end).catch(() => null),
      ),
    );
    const results = statements.filter((s): s is OwnerStatement => s !== null);
    return applyListOptions(results, opts);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async fetchRentRollRows(propertyId?: string): Promise<AfRentRollRow[]> {
    const filters: Record<string, unknown> = { property_visibility: 'active' };
    if (propertyId) filters.properties = { properties_ids: [Number(propertyId)] };
    return this.reportsPost<AfRentRollRow>('rent_roll.json', filters);
  }
}

// ---------------------------------------------------------------------------
// Owner statement assembly
// ---------------------------------------------------------------------------

function buildOwnerStatement(
  ownerId: string,
  rows: AfIncomeStatementRow[],
  periodStart: string,
  periodEnd: string,
): OwnerStatement {
  const lineItems: OwnerStatementLineItem[] = rows
    .filter((r) => r.account_name && r.selected_period)
    .map((r): OwnerStatementLineItem => {
      const amount = parseCents(r.selected_period);
      return {
        date: periodEnd,
        description: r.account_name ?? '',
        amount,
        category: mapOwnerStatementCategory(r.account_name, amount),
      };
    });

  const grossIncome = lineItems.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalExpenses = Math.abs(
    lineItems.filter((l) => l.category === 'expense').reduce((s, l) => s + l.amount, 0),
  );
  const managementFee = Math.abs(
    lineItems.filter((l) => l.category === 'fee').reduce((s, l) => s + l.amount, 0),
  );
  const netOwnerDistribution = grossIncome - totalExpenses - managementFee;

  return {
    ownerId,
    propertyId: '',  // income_statement_date_range aggregates across all owner properties
    periodStart,
    periodEnd,
    grossIncome,
    totalExpenses,
    managementFee,
    netOwnerDistribution,
    lineItems,
  };
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

function applyListOptions<T>(items: T[], opts?: ListOptions): T[] {
  if (!opts?.offset && !opts?.limit) return items;
  return items.slice(opts.offset ?? 0, (opts.offset ?? 0) + (opts.limit ?? items.length));
}

function lastNMonths(n: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  return d.toISOString().slice(0, 10);
}

interface Period { start: string; end: string }

function buildMonthlyPeriods(from: string, to: string): Period[] {
  const periods: Period[] = [];
  let cur = new Date(from);
  const end = new Date(to);
  while (cur <= end) {
    const start = cur.toISOString().slice(0, 10);
    const last = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
    periods.push({ start, end: last.toISOString().slice(0, 10) });
    cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
  }
  return periods;
}

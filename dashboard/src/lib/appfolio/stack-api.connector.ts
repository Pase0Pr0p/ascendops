/**
 * StackApiConnector — live AppFolio connector (Basic Auth, account-scoped host).
 *
 * Architecture: two API surfaces, one set of credentials.
 *
 *   Stack API v1 (entity CRUD)
 *     Base:   https://{accountId}.appfolio.com/api/v1
 *     Auth:   Authorization: Basic base64(clientId:clientSecret)
 *     Method: GET (list/single)
 *     Used for: work orders, occupancies (→ leases), tenants
 *
 *   Reports API v2 (tabular pull reports)
 *     Base:   https://{accountId}.appfolio.com/api/v2/reports
 *     Auth:   same Basic header
 *     Method: POST with JSON filter body
 *     Used for: rent roll (derived), owner statements
 *     Docs:   gist.github.com/omnimaxxing/2b016c518b4063fd536549b12694b7b7
 *
 * TIER: Rob is on Plus = read-only. No write methods needed.
 * Payables endpoints may 403 on plain Plus — callers receive NotSupportedError,
 * the connector continues to serve other methods normally.
 *
 * AMOUNTS: AppFolio returns dollar strings ("1500.00"). All our types use cents.
 *          parseCents() handles the conversion.
 *
 * VALIDATE comments mark every assumption that must be confirmed against the live API:
 *   - endpoint paths (Stack API paths unconfirmed; /api/v1/work_orders returned 404 in probe)
 *   - field names in API responses (PascalCase assumed from marketing docs)
 *   - report column names in Reports API responses
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
   * AppFolio account identifier — the subdomain.
   * e.g. "paseoproperties" for paseoproperties.appfolio.com
   * VALIDATE: may be numeric customer ID (e.g. "00339074") — confirm on first run.
   */
  accountId: string;
  /** Override host (e.g. for tests). When set, accountId is ignored for URL construction. */
  baseUrl?: string;
  writeEnabled?: boolean;
}

// ---------------------------------------------------------------------------
// AppFolio API response types
// Field names taken from Stack API marketing page (appfolio.com/stack/partners/api).
// VALIDATE: confirm actual JSON key names on first live run.
// ---------------------------------------------------------------------------

interface AfWorkOrder {
  Id: string;
  PropertyId: string;
  UnitId?: string;
  OccupancyId?: string;
  /** Array of status codes, e.g. ["4"] for Completed. Current status = [0]. */
  Statuses?: string[];
  /** Service area / category e.g. "Plumbing", "Electrical". VALIDATE field name. */
  ServiceArea?: string;
  JobDescription?: string;
  /** Priority enum. VALIDATE values. */
  Priority?: string;
  /** ISO 8601 datetime. VALIDATE field name — may be "CreatedOn". */
  CreatedAt?: string;
  LastUpdatedAt?: string;
  CompletedAt?: string;
  VendorId?: string;
  /** Dollar string e.g. "150.00". VALIDATE field name. */
  EstimatedCost?: string;
  ActualCost?: string;
}

interface AfOccupancy {
  Id: string;
  PropertyId: string;
  UnitId?: string;
  /** e.g. "Active", "MonthToMonth", "NoticeGiven", "Past". VALIDATE values. */
  Status?: string;
  LeaseStartDate?: string;  // YYYY-MM-DD
  LeaseEndDate?: string;
  MoveInDate?: string;
  MoveOutDate?: string;
  /** Monthly rent dollar string. VALIDATE field name — may be "RentAmount" or "MonthlyRent". */
  Rent?: string;
  SecurityDeposit?: string;
  LastUpdatedAt?: string;
  /** Tenants nested inside occupancy. VALIDATE: may be a separate GET /tenants call. */
  Tenants?: AfTenant[];
}

interface AfTenant {
  Id: string;
  FirstName?: string;
  LastName?: string;
  Email?: string;
  PhoneNumber?: string;
  OccupancyId?: string;
  PropertyId?: string;
  UnitId?: string;
}

/** Row from income_statement_date_range.json report. VALIDATE column names. */
interface AfIncomeStatementRow {
  /** Property or owner identifier. VALIDATE: may be property_id, owner_id, or property_name. */
  property_id?: string;
  owner_id?: string;
  property_name?: string;
  account_name?: string;     // GL account name e.g. "Rental Income", "Management Fee"
  account_number?: string;   // GL account number
  gl_account_id?: number;
  /** Dollar string for the period. May be positive (income) or negative (expense). */
  selected_period?: string;  // VALIDATE: might be "amount" or "period_amount"
  posted_on?: string;        // VALIDATE: date of entry
  description?: string;
}

/** Row from resident_financial_activity.json or charge_detail.json. VALIDATE column names. */
interface AfResidentActivityRow {
  property_id?: string;
  unit_id?: string;
  occupancy_id?: string;
  tenant_name?: string;
  lease_status?: string;
  /** Monthly rent charge amount. VALIDATE: may be "charge_amount" or "rent_amount". */
  rent_amount?: string;
  /** Outstanding balance. VALIDATE: may be "balance_due" or "amount_due". */
  balance?: string;
  last_payment_date?: string;
  lease_end_date?: string;
}

// ---------------------------------------------------------------------------
// HTTP client (raw Node https — no external runtime deps per CLAUDE.md)
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
// Mapping helpers (pure — fully testable with no network)
// ---------------------------------------------------------------------------

/** Parse a dollar string ("1500.00" or "-150.00" or "$1,500.00") to integer cents. */
export function parseCents(value: string | undefined | null): number {
  if (!value) return 0;
  const n = parseFloat(value.replace(/[$,\s]/g, ''));
  return isNaN(n) ? 0 : Math.round(n * 100);
}

export function mapWorkOrderStatus(statuses: string[] | undefined): WorkOrderStatus {
  // AppFolio status codes from gist: '4'=Completed, '5'=Canceled, '9'=Assigned (in_progress)
  // '0'=New, '3'=Scheduled, '8'=Work Done (in_progress), '12'=ReadyToBill
  const code = statuses?.[0] ?? '';
  if (code === '4' || code === '7') return 'completed';   // Completed / CompletedNoBill
  if (code === '5') return 'cancelled';
  if (code === '9' || code === '3' || code === '8' || code === '12') return 'in_progress';
  return 'open';
}

export function mapPriority(p: string | undefined): WorkOrder['priority'] {
  const s = (p ?? '').toLowerCase();
  if (s === 'urgent' || s === 'emergency' || s === 'high') return 'urgent';
  if (s === 'low') return 'low';
  return 'normal';
}

export function mapLeaseStatus(afStatus: string | undefined): LeaseStatus {
  const s = (afStatus ?? '').toLowerCase().replace(/[\s_]/g, '');
  if (s === 'active') return 'active';
  if (s === 'monthtomonth' || s === 'monthtomonthmtm') return 'month_to_month';
  if (s === 'noticegiven' || s === 'notice') return 'notice_given';
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

export function mapWorkOrder(raw: AfWorkOrder): WorkOrder {
  return {
    id: raw.Id,
    propertyId: raw.PropertyId,
    unit: raw.UnitId,
    tenantId: raw.OccupancyId,
    category: raw.ServiceArea ?? 'general',
    description: raw.JobDescription ?? '',
    status: mapWorkOrderStatus(raw.Statuses),
    priority: mapPriority(raw.Priority),
    createdAt: raw.CreatedAt ?? new Date().toISOString(),
    updatedAt: raw.LastUpdatedAt ?? raw.CreatedAt ?? new Date().toISOString(),
    completedAt: raw.CompletedAt,
    vendorId: raw.VendorId,
    estimatedCost: parseCents(raw.EstimatedCost),
    actualCost: raw.ActualCost ? parseCents(raw.ActualCost) : undefined,
  };
}

export function mapLease(raw: AfOccupancy): Lease {
  return {
    id: raw.Id,
    propertyId: raw.PropertyId,
    unit: raw.UnitId,
    status: mapLeaseStatus(raw.Status),
    tenantIds: (raw.Tenants ?? []).map((t) => t.Id),
    startDate: raw.LeaseStartDate ?? '',
    endDate: raw.LeaseEndDate,
    monthlyRent: parseCents(raw.Rent),
    securityDeposit: raw.SecurityDeposit ? parseCents(raw.SecurityDeposit) : undefined,
    moveInDate: raw.MoveInDate,
    moveOutDate: raw.MoveOutDate,
  };
}

export function mapTenant(raw: AfTenant, occ: AfOccupancy): Tenant {
  return {
    id: raw.Id,
    firstName: raw.FirstName ?? '',
    lastName: raw.LastName ?? '',
    email: raw.Email,
    phone: raw.PhoneNumber,
    leaseId: occ.Id,
    propertyId: raw.PropertyId ?? occ.PropertyId,
    unit: raw.UnitId ?? occ.UnitId,
  };
}

export function mapRentRollRow(row: AfResidentActivityRow): RentRollEntry {
  return {
    propertyId: row.property_id ?? '',
    unit: row.unit_id,
    leaseId: row.occupancy_id ?? '',
    tenantName: row.tenant_name ?? '',
    status: mapLeaseStatus(row.lease_status),
    monthlyRent: parseCents(row.rent_amount),
    balance: parseCents(row.balance),
    lastPaymentDate: row.last_payment_date,
    leaseEnd: row.lease_end_date,
  };
}

// ---------------------------------------------------------------------------
// Main connector class
// ---------------------------------------------------------------------------

export class StackApiConnector implements AppFolioConnector {
  readonly isDemo = false;

  private readonly hostname: string;
  /** base64(clientId:clientSecret) — computed once, reused for all requests. */
  private readonly basicAuth: string;

  constructor(private readonly config: StackApiConfig) {
    // VALIDATE: confirm whether accountId is subdomain ("paseoproperties") or numeric ID.
    const host = config.baseUrl
      ? new URL(config.baseUrl).hostname
      : `${config.accountId}.appfolio.com`;
    this.hostname = host;
    this.basicAuth = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64');
  }

  // -------------------------------------------------------------------------
  // Stack API v1 — GET entity endpoints
  // VALIDATE: all paths on first live run. Probe found /api/v1/work_orders → 404
  // on paseoproperties; paths may require .json extension or differ from assumed.
  // -------------------------------------------------------------------------

  private async stackGet<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T> {
    return withRetry(async () => {
      const qs = new URLSearchParams(
        Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)])),
      ).toString();
      const fullPath = `/api/v1${path}${qs ? `?${qs}` : ''}`;
      const res = await httpRequest({
        hostname: this.hostname,
        port: 443,
        path: fullPath,
        method: 'GET',
        headers: { Authorization: `Basic ${this.basicAuth}`, Accept: 'application/json' },
      });
      if (res.status === 403) {
        throw new NotSupportedError(
          `AppFolio Plus does not allow: ${path}. Requires add-on or Max tier.`,
        );
      }
      if (res.status >= 400) throw new AppFolioApiError(res.status, res.body);
      return JSON.parse(res.body) as T;
    });
  }

  /** Paginate all pages from a Stack API v1 endpoint. */
  private async stackGetAll<T>(
    path: string,
    params: Record<string, string | number> = {},
  ): Promise<T[]> {
    const results: T[] = [];
    let page = 1;
    while (true) {
      // VALIDATE: pagination params — may be page+per_page, offset+limit, or cursor-based.
      const data = await this.stackGet<{ results?: T[] } | T[]>(path, {
        ...params, page, per_page: 100,
      });
      const items: T[] = Array.isArray(data) ? data : (data.results ?? []);
      results.push(...items);
      if (items.length < 100) break;
      page++;
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // Reports API v2 — POST tabular report endpoints
  // URL: https://{accountId}.appfolio.com/api/v2/reports/{report_name}.json
  // Auth: same Basic header
  // Rate limit: 7 req / 15s (next_page_url requests exempt)
  // -------------------------------------------------------------------------

  private async reportsPost<T>(
    reportName: string,
    filters: Record<string, unknown>,
  ): Promise<T[]> {
    const results: T[] = [];
    let nextUrl: string | null = null;

    const fetchPage = async (body: string, urlOverride?: string): Promise<void> => {
      await withRetry(async () => {
        const url = urlOverride ?? `/api/v2/reports/${reportName}`;
        const res = await httpRequest({
          hostname: this.hostname,
          port: 443,
          path: url,
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
            `AppFolio Plus does not include report: ${reportName}. May require add-on.`,
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
    await fetchPage(body);
    // Follow next_page_url pagination (rate-limit exempt per AppFolio docs)
    while (nextUrl) {
      const url = nextUrl;
      nextUrl = null;
      await fetchPage('{}', url);
    }
    return results;
  }

  // -------------------------------------------------------------------------
  // ping
  // -------------------------------------------------------------------------

  async ping(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      // VALIDATE: lightweight Stack API endpoint to probe — /api/v1/properties with limit 1.
      await this.stackGet('/properties', { per_page: 1 });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // -------------------------------------------------------------------------
  // Work Orders — Stack API v1
  // VALIDATE: path is /work_orders, field names match AfWorkOrder interface
  // -------------------------------------------------------------------------

  async listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]> {
    const params: Record<string, string | number> = {};
    if (opts?.propertyId) params['property_id'] = opts.propertyId;
    // VALIDATE: filter param name for updatedAt filter — may be LastUpdatedAtFrom or last_updated_at_from
    if (opts?.since) params['last_updated_at_from'] = opts.since;

    const raw = await this.stackGetAll<AfWorkOrder>('/work_orders', params);
    const mapped = raw.map(mapWorkOrder);
    return applyListOptions(mapped, opts);
  }

  async getWorkOrder(id: string): Promise<WorkOrder> {
    // VALIDATE: single-entity path — may be /work_orders/{id} or /work_orders?id={id}
    const raw = await this.stackGet<AfWorkOrder>(`/work_orders/${id}`);
    return mapWorkOrder(raw);
  }

  // -------------------------------------------------------------------------
  // Leases — mapped from AppFolio Occupancies (Stack API v1)
  // AppFolio has no "Lease" resource; Occupancy = the lease+occupant relationship.
  // VALIDATE: path /occupancies, status values in AfOccupancy.Status
  // -------------------------------------------------------------------------

  async listLeases(opts?: ListOptions): Promise<Lease[]> {
    const occ = await this.fetchAllOccupancies(opts);
    return applyListOptions(occ.map(mapLease), opts);
  }

  async getLease(id: string): Promise<Lease> {
    // VALIDATE: single-occupancy path
    const raw = await this.stackGet<AfOccupancy>(`/occupancies/${id}`);
    return mapLease(raw);
  }

  // -------------------------------------------------------------------------
  // Tenants — Stack API v1
  // VALIDATE: whether tenants are nested inside occupancy responses, or require
  // a separate GET /tenants call. If nested, remove stackGetAll('/tenants') calls.
  // -------------------------------------------------------------------------

  async listTenants(opts?: ListOptions): Promise<Tenant[]> {
    try {
      // Try direct /tenants endpoint first (Stack API has separate Tenants resource)
      const params: Record<string, string | number> = {};
      if (opts?.propertyId) params['property_id'] = opts.propertyId;
      const rawTenants = await this.stackGetAll<AfTenant>('/tenants', params);
      if (rawTenants.length > 0) {
        // Need occupancy for leaseId mapping — build lookup from a parallel occupancy fetch
        const occ = await this.fetchAllOccupancies();
        const occMap = new Map(occ.map((o) => [o.Id, o]));
        const tenants = rawTenants
          .filter((t) => t.OccupancyId)
          .map((t) => {
            const occ = occMap.get(t.OccupancyId!) ?? {
              Id: t.OccupancyId!, PropertyId: t.PropertyId ?? '', Tenants: [] };
            return mapTenant(t, occ as AfOccupancy);
          });
        return applyListOptions(tenants, opts);
      }
    } catch {
      // Fall through to occupancy extraction
    }
    // Fallback: extract tenants from nested occupancy Tenants arrays
    const occ = await this.fetchAllOccupancies(opts);
    return applyListOptions(occ.flatMap((o) => (o.Tenants ?? []).map((t) => mapTenant(t, o))), opts);
  }

  async getTenant(id: string): Promise<Tenant> {
    try {
      // VALIDATE: direct tenant endpoint
      const raw = await this.stackGet<AfTenant>(`/tenants/${id}`);
      // Need the occupancy for leaseId
      if (raw.OccupancyId) {
        const occ = await this.stackGet<AfOccupancy>(`/occupancies/${raw.OccupancyId}`);
        return mapTenant(raw, occ);
      }
      return { id: raw.Id, firstName: raw.FirstName ?? '', lastName: raw.LastName ?? '',
        email: raw.Email, phone: raw.PhoneNumber, leaseId: raw.OccupancyId ?? '',
        propertyId: raw.PropertyId ?? '', unit: raw.UnitId };
    } catch {
      // Fallback: scan occupancies
      const occ = await this.fetchAllOccupancies();
      for (const o of occ) {
        const t = (o.Tenants ?? []).find((t) => t.Id === id);
        if (t) return mapTenant(t, o);
      }
      throw new Error(`Tenant not found: ${id}`);
    }
  }

  // -------------------------------------------------------------------------
  // Rent Roll — Reports API v2
  // VALIDATE: report name. No direct rent_roll.json found in gist.
  //   Candidates: resident_financial_activity.json (has tenant_statuses + date range)
  //   If neither works, fall back to deriving from occupancies (loses AR balance).
  // -------------------------------------------------------------------------

  async getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]> {
    const filters: Record<string, unknown> = {
      property_visibility: 'active',
      // Only active/MTM tenants for rent roll
      tenant_statuses: ['0', '4'],  // VALIDATE: '0'=current, '4'=month-to-month? Check report docs
    };
    if (opts?.propertyId) {
      filters.properties = { properties_ids: [opts.propertyId] };
    }
    try {
      // VALIDATE: report name — try resident_financial_activity.json first
      const rows = await this.reportsPost<AfResidentActivityRow>(
        'resident_financial_activity.json',
        filters,
      );
      if (rows.length > 0) return rows.map(mapRentRollRow);
    } catch (err) {
      if (err instanceof NotSupportedError) throw err;
      // Report not available on this tier — fall through to occupancy derivation
    }
    // Fallback: derive from occupancies (balance will be 0)
    return this.deriveRentRollFromOccupancies(opts?.propertyId);
  }

  // -------------------------------------------------------------------------
  // Owner Statements — Reports API v2
  // VALIDATE: income_statement_date_range.json is the right report.
  //   Confirmed fields: property_id (or owner_id), account_name, selected_period.
  //   We group rows by owner+period and sum into OwnerStatement shape.
  //   CAVEAT: "owner_id" vs "property_id" filter — AppFolio assigns multiple
  //   properties per owner; this groups by owner from the filter side.
  // -------------------------------------------------------------------------

  async getOwnerStatement(
    ownerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<OwnerStatement> {
    const rows = await this.fetchIncomeStatementRows(ownerId, periodStart, periodEnd);
    if (!rows.length) {
      throw new Error(`No owner statement data for owner ${ownerId} period ${periodStart}–${periodEnd}`);
    }
    return buildOwnerStatement(ownerId, rows, periodStart, periodEnd);
  }

  async listOwnerStatements(ownerId: string, opts?: ListOptions): Promise<OwnerStatement[]> {
    // Reports API doesn't have a "list owner statements" concept — we pull one period at a time.
    // Without a date range, default to the last 12 months, one statement per month.
    // VALIDATE: confirm this is the right approach; AppFolio may have a dedicated endpoint.
    const periods = buildMonthlyPeriods(opts?.since ?? lastNMonths(12), new Date().toISOString().slice(0, 10));
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

  private async fetchAllOccupancies(opts?: ListOptions): Promise<AfOccupancy[]> {
    const params: Record<string, string | number> = {};
    if (opts?.propertyId) params['property_id'] = opts.propertyId;
    if (opts?.since) params['last_updated_at_from'] = opts.since;
    return this.stackGetAll<AfOccupancy>('/occupancies', params);
  }

  private async fetchIncomeStatementRows(
    ownerId: string,
    periodStart: string,
    periodEnd: string,
  ): Promise<AfIncomeStatementRow[]> {
    // VALIDATE: filter field names — owners_ids vs owner_ids, posted_on_from vs from_date
    return this.reportsPost<AfIncomeStatementRow>('income_statement_date_range.json', {
      properties: { owners_ids: [ownerId] },
      posted_on_from: periodStart,
      posted_on_to: periodEnd,
      accounting_basis: 'Cash',
      level_of_detail: 'detail_view',
    });
  }

  private async deriveRentRollFromOccupancies(propertyId?: string): Promise<RentRollEntry[]> {
    const occ = await this.fetchAllOccupancies({ propertyId });
    return occ
      .filter((o) => ['active', 'month_to_month', 'notice_given'].includes(mapLeaseStatus(o.Status)))
      .map((o): RentRollEntry => ({
        propertyId: o.PropertyId,
        unit: o.UnitId,
        leaseId: o.Id,
        tenantName: (o.Tenants ?? []).map((t) => `${t.FirstName ?? ''} ${t.LastName ?? ''}`.trim()).join(', '),
        status: mapLeaseStatus(o.Status),
        monthlyRent: parseCents(o.Rent),
        // AR balance not available from occupancy alone; flag for validation
        balance: 0, // VALIDATE: use aged_receivables_detail.json if available
        leaseEnd: o.LeaseEndDate,
      }));
  }
}

// ---------------------------------------------------------------------------
// Owner statement assembly from income statement rows
// ---------------------------------------------------------------------------

function buildOwnerStatement(
  ownerId: string,
  rows: AfIncomeStatementRow[],
  periodStart: string,
  periodEnd: string,
): OwnerStatement {
  // VALIDATE: confirm selected_period field name and that it's the line-item amount
  const lineItems: OwnerStatementLineItem[] = rows
    .filter((r) => r.account_name && r.selected_period)
    .map((r): OwnerStatementLineItem => {
      const amount = parseCents(r.selected_period);
      return {
        date: r.posted_on ?? periodEnd,
        description: r.account_name ?? '',
        amount,
        category: mapOwnerStatementCategory(r.account_name, amount),
      };
    });

  const grossIncome = lineItems.filter((l) => l.amount > 0).reduce((s, l) => s + l.amount, 0);
  const totalExpenses = Math.abs(lineItems.filter((l) => l.category === 'expense').reduce((s, l) => s + l.amount, 0));
  const managementFee = Math.abs(lineItems.filter((l) => l.category === 'fee').reduce((s, l) => s + l.amount, 0));
  const netOwnerDistribution = grossIncome - totalExpenses - managementFee;

  // propertyId: use first row's property_id; may need per-property grouping for multi-property owners
  // VALIDATE: multi-property owner will have rows from multiple properties — may need to group separately
  const propertyId = rows.find((r) => r.property_id)?.property_id ?? '';

  return { ownerId, propertyId, periodStart, periodEnd, grossIncome, totalExpenses, managementFee, netOwnerDistribution, lineItems };
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

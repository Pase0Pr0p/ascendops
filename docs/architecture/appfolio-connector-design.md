# AppFolio Connector — Design Document

**Status:** Ready for implementation (one TODO pending)  
**Author:** claudia  
**Branch:** feat/appfolio-connector-design  
**Created:** 2026-06-25  
**Last revised:** 2026-06-25 (rev 2 — Stack API confirmed, self-serve provisioning documented)

---

## 1. Purpose

This document defines the design for the AppFolio data connector — the layer that gives Paseo's automation workflows access to portfolio data (leases, maintenance, rent roll, owner financials, tenants). The connector uses the **AppFolio Stack Database API** as its confirmed access path. A single abstract interface is defined once; the mock implementation and the live Stack API implementation slot in behind it. Callers never reference the access path directly.

**One open TODO:** read-only vs read/write scope depends on Rob's subscription tier (Plus vs Max). Everything else is settled. See §10.

---

## 2. Access Path — AppFolio Stack Database API

### 2.1 What it is

The Stack Database API is AppFolio's first-party REST API. It is the confirmed and sole primary access path for this connector.

**Confirmed:** self-provisioned by the property manager. Rob generates credentials directly via the AppFolio Developer Portal — no partner approval, no marketplace process, no AppFolio support ticket. Lead time is minutes to days, not months. The final click-through happens when Rob logs into the Developer Portal to generate credentials; the path itself is settled.

### 2.2 Auth model

OAuth 2.0 client credentials flow:

1. Rob logs into the AppFolio Developer Portal and creates an application → receives `client_id` + `client_secret`
2. Connector POSTs to the token endpoint with `grant_type=client_credentials`
3. Bearer token returned with expiry (typically 1 hour)
4. Connector handles token refresh transparently — callers never manage tokens

Credentials live in org `secrets.env` as `APPFOLIO_CLIENT_ID`, `APPFOLIO_CLIENT_SECRET`, `APPFOLIO_ACCOUNT_ID`. Never committed to the repo.

### 2.3 Data access

| Dimension | Detail |
|---|---|
| **Base URL** | `https://api.appfolio.com/api/v1/` (account-scoped) |
| **Data shape** | RESTful JSON. Pagination via `page` + `per_page`. |
| **Rate limits** | AppFolio-imposed (~60 req/min per credential set). Connector implements retry with exponential backoff on 429. |
| **Coverage** | Full — properties, leases, tenants, work orders, owner statements, journal entries, rent roll. |
| **Latency** | Real-time reads. No bulk export; paginate for large datasets. |
| **Write-back** | See §10 — depends on subscription tier. |

### 2.4 Subscription tier — the one open question

AppFolio offers two tiers relevant to API access:

| Tier | API Scope |
|---|---|
| **Plus** | Read-only — monitoring, reporting, dashboard population |
| **Max** | Read + write — full automation (update work order status, post journal entries, trigger workflows from our system back into AppFolio) |

> **TODO (pending Rob's answer):** Which tier does Paseo currently have?
> - **Plus → read-only connector.** Disable all write methods; throw `NotSupportedError` with a clear message. Sufficient for maintenance monitoring, leasing pipeline visibility, and financial reporting.
> - **Max → full read/write connector.** Enable write methods. Unlocks: closing work orders from our system, posting owner statement adjustments, automating rent roll updates.
>
> The interface is designed for both. When Rob's answer lands, set `APPFOLIO_WRITE_ENABLED=true|false` in secrets.env and implement the write methods (or leave them as stubs that throw `NotSupportedError`).

---

## 3. Connector Interface

The entire application codes against this interface. The implementation (live Stack API or mock) is injected at startup via the factory (§5).

```typescript
// src/connectors/appfolio/types.ts

export type WorkOrderStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';
export type LeaseStatus = 'active' | 'expired' | 'month_to_month' | 'notice_given' | 'pending';

export interface WorkOrder {
  id: string;
  propertyId: string;
  unit?: string;
  tenantId?: string;
  category: string;             // e.g. 'plumbing', 'electrical', 'hvac'
  description: string;
  status: WorkOrderStatus;
  priority: 'low' | 'normal' | 'urgent';
  createdAt: string;            // ISO 8601
  updatedAt: string;
  completedAt?: string;
  vendorId?: string;
  estimatedCost?: number;       // cents
  actualCost?: number;          // cents
}

export interface Tenant {
  id: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  leaseId: string;
  propertyId: string;
  unit?: string;
}

export interface Lease {
  id: string;
  propertyId: string;
  unit?: string;
  status: LeaseStatus;
  tenantIds: string[];
  startDate: string;            // YYYY-MM-DD
  endDate?: string;             // null for month-to-month
  monthlyRent: number;          // cents
  securityDeposit?: number;     // cents
  moveInDate?: string;
  moveOutDate?: string;
}

export interface RentRollEntry {
  propertyId: string;
  unit?: string;
  leaseId: string;
  tenantName: string;
  status: LeaseStatus;
  monthlyRent: number;          // cents
  balance: number;              // cents, positive = tenant owes
  lastPaymentDate?: string;
  leaseEnd?: string;
}

export interface OwnerStatement {
  ownerId: string;
  propertyId: string;
  periodStart: string;          // YYYY-MM-DD
  periodEnd: string;
  grossIncome: number;          // cents
  totalExpenses: number;        // cents
  managementFee: number;        // cents
  netOwnerDistribution: number; // cents
  lineItems: OwnerStatementLineItem[];
}

export interface OwnerStatementLineItem {
  date: string;
  description: string;
  amount: number;               // cents, negative = expense
  category: 'income' | 'expense' | 'fee' | 'adjustment';
}

export interface ListOptions {
  propertyId?: string;
  since?: string;               // ISO 8601 — filter by updatedAt
  limit?: number;
  offset?: number;
}

// The single interface callers use. Never import a concrete class directly.
export interface AppFolioConnector {
  // Health
  ping(): Promise<{ ok: boolean; latencyMs: number }>;

  // Maintenance
  listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]>;
  getWorkOrder(id: string): Promise<WorkOrder>;

  // Leasing
  listLeases(opts?: ListOptions): Promise<Lease[]>;
  getLease(id: string): Promise<Lease>;

  // Tenants
  listTenants(opts?: ListOptions): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant>;

  // Rent roll
  getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]>;

  // Owner financials
  getOwnerStatement(ownerId: string, periodStart: string, periodEnd: string): Promise<OwnerStatement>;
  listOwnerStatements(ownerId: string, opts?: ListOptions): Promise<OwnerStatement[]>;

  // Write methods — available on Max tier only.
  // On Plus tier: throw NotSupportedError('Requires AppFolio Max subscription').
  // TODO: implement once Rob confirms tier.
  updateWorkOrderStatus?(id: string, status: WorkOrderStatus, note?: string): Promise<WorkOrder>;
}

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}
```

---

## 4. Stack API Implementation (stub — fill in when credentials land)

```typescript
// src/connectors/appfolio/stack-api.connector.ts

import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions } from './types';
import { NotSupportedError } from './types';

interface StackApiConfig {
  clientId: string;
  clientSecret: string;
  accountId: string;
  baseUrl?: string;
  writeEnabled?: boolean;       // true = Max tier, false/absent = Plus tier
}

export class StackApiConnector implements AppFolioConnector {
  private readonly baseUrl: string;
  private token: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(private readonly config: StackApiConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.appfolio.com/api/v1';
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    // TODO: POST /oauth/token with client_credentials grant
    // Store token + expiry. Throw on auth failure.
    throw new Error('StackApiConnector.getToken: not yet implemented — awaiting credentials');
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const token = await this.getToken();
    // TODO: fetch with Authorization: Bearer, handle 429 (retry w/ backoff), pagination
    void token; void path; void params;
    throw new Error('StackApiConnector.get: not yet implemented');
  }

  private async patch<T>(path: string, body: unknown): Promise<T> {
    if (!this.config.writeEnabled) {
      throw new NotSupportedError('Requires AppFolio Max subscription (write-back not enabled)');
    }
    const token = await this.getToken();
    // TODO: PATCH with Authorization: Bearer
    void token; void path; void body;
    throw new Error('StackApiConnector.patch: not yet implemented');
  }

  async ping() { return { ok: false, latencyMs: 0 }; }
  async listWorkOrders(_opts?: ListOptions): Promise<WorkOrder[]> { throw new Error('not implemented'); }
  async getWorkOrder(_id: string): Promise<WorkOrder> { throw new Error('not implemented'); }
  async listLeases(_opts?: ListOptions): Promise<Lease[]> { throw new Error('not implemented'); }
  async getLease(_id: string): Promise<Lease> { throw new Error('not implemented'); }
  async listTenants(_opts?: ListOptions): Promise<Tenant[]> { throw new Error('not implemented'); }
  async getTenant(_id: string): Promise<Tenant> { throw new Error('not implemented'); }
  async getRentRoll(_opts?: { propertyId?: string }): Promise<RentRollEntry[]> { throw new Error('not implemented'); }
  async getOwnerStatement(_o: string, _s: string, _e: string): Promise<OwnerStatement> { throw new Error('not implemented'); }
  async listOwnerStatements(_o: string, _opts?: ListOptions): Promise<OwnerStatement[]> { throw new Error('not implemented'); }

  async updateWorkOrderStatus(id: string, status: WorkOrderStatus, note?: string): Promise<WorkOrder> {
    return this.patch(`/work_orders/${id}`, { status, note });
  }
}

// Import at call site to satisfy TS — remove when method is implemented
import type { WorkOrderStatus } from './types';
```

---

## 5. Factory — Path Selection at Startup

```typescript
// src/connectors/appfolio/index.ts

import type { AppFolioConnector } from './types';
import { StackApiConnector } from './stack-api.connector';
import { MockConnector } from './mock.connector';

export type ConnectorPath = 'stack-api' | 'mock';

export function createAppFolioConnector(path: ConnectorPath = 'mock'): AppFolioConnector {
  switch (path) {
    case 'stack-api':
      return new StackApiConnector({
        clientId: requireEnv('APPFOLIO_CLIENT_ID'),
        clientSecret: requireEnv('APPFOLIO_CLIENT_SECRET'),
        accountId: requireEnv('APPFOLIO_ACCOUNT_ID'),
        writeEnabled: process.env.APPFOLIO_WRITE_ENABLED === 'true',
      });
    case 'mock':
      return new MockConnector();
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export type { AppFolioConnector } from './types';
```

`APPFOLIO_CONNECTOR_PATH=stack-api` in staging/prod. Default (`mock`) requires no env vars — works out of the box in dev and CI.

---

## 6. Mock / Fixture Layer

Zero credentials, zero network. Used in dev and all unit/integration tests.

```typescript
// src/connectors/appfolio/mock.connector.ts

import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions, WorkOrderStatus } from './types';
import { FIXTURE_WORK_ORDERS, FIXTURE_LEASES, FIXTURE_TENANTS, FIXTURE_RENT_ROLL, FIXTURE_OWNER_STATEMENTS } from './fixtures';

export class MockConnector implements AppFolioConnector {
  async ping() { return { ok: true, latencyMs: 0 }; }

  async listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]> {
    return paginate(filter(FIXTURE_WORK_ORDERS, opts), opts);
  }
  async getWorkOrder(id: string): Promise<WorkOrder> {
    return findOrThrow(FIXTURE_WORK_ORDERS, id);
  }
  async listLeases(opts?: ListOptions): Promise<Lease[]> {
    return paginate(filter(FIXTURE_LEASES, opts), opts);
  }
  async getLease(id: string): Promise<Lease> {
    return findOrThrow(FIXTURE_LEASES, id);
  }
  async listTenants(opts?: ListOptions): Promise<Tenant[]> {
    return paginate(filter(FIXTURE_TENANTS, opts), opts);
  }
  async getTenant(id: string): Promise<Tenant> {
    return findOrThrow(FIXTURE_TENANTS, id);
  }
  async getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]> {
    if (opts?.propertyId) return FIXTURE_RENT_ROLL.filter(r => r.propertyId === opts.propertyId);
    return FIXTURE_RENT_ROLL;
  }
  async getOwnerStatement(ownerId: string, periodStart: string, _periodEnd: string): Promise<OwnerStatement> {
    const stmt = FIXTURE_OWNER_STATEMENTS.find(s => s.ownerId === ownerId && s.periodStart === periodStart);
    if (!stmt) throw new Error(`No fixture statement for owner ${ownerId} period ${periodStart}`);
    return stmt;
  }
  async listOwnerStatements(ownerId: string, _opts?: ListOptions): Promise<OwnerStatement[]> {
    return FIXTURE_OWNER_STATEMENTS.filter(s => s.ownerId === ownerId);
  }
  async updateWorkOrderStatus(id: string, status: WorkOrderStatus, _note?: string): Promise<WorkOrder> {
    const wo = await this.getWorkOrder(id);
    return { ...wo, status, updatedAt: new Date().toISOString() };
  }
}

function filter<T extends { propertyId?: string; updatedAt?: string }>(items: T[], opts?: ListOptions): T[] {
  let result = items;
  if (opts?.propertyId) result = result.filter(i => i.propertyId === opts.propertyId);
  if (opts?.since) result = result.filter(i => !i.updatedAt || i.updatedAt >= opts.since!);
  return result;
}

function paginate<T>(items: T[], opts?: ListOptions): T[] {
  const offset = opts?.offset ?? 0;
  const limit = opts?.limit ?? 100;
  return items.slice(offset, offset + limit);
}

function findOrThrow<T extends { id: string }>(items: T[], id: string): T {
  const item = items.find(i => i.id === id);
  if (!item) throw new Error(`Fixture not found: ${id}`);
  return item;
}
```

### 6.1 Fixture Data

Representative SF portfolio data covering all five entity types.

```typescript
// src/connectors/appfolio/fixtures.ts

import type { WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement } from './types';

export const FIXTURE_WORK_ORDERS: WorkOrder[] = [
  {
    id: 'wo-001',
    propertyId: 'prop-mission-101',
    unit: '3B',
    tenantId: 'tenant-001',
    category: 'plumbing',
    description: 'Kitchen faucet dripping — tenant reported 2026-06-20',
    status: 'open',
    priority: 'normal',
    createdAt: '2026-06-20T14:00:00Z',
    updatedAt: '2026-06-20T14:00:00Z',
    estimatedCost: 15000,
  },
  {
    id: 'wo-002',
    propertyId: 'prop-mission-101',
    unit: '1A',
    tenantId: 'tenant-002',
    category: 'hvac',
    description: 'AC not cooling — unit temp 85F, compressor running',
    status: 'in_progress',
    priority: 'urgent',
    createdAt: '2026-06-22T09:00:00Z',
    updatedAt: '2026-06-23T11:30:00Z',
    vendorId: 'vendor-cooltech',
    estimatedCost: 45000,
  },
  {
    id: 'wo-003',
    propertyId: 'prop-belvedere-200',
    unit: '12',
    category: 'electrical',
    description: 'Common area lighting — 3 bulbs out in hallway',
    status: 'completed',
    priority: 'low',
    createdAt: '2026-06-18T10:00:00Z',
    updatedAt: '2026-06-19T16:00:00Z',
    completedAt: '2026-06-19T16:00:00Z',
    actualCost: 8500,
  },
];

export const FIXTURE_TENANTS: Tenant[] = [
  {
    id: 'tenant-001',
    firstName: 'Maria',
    lastName: 'Gonzalez',
    email: 'mgonzalez@example.com',
    phone: '415-555-0101',
    leaseId: 'lease-001',
    propertyId: 'prop-mission-101',
    unit: '3B',
  },
  {
    id: 'tenant-002',
    firstName: 'James',
    lastName: 'Chen',
    email: 'jchen@example.com',
    phone: '415-555-0102',
    leaseId: 'lease-002',
    propertyId: 'prop-mission-101',
    unit: '1A',
  },
  {
    id: 'tenant-003',
    firstName: 'Priya',
    lastName: 'Sharma',
    email: 'psharma@example.com',
    phone: '415-555-0103',
    leaseId: 'lease-003',
    propertyId: 'prop-belvedere-200',
    unit: '12',
  },
];

export const FIXTURE_LEASES: Lease[] = [
  {
    id: 'lease-001',
    propertyId: 'prop-mission-101',
    unit: '3B',
    status: 'active',
    tenantIds: ['tenant-001'],
    startDate: '2025-09-01',
    endDate: '2026-08-31',
    monthlyRent: 285000,
    securityDeposit: 285000,
    moveInDate: '2025-09-01',
  },
  {
    id: 'lease-002',
    propertyId: 'prop-mission-101',
    unit: '1A',
    status: 'notice_given',
    tenantIds: ['tenant-002'],
    startDate: '2024-07-01',
    endDate: '2026-06-30',
    monthlyRent: 320000,
    securityDeposit: 320000,
    moveInDate: '2024-07-01',
    moveOutDate: '2026-06-30',
  },
  {
    id: 'lease-003',
    propertyId: 'prop-belvedere-200',
    unit: '12',
    status: 'month_to_month',
    tenantIds: ['tenant-003'],
    startDate: '2023-03-01',
    monthlyRent: 195000,
    securityDeposit: 195000,
    moveInDate: '2023-03-01',
  },
];

export const FIXTURE_RENT_ROLL: RentRollEntry[] = [
  {
    propertyId: 'prop-mission-101',
    unit: '3B',
    leaseId: 'lease-001',
    tenantName: 'Maria Gonzalez',
    status: 'active',
    monthlyRent: 285000,
    balance: 0,
    lastPaymentDate: '2026-06-01',
    leaseEnd: '2026-08-31',
  },
  {
    propertyId: 'prop-mission-101',
    unit: '1A',
    leaseId: 'lease-002',
    tenantName: 'James Chen',
    status: 'notice_given',
    monthlyRent: 320000,
    balance: 320000,            // one month outstanding
    lastPaymentDate: '2026-05-01',
    leaseEnd: '2026-06-30',
  },
  {
    propertyId: 'prop-belvedere-200',
    unit: '12',
    leaseId: 'lease-003',
    tenantName: 'Priya Sharma',
    status: 'month_to_month',
    monthlyRent: 195000,
    balance: 0,
    lastPaymentDate: '2026-06-01',
  },
];

export const FIXTURE_OWNER_STATEMENTS: OwnerStatement[] = [
  {
    ownerId: 'owner-legacy-001',
    propertyId: 'prop-mission-101',
    periodStart: '2026-06-01',
    periodEnd: '2026-06-30',
    grossIncome: 605000,
    totalExpenses: 68500,
    managementFee: 60500,
    netOwnerDistribution: 476000,
    lineItems: [
      { date: '2026-06-01', description: 'Rent — Unit 3B (Gonzalez)', amount: 285000, category: 'income' },
      { date: '2026-06-01', description: 'Rent — Unit 1A (Chen)', amount: 320000, category: 'income' },
      { date: '2026-06-20', description: 'Plumbing repair — Unit 3B', amount: -15000, category: 'expense' },
      { date: '2026-06-19', description: 'Electrical — hallway lighting', amount: -8500, category: 'expense' },
      { date: '2026-06-30', description: 'Management fee (10%)', amount: -60500, category: 'fee' },
      { date: '2026-06-30', description: 'HVAC repair — Unit 1A (est.)', amount: -45000, category: 'expense' },
    ],
  },
];
```

---

## 7. File Layout

```
src/connectors/appfolio/
  index.ts              — factory + re-exports (createAppFolioConnector)
  types.ts              — AppFolioConnector interface, entity types, NotSupportedError
  mock.connector.ts     — MockConnector (always available, no creds)
  fixtures.ts           — fixture data for mock + tests
  stack-api.connector.ts — StackApiConnector (implement when credentials land)
```

---

## 8. Environment Variables

| Variable | Required when | Notes |
|---|---|---|
| `APPFOLIO_CONNECTOR_PATH` | Always | `stack-api` or `mock` (default: `mock`) |
| `APPFOLIO_CLIENT_ID` | `path=stack-api` | From Developer Portal |
| `APPFOLIO_CLIENT_SECRET` | `path=stack-api` | From Developer Portal |
| `APPFOLIO_ACCOUNT_ID` | `path=stack-api` | AppFolio account subdomain |
| `APPFOLIO_WRITE_ENABLED` | `path=stack-api`, Max tier only | `true` enables write methods; omit or `false` for Plus/read-only |

In dev/CI: no env vars needed. `APPFOLIO_CONNECTOR_PATH` defaults to `mock`.

### 8.1 Credential provisioning (self-serve)

Rob provisions credentials directly:
1. Log into the AppFolio Developer Portal (login-gated — requires Rob's AppFolio credentials)
2. Create a new application → receive `client_id` + `client_secret`
3. Add to `orgs/paseo-pm/secrets.env` as `APPFOLIO_CLIENT_ID` and `APPFOLIO_CLIENT_SECRET`
4. Set `APPFOLIO_CONNECTOR_PATH=stack-api` and `APPFOLIO_WRITE_ENABLED=true|false` per tier
5. Restart the connector service

No partner approval, no AppFolio support ticket, no marketplace review.

---

## 9. Testing Strategy

- **Unit tests:** mock connector + fixtures. All workflow logic is testable today, zero credentials.
- **Integration tests:** tagged `@integration`, skipped in CI unless `APPFOLIO_CONNECTOR_PATH=stack-api` is set. Run manually before live release.
- **Contract tests:** once credentials land, a thin suite calling `ping()`, `listWorkOrders({ limit: 1 })`, `getRentRoll()` asserts response shape — catches API changes early.

---

## 10. Open Questions

| # | Question | Impact | Status |
|---|---|---|---|
| 1 | ~~Stack API or Skywalk?~~ | ~~Path selection~~ | **Resolved:** Stack Database API confirmed |
| 2 | ~~Does AppFolio support need to issue credentials?~~ | ~~Timeline~~ | **Resolved:** Self-serve via Developer Portal, no approval needed |
| 3 | Which subscription tier — Plus or Max? | Determines whether `APPFOLIO_WRITE_ENABLED=true`. Plus = read-only monitoring. Max = full read/write automation. | **OPEN — pending Rob's answer** |
| 4 | Which entities are highest priority? | Implementation order within the connector | Suggested default: work orders → leases/tenants → rent roll → owner financials |

---

## 11. Implementation Order (when credentials land)

1. Implement `ping()` + auth on `StackApiConnector` — verify credentials work end-to-end
2. `listWorkOrders` + `getWorkOrder` — unblocks maintenance coordination workflow
3. `listLeases` + `getLease` + `listTenants` — unblocks leasing pipeline
4. `getRentRoll` — unblocks delinquency visibility
5. `getOwnerStatement` + `listOwnerStatements` — unblocks owner comms automation
6. If Max tier: implement `updateWorkOrderStatus` and other write methods
7. Set `APPFOLIO_CONNECTOR_PATH=stack-api` in staging, run contract tests, confirm shape
8. Ship

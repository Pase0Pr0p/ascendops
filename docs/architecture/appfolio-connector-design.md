# AppFolio Connector — Design Document

**Status:** Draft  
**Author:** claudia  
**Branch:** feat/appfolio-connector-design  
**Created:** 2026-06-25  
**Decision pending:** Rob confirms access path at 9am PT 2026-06-25

---

## 1. Purpose

This document defines the design for the AppFolio data connector — the layer that gives Paseo's automation workflows access to portfolio data (leases, maintenance, rent roll, owner financials, tenants). The design is **path-agnostic**: a single abstract interface is defined once; the two candidate implementations (Stack API and Skywalk) slot in behind it. Callers never reference the access path.

Goal: when Rob confirms the path at 9am, implementation begins from a finished interface + fixtures, not a blank page.

---

## 2. Access Path Comparison

### 2.1 Stack API — AppFolio First-Party REST

AppFolio's native REST API, maintained by AppFolio Inc.

| Dimension | Detail |
|---|---|
| **Auth** | OAuth 2.0 client credentials flow. `client_id` + `client_secret` → bearer token. Tokens expire (typically 1h); connector handles refresh transparently. Credentials issued per AppFolio account by AppFolio support. |
| **Base URL** | `https://api.appfolio.com/api/v1/` (account-scoped) |
| **Data shape** | RESTful JSON. Resources: `properties`, `leases`, `tenants`, `work_orders`, `owner_statements`, `journal_entries`, `rent_roll`. Pagination via `page` + `per_page`. |
| **Rate limits** | AppFolio-imposed; typically 60 req/min per credential set. Connector must implement retry with exponential backoff. |
| **Coverage** | Full — all core PM entities. This is the source of truth. |
| **Latency** | Real-time reads. No bulk export endpoint; must paginate for large data sets. |
| **Credential complexity** | Low. Single OAuth credential set from AppFolio. |
| **Risk** | AppFolio can deprecate/version endpoints. We own the integration — our responsibility to track API changes. |

### 2.2 Skywalk — Third-Party Data Integration Layer

Skywalk is a middleware platform that aggregates property management data across multiple PM software providers, including AppFolio. Relevant when direct API access is unavailable or when multi-source normalization is needed.

| Dimension | Detail |
|---|---|
| **Auth** | API key (static, issued by Skywalk). Passed as `X-API-Key` header or equivalent. Simpler credential lifecycle than OAuth. |
| **Base URL** | Skywalk-issued endpoint (varies by account tier). |
| **Data shape** | Skywalk normalizes data into its own schema — not AppFolio's native shape. Fields map to PM industry standard but require translation to Paseo's internal model. |
| **Rate limits** | Skywalk-imposed per subscription tier. Generally more generous than direct API due to Skywalk's own caching layer. |
| **Coverage** | Depends on Skywalk's AppFolio adapter. Core entities (leases, rent roll, work orders) covered. Owner financials coverage varies by tier. |
| **Latency** | Skywalk caches AppFolio data; reads may be up to 15 min stale. Not suitable for real-time write-back. |
| **Credential complexity** | Low (static key), but adds Skywalk as a vendor dependency. |
| **Risk** | Double dependency (AppFolio + Skywalk). Skywalk schema changes break our translation layer. Vendor lock-in to Skywalk's pricing. |

### 2.3 Path Recommendation (for Rob's decision)

Stack API is the primary recommendation:
- Direct, real-time, full-coverage
- No vendor intermediary
- Lower ongoing cost at scale
- Aligns with AppFolio's own support path

Skywalk is the fallback if AppFolio credential issuance is blocked or takes too long. Once Stack API credentials land, migrating from Skywalk to Stack API requires only swapping the concrete implementation — callers are unchanged.

---

## 3. Connector Interface

The entire application codes against this interface. The concrete implementation (Stack API or Skywalk) is injected at startup.

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
}
```

---

## 4. Concrete Implementations (stubs — fill in when path confirmed)

### 4.1 Stack API Implementation

```typescript
// src/connectors/appfolio/stack-api.connector.ts

import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions } from './types';

interface StackApiConfig {
  clientId: string;
  clientSecret: string;
  accountId: string;            // AppFolio account subdomain
  baseUrl?: string;             // defaults to https://api.appfolio.com/api/v1
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
    throw new Error('StackApiConnector.getToken: not yet implemented');
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const token = await this.getToken();
    // TODO: fetch with Authorization: Bearer, handle rate limit (429 + retry), pagination
    void token; void path; void params;
    throw new Error('StackApiConnector.get: not yet implemented');
  }

  async ping() { return { ok: false, latencyMs: 0 }; }
  async listWorkOrders(_opts?: ListOptions): Promise<WorkOrder[]> { throw new Error('not implemented'); }
  async getWorkOrder(_id: string): Promise<WorkOrder> { throw new Error('not implemented'); }
  async listLeases(_opts?: ListOptions): Promise<Lease[]> { throw new Error('not implemented'); }
  async getLease(_id: string): Promise<Lease> { throw new Error('not implemented'); }
  async listTenants(_opts?: ListOptions): Promise<Tenant[]> { throw new Error('not implemented'); }
  async getTenant(_id: string): Promise<Tenant> { throw new Error('not implemented'); }
  async getRentRoll(_opts?: { propertyId?: string }): Promise<RentRollEntry[]> { throw new Error('not implemented'); }
  async getOwnerStatement(_ownerId: string, _start: string, _end: string): Promise<OwnerStatement> { throw new Error('not implemented'); }
  async listOwnerStatements(_ownerId: string, _opts?: ListOptions): Promise<OwnerStatement[]> { throw new Error('not implemented'); }
}
```

### 4.2 Skywalk Implementation

```typescript
// src/connectors/appfolio/skywalk.connector.ts

import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions } from './types';

interface SkywalkConfig {
  apiKey: string;
  baseUrl: string;              // Skywalk-issued, account-specific
}

export class SkywalkConnector implements AppFolioConnector {
  constructor(private readonly config: SkywalkConfig) {}

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    // TODO: fetch with X-API-Key header, map Skywalk schema to internal types
    void path; void params;
    throw new Error('SkywalkConnector.get: not yet implemented');
  }

  // Same method stubs as StackApiConnector — Skywalk schema translation happens here.
  // The translation layer is the only difference from the caller's perspective.

  async ping() { return { ok: false, latencyMs: 0 }; }
  async listWorkOrders(_opts?: ListOptions): Promise<WorkOrder[]> { throw new Error('not implemented'); }
  async getWorkOrder(_id: string): Promise<WorkOrder> { throw new Error('not implemented'); }
  async listLeases(_opts?: ListOptions): Promise<Lease[]> { throw new Error('not implemented'); }
  async getLease(_id: string): Promise<Lease> { throw new Error('not implemented'); }
  async listTenants(_opts?: ListOptions): Promise<Tenant[]> { throw new Error('not implemented'); }
  async getTenant(_id: string): Promise<Tenant> { throw new Error('not implemented'); }
  async getRentRoll(_opts?: { propertyId?: string }): Promise<RentRollEntry[]> { throw new Error('not implemented'); }
  async getOwnerStatement(_ownerId: string, _start: string, _end: string): Promise<OwnerStatement> { throw new Error('not implemented'); }
  async listOwnerStatements(_ownerId: string, _opts?: ListOptions): Promise<OwnerStatement[]> { throw new Error('not implemented'); }
}
```

---

## 5. Factory — Path Selection at Startup

```typescript
// src/connectors/appfolio/index.ts

import type { AppFolioConnector } from './types';
import { StackApiConnector } from './stack-api.connector';
import { SkywalkConnector } from './skywalk.connector';
import { MockConnector } from './mock.connector';

export type ConnectorPath = 'stack-api' | 'skywalk' | 'mock';

export function createAppFolioConnector(path: ConnectorPath): AppFolioConnector {
  switch (path) {
    case 'stack-api':
      return new StackApiConnector({
        clientId: requireEnv('APPFOLIO_CLIENT_ID'),
        clientSecret: requireEnv('APPFOLIO_CLIENT_SECRET'),
        accountId: requireEnv('APPFOLIO_ACCOUNT_ID'),
      });
    case 'skywalk':
      return new SkywalkConnector({
        apiKey: requireEnv('SKYWALK_API_KEY'),
        baseUrl: requireEnv('SKYWALK_BASE_URL'),
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

Env var to control path: `APPFOLIO_CONNECTOR_PATH=stack-api|skywalk|mock` (default: `mock` in dev/test).

---

## 6. Mock / Fixture Layer

The mock connector ships representative fixture data for every entity. Zero credentials, zero network. Used in dev and all unit/integration tests.

```typescript
// src/connectors/appfolio/mock.connector.ts

import type { AppFolioConnector, WorkOrder, Lease, Tenant, RentRollEntry, OwnerStatement, ListOptions } from './types';
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

Representative data for a 550-door SF portfolio. Enough coverage to exercise all workflows.

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
    estimatedCost: 15000,       // $150.00
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
    estimatedCost: 45000,       // $450.00
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
    actualCost: 8500,           // $85.00
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
    monthlyRent: 285000,        // $2,850.00
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
    monthlyRent: 320000,        // $3,200.00
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
    monthlyRent: 195000,        // $1,950.00
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
    grossIncome: 605000,        // $6,050.00 (two units paid)
    totalExpenses: 68500,       // $685.00 (wo-001 estimate + common area)
    managementFee: 60500,       // 10% of gross
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
  types.ts              — AppFolioConnector interface + all entity types
  mock.connector.ts     — MockConnector (always available, no creds)
  fixtures.ts           — fixture data for mock
  stack-api.connector.ts — StackApiConnector (implement when path confirmed)
  skywalk.connector.ts   — SkywalkConnector (implement if Stack API blocked)
```

---

## 8. Environment Variables

| Variable | Used by | Required when |
|---|---|---|
| `APPFOLIO_CONNECTOR_PATH` | Factory | Always (defaults to `mock`) |
| `APPFOLIO_CLIENT_ID` | StackApiConnector | `path=stack-api` |
| `APPFOLIO_CLIENT_SECRET` | StackApiConnector | `path=stack-api` |
| `APPFOLIO_ACCOUNT_ID` | StackApiConnector | `path=stack-api` |
| `SKYWALK_API_KEY` | SkywalkConnector | `path=skywalk` |
| `SKYWALK_BASE_URL` | SkywalkConnector | `path=skywalk` |

In dev/test: set `APPFOLIO_CONNECTOR_PATH=mock`. No other env vars needed.

---

## 9. Testing Strategy

- **Unit tests:** mock connector + fixtures cover all workflow logic. 100% of business logic is testable without credentials.
- **Integration tests:** tagged `@integration`, skipped in CI unless `APPFOLIO_CONNECTOR_PATH` is set to a live path. Run manually before release.
- **Contract tests:** once a live path is confirmed, add a thin suite that calls `ping()`, `listWorkOrders({ limit: 1 })`, `getRentRoll()` and asserts shape — catches API changes early.

---

## 10. Open Questions (for Rob, 9am PT)

| # | Question | Impact |
|---|---|---|
| 1 | Stack API or Skywalk? | Determines which concrete class to implement first |
| 2 | Does AppFolio support already have Stack API credentials for Paseo's account? | If yes, Stack API path can start immediately |
| 3 | Is Skywalk already contracted/paid for? | Changes cost calculus on fallback path |
| 4 | Write-back required? (e.g. update work order status from our system into AppFolio) | Both paths support reads; write-back scope affects interface |
| 5 | Which entities are highest priority? (maintenance? leasing? financials?) | Determines implementation order within the chosen path |

---

## 11. Implementation Order (once path confirmed)

1. Implement `ping()` + auth on chosen connector — verify credentials work
2. `listWorkOrders` + `getWorkOrder` — maintenance workflow unblocked
3. `listLeases` + `getLease` + `listTenants` — leasing pipeline unblocked
4. `getRentRoll` — delinquency visibility
5. `getOwnerStatement` + `listOwnerStatements` — owner comms unblocked
6. Swap `APPFOLIO_CONNECTOR_PATH` from `mock` to live path in staging env
7. Run contract tests, confirm shape matches, ship

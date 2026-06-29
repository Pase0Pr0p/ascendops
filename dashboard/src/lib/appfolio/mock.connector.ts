import type {
  AppFolioConnector,
  WorkOrder,
  Lease,
  Tenant,
  RentRollEntry,
  OwnerStatement,
  ListOptions,
} from './types';
import {
  FIXTURE_WORK_ORDERS,
  FIXTURE_LEASES,
  FIXTURE_TENANTS,
  FIXTURE_RENT_ROLL,
  FIXTURE_OWNER_STATEMENTS,
} from './fixtures';

export class MockConnector implements AppFolioConnector {
  readonly isDemo = true;
  async ping() { return { ok: true, latencyMs: 0 }; }

  async listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]> {
    return paginate(filterByProperty(FIXTURE_WORK_ORDERS, opts), opts);
  }

  async getWorkOrder(id: string): Promise<WorkOrder> {
    return findOrThrow(FIXTURE_WORK_ORDERS, id);
  }

  async listLeases(opts?: ListOptions): Promise<Lease[]> {
    return paginate(filterByProperty(FIXTURE_LEASES, opts), opts);
  }

  async getLease(id: string): Promise<Lease> {
    return findOrThrow(FIXTURE_LEASES, id);
  }

  async listTenants(opts?: ListOptions): Promise<Tenant[]> {
    return paginate(filterByProperty(FIXTURE_TENANTS, opts), opts);
  }

  async getTenant(id: string): Promise<Tenant> {
    return findOrThrow(FIXTURE_TENANTS, id);
  }

  async getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]> {
    if (opts?.propertyId) {
      return FIXTURE_RENT_ROLL.filter(r => r.propertyId === opts.propertyId);
    }
    return [...FIXTURE_RENT_ROLL];
  }

  async getOwnerStatement(
    ownerId: string,
    periodStart: string,
    _periodEnd: string,
  ): Promise<OwnerStatement> {
    const stmt = FIXTURE_OWNER_STATEMENTS.find(
      s => s.ownerId === ownerId && s.periodStart === periodStart,
    );
    if (!stmt) throw new Error(`No fixture statement for owner ${ownerId} period ${periodStart}`);
    return stmt;
  }

  async listOwnerStatements(ownerId: string, _opts?: ListOptions): Promise<OwnerStatement[]> {
    return FIXTURE_OWNER_STATEMENTS.filter(s => s.ownerId === ownerId);
  }
}

function filterByProperty<T extends { propertyId?: string }>(items: T[], opts?: ListOptions): T[] {
  if (!opts?.propertyId) return items;
  return items.filter(i => i.propertyId === opts.propertyId);
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

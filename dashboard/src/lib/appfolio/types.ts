// AppFolio connector interface + entity types.
// The entire app codes against this interface; implementation (mock or live) is injected by the factory.

export type WorkOrderStatus = 'open' | 'in_progress' | 'completed' | 'cancelled';
export type LeaseStatus = 'active' | 'expired' | 'month_to_month' | 'notice_given' | 'pending';
export type BillStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'voided';

export interface WorkOrder {
  id: string;
  propertyId: string;
  unit?: string;
  tenantId?: string;
  category: string;
  description: string;
  status: WorkOrderStatus;
  priority: 'low' | 'normal' | 'urgent';
  createdAt: string;   // ISO 8601
  updatedAt: string;
  completedAt?: string;
  vendorId?: string;
  estimatedCost?: number;  // cents
  actualCost?: number;     // cents
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
  startDate: string;    // YYYY-MM-DD
  endDate?: string;
  monthlyRent: number;  // cents
  securityDeposit?: number;
  moveInDate?: string;
  moveOutDate?: string;
}

export interface RentRollEntry {
  propertyId: string;
  unit?: string;
  leaseId: string;
  tenantName: string;
  status: LeaseStatus;
  monthlyRent: number;  // cents
  balance: number;      // cents, positive = tenant owes
  lastPaymentDate?: string;
  leaseEnd?: string;
}

export interface OwnerStatementLineItem {
  date: string;
  description: string;
  amount: number;  // cents, negative = expense
  category: 'income' | 'expense' | 'fee' | 'adjustment';
}

export interface OwnerStatement {
  ownerId: string;
  propertyId: string;
  periodStart: string;
  periodEnd: string;
  grossIncome: number;
  totalExpenses: number;
  managementFee: number;
  netOwnerDistribution: number;
  lineItems: OwnerStatementLineItem[];
}

export interface ListOptions {
  propertyId?: string;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface AppFolioConnector {
  readonly isDemo: boolean;
  ping(): Promise<{ ok: boolean; latencyMs: number }>;
  listWorkOrders(opts?: ListOptions): Promise<WorkOrder[]>;
  getWorkOrder(id: string): Promise<WorkOrder>;
  listLeases(opts?: ListOptions): Promise<Lease[]>;
  getLease(id: string): Promise<Lease>;
  listTenants(opts?: ListOptions): Promise<Tenant[]>;
  getTenant(id: string): Promise<Tenant>;
  getRentRoll(opts?: { propertyId?: string }): Promise<RentRollEntry[]>;
  getOwnerStatement(ownerId: string, periodStart: string, periodEnd: string): Promise<OwnerStatement>;
  listOwnerStatements(ownerId: string, opts?: ListOptions): Promise<OwnerStatement[]>;
}

export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NotSupportedError';
  }
}

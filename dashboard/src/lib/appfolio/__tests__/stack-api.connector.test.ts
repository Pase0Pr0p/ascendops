/**
 * Unit tests for StackApiConnector mapping functions + parseCents.
 * No network calls — all tests are pure function assertions.
 * The mapping functions (mapWorkOrder, mapLease, etc.) are the layer most
 * likely to need tweaks after live-API validation; keeping them separately
 * testable makes reconciliation fast.
 */

import { describe, it, expect } from 'vitest';
import {
  parseCents,
  mapWorkOrderStatus,
  mapPriority,
  mapLeaseStatus,
  mapOwnerStatementCategory,
  mapWorkOrder,
  mapLease,
  mapTenant,
  mapRentRollRow,
} from '../stack-api.connector';

// ---------------------------------------------------------------------------
// parseCents
// ---------------------------------------------------------------------------

describe('parseCents', () => {
  it('parses plain dollar string', () => {
    expect(parseCents('1500.00')).toBe(150000);
  });

  it('parses negative dollar string (expense)', () => {
    expect(parseCents('-150.00')).toBe(-15000);
  });

  it('parses string with $ and comma', () => {
    expect(parseCents('$2,850.00')).toBe(285000);
  });

  it('returns 0 for undefined', () => {
    expect(parseCents(undefined)).toBe(0);
  });

  it('returns 0 for null', () => {
    expect(parseCents(null)).toBe(0);
  });

  it('returns 0 for empty string', () => {
    expect(parseCents('')).toBe(0);
  });

  it('handles fractional cents via rounding', () => {
    expect(parseCents('1500.005')).toBe(150001);
  });
});

// ---------------------------------------------------------------------------
// mapWorkOrderStatus
// ---------------------------------------------------------------------------

describe('mapWorkOrderStatus', () => {
  it('maps code 4 to completed', () => {
    expect(mapWorkOrderStatus(['4'])).toBe('completed');
  });

  it('maps code 7 (CompletedNoBill) to completed', () => {
    expect(mapWorkOrderStatus(['7'])).toBe('completed');
  });

  it('maps code 5 to cancelled', () => {
    expect(mapWorkOrderStatus(['5'])).toBe('cancelled');
  });

  it('maps code 9 (Assigned) to in_progress', () => {
    expect(mapWorkOrderStatus(['9'])).toBe('in_progress');
  });

  it('maps code 3 (Scheduled) to in_progress', () => {
    expect(mapWorkOrderStatus(['3'])).toBe('in_progress');
  });

  it('maps code 8 (Work Done) to in_progress', () => {
    expect(mapWorkOrderStatus(['8'])).toBe('in_progress');
  });

  it('maps code 0 (New) to open', () => {
    expect(mapWorkOrderStatus(['0'])).toBe('open');
  });

  it('maps unknown code to open', () => {
    expect(mapWorkOrderStatus(['99'])).toBe('open');
  });

  it('maps undefined to open', () => {
    expect(mapWorkOrderStatus(undefined)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// mapPriority
// ---------------------------------------------------------------------------

describe('mapPriority', () => {
  it('maps Urgent to urgent', () => {
    expect(mapPriority('Urgent')).toBe('urgent');
  });

  it('maps Emergency to urgent', () => {
    expect(mapPriority('Emergency')).toBe('urgent');
  });

  it('maps Low to low', () => {
    expect(mapPriority('Low')).toBe('low');
  });

  it('maps Normal to normal', () => {
    expect(mapPriority('Normal')).toBe('normal');
  });

  it('maps undefined to normal', () => {
    expect(mapPriority(undefined)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// mapLeaseStatus
// ---------------------------------------------------------------------------

describe('mapLeaseStatus', () => {
  it('maps Active to active', () => {
    expect(mapLeaseStatus('Active')).toBe('active');
  });

  it('maps MonthToMonth to month_to_month', () => {
    expect(mapLeaseStatus('MonthToMonth')).toBe('month_to_month');
  });

  it('maps NoticeGiven to notice_given', () => {
    expect(mapLeaseStatus('NoticeGiven')).toBe('notice_given');
  });

  it('maps Past to expired', () => {
    expect(mapLeaseStatus('Past')).toBe('expired');
  });

  it('maps Expired to expired', () => {
    expect(mapLeaseStatus('Expired')).toBe('expired');
  });

  it('maps Future to pending', () => {
    expect(mapLeaseStatus('Future')).toBe('pending');
  });

  it('maps undefined to active (safe default)', () => {
    expect(mapLeaseStatus(undefined)).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// mapOwnerStatementCategory
// ---------------------------------------------------------------------------

describe('mapOwnerStatementCategory', () => {
  it('categorises management fee as fee', () => {
    expect(mapOwnerStatementCategory('Management Fee (10%)', -6050)).toBe('fee');
  });

  it('categorises negative amounts as expense', () => {
    expect(mapOwnerStatementCategory('Plumbing repair', -15000)).toBe('expense');
  });

  it('categorises positive amounts as income', () => {
    expect(mapOwnerStatementCategory('Rental Income', 285000)).toBe('income');
  });

  it('categorises adjustment by name', () => {
    expect(mapOwnerStatementCategory('Balance Adjustment', 0)).toBe('adjustment');
  });
});

// ---------------------------------------------------------------------------
// mapWorkOrder
// ---------------------------------------------------------------------------

describe('mapWorkOrder', () => {
  const raw = {
    Id: 'wo-af-001',
    PropertyId: 'prop-101',
    UnitId: '3B',
    OccupancyId: 'occ-001',
    ServiceArea: 'Plumbing',
    JobDescription: 'Kitchen faucet dripping',
    Statuses: ['0'],           // New
    Priority: 'Normal',
    CreatedAt: '2026-06-20T14:00:00Z',
    LastUpdatedAt: '2026-06-20T14:00:00Z',
    EstimatedCost: '150.00',
  };

  it('maps id, propertyId, unit, description', () => {
    const wo = mapWorkOrder(raw);
    expect(wo.id).toBe('wo-af-001');
    expect(wo.propertyId).toBe('prop-101');
    expect(wo.unit).toBe('3B');
    expect(wo.description).toBe('Kitchen faucet dripping');
  });

  it('maps tenantId from OccupancyId', () => {
    expect(mapWorkOrder(raw).tenantId).toBe('occ-001');
  });

  it('maps category from ServiceArea', () => {
    expect(mapWorkOrder(raw).category).toBe('Plumbing');
  });

  it('maps status from Statuses array', () => {
    expect(mapWorkOrder(raw).status).toBe('open');
  });

  it('maps estimatedCost to cents', () => {
    expect(mapWorkOrder(raw).estimatedCost).toBe(15000);
  });

  it('maps completed work order', () => {
    const wo = mapWorkOrder({ ...raw, Statuses: ['4'], CompletedAt: '2026-06-21T10:00:00Z' });
    expect(wo.status).toBe('completed');
    expect(wo.completedAt).toBe('2026-06-21T10:00:00Z');
  });

  it('uses general as fallback category when ServiceArea absent', () => {
    const wo = mapWorkOrder({ ...raw, ServiceArea: undefined });
    expect(wo.category).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// mapLease (from AfOccupancy)
// ---------------------------------------------------------------------------

describe('mapLease', () => {
  const raw = {
    Id: 'occ-001',
    PropertyId: 'prop-101',
    UnitId: '3B',
    Status: 'Active',
    LeaseStartDate: '2025-09-01',
    LeaseEndDate: '2026-08-31',
    Rent: '2850.00',
    SecurityDeposit: '2850.00',
    MoveInDate: '2025-09-01',
    Tenants: [{ Id: 'tenant-001', FirstName: 'Maria', LastName: 'Gonzalez',
      OccupancyId: 'occ-001', PropertyId: 'prop-101', UnitId: '3B' }],
  };

  it('maps occupancy id to lease id', () => {
    expect(mapLease(raw).id).toBe('occ-001');
  });

  it('maps status Active to active', () => {
    expect(mapLease(raw).status).toBe('active');
  });

  it('collects tenant ids from nested Tenants', () => {
    expect(mapLease(raw).tenantIds).toEqual(['tenant-001']);
  });

  it('maps rent string to monthly rent in cents', () => {
    expect(mapLease(raw).monthlyRent).toBe(285000);
  });

  it('maps security deposit to cents', () => {
    expect(mapLease(raw).securityDeposit).toBe(285000);
  });

  it('maps dates directly', () => {
    const lease = mapLease(raw);
    expect(lease.startDate).toBe('2025-09-01');
    expect(lease.endDate).toBe('2026-08-31');
  });

  it('handles missing optional fields', () => {
    const lease = mapLease({ Id: 'occ-002', PropertyId: 'prop-102', Tenants: [] });
    expect(lease.tenantIds).toEqual([]);
    expect(lease.monthlyRent).toBe(0);
    expect(lease.securityDeposit).toBeUndefined();
    expect(lease.endDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapTenant (from AfTenant + parent AfOccupancy)
// ---------------------------------------------------------------------------

describe('mapTenant', () => {
  const occ = { Id: 'occ-001', PropertyId: 'prop-101', UnitId: '3B', Tenants: [] };
  const raw = {
    Id: 'tenant-001',
    FirstName: 'Maria',
    LastName: 'Gonzalez',
    Email: 'mgonzalez@example.com',
    PhoneNumber: '415-555-0101',
    OccupancyId: 'occ-001',
    PropertyId: 'prop-101',
    UnitId: '3B',
  };

  it('maps id, firstName, lastName', () => {
    const t = mapTenant(raw, occ);
    expect(t.id).toBe('tenant-001');
    expect(t.firstName).toBe('Maria');
    expect(t.lastName).toBe('Gonzalez');
  });

  it('maps leaseId from parent occupancy id', () => {
    expect(mapTenant(raw, occ).leaseId).toBe('occ-001');
  });

  it('maps email and phone', () => {
    const t = mapTenant(raw, occ);
    expect(t.email).toBe('mgonzalez@example.com');
    expect(t.phone).toBe('415-555-0101');
  });

  it('falls back to occupancy propertyId when tenant has no PropertyId', () => {
    const t = mapTenant({ ...raw, PropertyId: undefined }, occ);
    expect(t.propertyId).toBe('prop-101');
  });
});

// ---------------------------------------------------------------------------
// mapRentRollRow
// ---------------------------------------------------------------------------

describe('mapRentRollRow', () => {
  const raw = {
    property_id: 'prop-101',
    unit_id: '3B',
    occupancy_id: 'occ-001',
    tenant_name: 'Maria Gonzalez',
    lease_status: 'Active',
    rent_amount: '2850.00',
    balance: '0.00',
    last_payment_date: '2026-06-01',
    lease_end_date: '2026-08-31',
  };

  it('maps all fields', () => {
    const r = mapRentRollRow(raw);
    expect(r.propertyId).toBe('prop-101');
    expect(r.unit).toBe('3B');
    expect(r.leaseId).toBe('occ-001');
    expect(r.tenantName).toBe('Maria Gonzalez');
    expect(r.status).toBe('active');
    expect(r.monthlyRent).toBe(285000);
    expect(r.balance).toBe(0);
    expect(r.lastPaymentDate).toBe('2026-06-01');
    expect(r.leaseEnd).toBe('2026-08-31');
  });

  it('maps positive balance (tenant owes) to positive cents', () => {
    const r = mapRentRollRow({ ...raw, balance: '3200.00' });
    expect(r.balance).toBe(320000);
  });

  it('handles missing optional fields', () => {
    const r = mapRentRollRow({ property_id: 'prop-102' });
    expect(r.propertyId).toBe('prop-102');
    expect(r.monthlyRent).toBe(0);
    expect(r.balance).toBe(0);
    expect(r.leaseId).toBe('');
  });
});

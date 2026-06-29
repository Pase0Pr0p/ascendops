/**
 * Unit tests for StackApiConnector mapping functions.
 * No network calls — pure function assertions only.
 * Field names match confirmed live AppFolio API (2026-06-29 probe).
 */

import { describe, it, expect } from 'vitest';
import {
  parseCents,
  mapWorkOrderStatus,
  mapPriority,
  mapLeaseStatus,
  mapOwnerStatementCategory,
  mapWorkOrderRow,
  mapRentRollRowToLease,
  mapTenantRow,
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

  it('accepts numeric input directly', () => {
    expect(parseCents(29.99)).toBe(2999);
  });
});

// ---------------------------------------------------------------------------
// mapWorkOrderStatus — live API uses text strings, not numeric codes
// ---------------------------------------------------------------------------

describe('mapWorkOrderStatus', () => {
  it('maps "Completed" to completed', () => {
    expect(mapWorkOrderStatus('Completed')).toBe('completed');
  });

  it('maps "Ready to Bill" to completed', () => {
    expect(mapWorkOrderStatus('Ready to Bill')).toBe('completed');
  });

  it('maps "Canceled" to cancelled', () => {
    expect(mapWorkOrderStatus('Canceled')).toBe('cancelled');
  });

  it('maps "Cancelled" (British spelling) to cancelled', () => {
    expect(mapWorkOrderStatus('Cancelled')).toBe('cancelled');
  });

  it('maps "Assigned" to in_progress', () => {
    expect(mapWorkOrderStatus('Assigned')).toBe('in_progress');
  });

  it('maps "Scheduled" to in_progress', () => {
    expect(mapWorkOrderStatus('Scheduled')).toBe('in_progress');
  });

  it('maps "Work Done" to in_progress', () => {
    expect(mapWorkOrderStatus('Work Done')).toBe('in_progress');
  });

  it('maps "Waiting" to in_progress', () => {
    expect(mapWorkOrderStatus('Waiting')).toBe('in_progress');
  });

  it('maps "New" to open', () => {
    expect(mapWorkOrderStatus('New')).toBe('open');
  });

  it('maps unknown string to open', () => {
    expect(mapWorkOrderStatus('SomeUnknownStatus')).toBe('open');
  });

  it('maps undefined to open', () => {
    expect(mapWorkOrderStatus(undefined)).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// mapPriority
// ---------------------------------------------------------------------------

describe('mapPriority', () => {
  it('maps "Urgent" to urgent', () => {
    expect(mapPriority('Urgent')).toBe('urgent');
  });

  it('maps "Emergency" to urgent', () => {
    expect(mapPriority('Emergency')).toBe('urgent');
  });

  it('maps "Low" to low', () => {
    expect(mapPriority('Low')).toBe('low');
  });

  it('maps "Normal" to normal', () => {
    expect(mapPriority('Normal')).toBe('normal');
  });

  it('maps undefined to normal', () => {
    expect(mapPriority(undefined)).toBe('normal');
  });
});

// ---------------------------------------------------------------------------
// mapLeaseStatus — live API values confirmed: "Current", "Vacating", "Notice", "Past", "Future"
// ---------------------------------------------------------------------------

describe('mapLeaseStatus', () => {
  it('maps "Current" to active', () => {
    expect(mapLeaseStatus('Current')).toBe('active');
  });

  it('maps "Vacating" to month_to_month', () => {
    expect(mapLeaseStatus('Vacating')).toBe('month_to_month');
  });

  it('maps "Notice" to notice_given', () => {
    expect(mapLeaseStatus('Notice')).toBe('notice_given');
  });

  it('maps "Past" to expired', () => {
    expect(mapLeaseStatus('Past')).toBe('expired');
  });

  it('maps "Expired" to expired', () => {
    expect(mapLeaseStatus('Expired')).toBe('expired');
  });

  it('maps "Future" to pending', () => {
    expect(mapLeaseStatus('Future')).toBe('pending');
  });

  it('maps undefined to active (safe default)', () => {
    expect(mapLeaseStatus(undefined)).toBe('active');
  });

  it('is case-insensitive', () => {
    expect(mapLeaseStatus('current')).toBe('active');
    expect(mapLeaseStatus('PAST')).toBe('expired');
  });
});

// ---------------------------------------------------------------------------
// mapOwnerStatementCategory
// ---------------------------------------------------------------------------

describe('mapOwnerStatementCategory', () => {
  it('categorises management fee as fee', () => {
    expect(mapOwnerStatementCategory('Management Fee (10%)', -6050)).toBe('fee');
  });

  it('categorises mgmt fee as fee', () => {
    expect(mapOwnerStatementCategory('Mgmt Fee', -5000)).toBe('fee');
  });

  it('categorises negative expense amounts as expense', () => {
    expect(mapOwnerStatementCategory('Plumbing Repair', -15000)).toBe('expense');
  });

  it('categorises positive amounts as income', () => {
    expect(mapOwnerStatementCategory('Rental Income', 285000)).toBe('income');
  });

  it('categorises adjustment by name', () => {
    expect(mapOwnerStatementCategory('Balance Adjustment', 0)).toBe('adjustment');
  });
});

// ---------------------------------------------------------------------------
// mapWorkOrderRow — live snake_case fields from work_order.json
// ---------------------------------------------------------------------------

describe('mapWorkOrderRow', () => {
  const raw = {
    work_order_id: 12345,
    property_id: 101,
    unit_id: 202,
    unit_name: '3B',
    occupancy_id: 999,
    job_description: 'Kitchen faucet dripping',
    vendor_trade: 'Plumbing',
    status: 'New',
    priority: 'Normal',
    created_at: '2026-06-20T14:00:00Z',
    estimate_amount: '150.00',
  };

  it('maps work_order_id to string id', () => {
    expect(mapWorkOrderRow(raw).id).toBe('12345');
  });

  it('maps property_id to string propertyId', () => {
    expect(mapWorkOrderRow(raw).propertyId).toBe('101');
  });

  it('maps unit_name to unit', () => {
    expect(mapWorkOrderRow(raw).unit).toBe('3B');
  });

  it('maps job_description to description', () => {
    expect(mapWorkOrderRow(raw).description).toBe('Kitchen faucet dripping');
  });

  it('maps vendor_trade to category', () => {
    expect(mapWorkOrderRow(raw).category).toBe('Plumbing');
  });

  it('maps occupancy_id to string tenantId', () => {
    expect(mapWorkOrderRow(raw).tenantId).toBe('999');
  });

  it('maps "New" status to open', () => {
    expect(mapWorkOrderRow(raw).status).toBe('open');
  });

  it('maps "Completed" status to completed', () => {
    const wo = mapWorkOrderRow({ ...raw, status: 'Completed', completed_on: '2026-06-21T10:00:00Z' });
    expect(wo.status).toBe('completed');
    expect(wo.completedAt).toBe('2026-06-21T10:00:00Z');
  });

  it('converts estimate_amount string to integer cents', () => {
    expect(mapWorkOrderRow(raw).estimatedCost).toBe(15000);
  });

  it('falls back to work_order_issue when vendor_trade absent', () => {
    const wo = mapWorkOrderRow({ ...raw, vendor_trade: undefined, work_order_issue: 'HVAC' });
    expect(wo.category).toBe('HVAC');
  });

  it('falls back to "general" when both category fields absent', () => {
    const wo = mapWorkOrderRow({ ...raw, vendor_trade: undefined, work_order_issue: undefined });
    expect(wo.category).toBe('general');
  });
});

// ---------------------------------------------------------------------------
// mapRentRollRowToLease — live snake_case fields from rent_roll.json
// ---------------------------------------------------------------------------

describe('mapRentRollRowToLease', () => {
  const raw = {
    occupancy_id: 999,
    unit_id: 202,
    property_id: 101,
    unit: '3B',
    tenant: 'Maria Gonzalez',
    tenant_id: 500,
    status: 'Current',
    rent: '2850.00',
    deposit: '2850.00',
    lease_from: '2025-09-01',
    lease_to: '2026-08-31',
    move_in: '2025-09-01',
  };

  it('maps occupancy_id to string id', () => {
    expect(mapRentRollRowToLease(raw).id).toBe('999');
  });

  it('maps property_id to string propertyId', () => {
    expect(mapRentRollRowToLease(raw).propertyId).toBe('101');
  });

  it('maps "Current" status to active', () => {
    expect(mapRentRollRowToLease(raw).status).toBe('active');
  });

  it('maps tenant_id to tenantIds array', () => {
    expect(mapRentRollRowToLease(raw).tenantIds).toContain('500');
  });

  it('maps rent string to monthlyRent in cents', () => {
    expect(mapRentRollRowToLease(raw).monthlyRent).toBe(285000);
  });

  it('maps deposit string to securityDeposit in cents', () => {
    expect(mapRentRollRowToLease(raw).securityDeposit).toBe(285000);
  });

  it('maps lease_from to startDate', () => {
    expect(mapRentRollRowToLease(raw).startDate).toBe('2025-09-01');
  });

  it('maps lease_to to endDate', () => {
    expect(mapRentRollRowToLease(raw).endDate).toBe('2026-08-31');
  });

  it('handles missing optional fields gracefully', () => {
    const lease = mapRentRollRowToLease({ occupancy_id: 1, unit_id: 2, property_id: 3 });
    expect(lease.tenantIds).toEqual([]);
    expect(lease.monthlyRent).toBe(0);
    expect(lease.securityDeposit).toBeUndefined();
    expect(lease.endDate).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// mapTenantRow — live snake_case fields from tenant_directory.json
// ---------------------------------------------------------------------------

describe('mapTenantRow', () => {
  const raw = {
    selected_tenant_id: 500,
    occupancy_id: 999,
    property_id: 101,
    unit_id: 202,
    unit: '3B',
    tenant: 'Maria Gonzalez',
    first_name: 'Maria',
    last_name: 'Gonzalez',
    emails: 'mgonzalez@example.com',
    phone_numbers: '415-555-0101',
    status: 'Current',
  };

  it('maps selected_tenant_id to string id', () => {
    expect(mapTenantRow(raw).id).toBe('500');
  });

  it('maps first_name and last_name', () => {
    const t = mapTenantRow(raw);
    expect(t.firstName).toBe('Maria');
    expect(t.lastName).toBe('Gonzalez');
  });

  it('maps occupancy_id to string leaseId', () => {
    expect(mapTenantRow(raw).leaseId).toBe('999');
  });

  it('maps property_id to string propertyId', () => {
    expect(mapTenantRow(raw).propertyId).toBe('101');
  });

  it('maps first email from emails field', () => {
    expect(mapTenantRow(raw).email).toBe('mgonzalez@example.com');
  });

  it('maps first phone from phone_numbers field', () => {
    expect(mapTenantRow(raw).phone).toBe('415-555-0101');
  });

  it('splits semicolon-separated emails and takes first', () => {
    const t = mapTenantRow({ ...raw, emails: 'a@b.com; c@d.com' });
    expect(t.email).toBe('a@b.com');
  });
});

// ---------------------------------------------------------------------------
// mapRentRollRow — live snake_case fields from rent_roll.json
// ---------------------------------------------------------------------------

describe('mapRentRollRow', () => {
  const raw = {
    property_id: 101,
    unit_id: 202,
    occupancy_id: 999,
    unit: '3B',
    tenant: 'Maria Gonzalez',
    status: 'Current',
    rent: '2850.00',
    past_due: '0.00',
    lease_to: '2026-08-31',
  };

  it('maps all standard fields', () => {
    const r = mapRentRollRow(raw);
    expect(r.propertyId).toBe('101');
    expect(r.unit).toBe('3B');
    expect(r.leaseId).toBe('999');
    expect(r.tenantName).toBe('Maria Gonzalez');
    expect(r.status).toBe('active');
    expect(r.monthlyRent).toBe(285000);
    expect(r.balance).toBe(0);
    expect(r.leaseEnd).toBe('2026-08-31');
  });

  it('maps positive past_due (tenant owes) to positive cents', () => {
    const r = mapRentRollRow({ ...raw, past_due: '3200.00' });
    expect(r.balance).toBe(320000);
  });

  it('handles missing optional fields', () => {
    const r = mapRentRollRow({ property_id: 102, occupancy_id: 1, unit_id: 1 });
    expect(r.propertyId).toBe('102');
    expect(r.monthlyRent).toBe(0);
    expect(r.balance).toBe(0);
    expect(r.leaseId).toBe('1');
  });
});

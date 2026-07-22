import { describe, it, expect } from 'vitest';
import {
  buildCreateWoFormFields,
  computeCreateWoApprovalHash,
  computePropertyIdToken,
} from '../lib/create-wo-fields';

describe('production form fields: no-tenant WO', () => {
  it('tenant-path includes unit_id and occupancy_id', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '86',
      unitId: '202',
      occupancyId: '2625',
      description: 'Kitchen faucet leaking',
      requestType: 'tenant_requested',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[property_id]']).toBe('t_2625');
    expect(fields['maintenance_service_request[unit_id]']).toBe('202');
    expect(fields['maintenance_service_request[occupancy_id]']).toBe('2625');
  });

  it('property-path omits occupancy_id field entirely', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      unitId: '51',
      description: 'Basement knob-and-tube electrical',
      requestType: 'internal',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[property_id]']).toBe('p_24');
    expect(fields['maintenance_service_request[unit_id]']).toBe('51');
    expect(fields).not.toHaveProperty('maintenance_service_request[occupancy_id]');
  });

  it('common-area (no unit, no occupancy) omits both fields', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Common area exterior light broken',
      requestType: 'internal',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[property_id]']).toBe('p_24');
    expect(fields).not.toHaveProperty('maintenance_service_request[unit_id]');
    expect(fields).not.toHaveProperty('maintenance_service_request[occupancy_id]');
  });

  it('empty-string unitId is treated as absent (omitted)', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      unitId: '',
      occupancyId: '',
      description: 'Test',
    }, 'csrf_test');
    expect(fields).not.toHaveProperty('maintenance_service_request[unit_id]');
    expect(fields).not.toHaveProperty('maintenance_service_request[occupancy_id]');
  });

  it('includes authenticity_token from csrfToken argument', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
    }, 'my_csrf_token');
    expect(fields['authenticity_token']).toBe('my_csrf_token');
  });

  it('includes permissionToEnter when provided', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
      permissionToEnter: 'true',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[permission_to_enter]']).toBe('true');
  });

  it('omits permissionToEnter when not provided', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
    }, 'csrf_test');
    expect(fields).not.toHaveProperty('maintenance_service_request[permission_to_enter]');
  });

  it('includes specialInstructions when provided', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
      specialInstructions: 'Ring doorbell',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[special_instructions]']).toBe('Ring doorbell');
  });

  it('request_type defaults to internal', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[request_type]']).toBe('internal');
  });

  it('vendor party/wo-link/text flags stay off (inert-pin)', () => {
    const fields = buildCreateWoFormFields({
      propertyId: '24',
      description: 'Test',
    }, 'csrf_test');
    expect(fields['maintenance_service_request[maintenance_work_order][party]']).toBe('');
    expect(fields['maintenance_service_request[maintenance_work_order][send_vendor_wo_link]']).toBe('0');
    expect(fields['maintenance_service_request[maintenance_work_order][send_vendor_text]']).toBe('0');
    expect(fields['maintenance_service_request[maintenance_work_order][require_vendor_accept_wo]']).toBe('0');
  });
});

describe('production computePropertyIdToken', () => {
  it('uses p_ prefix for property-path', () => {
    expect(computePropertyIdToken({ propertyId: '24' })).toBe('p_24');
  });

  it('uses t_ prefix for tenant-path', () => {
    expect(computePropertyIdToken({ propertyId: '86', occupancyId: '2625' })).toBe('t_2625');
  });
});

describe('production computeCreateWoApprovalHash', () => {
  it('no-tenant hash uses p_ prefix', () => {
    const h = computeCreateWoApprovalHash({
      propertyId: '24',
      description: 'Basement electrical',
      requestType: 'internal',
    });
    expect(h).toHaveLength(16);
  });

  it('same no-tenant params produce stable hash', () => {
    const params = { propertyId: '24', description: 'Test', requestType: 'internal' as const };
    expect(computeCreateWoApprovalHash(params)).toBe(computeCreateWoApprovalHash(params));
  });

  it('no-tenant hash differs from tenant hash for same property', () => {
    const noTenant = computeCreateWoApprovalHash({
      propertyId: '24',
      description: 'Basement electrical',
    });
    const withTenant = computeCreateWoApprovalHash({
      propertyId: '24',
      occupancyId: '999',
      unitId: '51',
      description: 'Basement electrical',
    });
    expect(noTenant).not.toBe(withTenant);
  });

  it('property-only with unit differs from property-only without unit', () => {
    const withUnit = computeCreateWoApprovalHash({
      propertyId: '24',
      unitId: '51',
      description: 'Basement electrical',
    });
    const noUnit = computeCreateWoApprovalHash({
      propertyId: '24',
      description: 'Basement electrical',
    });
    expect(withUnit).not.toBe(noUnit);
  });

  it('different description changes hash', () => {
    const base = { propertyId: '24', description: 'A' };
    const alt = { propertyId: '24', description: 'B' };
    expect(computeCreateWoApprovalHash(base)).not.toBe(computeCreateWoApprovalHash(alt));
  });

  it('different requestType changes hash', () => {
    const internal = computeCreateWoApprovalHash({
      propertyId: '24', description: 'Test', requestType: 'internal',
    });
    const tenant = computeCreateWoApprovalHash({
      propertyId: '24', description: 'Test', requestType: 'tenant_requested',
    });
    expect(internal).not.toBe(tenant);
  });
});

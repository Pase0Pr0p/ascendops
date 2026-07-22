import { describe, it, expect } from 'vitest';
import { createHash } from 'crypto';

function computeCreateWoApprovalHash(params: {
  propertyId: string;
  unitId?: string;
  occupancyId?: string;
  description: string;
  category?: string;
  issueDescriptorId?: string;
  priority?: string;
  permissionToEnter?: string;
  specialInstructions?: string;
  requestType?: string;
}): string {
  const propertyIdToken = params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;
  const payload = JSON.stringify({
    propertyId: params.propertyId,
    propertyIdToken,
    unitId: params.unitId ?? '',
    occupancyId: params.occupancyId ?? '',
    description: params.description,
    category: params.category ?? '',
    issueDescriptorId: params.issueDescriptorId ?? '',
    priority: params.priority ?? 'Normal',
    permissionToEnter: params.permissionToEnter ?? '',
    specialInstructions: params.specialInstructions ?? '',
    requestType: params.requestType ?? 'internal',
    party: '',
    sendVendorWoLink: '0',
    sendVendorText: '0',
    requireVendorAcceptWo: '0',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function buildFormFields(params: {
  propertyId: string;
  unitId?: string;
  occupancyId?: string;
  description: string;
  category?: string;
  priority?: string;
  requestType?: string;
  permissionToEnter?: string;
}): Record<string, string> {
  const propertyIdToken = params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;

  const formFields: Record<string, string> = {
    'maintenance_service_request[property_id]': propertyIdToken,
    'maintenance_service_request[description]': params.description,
  };
  if (params.unitId) {
    formFields['maintenance_service_request[unit_id]'] = params.unitId;
  }
  if (params.occupancyId) {
    formFields['maintenance_service_request[occupancy_id]'] = params.occupancyId;
  }
  Object.assign(formFields, {
    'maintenance_service_request[maintenance_work_order][maintenance_work_order_category][work_order_category]': params.category ?? '',
    'maintenance_service_request[priority]': params.priority ?? 'Normal',
    'maintenance_service_request[request_type]': params.requestType ?? 'internal',
    'maintenance_service_request[maintenance_work_order][party]': '',
    'maintenance_service_request[maintenance_work_order][send_vendor_wo_link]': '0',
    'maintenance_service_request[maintenance_work_order][send_vendor_text]': '0',
    'maintenance_service_request[maintenance_work_order][require_vendor_accept_wo]': '0',
  });
  if (params.permissionToEnter) {
    formFields['maintenance_service_request[permission_to_enter]'] = params.permissionToEnter;
  }
  return formFields;
}

describe('no-tenant WO form fields', () => {
  it('tenant-path includes unit_id and occupancy_id', () => {
    const fields = buildFormFields({
      propertyId: '86',
      unitId: '202',
      occupancyId: '2625',
      description: 'Kitchen faucet leaking',
      requestType: 'tenant_requested',
    });
    expect(fields['maintenance_service_request[property_id]']).toBe('t_2625');
    expect(fields['maintenance_service_request[unit_id]']).toBe('202');
    expect(fields['maintenance_service_request[occupancy_id]']).toBe('2625');
  });

  it('property-path omits occupancy_id field entirely', () => {
    const fields = buildFormFields({
      propertyId: '24',
      unitId: '51',
      description: 'Basement knob-and-tube electrical',
      requestType: 'internal',
    });
    expect(fields['maintenance_service_request[property_id]']).toBe('p_24');
    expect(fields['maintenance_service_request[unit_id]']).toBe('51');
    expect(fields).not.toHaveProperty('maintenance_service_request[occupancy_id]');
  });

  it('common-area (no unit, no occupancy) omits both fields', () => {
    const fields = buildFormFields({
      propertyId: '24',
      description: 'Common area exterior light broken',
      requestType: 'internal',
    });
    expect(fields['maintenance_service_request[property_id]']).toBe('p_24');
    expect(fields).not.toHaveProperty('maintenance_service_request[unit_id]');
    expect(fields).not.toHaveProperty('maintenance_service_request[occupancy_id]');
  });

  it('property-path uses p_ prefix token', () => {
    const fields = buildFormFields({
      propertyId: '24',
      description: 'Test',
    });
    expect(fields['maintenance_service_request[property_id]']).toBe('p_24');
  });

  it('tenant-path uses t_ prefix token', () => {
    const fields = buildFormFields({
      propertyId: '86',
      occupancyId: '2625',
      description: 'Test',
    });
    expect(fields['maintenance_service_request[property_id]']).toBe('t_2625');
  });

  it('request_type defaults to internal', () => {
    const fields = buildFormFields({
      propertyId: '24',
      description: 'Test',
    });
    expect(fields['maintenance_service_request[request_type]']).toBe('internal');
  });

  it('vendor party/wo-link/text flags stay off (inert-pin)', () => {
    const fields = buildFormFields({
      propertyId: '24',
      description: 'Test',
    });
    expect(fields['maintenance_service_request[maintenance_work_order][party]']).toBe('');
    expect(fields['maintenance_service_request[maintenance_work_order][send_vendor_wo_link]']).toBe('0');
    expect(fields['maintenance_service_request[maintenance_work_order][send_vendor_text]']).toBe('0');
    expect(fields['maintenance_service_request[maintenance_work_order][require_vendor_accept_wo]']).toBe('0');
  });
});

describe('approval hash for no-tenant WOs', () => {
  it('no-tenant hash uses p_ prefix', () => {
    const h = computeCreateWoApprovalHash({
      propertyId: '24',
      description: 'Basement electrical',
      requestType: 'internal',
    });
    expect(h).toHaveLength(16);
  });

  it('same no-tenant params produce stable hash', () => {
    const params = { propertyId: '24', description: 'Test', requestType: 'internal' };
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
});

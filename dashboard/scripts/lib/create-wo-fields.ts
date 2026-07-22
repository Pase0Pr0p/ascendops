import { createHash } from 'crypto';

export interface CreateWoParams {
  propertyId: string;
  unitId?: string;
  occupancyId?: string;
  description: string;
  category?: string;
  issueDescriptorId?: string;
  priority?: 'Urgent' | 'Normal' | 'Low';
  permissionToEnter?: 'true' | 'false' | 'not_applicable';
  specialInstructions?: string;
  requestType?: 'internal' | 'tenant_requested' | 'unit_turn';
}

export function computePropertyIdToken(params: Pick<CreateWoParams, 'propertyId' | 'occupancyId'>): string {
  return params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;
}

export function buildCreateWoFormFields(
  params: CreateWoParams,
  csrfToken: string,
): Record<string, string> {
  const propertyIdToken = computePropertyIdToken(params);

  const formFields: Record<string, string> = {
    'authenticity_token': csrfToken,
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
    'maintenance_service_request[maintenance_work_order][issue_descriptor_id]': params.issueDescriptorId ?? '',
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
  if (params.specialInstructions) {
    formFields['maintenance_service_request[special_instructions]'] = params.specialInstructions;
  }
  return formFields;
}

export function computeCreateWoApprovalHash(params: CreateWoParams): string {
  const propertyIdToken = computePropertyIdToken(params);
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

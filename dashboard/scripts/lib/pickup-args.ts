export interface PickupIntakeParams {
  appfolioPropertyId: string;
  appfolioUnitId: string;
  appfolioOccupancyId: string;
  tenantName: string;
  issueDescription: string;
  locationDetail: string;
  severity: string;
  permissionToEnter: boolean | string | null;
}

export function mapPteFlag(pte: boolean | string | null): string {
  const s = String(pte).toLowerCase();
  if (s === 'true') return 'true';
  if (s === 'false') return 'false';
  return 'not_applicable';
}

export function mapPickupPriority(severity: string): string {
  return severity === 'urgent' ? 'Urgent' : 'Normal';
}

export function buildPickupDescription(tenantName: string, issueDescription: string, locationDetail: string): string {
  return `Voice intake from ${tenantName}: ${issueDescription}${locationDetail ? ' (' + locationDetail + ')' : ''}`;
}

export function buildPickupArgs(params: PickupIntakeParams): string[] {
  const pteFlag = mapPteFlag(params.permissionToEnter);
  const priority = mapPickupPriority(params.severity);
  const description = buildPickupDescription(params.tenantName, params.issueDescription, params.locationDetail);

  return [
    'scripts/appfolio-browser-read.ts', 'create-work-order',
    '--property-id', params.appfolioPropertyId,
    ...(params.appfolioUnitId ? ['--unit-id', params.appfolioUnitId] : []),
    ...(params.appfolioOccupancyId ? ['--occupancy-id', params.appfolioOccupancyId] : []),
    '--description', description,
    '--priority', priority,
    '--permission-to-enter', pteFlag,
    '--request-type', params.appfolioOccupancyId ? 'tenant_requested' : 'internal',
  ];
}

export function buildPickupLiveArgs(
  params: PickupIntakeParams,
  approvalHash: string,
): string[] {
  return [...buildPickupArgs(params), '--execute', '--approval-hash', approvalHash];
}

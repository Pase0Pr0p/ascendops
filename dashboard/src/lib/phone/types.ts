export type ContactType = 'tenant' | 'owner' | 'vendor';
export type OccupancyStatus = 'current' | 'notice' | 'past' | 'future' | 'vacant';
export type WorkOrderStatus = 'new' | 'assigned' | 'scheduled' | 'in_progress' | 'on_hold' | 'completed' | 'canceled';
export type WorkOrderPriority = 'critical' | 'high' | 'normal' | 'low';

export interface CallerInfo {
  contactId: string;
  displayName: string;
  phoneE164: string;
  contactType: ContactType;
  /** Present when caller has a current or notice occupancy */
  occupancy?: {
    occupancyId: string;
    unitId: string;
    unitName: string;
    propertyId: string;
    propertyName: string;
    propertyAddress: string;
    appfolioPropertyId: string | null;
    status: OccupancyStatus;
    rentCents: number | null;
    leaseFrom: string | null;
    leaseTo: string | null;
  };
}

export interface WorkOrderSummary {
  id: string;
  workOrderNumber: string | null;
  jobDescription: string | null;
  issueDescription: string | null;
  status: WorkOrderStatus;
  priority: WorkOrderPriority;
  vendorTrade: string | null;
  assignedUser: string | null;
  createdAtAppfolio: string | null;
  scheduledStart: string | null;
}

export interface LeaseStatus {
  status: OccupancyStatus;
  rentCents: number | null;
  leaseFrom: string | null;
  leaseTo: string | null;
}

export interface ArBalance {
  balanceCents: number;
  openChargeCount: number;
}

/** Full context for a single phone call — all lookups combined */
export interface PhoneCallerContext {
  caller: CallerInfo;
  openWorkOrders: WorkOrderSummary[];
  arBalance: ArBalance;
}

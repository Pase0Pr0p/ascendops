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

// ---------------------------------------------------------------------------
// Inbound post-call webhook payload (Telnyx conversation-insights shape)
// ---------------------------------------------------------------------------

export interface CallTurn {
  role: 'agent' | 'user';
  content: string;
  timestamp?: string;
}

/** Payload the voice provider drops to our Edge Function after every call */
export interface ConversationInsightsPayload {
  caller_number: string;        // E.164
  number_called: string;        // E.164 — our Telnyx DID
  call_control_id: string;      // provider call ID for cross-referencing
  start_time: string;           // ISO 8601
  duration_seconds: number;
  intent: string | null;        // provider-classified intent
  sentiment: string | null;     // provider-classified sentiment
  summary: string | null;
  transcript: string | null;    // full transcript
  turns: CallTurn[];
}

/** Result of inbound triage — what was written to the canonical store */
export interface InboundTriageResult {
  callControlId: string;
  callerResolved: boolean;
  contactId: string | null;
  unitId: string | null;
  workOrderId: string | null;   // created or matched
  commsLogId: string | null;    // row written to communications_log
  smsHandoffSent: boolean;
}

// ---------------------------------------------------------------------------
// Outbound call request (POST /voice/outbound body)
// ---------------------------------------------------------------------------

export interface OutboundCallRequest {
  target_number: string;          // E.164
  reason: string;
  requested_by: string;           // agent or human operator name
  dynamic_variables: {
    call_reason: string;
    callback_number?: string;
    pre_loaded_context?: string;  // summary string the AI greets with
    [key: string]: string | undefined;
  };
}

export interface OutboundCallResponse {
  ok: boolean;
  call_control_id: string | null;
  status: string;
  approval_request_id: string;    // pending approval before call fires
}

// ---------------------------------------------------------------------------
// Scoped write: call note appended to a work order
// ---------------------------------------------------------------------------

export interface CallNoteWrite {
  workOrderId: string;
  callControlId: string;
  transcript: string | null;
  summary: string | null;
  callerNumber: string;
  durationSeconds: number;
  appendedAt: string;             // ISO 8601
}

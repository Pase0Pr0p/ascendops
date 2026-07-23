export type TriageState =
  | 'INTAKE'
  | 'READING'
  | 'CLASSIFYING'
  | 'DRAFTING'
  | 'REVIEW'
  | 'READY_FOR_HUMAN'
  | 'ESCALATED';

export type TerminalFlag =
  | 'MOLD_ESCALATE'
  | 'LIFE_SAFETY_E0'
  | 'SCOPE_EXCLUDED';

export type EscalationFlag =
  | TerminalFlag
  | 'PROPERTY_EMERGENCY_E1'
  | 'VULNERABLE_OCCUPANT'
  | 'INSURANCE_EVENT'
  | 'LEGAL_HABITABILITY'
  | 'RESPONSIBILITY_UNCLEAR'
  | 'COST_UNKNOWN'
  | 'COST_OVER_LIMIT'
  | 'VENDOR_DISPATCH'
  | 'QUOTE_PO'
  | 'NEW_VENDOR'
  | 'CROSS_UNIT_ENTRY'
  | 'ACCESS_REFUSAL'
  | 'SOURCE_EXTERNAL'
  | 'OWNER_DIRECTED_WORK'
  | 'AMBIGUOUS_DIAGNOSIS'
  | 'PERMISSION_TO_ENTER_UNKNOWN'
  | 'REPEAT_FAILURE'
  | 'TENANT_FRICTION'
  | 'DATA_DRIFT'
  | 'SYSTEM_UNAVAILABLE'
  | 'SLA_BREACH';

export type Tier = 'E0' | 'E1' | 'U' | 'N' | 'D';

export type ActionPurpose =
  | 'ACK'
  | 'INFO_REQUEST'
  | 'CONTAINMENT'
  | 'DIY_OFFER'
  | 'STATUS'
  | 'VENDOR_DISPATCH'
  | 'ESCALATION'
  | 'CLOSE_REQUEST';

export type ActionType =
  | 'SEND_TENANT'
  | 'SEND_VENDOR'
  | 'VENDOR_DISPATCH'
  | 'VENDOR_SCHEDULE'
  | 'SPEND_APPROVE'
  | 'RESPONSIBILITY_STATEMENT'
  | 'LEGAL_COMMITMENT'
  | 'ENTRY_DECISION'
  | 'STATUS_WRITE'
  | 'LIFECYCLE_WRITE'
  | 'COMPLETION_CLOSE'
  | 'WO_ASSIGNMENT'
  | 'INTERNAL_NOTE_REVIEWED'
  | 'INTERNAL_NOTE_OTHER'
  | 'DIY_OFFER'
  | 'CLOSE_REQUEST';

export type Phase = 0 | 1 | 2 | 3 | 4;

export type SufficiencyResult =
  | 'CLEAR'
  | 'NEEDS_CLARIFICATION'
  | 'NEEDS_PHOTOS'
  | 'EMERGENCY_OVERRIDE';

export type FactType =
  | 'tenant_fact'
  | 'system_fact'
  | 'vision_observation'
  | 'inference';

export interface Fact {
  type: FactType;
  source: string;
  value: string;
  confidence: number;
  timestamp: string;
}

export interface TriageWO {
  woId: string;
  propertyId?: string;
  propertyAddress: string;
  unitId?: string;
  tenantName?: string;
  tenantContact?: string;
  conversationText: string;
  photoUrls: string[];
  visionAnalysis?: string;
  tier?: Tier;
  escalationFlags: EscalationFlag[];
  facts: Fact[];
  state: TriageState;
  terminalFlag?: TerminalFlag;
}

export interface TerminalCheckResult {
  terminal: boolean;
  flag?: TerminalFlag;
  reason?: string;
  recipients?: string[];
}

export interface PolicyConfig {
  version: number;
  updated_at: string;
  updated_by: string;
  global_auto_send: boolean;
  cards: Record<string, CardConfig>;
}

export interface CardConfig {
  auto_send: boolean;
  enabled_at: string;
  enabled_by: string;
}

export interface FallbackHandoff {
  active: boolean;
  set_by: string;
  effective_from: string;
  expires_at: string;
  reason: string;
  set_at: string;
}

export interface ActionPacket {
  woId: string;
  recipient: string;
  recipientRole: string;
  channel: string;
  messageBytes: string;
  purpose: ActionPurpose;
  facts: Fact[];
  escalationFlags: EscalationFlag[];
  tier?: Tier;
  policyVersion: number;
  cardId?: string;
  conversationFingerprint: string;
  issuedAt: string;
  expiresAt: string;
  nonce: string;
}

export interface ReviewVerdict {
  result: 'PASS' | 'FAIL' | 'ESCALATE';
  reasons: string[];
  reviewedAt: string;
}

export interface ShadowRecord {
  woId: string;
  shadowVerdict: ActionPacket;
  reviewResult: ReviewVerdict;
  timestamp: string;
}

export type CapabilityDecision = 'ALLOW' | 'DENY';

export interface CapabilityCheckResult {
  decision: CapabilityDecision;
  reason: string;
  rule: string;
}

export { checkTerminalInvariants } from './terminal-invariants.js';
export { detectMold, detectMoldInText, detectMoldInVision } from './mold-detection.js';
export { loadPolicyConfig, isAutoSendEnabled, isCardEnabled, checkVersionMatch, resetLastSeenVersion } from './policy-config.js';
export { checkCapability, getPermanentDenies, getPhaseAllows } from './capability-matrix.js';
export { transition, createTriageWO, createShadowRecord } from './state-machine.js';
export type {
  TriageState, TerminalFlag, EscalationFlag, Tier, ActionPurpose, ActionType,
  Phase, TriageWO, TerminalCheckResult, PolicyConfig, CardConfig,
  FallbackHandoff, ActionPacket, ReviewVerdict, ShadowRecord,
  CapabilityCheckResult, CapabilityDecision,
  SufficiencyResult, FactType, Fact,
} from './types.js';

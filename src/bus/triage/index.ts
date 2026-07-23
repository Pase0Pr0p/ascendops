export { checkTerminalInvariants } from './terminal-invariants.js';
export { detectMold, detectMoldInText, detectMoldInVision } from './mold-detection.js';
export { loadPolicyConfig, isAutoSendEnabled, isCardEnabled, checkVersionMatch, resetLastSeenVersion, setVersionFilePath } from './policy-config.js';
export { checkCapability, getPermanentDenies, getPhaseAllows } from './capability-matrix.js';
export { transition, createTriageWO, createShadowRecord } from './state-machine.js';
export { enqueue, drainOnKillswitch, drainOnVersionChange, markSent, reserveForSend, releaseNonce, getQueue, getQueuedCount, getInFlightCount, getActiveCount, clearQueue, checkAndDrain } from './send-queue.js';
export { checkFallbackRouting } from './fallback-routing.js';
export { checkAutoSendConstraints } from './auto-send-constraints.js';
export { classifySchedulePromise, reclassifyIfSchedule } from './schedule-classifier.js';
export type {
  TriageState, TerminalFlag, EscalationFlag, Tier, ActionPurpose, ActionType,
  Phase, TriageWO, TerminalCheckResult, PolicyConfig, CardConfig,
  FallbackHandoff, ActionPacket, ReviewVerdict, ShadowRecord,
  CapabilityCheckResult, CapabilityDecision,
  SufficiencyResult, FactType, Fact,
} from './types.js';
export type { QueuedSend, QueuedSendStatus, DrainResult, ReserveResult } from './send-queue.js';
export type { FallbackCheckResult } from './fallback-routing.js';
export type { PropertyConstraints, AutoSendConstraintResult } from './auto-send-constraints.js';
export type { ShadowRecordResult } from './state-machine.js';
export type { ScheduleClassifyResult } from './schedule-classifier.js';

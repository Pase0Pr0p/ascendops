export { checkTerminalInvariants } from './terminal-invariants.js';
export { detectMold, detectMoldInText, detectMoldInVision } from './mold-detection.js';
export { getPermanentDenies, getPhaseAllows } from './capability-matrix.js';
export { transition, createTriageWO, createShadowRecord } from './state-machine.js';
export { classifySchedulePromise, reclassifyIfSchedule } from './schedule-classifier.js';
export { triageGate } from './triage-gate.js';
export { classify, applyClassification } from './classifier.js';
export { buildPacket } from './packet-builder.js';
export { runReviewGate } from './review-gate-runner.js';
export { runShadowPipeline } from './shadow-pipeline.js';
export type {
  TriageState, TerminalFlag, EscalationFlag, Tier, ActionPurpose, ActionType,
  Phase, TriageWO, TerminalCheckResult,
  CapabilityCheckResult, CapabilityDecision,
  SufficiencyResult, FactType, Fact,
} from './types.js';
export type { ShadowRecordResult } from './state-machine.js';
export type { ScheduleClassifyResult } from './schedule-classifier.js';
export type { GateResult } from './triage-gate.js';
export type { ClassificationResult } from './classifier.js';
export type { PacketBuildOptions } from './packet-builder.js';
export type { ReviewGateInput, ReviewGateOutput } from './review-gate-runner.js';
export type { PipelineInput, PipelineResult } from './shadow-pipeline.js';

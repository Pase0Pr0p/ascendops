import type { TriageWO, Phase, ActionType, ActionPurpose, ShadowRecord } from './types.js';
import type { ClassificationResult } from './classifier.js';
import type { ReviewGateOutput, ReviewerFn } from './review-gate-runner.js';
import { createTriageWO, transition } from './state-machine.js';
import { classify, applyClassification } from './classifier.js';
import { buildPacket } from './packet-builder.js';
import { runReviewGate } from './review-gate-runner.js';

export interface PipelineInput {
  woId: string;
  propertyAddress: string;
  conversationText: string;
  tenantName?: string;
  tenantContact?: string;
  unitId?: string;
  photoUrls?: string[];
  visionAnalysis?: string;
  phase: Phase;
  actionType: ActionType;
  purpose: ActionPurpose;
  messageBytes: string;
  channel?: string;
  cardId?: string;
  policyVersion?: number;
  auditPath?: string;
  reviewer?: ReviewerFn;
}

export interface PipelineResult {
  wo: TriageWO;
  classification: ClassificationResult | null;
  gateOutput: ReviewGateOutput | null;
  escalated: boolean;
  escalationReason?: string;
  rejected: boolean;
  rejectReason?: string;
  finalState: string;
}

export function runShadowPipeline(input: PipelineInput): PipelineResult {
  const wo = createTriageWO(input.woId, input.propertyAddress, input.conversationText);
  if (input.tenantName) wo.tenantName = input.tenantName;
  if (input.tenantContact) wo.tenantContact = input.tenantContact;
  if (input.unitId) wo.unitId = input.unitId;
  if (input.photoUrls) wo.photoUrls = input.photoUrls;
  if (input.visionAnalysis) wo.visionAnalysis = input.visionAnalysis;

  const readTransition = transition(wo, 'READING');
  if (!readTransition.success) {
    return {
      wo,
      classification: null,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: readTransition.reason,
      rejected: false,
      finalState: wo.state,
    };
  }

  const classifyTransition = transition(wo, 'CLASSIFYING');
  if (!classifyTransition.success) {
    return {
      wo,
      classification: null,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: classifyTransition.reason,
      rejected: false,
      finalState: wo.state,
    };
  }

  const classification = classify(wo);
  applyClassification(wo, classification);

  const draftTransition = transition(wo, 'DRAFTING');
  if (!draftTransition.success) {
    return {
      wo,
      classification,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: draftTransition.reason,
      rejected: false,
      finalState: wo.state,
    };
  }

  const packetResult = buildPacket(wo, {
    purpose: input.purpose,
    messageBytes: input.messageBytes,
    channel: input.channel,
    cardId: input.cardId,
    policyVersion: input.policyVersion,
  });

  if (packetResult.rejected || !packetResult.packet) {
    return {
      wo,
      classification,
      gateOutput: null,
      escalated: false,
      rejected: true,
      rejectReason: packetResult.rejectReason,
      finalState: wo.state,
    };
  }

  const reviewTransition = transition(wo, 'REVIEW');
  if (!reviewTransition.success) {
    return {
      wo,
      classification,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: reviewTransition.reason,
      rejected: false,
      finalState: wo.state,
    };
  }

  const gateOutput = runReviewGate({
    wo,
    packet: packetResult.packet,
    phase: input.phase,
    actionType: input.actionType,
    auditPath: input.auditPath,
    reviewer: input.reviewer,
  });

  if (gateOutput.escalated) {
    return {
      wo,
      classification,
      gateOutput,
      escalated: true,
      escalationReason: gateOutput.escalationReason,
      rejected: false,
      finalState: wo.state,
    };
  }

  if (gateOutput.verdict.result === 'PASS' && !gateOutput.auditResult?.acknowledged) {
    return {
      wo,
      classification,
      gateOutput: {
        ...gateOutput,
        gateResult: { decision: 'DENY', finalActionType: input.actionType, reclassified: false, reason: 'Durable audit append failed or not acknowledged', rule: 'audit-required' },
        verdict: { result: 'FAIL', reasons: ['PASS denied: durable audit not acknowledged'], reviewedAt: new Date().toISOString(), reviewerVersion: gateOutput.verdict.reviewerVersion },
        shadowRecord: null,
      },
      escalated: false,
      rejected: false,
      finalState: wo.state,
    };
  }

  const readyTransition = transition(wo, 'READY_FOR_HUMAN');
  if (!readyTransition.success) {
    return {
      wo,
      classification,
      gateOutput,
      escalated: wo.state === 'ESCALATED',
      escalationReason: readyTransition.reason,
      rejected: false,
      finalState: wo.state,
    };
  }

  return {
    wo,
    classification,
    gateOutput,
    escalated: false,
    rejected: false,
    finalState: wo.state,
  };
}

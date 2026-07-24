import type { TriageWO, Phase, ActionType, ActionPurpose } from './types.js';
import type { ClassificationResult } from './classifier.js';
import type { ReviewGateOutput } from './review-gate-runner.js';
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
}

export interface PipelineResult {
  wo: TriageWO;
  classification: ClassificationResult | null;
  gateOutput: ReviewGateOutput | null;
  escalated: boolean;
  escalationReason?: string;
  finalState: string;
}

export function runShadowPipeline(input: PipelineInput): PipelineResult {
  const wo = createTriageWO(input.woId, input.propertyAddress, input.conversationText);
  if (input.tenantName) wo.tenantName = input.tenantName;
  if (input.tenantContact) wo.tenantContact = input.tenantContact;
  if (input.unitId) wo.unitId = input.unitId;
  if (input.photoUrls) wo.photoUrls = input.photoUrls;
  if (input.visionAnalysis) wo.visionAnalysis = input.visionAnalysis;

  // INTAKE → READING
  const readTransition = transition(wo, 'READING');
  if (!readTransition.success) {
    return {
      wo,
      classification: null,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: readTransition.reason,
      finalState: wo.state,
    };
  }

  // READING → CLASSIFYING
  const classifyTransition = transition(wo, 'CLASSIFYING');
  if (!classifyTransition.success) {
    return {
      wo,
      classification: null,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: classifyTransition.reason,
      finalState: wo.state,
    };
  }

  const classification = classify(wo);
  applyClassification(wo, classification);

  // CLASSIFYING → DRAFTING
  const draftTransition = transition(wo, 'DRAFTING');
  if (!draftTransition.success) {
    return {
      wo,
      classification,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: draftTransition.reason,
      finalState: wo.state,
    };
  }

  const packet = buildPacket(wo, {
    purpose: input.purpose,
    messageBytes: input.messageBytes,
    channel: input.channel,
    cardId: input.cardId,
    policyVersion: input.policyVersion,
  });

  // DRAFTING → REVIEW
  const reviewTransition = transition(wo, 'REVIEW');
  if (!reviewTransition.success) {
    return {
      wo,
      classification,
      gateOutput: null,
      escalated: wo.state === 'ESCALATED',
      escalationReason: reviewTransition.reason,
      finalState: wo.state,
    };
  }

  const gateOutput = runReviewGate({
    wo,
    packet,
    phase: input.phase,
    actionType: input.actionType,
  });

  if (gateOutput.shadowResult.escalated) {
    return {
      wo,
      classification,
      gateOutput,
      escalated: true,
      escalationReason: gateOutput.shadowResult.terminalCheck?.reason,
      finalState: wo.state,
    };
  }

  // REVIEW → READY_FOR_HUMAN
  const readyTransition = transition(wo, 'READY_FOR_HUMAN');
  if (!readyTransition.success) {
    return {
      wo,
      classification,
      gateOutput,
      escalated: wo.state === 'ESCALATED',
      escalationReason: readyTransition.reason,
      finalState: wo.state,
    };
  }

  return {
    wo,
    classification,
    gateOutput,
    escalated: false,
    finalState: wo.state,
  };
}

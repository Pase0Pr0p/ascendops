import type {
  TriageWO, ActionPacket, ReviewVerdict, Phase, ActionType, ActionPurpose,
} from './types.js';
import type { GateResult } from './triage-gate.js';
import type { ShadowRecordResult } from './state-machine.js';
import { triageGate } from './triage-gate.js';
import { createShadowRecord } from './state-machine.js';

export interface ReviewGateInput {
  wo: TriageWO;
  packet: ActionPacket;
  phase: Phase;
  actionType: ActionType;
}

export interface ReviewGateOutput {
  gateResult: GateResult;
  verdict: ReviewVerdict;
  shadowResult: ShadowRecordResult;
}

function gateToVerdict(gate: GateResult): ReviewVerdict {
  const now = new Date().toISOString();

  if (gate.decision === 'DENY') {
    return {
      result: 'FAIL',
      reasons: [
        `Gate DENY: ${gate.reason}`,
        `Rule: ${gate.rule}`,
        ...(gate.reclassified ? [`Action reclassified to ${gate.finalActionType}`] : []),
      ],
      reviewedAt: now,
    };
  }

  return {
    result: 'PASS',
    reasons: [
      `Gate ALLOW: ${gate.reason}`,
      `Rule: ${gate.rule}`,
      ...(gate.reclassified ? [`Action reclassified to ${gate.finalActionType}`] : []),
    ],
    reviewedAt: now,
  };
}

export function runReviewGate(input: ReviewGateInput): ReviewGateOutput {
  const { wo, packet, phase, actionType } = input;

  const gateResult = triageGate(
    phase,
    wo.tier,
    packet.purpose,
    actionType,
    packet.messageBytes,
    wo.escalationFlags,
    packet.cardId,
  );

  const verdict = gateToVerdict(gateResult);
  const shadowResult = createShadowRecord(wo, packet, verdict);

  return { gateResult, verdict, shadowResult };
}

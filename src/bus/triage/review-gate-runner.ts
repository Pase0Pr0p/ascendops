import { createHash } from 'node:crypto';
import type {
  TriageWO, ActionPacket, ReviewVerdict, Phase, ActionType,
  ShadowRecord,
} from './types.js';
import type { GateResult } from './triage-gate.js';
import { triageGate } from './triage-gate.js';
import { validateContent } from './content-validator.js';

export const REVIEWER_VERSION = 'review-gate-runner-v2';

export interface ReviewGateInput {
  wo: TriageWO;
  packet: ActionPacket;
  phase: Phase;
  actionType: ActionType;
}

export interface ReviewGateOutput {
  gateResult: GateResult;
  verdict: ReviewVerdict;
  shadowRecord: ShadowRecord | null;
  escalated: boolean;
  escalationReason?: string;
}

interface PacketValidation {
  valid: boolean;
  violations: string[];
}

function validatePacketAuthority(wo: TriageWO, packet: ActionPacket): PacketValidation {
  const violations: string[] = [];

  if (packet.woId !== wo.woId) {
    violations.push(`Packet WO '${packet.woId}' does not match current WO '${wo.woId}'`);
  }

  const now = new Date();
  const expiry = new Date(packet.expiresAt);
  if (expiry <= now) {
    violations.push(`Packet expired at ${packet.expiresAt}`);
  }

  if (packet.recipientRole === 'tenant' && packet.recipient === 'tenant') {
    violations.push('Packet has fallback tenant recipient — real identity required');
  }

  if (packet.recipientRole === 'tenant') {
    if (wo.tenantName && packet.recipient !== wo.tenantName) {
      violations.push(`Packet recipient '${packet.recipient}' does not match WO tenant '${wo.tenantName}'`);
    }
  }

  return { valid: violations.length === 0, violations };
}

function computePacketHash(packet: ActionPacket): string {
  return packet.canonicalHash;
}

function deepFreeze(packet: ActionPacket): ActionPacket {
  return JSON.parse(JSON.stringify(packet));
}

function buildVerdict(
  result: 'PASS' | 'FAIL' | 'ESCALATE',
  reasons: string[],
): ReviewVerdict {
  return {
    result,
    reasons,
    reviewedAt: new Date().toISOString(),
    reviewerVersion: REVIEWER_VERSION,
  };
}

export function runReviewGate(input: ReviewGateInput): ReviewGateOutput {
  const { wo, packet, phase, actionType } = input;

  const authorityCheck = validatePacketAuthority(wo, packet);
  if (!authorityCheck.valid) {
    const verdict = buildVerdict('FAIL', authorityCheck.violations);
    return {
      gateResult: { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: authorityCheck.violations.join('; '), rule: 'packet-authority' },
      verdict,
      shadowRecord: null,
      escalated: false,
    };
  }

  const contentCheck = validateContent(packet.messageBytes, packet.purpose);
  if (!contentCheck.valid) {
    const verdict = buildVerdict('FAIL', contentCheck.violations);
    return {
      gateResult: { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: contentCheck.violations.join('; '), rule: 'content-validation' },
      verdict,
      shadowRecord: null,
      escalated: false,
    };
  }

  const gateResult = triageGate(
    phase,
    wo.tier,
    packet.purpose,
    actionType,
    packet.messageBytes,
    wo.escalationFlags,
    packet.cardId,
  );

  const reasons = [
    `Gate ${gateResult.decision}: ${gateResult.reason}`,
    `Rule: ${gateResult.rule}`,
    ...(gateResult.reclassified ? [`Action reclassified to ${gateResult.finalActionType}`] : []),
  ];

  if (gateResult.decision === 'DENY') {
    const verdict = buildVerdict('FAIL', reasons);
    return { gateResult, verdict, shadowRecord: null, escalated: false };
  }

  const verdict = buildVerdict('PASS', reasons);
  const frozenPacket = deepFreeze(packet);
  const shadowRecord: ShadowRecord = {
    woId: wo.woId,
    shadowVerdict: frozenPacket,
    reviewResult: verdict,
    timestamp: new Date().toISOString(),
    packetHash: computePacketHash(frozenPacket),
  };

  return { gateResult, verdict, shadowRecord, escalated: false };
}

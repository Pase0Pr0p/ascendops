import type {
  TriageWO, ActionPacket, ReviewVerdict, Phase, ActionType, ActionPurpose,
  ShadowRecord,
} from './types.js';
import type { GateResult } from './triage-gate.js';
import { triageGate } from './triage-gate.js';
import { validateContent } from './content-validator.js';
import { checkTerminalInvariants } from './terminal-invariants.js';
import { computeFingerprint, computeCanonicalHash } from './packet-builder.js';

export const REVIEWER_VERSION = 'review-gate-runner-v3';

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

const ALLOWED_TENANT_CHANNELS: Set<string> = new Set(['appfolio_wo_message']);
const ALLOWED_ESCALATION_CHANNELS: Set<string> = new Set(['telegram']);

const PURPOSE_ROLE_MAP: Record<string, string> = {
  ACK: 'tenant',
  INFO_REQUEST: 'tenant',
  DIY_OFFER: 'tenant',
  STATUS: 'tenant',
  CLOSE_REQUEST: 'tenant',
  ESCALATION: 'operations_manager',
  VENDOR_DISPATCH: 'operations_manager',
  CONTAINMENT: 'operations_manager',
};

function isValidFiniteDate(value: string): boolean {
  const d = new Date(value);
  return !isNaN(d.getTime()) && isFinite(d.getTime());
}

function validatePacketAuthority(wo: TriageWO, packet: ActionPacket): string[] {
  const violations: string[] = [];

  if (packet.woId !== wo.woId) {
    violations.push(`Packet WO '${packet.woId}' does not match current WO '${wo.woId}'`);
  }

  if (!isValidFiniteDate(packet.expiresAt)) {
    violations.push(`Packet expiresAt '${packet.expiresAt}' is not a valid date`);
  } else if (!isValidFiniteDate(packet.issuedAt)) {
    violations.push(`Packet issuedAt '${packet.issuedAt}' is not a valid date`);
  } else {
    const now = new Date();
    const expiry = new Date(packet.expiresAt);
    if (expiry <= now) {
      violations.push(`Packet expired at ${packet.expiresAt}`);
    }
    const issued = new Date(packet.issuedAt);
    if (issued > now) {
      violations.push(`Packet issuedAt ${packet.issuedAt} is in the future`);
    }
    if (expiry <= issued) {
      violations.push(`Packet expiresAt ${packet.expiresAt} is not after issuedAt ${packet.issuedAt}`);
    }
  }

  if (packet.recipientRole === 'tenant' && packet.recipient === 'tenant') {
    violations.push('Packet has fallback tenant recipient — real identity required');
  }

  if (packet.recipientRole === 'tenant' && wo.tenantName && packet.recipient !== wo.tenantName) {
    violations.push(`Packet recipient '${packet.recipient}' does not match WO tenant '${wo.tenantName}'`);
  }

  const expectedRole = PURPOSE_ROLE_MAP[packet.purpose];
  if (expectedRole && packet.recipientRole !== expectedRole) {
    violations.push(`Packet recipientRole '${packet.recipientRole}' does not match expected '${expectedRole}' for purpose '${packet.purpose}'`);
  }

  if (packet.recipientRole === 'tenant') {
    if (!ALLOWED_TENANT_CHANNELS.has(packet.channel)) {
      violations.push(`Channel '${packet.channel}' not authorized for tenant-facing purpose`);
    }
  } else if (packet.purpose === 'ESCALATION' || packet.purpose === 'VENDOR_DISPATCH') {
    if (!ALLOWED_ESCALATION_CHANNELS.has(packet.channel)) {
      violations.push(`Channel '${packet.channel}' not authorized for escalation purpose`);
    }
  }

  return violations;
}

function validateSourceFreshness(wo: TriageWO, packet: ActionPacket): string[] {
  const violations: string[] = [];

  const currentFingerprint = computeFingerprint(wo);
  if (currentFingerprint !== packet.conversationFingerprint) {
    violations.push(`Source fingerprint drift: packet fingerprint '${packet.conversationFingerprint}' does not match current WO fingerprint '${currentFingerprint}'`);
  }

  const recomputedHash = computeCanonicalHash(packet);
  if (recomputedHash !== packet.canonicalHash) {
    violations.push(`Canonical hash mismatch: packet hash '${packet.canonicalHash}' does not match recomputed hash '${recomputedHash}'`);
  }

  return violations;
}

function makeImmutable<T extends object>(obj: T): T {
  const clone = JSON.parse(JSON.stringify(obj));
  const handler: ProxyHandler<Record<string, unknown>> = {
    set(): boolean { throw new TypeError('Cannot assign to read-only property of immutable shadow record'); },
    deleteProperty(): boolean { throw new TypeError('Cannot delete property of immutable shadow record'); },
    get(target, prop, receiver): unknown {
      const value = Reflect.get(target, prop, receiver);
      if (value !== null && typeof value === 'object') {
        return new Proxy(value as Record<string, unknown>, handler);
      }
      return value;
    },
  };
  return new Proxy(clone, handler) as T;
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

function denyOutput(actionType: ActionType, reasons: string[], rule: string): ReviewGateOutput {
  return {
    gateResult: { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: reasons.join('; '), rule },
    verdict: buildVerdict('FAIL', reasons),
    shadowRecord: null,
    escalated: false,
  };
}

export function runReviewGate(input: ReviewGateInput): ReviewGateOutput {
  const { wo, packet, phase, actionType } = input;

  const terminalCheck = checkTerminalInvariants(wo);
  if (terminalCheck.terminal) {
    return {
      gateResult: { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: terminalCheck.reason || 'Terminal invariant active', rule: 'terminal-invariant' },
      verdict: buildVerdict('ESCALATE', [terminalCheck.reason || 'Terminal invariant active']),
      shadowRecord: null,
      escalated: true,
      escalationReason: terminalCheck.reason,
    };
  }

  const authorityViolations = validatePacketAuthority(wo, packet);
  if (authorityViolations.length > 0) {
    return denyOutput(actionType, authorityViolations, 'packet-authority');
  }

  const freshnessViolations = validateSourceFreshness(wo, packet);
  if (freshnessViolations.length > 0) {
    return denyOutput(actionType, freshnessViolations, 'source-freshness');
  }

  const contentCheck = validateContent(packet.messageBytes, packet.purpose);
  if (!contentCheck.valid) {
    return denyOutput(actionType, contentCheck.violations, 'content-validation');
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
    return { gateResult, verdict: buildVerdict('FAIL', reasons), shadowRecord: null, escalated: false };
  }

  const verdict = buildVerdict('PASS', reasons);
  const frozenPacket = makeImmutable(packet);
  const frozenVerdict = makeImmutable(verdict);
  const packetClone = JSON.parse(JSON.stringify(packet));
  const shadowRecord = makeImmutable<ShadowRecord>({
    woId: wo.woId,
    shadowVerdict: packetClone,
    reviewResult: JSON.parse(JSON.stringify(verdict)),
    timestamp: new Date().toISOString(),
    packetHash: packetClone.canonicalHash,
  });

  return { gateResult, verdict, shadowRecord, escalated: false };
}

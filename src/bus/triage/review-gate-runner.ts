import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  TriageWO, ActionPacket, ReviewVerdict, Phase, ActionType, ActionPurpose,
  ShadowRecord,
} from './types.js';
import type { GateResult } from './triage-gate.js';
import type { IndependentReviewResult } from './independent-reviewer.js';
import type { AppendResult } from './shadow-audit.js';
import { triageGate } from './triage-gate.js';
import { validateContent } from './content-validator.js';
import { checkTerminalInvariants } from './terminal-invariants.js';
import { computeFingerprint, computeCanonicalHash } from './packet-builder.js';
import { independentReview } from './independent-reviewer.js';
import { appendShadowAudit } from './shadow-audit.js';

export const REVIEWER_VERSION = 'review-gate-runner-v3';

export type ReviewerFn = (wo: TriageWO, packet: ActionPacket) => IndependentReviewResult;

export interface ReviewGateInput {
  wo: TriageWO;
  packet: ActionPacket;
  phase: Phase;
  actionType: ActionType;
  reviewer?: ReviewerFn;
}

export interface ReviewGateOutput {
  gateResult: GateResult;
  verdict: ReviewVerdict;
  shadowRecord: ShadowRecord | null;
  escalated: boolean;
  escalationReason?: string;
  independentReview?: IndependentReviewResult;
  auditResult?: AppendResult;
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

const SHADOW_AUDIT_ROOT = join(homedir(), '.cortextos', 'shadow-audit');

function internalAuditPath(woId: string): string {
  const safeId = woId.replace(/[^a-zA-Z0-9_-]/g, '_');
  return join(SHADOW_AUDIT_ROOT, `${safeId}.jsonl`);
}

export function getAuditPath(woId: string): string {
  return internalAuditPath(woId);
}

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

function isValidReviewerResult(value: unknown): value is IndependentReviewResult {
  if (value === null || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  if (obj.result !== 'PASS' && obj.result !== 'FAIL' && obj.result !== 'ESCALATE') return false;
  if (!Array.isArray(obj.violations)) return false;
  if (!(obj.violations as unknown[]).every(v => typeof v === 'string')) return false;
  if (typeof obj.reviewerVersion !== 'string' || obj.reviewerVersion.length === 0) return false;
  if (typeof obj.reviewedAt !== 'string') return false;
  if (!isValidFiniteDate(obj.reviewedAt as string)) return false;
  return true;
}

function invokeReviewer(reviewerFn: ReviewerFn | undefined, wo: TriageWO, packet: ActionPacket): IndependentReviewResult {
  if (!reviewerFn) {
    return {
      result: 'FAIL',
      violations: ['Reviewer unavailable: no reviewer function provided'],
      reviewerVersion: 'unavailable',
      reviewedAt: new Date().toISOString(),
    };
  }

  let raw: unknown;
  try {
    raw = reviewerFn(wo, packet);
  } catch (err) {
    return {
      result: 'FAIL',
      violations: [`Reviewer threw: ${err instanceof Error ? err.message : String(err)}`],
      reviewerVersion: 'error',
      reviewedAt: new Date().toISOString(),
    };
  }

  if (!isValidReviewerResult(raw)) {
    return {
      result: 'FAIL',
      violations: ['Reviewer returned malformed result: missing or invalid result/violations/reviewerVersion/reviewedAt'],
      reviewerVersion: 'malformed',
      reviewedAt: new Date().toISOString(),
    };
  }

  return raw;
}

function appendAuditForOutcome(
  auditPath: string,
  wo: TriageWO,
  packet: ActionPacket,
  gateResult: GateResult,
  verdict: ReviewVerdict,
  irResult: IndependentReviewResult,
): AppendResult {
  const packetClone = JSON.parse(JSON.stringify(packet));
  const shadowForAudit: ShadowRecord = {
    woId: wo.woId,
    shadowVerdict: packetClone,
    reviewResult: JSON.parse(JSON.stringify(verdict)),
    timestamp: new Date().toISOString(),
    packetHash: packetClone.canonicalHash,
  };
  return appendShadowAudit(auditPath, shadowForAudit, gateResult, irResult);
}

function reviewerNotReached(): IndependentReviewResult {
  return {
    result: 'FAIL',
    violations: ['Reviewer not reached: early deterministic denial'],
    reviewerVersion: 'not-reached',
    reviewedAt: new Date().toISOString(),
  };
}

function finalizeWithAudit(
  wo: TriageWO,
  packet: ActionPacket,
  gateResult: GateResult,
  verdict: ReviewVerdict,
  irResult: IndependentReviewResult,
  output: ReviewGateOutput,
): ReviewGateOutput {
  const auditPath = internalAuditPath(wo.woId);
  const auditResult = appendAuditForOutcome(auditPath, wo, packet, gateResult, verdict, irResult);
  return { ...output, auditResult };
}

export function runReviewGate(input: ReviewGateInput): ReviewGateOutput {
  const { wo, packet, phase, actionType, reviewer } = input;

  const terminalCheck = checkTerminalInvariants(wo);
  if (terminalCheck.terminal) {
    const gateResult: GateResult = { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: terminalCheck.reason || 'Terminal invariant active', rule: 'terminal-invariant' };
    const verdict = buildVerdict('ESCALATE', [terminalCheck.reason || 'Terminal invariant active']);
    const ir = reviewerNotReached();
    const output: ReviewGateOutput = { gateResult, verdict, shadowRecord: null, escalated: true, escalationReason: terminalCheck.reason };
    return finalizeWithAudit(wo, packet, gateResult, verdict, ir, output);
  }

  const authorityViolations = validatePacketAuthority(wo, packet);
  if (authorityViolations.length > 0) {
    const gateResult: GateResult = { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: authorityViolations.join('; '), rule: 'packet-authority' };
    const verdict = buildVerdict('FAIL', authorityViolations);
    const ir = reviewerNotReached();
    const output: ReviewGateOutput = { gateResult, verdict, shadowRecord: null, escalated: false };
    return finalizeWithAudit(wo, packet, gateResult, verdict, ir, output);
  }

  const freshnessViolations = validateSourceFreshness(wo, packet);
  if (freshnessViolations.length > 0) {
    const gateResult: GateResult = { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: freshnessViolations.join('; '), rule: 'source-freshness' };
    const verdict = buildVerdict('FAIL', freshnessViolations);
    const ir = reviewerNotReached();
    const output: ReviewGateOutput = { gateResult, verdict, shadowRecord: null, escalated: false };
    return finalizeWithAudit(wo, packet, gateResult, verdict, ir, output);
  }

  const contentCheck = validateContent(packet.messageBytes, packet.purpose);
  if (!contentCheck.valid) {
    const gateResult: GateResult = { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: contentCheck.violations.join('; '), rule: 'content-validation' };
    const verdict = buildVerdict('FAIL', contentCheck.violations);
    const ir = reviewerNotReached();
    const output: ReviewGateOutput = { gateResult, verdict, shadowRecord: null, escalated: false };
    return finalizeWithAudit(wo, packet, gateResult, verdict, ir, output);
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
    const ir = reviewerNotReached();
    const output: ReviewGateOutput = { gateResult, verdict, shadowRecord: null, escalated: false };
    return finalizeWithAudit(wo, packet, gateResult, verdict, ir, output);
  }

  const reviewerFn = reviewer !== undefined ? reviewer : independentReview;
  const irResult = invokeReviewer(reviewerFn, wo, packet);

  if (irResult.result !== 'PASS') {
    const irReasons = irResult.violations.map(v => `Independent review: ${v}`);
    const denyGateResult: GateResult = { decision: 'DENY', finalActionType: actionType, reclassified: false, reason: irReasons.join('; '), rule: 'independent-review' };
    const verdict = buildVerdict('FAIL', irReasons);
    const output: ReviewGateOutput = { gateResult: denyGateResult, verdict, shadowRecord: null, escalated: false, independentReview: irResult };
    return finalizeWithAudit(wo, packet, denyGateResult, verdict, irResult, output);
  }

  const verdict = buildVerdict('PASS', reasons);
  const packetClone = JSON.parse(JSON.stringify(packet));
  const shadowRecord = makeImmutable<ShadowRecord>({
    woId: wo.woId,
    shadowVerdict: packetClone,
    reviewResult: JSON.parse(JSON.stringify(verdict)),
    timestamp: new Date().toISOString(),
    packetHash: packetClone.canonicalHash,
  });

  const output: ReviewGateOutput = { gateResult, verdict, shadowRecord, escalated: false, independentReview: irResult };
  return finalizeWithAudit(wo, packet, gateResult, verdict, irResult, output);
}

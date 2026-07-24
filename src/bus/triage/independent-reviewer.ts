import type { TriageWO, ActionPacket, ActionPurpose } from './types.js';
import { computeFingerprint, computeCanonicalHash } from './packet-builder.js';
import { checkTerminalInvariants } from './terminal-invariants.js';
import { validateContent } from './content-validator.js';

export const INDEPENDENT_REVIEWER_VERSION = 'independent-reviewer-v1';

export interface IndependentReviewResult {
  approved: boolean;
  violations: string[];
  reviewerVersion: string;
  reviewedAt: string;
}

const TENANT_FACING_PURPOSES: Set<ActionPurpose> = new Set([
  'ACK', 'INFO_REQUEST', 'DIY_OFFER', 'STATUS', 'CLOSE_REQUEST',
]);

export function independentReview(wo: TriageWO, packet: ActionPacket): IndependentReviewResult {
  const violations: string[] = [];
  const now = new Date().toISOString();

  const terminal = checkTerminalInvariants(wo);
  if (terminal.terminal) {
    violations.push(`Terminal invariant active: ${terminal.reason}`);
  }

  if (packet.woId !== wo.woId) {
    violations.push(`WO ID mismatch: packet='${packet.woId}' current='${wo.woId}'`);
  }

  const currentFingerprint = computeFingerprint(wo);
  if (currentFingerprint !== packet.conversationFingerprint) {
    violations.push('Source fingerprint does not match current WO state');
  }

  const recomputedHash = computeCanonicalHash(packet);
  if (recomputedHash !== packet.canonicalHash) {
    violations.push('Canonical hash does not match packet contents');
  }

  const expiresAt = new Date(packet.expiresAt);
  const issuedAt = new Date(packet.issuedAt);
  if (isNaN(expiresAt.getTime()) || isNaN(issuedAt.getTime())) {
    violations.push('Packet has invalid date fields');
  } else if (expiresAt <= new Date()) {
    violations.push('Packet is expired');
  }

  if (TENANT_FACING_PURPOSES.has(packet.purpose)) {
    if (packet.recipientRole !== 'tenant') {
      violations.push(`Tenant-facing purpose '${packet.purpose}' has non-tenant role '${packet.recipientRole}'`);
    }
    if (packet.channel !== 'appfolio_wo_message') {
      violations.push(`Tenant-facing purpose '${packet.purpose}' has unauthorized channel '${packet.channel}'`);
    }
    if (!wo.tenantName || packet.recipient !== wo.tenantName) {
      violations.push('Tenant recipient identity does not match current WO');
    }
  }

  const content = validateContent(packet.messageBytes, packet.purpose);
  if (!content.valid) {
    violations.push(...content.violations.map(v => `Content: ${v}`));
  }

  return {
    approved: violations.length === 0,
    violations,
    reviewerVersion: INDEPENDENT_REVIEWER_VERSION,
    reviewedAt: now,
  };
}

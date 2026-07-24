import { describe, it, expect } from 'vitest';
import { runReviewGate, REVIEWER_VERSION } from '../../../../src/bus/triage/review-gate-runner';
import { buildPacket } from '../../../../src/bus/triage/packet-builder';
import type { TriageWO, ActionPacket } from '../../../../src/bus/triage/types';

function makeWO(overrides: Partial<TriageWO> = {}): TriageWO {
  return {
    woId: 'WO-4000',
    propertyAddress: '789 Elm St',
    conversationText: 'The faucet is dripping.',
    photoUrls: [],
    escalationFlags: [],
    facts: [],
    state: 'REVIEW',
    tier: 'N',
    tenantName: 'Test Tenant',
    ...overrides,
  };
}

function makeValidPacket(wo: TriageWO, messageBytes = 'We have received your request.'): ActionPacket {
  const result = buildPacket(wo, { purpose: 'ACK', messageBytes });
  if (!result.packet) throw new Error('Failed to build packet for test');
  return result.packet;
}

describe('review-gate-runner', () => {
  describe('ALLOW scenarios', () => {
    it('allows SEND_TENANT ACK at Phase 1 for tier N', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
      expect(output.shadowRecord).not.toBeNull();
      expect(output.escalated).toBe(false);
    });

    it('allows WO_ASSIGNMENT at Phase 0', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
    });

    it('allows INTERNAL_NOTE_REVIEWED at Phase 0', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'INTERNAL_NOTE_REVIEWED' });

      expect(output.gateResult.decision).toBe('ALLOW');
    });
  });

  describe('terminal invariant recheck at review entry', () => {
    it('escalates when WO has mold at review time', () => {
      const wo = makeWO({ conversationText: 'There is mold all over the walls' });
      const safeWO = makeWO();
      const packet = makeValidPacket(safeWO);
      packet.woId = wo.woId;
      packet.conversationFingerprint = 'stale';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('ESCALATE');
      expect(output.shadowRecord).toBeNull();
      expect(output.escalated).toBe(true);
    });

    it('escalates when WO changes to E0 after packet was built', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      wo.conversationText = 'The electrical panel is arcing.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('ESCALATE');
      expect(output.shadowRecord).toBeNull();
      expect(output.escalated).toBe(true);
    });

    it('escalates scope-excluded WO at review entry', () => {
      const wo = makeWO({ propertyAddress: '100 Belvedere Dr' });
      const safeWO = makeWO();
      const packet = makeValidPacket(safeWO);
      packet.woId = wo.woId;
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.escalated).toBe(true);
      expect(output.shadowRecord).toBeNull();
    });
  });

  describe('packet authority validation', () => {
    it('denies cross-WO packet', () => {
      const wo = makeWO({ woId: 'WO-current' });
      const packet = makeValidPacket(wo);
      packet.woId = 'WO-other';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('packet-authority');
    });

    it('denies expired packet', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.expiresAt = '2000-01-01T00:00:00.000Z';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('packet-authority');
    });

    it('denies malformed expiresAt', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.expiresAt = 'not-a-date';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies packet with wrong recipient', () => {
      const wo = makeWO({ tenantName: 'Real Tenant' });
      const packet = makeValidPacket(wo);
      packet.recipient = 'Wrong Person';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies packet with fallback "tenant" recipient', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.recipient = 'tenant';
      packet.recipientRole = 'tenant';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies wrong recipientRole for purpose', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.recipientRole = 'vendor';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies email channel for tenant purpose', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.channel = 'email';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies combined cross-WO, expired, wrong-recipient packet', () => {
      const wo = makeWO({ woId: 'WO-current', tenantName: 'Real Tenant' });
      const packet = makeValidPacket(wo);
      packet.woId = 'WO-other';
      packet.recipient = 'wrong-recipient';
      packet.recipientRole = 'vendor';
      packet.channel = 'email';
      packet.expiresAt = '2000-01-01T00:00:00.000Z';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });
  });

  describe('source freshness validation', () => {
    it('denies stale packet after WO source changes', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      wo.conversationText = 'Completely different text now about a new issue.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).not.toBe('PASS');
      expect(output.gateResult.rule).toBe('source-freshness');
    });

    it('denies packet with tampered facts (hash mismatch)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.facts.push({
        type: 'system_fact', source: 'attacker', value: 'Tenant admitted fault',
        confidence: 1, timestamp: new Date().toISOString(),
      });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('source-freshness');
    });
  });

  describe('content validation (allowlist model)', () => {
    it('denies internal classification labels in tenant content', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'We classified your request as tier N with trade PLUMBING and low priority.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('content-validation');
    });

    it('denies responsibility/chargeback language', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'This damage is your fault and you will be charged for the repair.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies entry/access authority claims', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'We have permission and will enter your unit even if you are away.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies schedule promises', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'Your appointment is Friday.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies "the repair bill is yours" paraphrase', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'The repair bill is yours.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies "let ourselves into" paraphrase', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'We can let ourselves into the apartment.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies "technician is booked" paraphrase', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'The technician is booked Friday.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies free-form content not in allowlist', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo, 'Sounds good, someone will handle it.');
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.verdict.result).toBe('FAIL');
    });

    it('allows approved ACK template', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });
      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
    });
  });

  describe('shadow record', () => {
    it('creates shadow record with correct structure on PASS', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      expect(output.shadowRecord).not.toBeNull();
      const record = output.shadowRecord!;
      expect(record.woId).toBe('WO-4000');
      expect(record.packetHash).toHaveLength(64);
      expect(record.timestamp).toBeTruthy();
      expect(record.reviewResult.reviewerVersion).toBe(REVIEWER_VERSION);
    });

    it('shadow record packet is immutable (Object.freeze)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      expect(output.shadowRecord).not.toBeNull();
      expect(() => {
        output.shadowRecord!.shadowVerdict.messageBytes = 'MUTATED AFTER REVIEW';
      }).toThrow();
    });

    it('does not create shadow record on FAIL', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.woId = 'WO-wrong';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.shadowRecord).toBeNull();
    });

    it('does not create shadow record on terminal escalation', () => {
      const wo = makeWO({ conversationText: 'There is mold in the bathroom' });
      const safeWO = makeWO();
      const packet = makeValidPacket(safeWO);
      packet.woId = wo.woId;
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.shadowRecord).toBeNull();
      expect(output.escalated).toBe(true);
    });
  });

  describe('capability matrix DENY', () => {
    it('denies VENDOR_DISPATCH (permanent deny)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 3, actionType: 'VENDOR_DISPATCH' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies SEND_TENANT at Phase 0', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });
  });

  describe('reviewer version', () => {
    it('includes reviewer version in all verdicts', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });
      expect(output.verdict.reviewerVersion).toBe(REVIEWER_VERSION);
    });
  });

  describe('injectable reviewer boundary', () => {
    it('uses injected reviewer when provided', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const customReviewer = () => ({
        result: 'FAIL' as const,
        violations: ['Custom reviewer rejects'],
        reviewerVersion: 'custom-v1',
        reviewedAt: new Date().toISOString(),
      });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT', reviewer: customReviewer });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('independent-review');
    });

    it('fails closed when reviewer throws', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const throwingReviewer = () => { throw new Error('reviewer crashed'); };
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT', reviewer: throwingReviewer });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('independent-review');
    });

    it('fails closed when reviewer returns malformed result', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const malformedReviewer = (() => ({ bad: 'data' })) as any;
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT', reviewer: malformedReviewer });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('independent-review');
    });

    it('fails closed when reviewer is explicitly null (unavailable)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT', reviewer: null as any });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('independent-review');
    });

    it('records independent review result on PASS', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('PASS');
      expect(output.independentReview).toBeDefined();
      expect(output.independentReview!.result).toBe('PASS');
    });

    it('records independent review result on FAIL', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const rejectingReviewer = () => ({
        result: 'FAIL' as const,
        violations: ['Reviewer says no'],
        reviewerVersion: 'test-v1',
        reviewedAt: new Date().toISOString(),
      });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT', reviewer: rejectingReviewer });

      expect(output.independentReview).toBeDefined();
      expect(output.independentReview!.result).toBe('FAIL');
    });
  });
});

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

function makeValidPacket(wo: TriageWO, overrides: Partial<ActionPacket> = {}): ActionPacket {
  const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'We received your request.' });
  if (!result.packet) throw new Error('Failed to build packet for test');
  return { ...result.packet, ...overrides };
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

  describe('DENY scenarios — capability matrix', () => {
    it('denies VENDOR_DISPATCH (permanent deny)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 3, actionType: 'VENDOR_DISPATCH' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies SEND_TENANT at Phase 0 (not in phase actions)', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies SPEND_APPROVE (permanent deny)', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 3, actionType: 'SPEND_APPROVE' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });
  });

  describe('DENY scenarios — packet authority validation', () => {
    it('denies cross-WO packet (packet WO != current WO)', () => {
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

  describe('DENY scenarios — content validation', () => {
    it('denies internal classification labels in tenant content', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'We classified your request as tier N with trade PLUMBING and low priority.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.gateResult.rule).toBe('content-validation');
    });

    it('denies responsibility/chargeback language', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'This damage is your fault and you will be charged for the repair.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies entry/access authority claims', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'We have permission and will enter your unit even if you are away.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies schedule promises', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'Your appointment is Friday.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies legal/health commitment language', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'This is a habitability issue and we are legally required to fix it within 24 hours.';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
    });

    it('allows clean ACK content', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.messageBytes = 'Thank you for letting us know. We have received your maintenance request.';
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

    it('shadow record packet is an immutable deep copy', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      packet.messageBytes = 'MUTATED';
      expect(output.shadowRecord!.shadowVerdict.messageBytes).not.toBe('MUTATED');
    });

    it('does not create shadow record on FAIL', () => {
      const wo = makeWO();
      const packet = makeValidPacket(wo);
      packet.woId = 'WO-wrong';
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.verdict.result).toBe('FAIL');
      expect(output.shadowRecord).toBeNull();
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
});

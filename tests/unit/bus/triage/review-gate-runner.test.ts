import { describe, it, expect } from 'vitest';
import { runReviewGate } from '../../../../src/bus/triage/review-gate-runner';
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
    ...overrides,
  };
}

function makePacket(overrides: Partial<ActionPacket> = {}): ActionPacket {
  return {
    woId: 'WO-4000',
    recipient: 'tenant',
    recipientRole: 'tenant',
    channel: 'appfolio_wo_message',
    messageBytes: 'We received your request.',
    purpose: 'ACK',
    facts: [],
    escalationFlags: [],
    tier: 'N',
    policyVersion: 0,
    conversationFingerprint: 'abc123',
    issuedAt: '2026-01-01T00:00:00Z',
    expiresAt: '2026-01-04T00:00:00Z',
    nonce: 'test-nonce-1234',
    ...overrides,
  };
}

describe('review-gate-runner', () => {
  describe('ALLOW scenarios', () => {
    it('allows SEND_TENANT ACK at Phase 1 for tier N', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makePacket({ purpose: 'ACK' });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
      expect(output.shadowResult.record).not.toBeNull();
      expect(output.shadowResult.escalated).toBe(false);
    });

    it('allows WO_ASSIGNMENT at Phase 0', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makePacket({ purpose: 'ACK' });
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
    });

    it('allows INTERNAL_NOTE_REVIEWED at Phase 0', () => {
      const wo = makeWO();
      const packet = makePacket();
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'INTERNAL_NOTE_REVIEWED' });

      expect(output.gateResult.decision).toBe('ALLOW');
    });

    it('allows DIY_OFFER at Phase 2 for tier N', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makePacket({ purpose: 'DIY_OFFER' });
      const output = runReviewGate({ wo, packet, phase: 2, actionType: 'DIY_OFFER' });

      expect(output.gateResult.decision).toBe('ALLOW');
      expect(output.verdict.result).toBe('PASS');
    });
  });

  describe('DENY scenarios', () => {
    it('denies VENDOR_DISPATCH (permanent deny)', () => {
      const wo = makeWO();
      const packet = makePacket({ purpose: 'VENDOR_DISPATCH' });
      const output = runReviewGate({ wo, packet, phase: 3, actionType: 'VENDOR_DISPATCH' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
      expect(output.verdict.reasons[0]).toContain('DENY');
    });

    it('denies SEND_TENANT at Phase 0 (not in phase actions)', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makePacket({ purpose: 'ACK' });
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });

    it('denies SEND_TENANT for E0 tier at Phase 1', () => {
      const wo = makeWO({ tier: 'E0' });
      const packet = makePacket({ purpose: 'ACK' });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.gateResult.decision).toBe('DENY');
    });

    it('denies SPEND_APPROVE (permanent deny)', () => {
      const wo = makeWO();
      const packet = makePacket();
      const output = runReviewGate({ wo, packet, phase: 3, actionType: 'SPEND_APPROVE' });

      expect(output.gateResult.decision).toBe('DENY');
      expect(output.verdict.result).toBe('FAIL');
    });
  });

  describe('reclassification', () => {
    it('records reclassification in verdict reasons', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = makePacket({
        purpose: 'ACK',
        messageBytes: 'We will schedule someone to come out next Tuesday.',
      });
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      if (output.gateResult.reclassified) {
        expect(output.verdict.reasons.some(r => r.includes('reclassified'))).toBe(true);
      }
    });
  });

  describe('escalation via terminal invariants', () => {
    it('escalates mold WO during shadow record creation', () => {
      const wo = makeWO({
        conversationText: 'There is mold all over the bathroom walls',
        tier: 'N',
      });
      const packet = makePacket();
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.shadowResult.escalated).toBe(true);
      expect(output.shadowResult.record).toBeNull();
    });

    it('escalates scope-excluded properties', () => {
      const wo = makeWO({
        propertyAddress: '100 Belvedere Dr',
        tier: 'N',
      });
      const packet = makePacket();
      const output = runReviewGate({ wo, packet, phase: 1, actionType: 'SEND_TENANT' });

      expect(output.shadowResult.escalated).toBe(true);
    });
  });

  describe('shadow record creation', () => {
    it('creates shadow record with correct structure', () => {
      const wo = makeWO();
      const packet = makePacket();
      const output = runReviewGate({ wo, packet, phase: 0, actionType: 'WO_ASSIGNMENT' });

      expect(output.shadowResult.record).not.toBeNull();
      const record = output.shadowResult.record!;
      expect(record.woId).toBe('WO-4000');
      expect(record.shadowVerdict).toBe(packet);
      expect(record.reviewResult).toBe(output.verdict);
      expect(record.timestamp).toBeTruthy();
    });
  });
});

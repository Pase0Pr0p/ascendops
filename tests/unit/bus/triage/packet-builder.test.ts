import { describe, it, expect } from 'vitest';
import { buildPacket, computeFingerprint } from '../../../../src/bus/triage/packet-builder';
import type { TriageWO } from '../../../../src/bus/triage/types';

function makeWO(overrides: Partial<TriageWO> = {}): TriageWO {
  return {
    woId: 'WO-3000',
    propertyAddress: '456 Oak Ave',
    conversationText: 'The faucet is leaking in the bathroom.',
    photoUrls: [],
    escalationFlags: [],
    facts: [{ type: 'system_fact', source: 'wo_metadata', value: 'WO ID: WO-3000', confidence: 1.0, timestamp: '2026-01-01T00:00:00Z' }],
    state: 'DRAFTING',
    tier: 'N',
    tenantName: 'Test Tenant',
    ...overrides,
  };
}

describe('packet-builder', () => {
  describe('buildPacket', () => {
    it('builds a complete packet', () => {
      const wo = makeWO();
      const result = buildPacket(wo, {
        purpose: 'ACK',
        messageBytes: 'We received your request and will look into it.',
      });

      expect(result.rejected).toBe(false);
      expect(result.packet).not.toBeNull();
      const packet = result.packet!;
      expect(packet.woId).toBe('WO-3000');
      expect(packet.purpose).toBe('ACK');
      expect(packet.messageBytes).toBe('We received your request and will look into it.');
      expect(packet.tier).toBe('N');
      expect(packet.nonce).toHaveLength(32);
      expect(packet.conversationFingerprint).toHaveLength(16);
      expect(packet.canonicalHash).toHaveLength(64);
      expect(packet.issuedAt).toBeTruthy();
      expect(packet.expiresAt).toBeTruthy();
    });

    it('resolves tenant recipient for ACK purpose', () => {
      const wo = makeWO({ tenantName: 'John Smith' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'Acknowledged.' });
      expect(result.packet!.recipient).toBe('John Smith');
      expect(result.packet!.recipientRole).toBe('tenant');
    });

    it('resolves tenant recipient for INFO_REQUEST purpose', () => {
      const wo = makeWO({ tenantName: 'Jane Doe' });
      const result = buildPacket(wo, { purpose: 'INFO_REQUEST', messageBytes: 'Can you send photos?' });
      expect(result.packet!.recipient).toBe('Jane Doe');
      expect(result.packet!.recipientRole).toBe('tenant');
    });

    it('resolves albie for ESCALATION purpose', () => {
      const wo = makeWO();
      const result = buildPacket(wo, { purpose: 'ESCALATION', messageBytes: 'Needs review.' });
      expect(result.packet!.recipient).toBe('albie');
      expect(result.packet!.recipientRole).toBe('operations_manager');
    });

    it('resolves albie for VENDOR_DISPATCH purpose', () => {
      const wo = makeWO();
      const result = buildPacket(wo, { purpose: 'VENDOR_DISPATCH', messageBytes: 'Dispatch plumber.' });
      expect(result.packet!.recipient).toBe('albie');
      expect(result.packet!.recipientRole).toBe('operations_manager');
    });

    it('rejects packet when tenantName is missing for tenant-facing purpose', () => {
      const wo = makeWO({ tenantName: undefined });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(result.rejected).toBe(true);
      expect(result.packet).toBeNull();
      expect(result.rejectReason).toContain('Unknown tenant identity');
    });

    it('resolves appfolio_wo_message channel for tenant comms', () => {
      const result = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.' });
      expect(result.packet!.channel).toBe('appfolio_wo_message');
    });

    it('resolves telegram channel for escalation', () => {
      const result = buildPacket(makeWO(), { purpose: 'ESCALATION', messageBytes: 'Needs review.' });
      expect(result.packet!.channel).toBe('telegram');
    });

    it('rejects unauthorized channel override for tenant purpose', () => {
      const result = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', channel: 'email' });
      expect(result.rejected).toBe(true);
      expect(result.packet).toBeNull();
      expect(result.rejectReason).toContain('not authorized');
    });

    it('rejects unauthorized channel override for escalation', () => {
      const result = buildPacket(makeWO(), { purpose: 'ESCALATION', messageBytes: 'X.', channel: 'email' });
      expect(result.rejected).toBe(true);
      expect(result.packet).toBeNull();
    });

    it('copies escalation flags from WO', () => {
      const wo = makeWO({ escalationFlags: ['VULNERABLE_OCCUPANT', 'REPEAT_FAILURE'] });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(result.packet!.escalationFlags).toEqual(['VULNERABLE_OCCUPANT', 'REPEAT_FAILURE']);
    });

    it('copies facts from WO', () => {
      const wo = makeWO();
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(result.packet!.facts).toHaveLength(1);
      expect(result.packet!.facts[0].value).toBe('WO ID: WO-3000');
    });

    it('does not share reference with WO arrays', () => {
      const wo = makeWO();
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      result.packet!.facts.push({ type: 'system_fact', source: 'test', value: 'extra', confidence: 1, timestamp: '' });
      expect(wo.facts).toHaveLength(1);
    });

    it('sets policyVersion from options', () => {
      const result = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', policyVersion: 5 });
      expect(result.packet!.policyVersion).toBe(5);
    });

    it('defaults policyVersion to 0', () => {
      const result = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.' });
      expect(result.packet!.policyVersion).toBe(0);
    });

    it('includes cardId when provided', () => {
      const result = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', cardId: 'card-123' });
      expect(result.packet!.cardId).toBe('card-123');
    });

    it('generates unique nonces', () => {
      const wo = makeWO();
      const p1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const p2 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(p1.packet!.nonce).not.toBe(p2.packet!.nonce);
    });

    it('generates deterministic fingerprint for same WO content', () => {
      const wo = makeWO();
      const p1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const p2 = buildPacket(wo, { purpose: 'INFO_REQUEST', messageBytes: 'Photos?' });
      expect(p1.packet!.conversationFingerprint).toBe(p2.packet!.conversationFingerprint);
    });
  });

  describe('fingerprint material coverage', () => {
    it('changes when tenant changes', () => {
      const wo1 = makeWO({ tenantName: 'Tenant A' });
      const wo2 = makeWO({ tenantName: 'Tenant B' });
      expect(computeFingerprint(wo1)).not.toBe(computeFingerprint(wo2));
    });

    it('changes when unit changes', () => {
      const wo1 = makeWO({ unitId: '1A' });
      const wo2 = makeWO({ unitId: '9Z' });
      expect(computeFingerprint(wo1)).not.toBe(computeFingerprint(wo2));
    });

    it('changes when photos change', () => {
      const wo1 = makeWO({ photoUrls: ['https://example.com/old.jpg'] });
      const wo2 = makeWO({ photoUrls: ['https://example.com/new.jpg'] });
      expect(computeFingerprint(wo1)).not.toBe(computeFingerprint(wo2));
    });

    it('changes when vision analysis changes', () => {
      const wo1 = makeWO({ visionAnalysis: 'No visible water.' });
      const wo2 = makeWO({ visionAnalysis: 'Possible active mold.' });
      expect(computeFingerprint(wo1)).not.toBe(computeFingerprint(wo2));
    });

    it('changes when conversation text changes', () => {
      const wo1 = makeWO({ conversationText: 'Leak in kitchen' });
      const wo2 = makeWO({ conversationText: 'Leak in bathroom' });
      expect(computeFingerprint(wo1)).not.toBe(computeFingerprint(wo2));
    });
  });

  describe('expiry by tier', () => {
    it('E0 expires in 1 hour', () => {
      const wo = makeWO({ tier: 'E0' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(1, 0);
    });

    it('E1 expires in 4 hours', () => {
      const wo = makeWO({ tier: 'E1' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(4, 0);
    });

    it('U expires in 24 hours', () => {
      const wo = makeWO({ tier: 'U' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(24, 0);
    });

    it('N expires in 72 hours', () => {
      const wo = makeWO({ tier: 'N' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(72, 0);
    });

    it('D expires in 168 hours', () => {
      const wo = makeWO({ tier: 'D' });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(168, 0);
    });

    it('defaults to 72 hours when tier is undefined', () => {
      const wo = makeWO({ tier: undefined });
      const result = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(result.packet!.issuedAt);
      const expires = new Date(result.packet!.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(72, 0);
    });
  });

  describe('canonical hash', () => {
    it('produces consistent hash for same packet content', () => {
      const wo = makeWO();
      const r1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(r1.packet!.canonicalHash).toHaveLength(64);
    });

    it('hash changes when message content differs', () => {
      const wo = makeWO();
      const r1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'Hello.' });
      const r2 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'Goodbye.' });
      expect(r1.packet!.canonicalHash).not.toBe(r2.packet!.canonicalHash);
    });
  });
});

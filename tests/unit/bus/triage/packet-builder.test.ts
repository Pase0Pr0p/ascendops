import { describe, it, expect } from 'vitest';
import { buildPacket } from '../../../../src/bus/triage/packet-builder';
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
    ...overrides,
  };
}

describe('packet-builder', () => {
  describe('buildPacket', () => {
    it('builds a complete packet', () => {
      const wo = makeWO();
      const packet = buildPacket(wo, {
        purpose: 'ACK',
        messageBytes: 'We received your request and will look into it.',
      });

      expect(packet.woId).toBe('WO-3000');
      expect(packet.purpose).toBe('ACK');
      expect(packet.messageBytes).toBe('We received your request and will look into it.');
      expect(packet.tier).toBe('N');
      expect(packet.nonce).toHaveLength(32);
      expect(packet.conversationFingerprint).toHaveLength(16);
      expect(packet.issuedAt).toBeTruthy();
      expect(packet.expiresAt).toBeTruthy();
    });

    it('resolves tenant recipient for ACK purpose', () => {
      const wo = makeWO({ tenantName: 'John Smith' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'Acknowledged.' });
      expect(packet.recipient).toBe('John Smith');
      expect(packet.recipientRole).toBe('tenant');
    });

    it('resolves tenant recipient for INFO_REQUEST purpose', () => {
      const wo = makeWO({ tenantName: 'Jane Doe' });
      const packet = buildPacket(wo, { purpose: 'INFO_REQUEST', messageBytes: 'Can you send photos?' });
      expect(packet.recipient).toBe('Jane Doe');
      expect(packet.recipientRole).toBe('tenant');
    });

    it('resolves albie for ESCALATION purpose', () => {
      const wo = makeWO();
      const packet = buildPacket(wo, { purpose: 'ESCALATION', messageBytes: 'Needs review.' });
      expect(packet.recipient).toBe('albie');
      expect(packet.recipientRole).toBe('operations_manager');
    });

    it('resolves albie for VENDOR_DISPATCH purpose', () => {
      const wo = makeWO();
      const packet = buildPacket(wo, { purpose: 'VENDOR_DISPATCH', messageBytes: 'Dispatch plumber.' });
      expect(packet.recipient).toBe('albie');
      expect(packet.recipientRole).toBe('operations_manager');
    });

    it('uses fallback tenant when tenantName is missing', () => {
      const wo = makeWO({ tenantName: undefined });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(packet.recipient).toBe('tenant');
    });

    it('resolves appfolio_wo_message channel for tenant comms', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.' });
      expect(packet.channel).toBe('appfolio_wo_message');
    });

    it('resolves telegram channel for escalation', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ESCALATION', messageBytes: 'Needs review.' });
      expect(packet.channel).toBe('telegram');
    });

    it('uses explicit channel override', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', channel: 'sms' });
      expect(packet.channel).toBe('sms');
    });

    it('copies escalation flags from WO', () => {
      const wo = makeWO({ escalationFlags: ['VULNERABLE_OCCUPANT', 'REPEAT_FAILURE'] });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(packet.escalationFlags).toEqual(['VULNERABLE_OCCUPANT', 'REPEAT_FAILURE']);
    });

    it('copies facts from WO', () => {
      const wo = makeWO();
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(packet.facts).toHaveLength(1);
      expect(packet.facts[0].value).toBe('WO ID: WO-3000');
    });

    it('does not share reference with WO arrays', () => {
      const wo = makeWO();
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      packet.facts.push({ type: 'system_fact', source: 'test', value: 'extra', confidence: 1, timestamp: '' });
      expect(wo.facts).toHaveLength(1);
    });

    it('sets policyVersion from options', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', policyVersion: 5 });
      expect(packet.policyVersion).toBe(5);
    });

    it('defaults policyVersion to 0', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.' });
      expect(packet.policyVersion).toBe(0);
    });

    it('includes cardId when provided', () => {
      const packet = buildPacket(makeWO(), { purpose: 'ACK', messageBytes: 'OK.', cardId: 'card-123' });
      expect(packet.cardId).toBe('card-123');
    });

    it('generates unique nonces', () => {
      const wo = makeWO();
      const p1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const p2 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      expect(p1.nonce).not.toBe(p2.nonce);
    });

    it('generates deterministic fingerprint for same WO content', () => {
      const wo = makeWO();
      const p1 = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const p2 = buildPacket(wo, { purpose: 'INFO_REQUEST', messageBytes: 'Photos?' });
      expect(p1.conversationFingerprint).toBe(p2.conversationFingerprint);
    });
  });

  describe('expiry by tier', () => {
    it('E0 expires in 1 hour', () => {
      const wo = makeWO({ tier: 'E0' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(1, 0);
    });

    it('E1 expires in 4 hours', () => {
      const wo = makeWO({ tier: 'E1' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(4, 0);
    });

    it('U expires in 24 hours', () => {
      const wo = makeWO({ tier: 'U' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(24, 0);
    });

    it('N expires in 72 hours', () => {
      const wo = makeWO({ tier: 'N' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(72, 0);
    });

    it('D expires in 168 hours', () => {
      const wo = makeWO({ tier: 'D' });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(168, 0);
    });

    it('defaults to 72 hours when tier is undefined', () => {
      const wo = makeWO({ tier: undefined });
      const packet = buildPacket(wo, { purpose: 'ACK', messageBytes: 'OK.' });
      const issued = new Date(packet.issuedAt);
      const expires = new Date(packet.expiresAt);
      const hours = (expires.getTime() - issued.getTime()) / (1000 * 60 * 60);
      expect(hours).toBeCloseTo(72, 0);
    });
  });
});

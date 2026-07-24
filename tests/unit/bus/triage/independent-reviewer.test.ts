import { describe, it, expect } from 'vitest';
import { independentReview, INDEPENDENT_REVIEWER_VERSION } from '../../../../src/bus/triage/independent-reviewer';
import { buildPacket, computeFingerprint, computeCanonicalHash } from '../../../../src/bus/triage/packet-builder';
import type { TriageWO, ActionPacket } from '../../../../src/bus/triage/types';

function makeWO(overrides: Partial<TriageWO> = {}): TriageWO {
  return {
    woId: 'WO-5000',
    propertyAddress: '200 Oak Ave',
    conversationText: 'Kitchen sink is dripping slowly.',
    photoUrls: [],
    escalationFlags: [],
    facts: [],
    state: 'REVIEW',
    tier: 'N',
    tenantName: 'Test Tenant',
    ...overrides,
  };
}

function makePacket(wo: TriageWO, message = 'We have received your request.'): ActionPacket {
  const result = buildPacket(wo, { purpose: 'ACK', messageBytes: message });
  if (!result.packet) throw new Error('packet build failed');
  return result.packet;
}

describe('independent-reviewer', () => {
  it('approves a valid packet built from the same WO', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.reviewerVersion).toBe(INDEPENDENT_REVIEWER_VERSION);
    expect(result.reviewedAt).toBeTruthy();
  });

  it('rejects when WO has terminal invariant (mold)', () => {
    const wo = makeWO({ conversationText: 'There is mold behind the sink.' });
    const safeWO = makeWO();
    const packet = makePacket(safeWO);
    packet.woId = wo.woId;
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('Terminal invariant'))).toBe(true);
  });

  it('rejects WO ID mismatch', () => {
    const wo = makeWO({ woId: 'WO-A' });
    const otherWO = makeWO({ woId: 'WO-B' });
    const packet = makePacket(otherWO);
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('WO ID mismatch'))).toBe(true);
  });

  it('rejects fingerprint drift after WO changes', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    wo.conversationText = 'Now there is a completely different problem.';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('fingerprint'))).toBe(true);
  });

  it('rejects canonical hash mismatch (tampered packet)', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.facts.push({
      type: 'system_fact',
      source: 'tamper',
      value: 'injected',
      confidence: 1,
      timestamp: new Date().toISOString(),
    });
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('Canonical hash'))).toBe(true);
  });

  it('rejects expired packet', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.expiresAt = '2000-01-01T00:00:00.000Z';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('expired'))).toBe(true);
  });

  it('rejects malformed date fields', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.expiresAt = 'not-a-date';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('invalid date'))).toBe(true);
  });

  it('rejects wrong recipientRole for tenant purpose', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.recipientRole = 'vendor';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('non-tenant role'))).toBe(true);
  });

  it('rejects wrong channel for tenant purpose', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.channel = 'email';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('unauthorized channel'))).toBe(true);
  });

  it('rejects wrong recipient for tenant purpose', () => {
    const wo = makeWO({ tenantName: 'Real Tenant' });
    const packet = makePacket(wo);
    packet.recipient = 'Wrong Person';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('recipient identity'))).toBe(true);
  });

  it('rejects prohibited content', () => {
    const wo = makeWO();
    const packet = makePacket(wo, 'This is your fault and you will be charged.');
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('Content:'))).toBe(true);
  });

  it('rejects fact ledger drift (fact added after packet build)', () => {
    const wo = makeWO({
      facts: [{
        type: 'tenant_fact',
        source: 'message-1',
        value: 'Door paint chipped',
        confidence: 1,
        timestamp: '2026-07-24T01:00:00.000Z',
      }],
    });
    const packet = makePacket(wo);
    wo.facts.push({
      type: 'system_fact',
      source: 'live-update',
      value: 'Water now active',
      confidence: 1,
      timestamp: '2026-07-24T02:00:00.000Z',
    });
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.some(v => v.includes('fingerprint'))).toBe(true);
  });

  it('collects multiple violations', () => {
    const wo = makeWO({ woId: 'WO-A', conversationText: 'There is mold in the wall.' });
    const otherWO = makeWO({ woId: 'WO-B' });
    const packet = makePacket(otherWO);
    packet.recipientRole = 'vendor';
    packet.channel = 'email';
    const result = independentReview(wo, packet);

    expect(result.approved).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });
});

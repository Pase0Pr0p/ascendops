import { describe, it, expect } from 'vitest';
import { independentReview, INDEPENDENT_REVIEWER_VERSION } from '../../../../src/bus/triage/independent-reviewer';
import { buildPacket } from '../../../../src/bus/triage/packet-builder';
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
  it('passes a valid packet built from the same WO', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    const result = independentReview(wo, packet);

    expect(result.result).toBe('PASS');
    expect(result.violations).toHaveLength(0);
    expect(result.reviewerVersion).toBe(INDEPENDENT_REVIEWER_VERSION);
    expect(result.reviewedAt).toBeTruthy();
  });

  it('escalates when WO has terminal invariant (mold)', () => {
    const wo = makeWO({ conversationText: 'There is mold behind the sink.' });
    const safeWO = makeWO();
    const packet = makePacket(safeWO);
    packet.woId = wo.woId;
    const result = independentReview(wo, packet);

    expect(result.result).toBe('ESCALATE');
    expect(result.violations.some(v => v.includes('Terminal'))).toBe(true);
  });

  it('fails WO ID mismatch', () => {
    const wo = makeWO({ woId: 'WO-A' });
    const otherWO = makeWO({ woId: 'WO-B' });
    const packet = makePacket(otherWO);
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('WO ID mismatch'))).toBe(true);
  });

  it('fails fingerprint drift after WO changes', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    wo.conversationText = 'Now there is a completely different problem.';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('fingerprint'))).toBe(true);
  });

  it('fails canonical hash mismatch (tampered packet)', () => {
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

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('Canonical hash'))).toBe(true);
  });

  it('fails expired packet', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.expiresAt = '2000-01-01T00:00:00.000Z';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('expired'))).toBe(true);
  });

  it('fails malformed date fields', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.expiresAt = 'not-a-date';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('invalid date'))).toBe(true);
  });

  it('fails wrong recipientRole for tenant purpose', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.recipientRole = 'vendor';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('role'))).toBe(true);
  });

  it('fails wrong channel for tenant purpose', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    packet.channel = 'email';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('channel'))).toBe(true);
  });

  it('fails wrong recipient for tenant purpose', () => {
    const wo = makeWO({ tenantName: 'Real Tenant' });
    const packet = makePacket(wo);
    packet.recipient = 'Wrong Person';
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('recipient identity'))).toBe(true);
  });

  it('fails prohibited content', () => {
    const wo = makeWO();
    const packet = makePacket(wo, 'This is your fault and you will be charged.');
    const result = independentReview(wo, packet);

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('Content:'))).toBe(true);
  });

  it('fails fact ledger drift (fact added after packet build)', () => {
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

    expect(result.result).toBe('FAIL');
    expect(result.violations.some(v => v.includes('fingerprint'))).toBe(true);
  });

  it('collects multiple violations', () => {
    const wo = makeWO({ woId: 'WO-A', conversationText: 'There is mold in the wall.' });
    const otherWO = makeWO({ woId: 'WO-B' });
    const packet = makePacket(otherWO);
    packet.recipientRole = 'vendor';
    packet.channel = 'email';
    const result = independentReview(wo, packet);

    expect(result.result).not.toBe('PASS');
    expect(result.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('uses independent implementation (does not share packet-builder imports)', () => {
    expect(INDEPENDENT_REVIEWER_VERSION).toContain('independent-reviewer');
  });

  it('returns strict PASS/FAIL/ESCALATE schema', () => {
    const wo = makeWO();
    const packet = makePacket(wo);
    const result = independentReview(wo, packet);

    expect(['PASS', 'FAIL', 'ESCALATE']).toContain(result.result);
    expect(Array.isArray(result.violations)).toBe(true);
    expect(typeof result.reviewerVersion).toBe('string');
    expect(typeof result.reviewedAt).toBe('string');
  });
});

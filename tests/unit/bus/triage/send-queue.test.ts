import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueue, drainOnKillswitch, drainOnVersionChange,
  markSent, getQueue, getQueuedCount, clearQueue, checkAndDrain,
} from '../../../../src/bus/triage/send-queue';
import { resetLastSeenVersion } from '../../../../src/bus/triage/policy-config';
import type { ActionPacket } from '../../../../src/bus/triage/types';

function makePacket(overrides: Partial<ActionPacket> = {}): ActionPacket {
  return {
    woId: 'WO-1000',
    recipient: 'tenant@example.com',
    recipientRole: 'tenant',
    channel: 'email',
    messageBytes: 'Your faucet repair is scheduled.',
    purpose: 'ACK',
    facts: [],
    escalationFlags: [],
    policyVersion: 1,
    conversationFingerprint: 'abc123',
    issuedAt: '2026-07-23T00:00:00Z',
    expiresAt: '2026-07-23T01:00:00Z',
    nonce: 'nonce-1',
    ...overrides,
  };
}

describe('send queue', () => {
  beforeEach(() => {
    clearQueue();
  });

  describe('AT-11: killswitch cancels all queued sends', () => {
    it('drainOnKillswitch cancels all QUEUED items', () => {
      enqueue(makePacket({ woId: 'WO-1' }), 1);
      enqueue(makePacket({ woId: 'WO-2' }), 1);
      enqueue(makePacket({ woId: 'WO-3' }), 1);
      expect(getQueuedCount()).toBe(3);

      const result = drainOnKillswitch('Global killswitch activated');
      expect(result.cancelled).toBe(3);
      expect(getQueuedCount()).toBe(0);

      for (const item of result.items) {
        expect(item.status).toBe('CANCELLED');
        expect(item.cancelReason).toBe('Global killswitch activated');
        expect(item.cancelledAt).toBeDefined();
      }
    });

    it('drainOnKillswitch does not cancel already-sent items', () => {
      const sent = enqueue(makePacket({ woId: 'WO-1' }), 1);
      markSent(sent);
      enqueue(makePacket({ woId: 'WO-2' }), 1);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(1);
      expect(getQueue().find(e => e.packet.woId === 'WO-1')!.status).toBe('SENT');
      expect(getQueue().find(e => e.packet.woId === 'WO-2')!.status).toBe('CANCELLED');
    });

    it('checkAndDrain cancels queue when config file is missing', () => {
      enqueue(makePacket(), 1);
      enqueue(makePacket(), 1);
      const result = checkAndDrain('/nonexistent/path/config.json');
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(2);
      expect(getQueuedCount()).toBe(0);
    });

    it('checkAndDrain cancels queue when global_auto_send is false', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const configPath = join(tmp, 'policy.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: false, cards: {},
      }));

      enqueue(makePacket(), 1);
      const result = checkAndDrain(configPath);
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(1);

      rmSync(tmp, { recursive: true, force: true });
    });

    it('checkAndDrain returns null when config is valid and enabled', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const configPath = join(tmp, 'policy.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: true, cards: {},
      }));

      enqueue(makePacket(), 1);
      resetLastSeenVersion();
      const result = checkAndDrain(configPath);
      expect(result).toBeNull();
      expect(getQueuedCount()).toBe(1);

      rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe('version-change drain', () => {
    it('cancels items queued under old version when config advances', () => {
      enqueue(makePacket({ woId: 'WO-old-1' }), 1);
      enqueue(makePacket({ woId: 'WO-old-2' }), 1);
      enqueue(makePacket({ woId: 'WO-new' }), 2);

      const result = drainOnVersionChange(2, 'Config version advanced to 2');
      expect(result.cancelled).toBe(2);
      expect(getQueuedCount()).toBe(1);
      expect(getQueue().find(e => e.status === 'QUEUED')!.packet.woId).toBe('WO-new');
    });
  });
});

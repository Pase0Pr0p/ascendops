import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueue, drainOnKillswitch, drainOnVersionChange,
  markSent, reserveForSend, releaseNonce,
  getQueue, getQueuedCount, getInFlightCount, getActiveCount,
  clearQueue, checkAndDrain,
} from '../../../../src/bus/triage/send-queue';
import { resetLastSeenVersion, setVersionFilePath } from '../../../../src/bus/triage/policy-config';
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

  describe('nonce reserve/release lifecycle', () => {
    it('reserves a QUEUED entry to IN_FLIGHT', () => {
      const entry = enqueue(makePacket(), 1);
      expect(entry.status).toBe('QUEUED');

      const result = reserveForSend(entry);
      expect(result.reserved).toBe(true);
      expect(entry.status).toBe('IN_FLIGHT');
      expect(entry.reservedAt).toBeDefined();
      expect(getInFlightCount()).toBe(1);
      expect(getQueuedCount()).toBe(0);
    });

    it('rejects reserve on non-QUEUED entry', () => {
      const entry = enqueue(makePacket(), 1);
      reserveForSend(entry);
      const result = reserveForSend(entry);
      expect(result.reserved).toBe(false);
      expect(result.reason).toContain('IN_FLIGHT');
    });

    it('releases nonce: IN_FLIGHT back to QUEUED', () => {
      const entry = enqueue(makePacket(), 1);
      reserveForSend(entry);
      expect(entry.status).toBe('IN_FLIGHT');

      releaseNonce(entry);
      expect(entry.status).toBe('QUEUED');
      expect(entry.reservedAt).toBeUndefined();
      expect(getQueuedCount()).toBe(1);
      expect(getInFlightCount()).toBe(0);
    });

    it('markSent only works on IN_FLIGHT entries', () => {
      const entry = enqueue(makePacket(), 1);
      markSent(entry);
      expect(entry.status).toBe('QUEUED');

      reserveForSend(entry);
      markSent(entry);
      expect(entry.status).toBe('SENT');
      expect(entry.sentAt).toBeDefined();
    });
  });

  describe('AT-11: killswitch cancels all queued AND in-flight sends', () => {
    it('drainOnKillswitch cancels QUEUED items', () => {
      enqueue(makePacket({ woId: 'WO-1' }), 1);
      enqueue(makePacket({ woId: 'WO-2' }), 1);
      enqueue(makePacket({ woId: 'WO-3' }), 1);
      expect(getQueuedCount()).toBe(3);

      const result = drainOnKillswitch('Global killswitch activated');
      expect(result.cancelled).toBe(3);
      expect(getActiveCount()).toBe(0);

      for (const item of result.items) {
        expect(item.status).toBe('CANCELLED');
        expect(item.cancelReason).toBe('Global killswitch activated');
        expect(item.cancelledAt).toBeDefined();
      }
    });

    it('drainOnKillswitch cancels IN_FLIGHT (nonce-reserved) items — the actual race', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-1' }), 1);
      const e2 = enqueue(makePacket({ woId: 'WO-2' }), 1);
      reserveForSend(e1);
      expect(e1.status).toBe('IN_FLIGHT');
      expect(e2.status).toBe('QUEUED');

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(2);
      expect(e1.status).toBe('CANCELLED');
      expect(e2.status).toBe('CANCELLED');
      expect(getInFlightCount()).toBe(0);
      expect(getQueuedCount()).toBe(0);
    });

    it('reserve → killswitch → no-send → release sequence', () => {
      const entry = enqueue(makePacket({ woId: 'WO-1' }), 1);
      reserveForSend(entry);
      expect(entry.status).toBe('IN_FLIGHT');

      drainOnKillswitch('Emergency killswitch');
      expect(entry.status).toBe('CANCELLED');

      markSent(entry);
      expect(entry.status).toBe('CANCELLED');

      releaseNonce(entry);
      expect(entry.status).toBe('CANCELLED');
    });

    it('does not cancel already-sent items', () => {
      const sent = enqueue(makePacket({ woId: 'WO-1' }), 1);
      reserveForSend(sent);
      markSent(sent);
      enqueue(makePacket({ woId: 'WO-2' }), 1);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(1);
      expect(getQueue().find(e => e.packet.woId === 'WO-1')!.status).toBe('SENT');
      expect(getQueue().find(e => e.packet.woId === 'WO-2')!.status).toBe('CANCELLED');
    });

    it('checkAndDrain cancels queue when config file is missing', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      resetLastSeenVersion();
      setVersionFilePath(join(tmp, '.policy-version'));

      enqueue(makePacket(), 1);
      enqueue(makePacket(), 1);
      const result = checkAndDrain('/nonexistent/path/config.json');
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(2);
      expect(getActiveCount()).toBe(0);

      rmSync(tmp, { recursive: true, force: true });
    });

    it('checkAndDrain cancels queue when global_auto_send is false', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const configPath = join(tmp, 'policy.json');
      resetLastSeenVersion();
      setVersionFilePath(join(tmp, '.policy-version'));
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
      resetLastSeenVersion();
      setVersionFilePath(join(tmp, '.policy-version'));
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: true, cards: {},
      }));

      enqueue(makePacket(), 1);
      const result = checkAndDrain(configPath);
      expect(result).toBeNull();
      expect(getQueuedCount()).toBe(1);

      rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe('version-change drain', () => {
    it('cancels QUEUED and IN_FLIGHT items under old version', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-old-1' }), 1);
      enqueue(makePacket({ woId: 'WO-old-2' }), 1);
      enqueue(makePacket({ woId: 'WO-new' }), 2);
      reserveForSend(e1);

      const result = drainOnVersionChange(2, 'Config version advanced to 2');
      expect(result.cancelled).toBe(2);
      expect(e1.status).toBe('CANCELLED');
      expect(getActiveCount()).toBe(1);
      expect(getQueue().find(e => e.status === 'QUEUED')!.packet.woId).toBe('WO-new');
    });
  });
});

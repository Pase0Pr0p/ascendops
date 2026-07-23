import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueue, drainOnKillswitch, drainOnVersionChange,
  markSent, reserveForSend, releaseNonce,
  isNonceReserved, getReservedNonces,
  getQueue, getQueuedCount, getInFlightCount, getActiveCount,
  clearQueue, checkAndDrain,
} from '../../../../src/bus/triage/send-queue';
import { resetLastSeenVersion, setVersionFilePath, bootstrapVersionLedger } from '../../../../src/bus/triage/policy-config';
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

  describe('real nonce store lifecycle', () => {
    it('reserveForSend reserves the packet nonce in the nonce store', () => {
      const entry = enqueue(makePacket({ nonce: 'n-abc' }), 1);
      expect(isNonceReserved('n-abc')).toBe(false);

      const result = reserveForSend(entry);
      expect(result.reserved).toBe(true);
      expect(result.nonce).toBe('n-abc');
      expect(isNonceReserved('n-abc')).toBe(true);
      expect(entry.status).toBe('IN_FLIGHT');
    });

    it('rejects duplicate nonce reservation', () => {
      const e1 = enqueue(makePacket({ nonce: 'n-dup' }), 1);
      const e2 = enqueue(makePacket({ nonce: 'n-dup', woId: 'WO-2' }), 1);
      reserveForSend(e1);

      const result = reserveForSend(e2);
      expect(result.reserved).toBe(false);
      expect(result.reason).toContain('already reserved');
    });

    it('releaseNonce removes nonce from store and resets to QUEUED', () => {
      const entry = enqueue(makePacket({ nonce: 'n-rel' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('n-rel')).toBe(true);

      const released = releaseNonce(entry);
      expect(released).toBe(true);
      expect(isNonceReserved('n-rel')).toBe(false);
      expect(entry.status).toBe('QUEUED');
      expect(entry.reservedAt).toBeUndefined();
    });

    it('releaseNonce returns false when nonce was not reserved', () => {
      const entry = enqueue(makePacket({ nonce: 'n-never' }), 1);
      const released = releaseNonce(entry);
      expect(released).toBe(false);
    });

    it('markSent releases nonce from store on completion', () => {
      const entry = enqueue(makePacket({ nonce: 'n-sent' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('n-sent')).toBe(true);

      markSent(entry);
      expect(entry.status).toBe('SENT');
      expect(isNonceReserved('n-sent')).toBe(false);
    });

    it('markSent is no-op on QUEUED entry (must reserve first)', () => {
      const entry = enqueue(makePacket({ nonce: 'n-skip' }), 1);
      markSent(entry);
      expect(entry.status).toBe('QUEUED');
    });

    it('getReservedNonces returns snapshot of all reserved nonces', () => {
      const e1 = enqueue(makePacket({ nonce: 'n1' }), 1);
      const e2 = enqueue(makePacket({ nonce: 'n2' }), 1);
      reserveForSend(e1);
      reserveForSend(e2);
      const nonces = getReservedNonces();
      expect(nonces.has('n1')).toBe(true);
      expect(nonces.has('n2')).toBe(true);
      expect(nonces.size).toBe(2);
    });

    it('clearQueue clears nonce store', () => {
      const entry = enqueue(makePacket({ nonce: 'n-clear' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('n-clear')).toBe(true);
      clearQueue();
      expect(isNonceReserved('n-clear')).toBe(false);
    });
  });

  describe('AT-11: killswitch cancels all queued AND in-flight sends with nonce release', () => {
    it('drainOnKillswitch cancels QUEUED items', () => {
      enqueue(makePacket({ woId: 'WO-1', nonce: 'q1' }), 1);
      enqueue(makePacket({ woId: 'WO-2', nonce: 'q2' }), 1);
      enqueue(makePacket({ woId: 'WO-3', nonce: 'q3' }), 1);
      expect(getQueuedCount()).toBe(3);

      const result = drainOnKillswitch('Global killswitch activated');
      expect(result.cancelled).toBe(3);
      expect(getActiveCount()).toBe(0);

      for (const item of result.items) {
        expect(item.status).toBe('CANCELLED');
        expect(item.cancelReason).toBe('Global killswitch activated');
      }
    });

    it('drainOnKillswitch cancels IN_FLIGHT and RELEASES their nonces', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-1', nonce: 'flight-1' }), 1);
      const e2 = enqueue(makePacket({ woId: 'WO-2', nonce: 'flight-2' }), 1);
      enqueue(makePacket({ woId: 'WO-3', nonce: 'queued-1' }), 1);
      reserveForSend(e1);
      reserveForSend(e2);
      expect(isNonceReserved('flight-1')).toBe(true);
      expect(isNonceReserved('flight-2')).toBe(true);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(3);
      expect(result.releasedNonces).toContain('flight-1');
      expect(result.releasedNonces).toContain('flight-2');
      expect(result.releasedNonces).toHaveLength(2);
      expect(isNonceReserved('flight-1')).toBe(false);
      expect(isNonceReserved('flight-2')).toBe(false);
      expect(getInFlightCount()).toBe(0);
      expect(getQueuedCount()).toBe(0);
    });

    it('reserve → killswitch → nonce released → no send possible', () => {
      const entry = enqueue(makePacket({ nonce: 'race-nonce' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('race-nonce')).toBe(true);
      expect(entry.status).toBe('IN_FLIGHT');

      const drain = drainOnKillswitch('Emergency killswitch');
      expect(entry.status).toBe('CANCELLED');
      expect(isNonceReserved('race-nonce')).toBe(false);
      expect(drain.releasedNonces).toContain('race-nonce');

      markSent(entry);
      expect(entry.status).toBe('CANCELLED');
    });

    it('does not cancel already-sent items', () => {
      const sent = enqueue(makePacket({ woId: 'WO-1', nonce: 'sent-1' }), 1);
      reserveForSend(sent);
      markSent(sent);
      enqueue(makePacket({ woId: 'WO-2', nonce: 'pending-1' }), 1);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(1);
      expect(getQueue().find(e => e.packet.woId === 'WO-1')!.status).toBe('SENT');
      expect(getQueue().find(e => e.packet.woId === 'WO-2')!.status).toBe('CANCELLED');
    });

    it('checkAndDrain cancels queue when config file is missing', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      resetLastSeenVersion();
      bootstrapVersionLedger(join(tmp, '.policy-version'), 0);

      enqueue(makePacket({ nonce: 'cd-1' }), 1);
      enqueue(makePacket({ nonce: 'cd-2' }), 1);
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
      bootstrapVersionLedger(join(tmp, '.policy-version'), 0);
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: false, cards: {},
      }));

      enqueue(makePacket({ nonce: 'cd-3' }), 1);
      const result = checkAndDrain(configPath);
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(1);

      rmSync(tmp, { recursive: true, force: true });
    });

    it('checkAndDrain returns null when config is valid and enabled', () => {
      const tmp = mkdtempSync(join(tmpdir(), 'queue-test-'));
      const configPath = join(tmp, 'policy.json');
      resetLastSeenVersion();
      bootstrapVersionLedger(join(tmp, '.policy-version'), 0);
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: true, cards: {},
      }));

      enqueue(makePacket({ nonce: 'cd-4' }), 1);
      const result = checkAndDrain(configPath);
      expect(result).toBeNull();
      expect(getQueuedCount()).toBe(1);

      rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe('version-change drain releases nonces', () => {
    it('cancels QUEUED and IN_FLIGHT under old version, releases in-flight nonces', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-old-1', nonce: 'vold-1' }), 1);
      enqueue(makePacket({ woId: 'WO-old-2', nonce: 'vold-2' }), 1);
      enqueue(makePacket({ woId: 'WO-new', nonce: 'vnew-1' }), 2);
      reserveForSend(e1);

      const result = drainOnVersionChange(2, 'Config version advanced to 2');
      expect(result.cancelled).toBe(2);
      expect(result.releasedNonces).toContain('vold-1');
      expect(result.releasedNonces).toHaveLength(1);
      expect(isNonceReserved('vold-1')).toBe(false);
      expect(getActiveCount()).toBe(1);
    });
  });
});

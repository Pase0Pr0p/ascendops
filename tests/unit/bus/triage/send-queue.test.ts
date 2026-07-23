import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueue, drainOnKillswitch, drainOnVersionChange,
  markSent, reserveForSend, releaseNonce,
  isNonceReserved, getReservedNonces,
  getQueue, getQueuedCount, getInFlightCount, getActiveCount,
  clearQueue, checkAndDrain, setQueueLedgerPath,
} from '../../../../src/bus/triage/send-queue';
import { resetPolicyState, setLedgerPath } from '../../../../src/bus/triage/policy-config';
import { initializeLedger, isNonceConsumed } from '../../../../src/bus/triage/durable-ledger';
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
  let tmp: string;
  let ledgerPath: string;

  beforeEach(() => {
    clearQueue();
    tmp = mkdtempSync(join(tmpdir(), 'send-queue-'));
    ledgerPath = join(tmp, 'triage-ledger.json');
    initializeLedger(ledgerPath, 0);
    setQueueLedgerPath(ledgerPath);
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('real nonce store lifecycle', () => {
    it('reserveForSend reserves nonce in active set and checks durable store', () => {
      const entry = enqueue(makePacket({ nonce: 'n-abc' }), 1);
      expect(isNonceReserved('n-abc')).toBe(false);

      const result = reserveForSend(entry);
      expect(result.reserved).toBe(true);
      expect(result.nonce).toBe('n-abc');
      expect(isNonceReserved('n-abc')).toBe(true);
    });

    it('rejects duplicate nonce reservation', () => {
      const e1 = enqueue(makePacket({ nonce: 'n-dup' }), 1);
      const e2 = enqueue(makePacket({ nonce: 'n-dup', woId: 'WO-2' }), 1);
      reserveForSend(e1);

      const result = reserveForSend(e2);
      expect(result.reserved).toBe(false);
      expect(result.reason).toContain('already reserved');
    });

    it('rejects reservation of durably consumed nonce (replay prevention)', () => {
      const e1 = enqueue(makePacket({ nonce: 'n-replay' }), 1);
      reserveForSend(e1);
      markSent(e1);
      expect(isNonceConsumed(ledgerPath, 'n-replay')).toBe(true);

      const e2 = enqueue(makePacket({ nonce: 'n-replay', woId: 'WO-2' }), 1);
      const result = reserveForSend(e2);
      expect(result.reserved).toBe(false);
      expect(result.reason).toContain('already consumed');
      expect(result.reason).toContain('replay denied');
    });

    it('releaseNonce removes from active set and resets to QUEUED', () => {
      const entry = enqueue(makePacket({ nonce: 'n-rel' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('n-rel')).toBe(true);

      const released = releaseNonce(entry);
      expect(released).toBe(true);
      expect(isNonceReserved('n-rel')).toBe(false);
      expect(entry.status).toBe('QUEUED');
    });

    it('markSent durably consumes nonce and releases from active set', () => {
      const entry = enqueue(makePacket({ nonce: 'n-sent' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('n-sent')).toBe(true);

      const result = markSent(entry);
      expect(result.sent).toBe(true);
      expect(entry.status).toBe('SENT');
      expect(isNonceReserved('n-sent')).toBe(false);
      expect(isNonceConsumed(ledgerPath, 'n-sent')).toBe(true);
    });

    it('markSent rejects non-IN_FLIGHT entry', () => {
      const entry = enqueue(makePacket({ nonce: 'n-skip' }), 1);
      const result = markSent(entry);
      expect(result.sent).toBe(false);
      expect(entry.status).toBe('QUEUED');
    });

    it('getReservedNonces returns snapshot of active nonces', () => {
      const e1 = enqueue(makePacket({ nonce: 'n1' }), 1);
      const e2 = enqueue(makePacket({ nonce: 'n2' }), 1);
      reserveForSend(e1);
      reserveForSend(e2);
      const nonces = getReservedNonces();
      expect(nonces.has('n1')).toBe(true);
      expect(nonces.has('n2')).toBe(true);
    });
  });

  describe('AT-11: killswitch cancels all queued AND in-flight with nonce release', () => {
    it('drainOnKillswitch cancels QUEUED items', () => {
      enqueue(makePacket({ woId: 'WO-1', nonce: 'q1' }), 1);
      enqueue(makePacket({ woId: 'WO-2', nonce: 'q2' }), 1);
      expect(getQueuedCount()).toBe(2);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(2);
      expect(getActiveCount()).toBe(0);
    });

    it('drainOnKillswitch cancels IN_FLIGHT and RELEASES their active nonces', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-1', nonce: 'flight-1' }), 1);
      const e2 = enqueue(makePacket({ woId: 'WO-2', nonce: 'flight-2' }), 1);
      reserveForSend(e1);
      reserveForSend(e2);
      expect(isNonceReserved('flight-1')).toBe(true);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(2);
      expect(result.releasedNonces).toContain('flight-1');
      expect(result.releasedNonces).toContain('flight-2');
      expect(isNonceReserved('flight-1')).toBe(false);
      expect(isNonceReserved('flight-2')).toBe(false);
    });

    it('reserve → killswitch → nonce released → markSent is no-op', () => {
      const entry = enqueue(makePacket({ nonce: 'race-nonce' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('race-nonce')).toBe(true);

      drainOnKillswitch('Emergency killswitch');
      expect(entry.status).toBe('CANCELLED');
      expect(isNonceReserved('race-nonce')).toBe(false);

      const sendResult = markSent(entry);
      expect(sendResult.sent).toBe(false);
      expect(entry.status).toBe('CANCELLED');
      expect(isNonceConsumed(ledgerPath, 'race-nonce')).toBe(false);
    });

    it('does not cancel already-sent items', () => {
      const sent = enqueue(makePacket({ woId: 'WO-1', nonce: 'sent-1' }), 1);
      reserveForSend(sent);
      markSent(sent);
      enqueue(makePacket({ woId: 'WO-2', nonce: 'pending-1' }), 1);

      const result = drainOnKillswitch('Killswitch');
      expect(result.cancelled).toBe(1);
      expect(getQueue().find(e => e.packet.woId === 'WO-1')!.status).toBe('SENT');
    });

    it('checkAndDrain cancels queue when config file is missing', () => {
      resetPolicyState();
      setLedgerPath(ledgerPath);

      enqueue(makePacket({ nonce: 'cd-1' }), 1);
      const result = checkAndDrain('/nonexistent/path/config.json');
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(1);
    });

    it('checkAndDrain cancels queue when global_auto_send is false', () => {
      resetPolicyState();
      setLedgerPath(ledgerPath);
      const configPath = join(tmp, 'policy.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: false, cards: {},
      }));

      enqueue(makePacket({ nonce: 'cd-2' }), 1);
      const result = checkAndDrain(configPath);
      expect(result).not.toBeNull();
      expect(result!.cancelled).toBe(1);
    });

    it('checkAndDrain returns null when config is valid and enabled', () => {
      resetPolicyState();
      setLedgerPath(ledgerPath);
      const configPath = join(tmp, 'policy.json');
      writeFileSync(configPath, JSON.stringify({
        version: 1, updated_at: '', updated_by: '', global_auto_send: true, cards: {},
      }));

      enqueue(makePacket({ nonce: 'cd-3' }), 1);
      const result = checkAndDrain(configPath);
      expect(result).toBeNull();
      expect(getQueuedCount()).toBe(1);
    });
  });

  describe('version-change drain releases nonces', () => {
    it('cancels and releases in-flight nonces from old version', () => {
      const e1 = enqueue(makePacket({ woId: 'WO-old', nonce: 'vold-1' }), 1);
      enqueue(makePacket({ woId: 'WO-new', nonce: 'vnew-1' }), 2);
      reserveForSend(e1);

      const result = drainOnVersionChange(2, 'Version advanced');
      expect(result.cancelled).toBe(1);
      expect(result.releasedNonces).toContain('vold-1');
      expect(isNonceReserved('vold-1')).toBe(false);
      expect(getActiveCount()).toBe(1);
    });
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  enqueue, drainOnKillswitch, drainOnVersionChange,
  prepareSend, confirmSend, releaseOnProvenNoSend,
  reserveForSend, releaseNonce,
  isNonceReserved, getReservedNonces,
  getQueue, getQueuedCount, getInFlightCount, getActiveCount,
  clearQueue, checkAndDrain, setQueueLedgerPath,
} from '../../../../src/bus/triage/send-queue';
import { resetPolicyState, setLedgerPath } from '../../../../src/bus/triage/policy-config';
import { initializeLedger, isNonceConsumed, setInstallAnchorPath, resetAnchorPath } from '../../../../src/bus/triage/durable-ledger';
import * as barrel from '../../../../src/bus/triage/index';
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
  let anchorFile: string;

  beforeEach(() => {
    clearQueue();
    resetAnchorPath();
    tmp = mkdtempSync(join(tmpdir(), 'send-queue-'));
    ledgerPath = join(tmp, 'triage-ledger.json');
    anchorFile = join(tmp, 'anchor', 'triage.anchor');
    setInstallAnchorPath(anchorFile);
    initializeLedger(ledgerPath, 0);
    setQueueLedgerPath(ledgerPath);
  });

  afterEach(() => {
    resetAnchorPath();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('barrel access-surface audit — send queue', () => {
    it('barrel exports prepareSend, confirmSend, releaseOnProvenNoSend (enforced paths)', () => {
      expect('prepareSend' in barrel).toBe(true);
      expect('confirmSend' in barrel).toBe(true);
      expect('releaseOnProvenNoSend' in barrel).toBe(true);
    });

    it('barrel does NOT export unconsumeNonce — only reachable via releaseOnProvenNoSend', () => {
      expect('unconsumeNonce' in barrel).toBe(false);
    });

    it('barrel does NOT export resetAnchorPath — test-only', () => {
      expect('resetAnchorPath' in barrel).toBe(false);
    });
  });

  describe('mandatory ledger — fail-closed without it', () => {
    it('reserveForSend DENIES when ledger path not set', () => {
      clearQueue();
      setQueueLedgerPath(null as unknown as string);
      const entry = enqueue(makePacket({ nonce: 'n-noledger' }), 1);
      clearQueue();

      const e2 = enqueue(makePacket({ nonce: 'n-noledger2' }), 1);
      const result = reserveForSend(e2);
      expect(result.reserved).toBe(false);
      expect(result.reason).toContain('fail-closed');
    });

    it('prepareSend DENIES when ledger path not set', () => {
      const entry = enqueue(makePacket({ nonce: 'n-prep-noledger' }), 1);
      reserveForSend(entry);
      clearQueue();

      const e2 = enqueue(makePacket({ nonce: 'n-prep-noledger2' }), 1);
      e2.status = 'IN_FLIGHT';
      const result = prepareSend(e2);
      expect(result.prepared).toBe(false);
      expect(result.error).toContain('fail-closed');
    });
  });

  describe('pre-send consume lifecycle (reserve → prepare → confirm)', () => {
    it('full lifecycle: reserve → prepareSend → confirmSend', () => {
      const entry = enqueue(makePacket({ nonce: 'n-lifecycle' }), 1);

      const r1 = reserveForSend(entry);
      expect(r1.reserved).toBe(true);
      expect(entry.status).toBe('IN_FLIGHT');
      expect(isNonceReserved('n-lifecycle')).toBe(true);

      const r2 = prepareSend(entry);
      expect(r2.prepared).toBe(true);
      expect(entry.durableConsumed).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-lifecycle')).toBe(true);

      const r3 = confirmSend(entry);
      expect(r3.sent).toBe(true);
      expect(entry.status).toBe('SENT');
      expect(isNonceReserved('n-lifecycle')).toBe(false);
    });

    it('confirmSend DENIES without prior prepareSend', () => {
      const entry = enqueue(makePacket({ nonce: 'n-skip-prep' }), 1);
      reserveForSend(entry);

      const result = confirmSend(entry);
      expect(result.sent).toBe(false);
      expect(result.error).toContain('call prepareSend first');
    });

    it('confirmSend DENIES non-IN_FLIGHT entry', () => {
      const entry = enqueue(makePacket({ nonce: 'n-not-flight' }), 1);
      const result = confirmSend(entry);
      expect(result.sent).toBe(false);
    });

    it('prepareSend DENIES non-IN_FLIGHT entry', () => {
      const entry = enqueue(makePacket({ nonce: 'n-queued-prep' }), 1);
      const result = prepareSend(entry);
      expect(result.prepared).toBe(false);
    });
  });

  describe('releaseOnProvenNoSend — unconsume on proven no-send', () => {
    it('unconsumes nonce and returns to QUEUED', () => {
      const entry = enqueue(makePacket({ nonce: 'n-abort' }), 1);
      reserveForSend(entry);
      prepareSend(entry);
      expect(isNonceConsumed(ledgerPath, 'n-abort')).toBe(true);

      const result = releaseOnProvenNoSend(entry);
      expect(result.sent).toBe(false);
      expect(entry.status).toBe('QUEUED');
      expect(isNonceConsumed(ledgerPath, 'n-abort')).toBe(false);
      expect(isNonceReserved('n-abort')).toBe(false);
    });

    it('releases without durable unconsume when prepareSend was not called', () => {
      const entry = enqueue(makePacket({ nonce: 'n-noprep-abort' }), 1);
      reserveForSend(entry);

      const result = releaseOnProvenNoSend(entry);
      expect(result.sent).toBe(false);
      expect(entry.status).toBe('QUEUED');
      expect(isNonceConsumed(ledgerPath, 'n-noprep-abort')).toBe(false);
    });

    it('re-reserve after releaseOnProvenNoSend succeeds', () => {
      const entry = enqueue(makePacket({ nonce: 'n-re-reserve' }), 1);
      reserveForSend(entry);
      prepareSend(entry);
      releaseOnProvenNoSend(entry);

      const r2 = reserveForSend(entry);
      expect(r2.reserved).toBe(true);
    });
  });

  describe('nonce reservation and replay prevention', () => {
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
      prepareSend(e1);
      confirmSend(e1);
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

    it('reserve → killswitch → nonce released → confirmSend is no-op', () => {
      const entry = enqueue(makePacket({ nonce: 'race-nonce' }), 1);
      reserveForSend(entry);
      expect(isNonceReserved('race-nonce')).toBe(true);

      drainOnKillswitch('Emergency killswitch');
      expect(entry.status).toBe('CANCELLED');
      expect(isNonceReserved('race-nonce')).toBe(false);

      const sendResult = confirmSend(entry);
      expect(sendResult.sent).toBe(false);
      expect(entry.status).toBe('CANCELLED');
    });

    it('killswitch after prepareSend keeps nonce consumed (safe — blocks replay)', () => {
      const entry = enqueue(makePacket({ nonce: 'race-prepared' }), 1);
      reserveForSend(entry);
      prepareSend(entry);
      expect(isNonceConsumed(ledgerPath, 'race-prepared')).toBe(true);

      drainOnKillswitch('Emergency');
      expect(entry.status).toBe('CANCELLED');
      expect(isNonceConsumed(ledgerPath, 'race-prepared')).toBe(true);
    });

    it('does not cancel already-sent items', () => {
      const sent = enqueue(makePacket({ woId: 'WO-1', nonce: 'sent-1' }), 1);
      reserveForSend(sent);
      prepareSend(sent);
      confirmSend(sent);
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

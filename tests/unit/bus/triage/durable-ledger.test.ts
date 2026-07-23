import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initializeLedger, loadLedger, advanceVersion,
  consumeNonce, isNonceConsumed, getLedgerVersion,
} from '../../../../src/bus/triage/durable-ledger';

describe('durable triage ledger', () => {
  let tmp: string;
  let ledgerPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-ledger-'));
    ledgerPath = join(tmp, 'triage-ledger.json');
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('initializeLedger — install-once semantics', () => {
    it('creates ledger and marker on first run', () => {
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(true);
      expect(result.install_id).toBeDefined();
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(ledgerPath + '.installed')).toBe(true);
    });

    it('rejects re-initialization when ledger exists', () => {
      initializeLedger(ledgerPath, 0);
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('rejects re-initialization when only marker exists (ledger deleted)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath);
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('rejects re-initialization when only ledger exists (marker deleted)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath + '.installed');
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });
  });

  describe('loadLedger — tamper detection', () => {
    it('loads valid initialized ledger', () => {
      initializeLedger(ledgerPath, 0);
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(true);
      expect(result.state!.version).toBe(0);
      expect(result.state!.consumed_nonces).toEqual([]);
    });

    it('DENIES when not initialized', () => {
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Not initialized');
    });

    it('DENIES when ledger deleted but marker exists (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath);
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('tamper detected');
    });

    it('DENIES when marker deleted but ledger exists (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath + '.installed');
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('tamper detected');
    });

    it('DENIES when install_id mismatch between ledger and marker (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      writeFileSync(ledgerPath + '.installed', 'wrong-id', 'utf-8');
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('tamper detected');
    });

    it('DENIES when ledger JSON is corrupted', () => {
      initializeLedger(ledgerPath, 0);
      writeFileSync(ledgerPath, 'not json', 'utf-8');
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('malformed');
    });
  });

  describe('advanceVersion — monotonic, durable', () => {
    it('advances version forward', () => {
      initializeLedger(ledgerPath, 0);
      const result = advanceVersion(ledgerPath, 5);
      expect(result.loaded).toBe(true);
      expect(result.state!.version).toBe(5);
      expect(getLedgerVersion(ledgerPath)).toBe(5);
    });

    it('DENIES stale version (rollback)', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 5);
      const result = advanceVersion(ledgerPath, 3);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Stale version');
    });

    it('survives restart: delete→restart→still-denied for version rollback', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 10);

      const v = getLedgerVersion(ledgerPath);
      expect(v).toBe(10);

      const result = advanceVersion(ledgerPath, 3);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Stale version');
    });
  });

  describe('consumeNonce — consume-once, replay-denied', () => {
    it('consumes a nonce and records it durably', () => {
      initializeLedger(ledgerPath, 0);
      expect(isNonceConsumed(ledgerPath, 'n-1')).toBe(false);

      const result = consumeNonce(ledgerPath, 'n-1');
      expect(result.loaded).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-1')).toBe(true);
    });

    it('DENIES replay of consumed nonce', () => {
      initializeLedger(ledgerPath, 0);
      consumeNonce(ledgerPath, 'n-1');

      const result = consumeNonce(ledgerPath, 'n-1');
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('already consumed');
      expect(result.error).toContain('replay denied');
    });

    it('survives restart: consumed nonces persist across fresh loads', () => {
      initializeLedger(ledgerPath, 0);
      consumeNonce(ledgerPath, 'n-durable');

      const loaded = loadLedger(ledgerPath);
      expect(loaded.state!.consumed_nonces).toContain('n-durable');
      expect(isNonceConsumed(ledgerPath, 'n-durable')).toBe(true);
    });

    it('multiple nonces consumed independently', () => {
      initializeLedger(ledgerPath, 0);
      consumeNonce(ledgerPath, 'n-a');
      consumeNonce(ledgerPath, 'n-b');
      consumeNonce(ledgerPath, 'n-c');

      expect(isNonceConsumed(ledgerPath, 'n-a')).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-b')).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-c')).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-d')).toBe(false);
    });
  });

  describe('delete→restart→still-denied (structural)', () => {
    it('deleted ledger cannot be re-bootstrapped to bypass rollback', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 10);
      consumeNonce(ledgerPath, 'n-critical');

      unlinkSync(ledgerPath);
      const reinit = initializeLedger(ledgerPath, 0);
      expect(reinit.success).toBe(false);

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('tamper');
    });

    it('deleted marker cannot be re-bootstrapped', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 5);

      unlinkSync(ledgerPath + '.installed');
      const reinit = initializeLedger(ledgerPath, 0);
      expect(reinit.success).toBe(false);

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('tamper');
    });

    it('both files deleted = not initialized, not re-bootstrappable via normal path', () => {
      const init = initializeLedger(ledgerPath, 0);
      expect(init.success).toBe(true);

      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('Not initialized');
    });
  });
});

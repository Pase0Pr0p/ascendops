import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  initializeLedger, loadLedger, advanceVersion,
  consumeNonce, unconsumeNonce, isNonceConsumed, getLedgerVersion,
  setInstallAnchorPath, resetAnchorPath,
} from '../../../../src/bus/triage/durable-ledger';

describe('durable triage ledger', () => {
  let tmp: string;
  let ledgerPath: string;
  let anchorDir: string;
  let anchorFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-ledger-'));
    ledgerPath = join(tmp, 'triage-ledger.json');
    anchorDir = join(tmp, 'anchor');
    anchorFile = join(anchorDir, 'triage.anchor');
    setInstallAnchorPath(anchorFile);
  });

  afterEach(() => {
    resetAnchorPath();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('initializeLedger — install-once with anchor', () => {
    it('creates ledger, marker, and anchor on first run', () => {
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(true);
      expect(result.install_id).toBeDefined();
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(ledgerPath + '.installed')).toBe(true);
      expect(existsSync(anchorFile)).toBe(true);
    });

    it('rejects re-initialization when all three exist', () => {
      initializeLedger(ledgerPath, 0);
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('rejects re-initialization when only anchor exists (ledger+marker deleted)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('rejects re-initialization when only marker exists (ledger+anchor deleted)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath);
      unlinkSync(anchorFile);
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('rejects re-initialization when only ledger exists (marker+anchor deleted)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath + '.installed');
      unlinkSync(anchorFile);
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('already exists');
    });

    it('DENIES when anchor path not configured', () => {
      resetAnchorPath();
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('anchor path not configured');
    });
  });

  describe('loadLedger — tamper detection with anchor', () => {
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

    it('DENIES when ledger deleted but anchor+marker exist (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath);
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('tamper detected');
    });

    it('DENIES when marker deleted but anchor+ledger exist (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(ledgerPath + '.installed');
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('tamper detected');
    });

    it('DENIES when anchor deleted but ledger+marker exist (tamper)', () => {
      initializeLedger(ledgerPath, 0);
      unlinkSync(anchorFile);
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

    it('DENIES when anchor path not configured (fail-closed)', () => {
      initializeLedger(ledgerPath, 0);
      resetAnchorPath();
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('anchor path not configured');
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

    it('survives restart: version rollback still denied after fresh load', () => {
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

  describe('unconsumeNonce — proven-no-send release', () => {
    it('unconsumes a previously consumed nonce', () => {
      initializeLedger(ledgerPath, 0);
      consumeNonce(ledgerPath, 'n-undo');
      expect(isNonceConsumed(ledgerPath, 'n-undo')).toBe(true);

      const result = unconsumeNonce(ledgerPath, 'n-undo');
      expect(result.loaded).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-undo')).toBe(false);
    });

    it('unconsumed nonce can be re-consumed', () => {
      initializeLedger(ledgerPath, 0);
      consumeNonce(ledgerPath, 'n-retry');
      unconsumeNonce(ledgerPath, 'n-retry');
      const result = consumeNonce(ledgerPath, 'n-retry');
      expect(result.loaded).toBe(true);
      expect(isNonceConsumed(ledgerPath, 'n-retry')).toBe(true);
    });
  });

  describe('both-deleted DENIES reinit — anchor survives', () => {
    it('delete ledger+marker → load DENIED (anchor detects tamper)', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 10);
      consumeNonce(ledgerPath, 'n-critical');

      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('tamper');
    });

    it('delete ledger+marker → reinit DENIED (anchor blocks re-bootstrap)', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 10);
      consumeNonce(ledgerPath, 'n-critical');

      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');

      const reinit = initializeLedger(ledgerPath, 0);
      expect(reinit.success).toBe(false);
      expect(reinit.error).toContain('already exists');
    });

    it('delete all three → not initialized (full wipe requires re-provision)', () => {
      initializeLedger(ledgerPath, 0);

      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');
      unlinkSync(anchorFile);

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('Not initialized');
    });
  });

  describe('concurrent access — lock serialization', () => {
    it('locked operation fails-closed when lock file exists', () => {
      initializeLedger(ledgerPath, 0);

      const lockFile = ledgerPath + '.lock';
      writeFileSync(lockFile, '99999', 'utf-8');

      const result = advanceVersion(ledgerPath, 5);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('concurrent access denied');

      unlinkSync(lockFile);
    });

    it('sequential mutations serialize correctly', () => {
      initializeLedger(ledgerPath, 0);

      advanceVersion(ledgerPath, 1);
      consumeNonce(ledgerPath, 'seq-a');
      advanceVersion(ledgerPath, 2);
      consumeNonce(ledgerPath, 'seq-b');

      const state = loadLedger(ledgerPath);
      expect(state.state!.version).toBe(2);
      expect(state.state!.consumed_nonces).toEqual(['seq-a', 'seq-b']);
    });
  });
});

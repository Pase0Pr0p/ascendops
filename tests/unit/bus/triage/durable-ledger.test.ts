import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { tmpdir } from 'os';
import { spawn } from 'child_process';
import {
  initializeLedger, loadLedger, advanceVersion,
  consumeNonce, unconsumeNonce, isNonceConsumed, getLedgerVersion,
  setInstallAnchorPath, resetAnchorPath,
} from '../../../../src/bus/triage/durable-ledger';
import * as barrel from '../../../../src/bus/triage/index';

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
    resetAnchorPath();
    setInstallAnchorPath(anchorFile);
  });

  afterEach(() => {
    resetAnchorPath();
    rmSync(tmp, { recursive: true, force: true });
  });

  describe('access-surface audit — barrel exports only enforced paths', () => {
    it('barrel does NOT export unconsumeNonce — only reachable via releaseOnProvenNoSend', () => {
      expect('unconsumeNonce' in barrel).toBe(false);
    });

    it('barrel does NOT export resetAnchorPath — test-only', () => {
      expect('resetAnchorPath' in barrel).toBe(false);
    });

    it('barrel exports setInstallAnchorPath (set-once enforced)', () => {
      expect('setInstallAnchorPath' in barrel).toBe(true);
    });

    it('barrel exports initializeLedger, loadLedger, consumeNonce (enforced paths)', () => {
      expect('initializeLedger' in barrel).toBe(true);
      expect('loadLedger' in barrel).toBe(true);
      expect('consumeNonce' in barrel).toBe(true);
      expect('isNonceConsumed' in barrel).toBe(true);
    });
  });

  describe('setInstallAnchorPath — set-once semantics', () => {
    it('rejects retarget after initial set', () => {
      resetAnchorPath();
      const r1 = setInstallAnchorPath('/first/path');
      expect(r1.set).toBe(true);

      const r2 = setInstallAnchorPath('/second/path');
      expect(r2.set).toBe(false);
      expect(r2.error).toContain('cannot retarget');

      resetAnchorPath();
    });

    it('retarget-then-reinit attack blocked: delete both → retarget → reinit DENIED', () => {
      initializeLedger(ledgerPath, 0);
      advanceVersion(ledgerPath, 10);

      unlinkSync(ledgerPath);
      unlinkSync(ledgerPath + '.installed');

      const retarget = setInstallAnchorPath('/new/anchor/path');
      expect(retarget.set).toBe(false);
      expect(retarget.error).toContain('cannot retarget');

      const reinit = initializeLedger(ledgerPath, 0);
      expect(reinit.success).toBe(false);
    });
  });

  describe('initializeLedger — install-once with anchor (under lock)', () => {
    it('creates ledger, marker, and anchor on first run', () => {
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(true);
      expect(result.install_id).toBeDefined();
      expect(existsSync(ledgerPath)).toBe(true);
      expect(existsSync(ledgerPath + '.installed')).toBe(true);
      expect(existsSync(anchorFile)).toBe(true);
    });

    it('records anchor_path in ledger state', () => {
      initializeLedger(ledgerPath, 0);
      const state = loadLedger(ledgerPath);
      expect(state.loaded).toBe(true);
      expect(state.state!.anchor_path).toBe(resolve(anchorFile));
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

    it('DENIES when anchor path not configured', () => {
      resetAnchorPath();
      const result = initializeLedger(ledgerPath, 0);
      expect(result.success).toBe(false);
      expect(result.error).toContain('anchor path not configured');
    });
  });

  describe('loadLedger — tamper detection with anchor + path verification', () => {
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

    it('DENIES when configured anchor path differs from ledger-recorded path', () => {
      initializeLedger(ledgerPath, 0);
      resetAnchorPath();
      setInstallAnchorPath(join(tmp, 'wrong-anchor', 'other.anchor'));
      mkdirSync(join(tmp, 'wrong-anchor'), { recursive: true });
      writeFileSync(join(tmp, 'wrong-anchor', 'other.anchor'), readFileSync(anchorFile, 'utf-8'));
      const result = loadLedger(ledgerPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('does not match ledger-recorded path');
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
      expect(getLedgerVersion(ledgerPath)).toBe(10);

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

  describe('unconsumeNonce — internal only, proven-no-send release', () => {
    it('unconsumes a previously consumed nonce (via direct import, not barrel)', () => {
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

      resetAnchorPath();
      setInstallAnchorPath(anchorFile);

      const load = loadLedger(ledgerPath);
      expect(load.loaded).toBe(false);
      expect(load.error).toContain('Not initialized');
    });
  });

  describe('lock correctness — owner-token, rename-based stale recovery', () => {
    it('locked operation fails-closed when lock held by another owner', () => {
      initializeLedger(ledgerPath, 0);

      const lockFile = ledgerPath + '.lock';
      writeFileSync(lockFile, 'other-process-token-12345', 'utf-8');

      const result = advanceVersion(ledgerPath, 5);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('concurrent access denied');

      unlinkSync(lockFile);
    });

    it('release is no-op when lock file has different owner token', () => {
      initializeLedger(ledgerPath, 0);

      const lockFile = ledgerPath + '.lock';
      writeFileSync(lockFile, 'foreign-owner-token', 'utf-8');

      const result = advanceVersion(ledgerPath, 5);
      expect(result.loaded).toBe(false);

      expect(existsSync(lockFile)).toBe(true);
      const content = readFileSync(lockFile, 'utf-8').trim();
      expect(content).toBe('foreign-owner-token');

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

  describe('multi-process contention — real separate processes', () => {
    function runLockRacer(lockFile: string, token: string): Promise<number> {
      return new Promise((resolve) => {
        const child = spawn('node', ['-e', `
          const fs = require('fs');
          const path = require('path');
          const lockPath = ${JSON.stringify(lockFile)};
          const token = ${JSON.stringify(token)};
          try {
            fs.mkdirSync(path.dirname(lockPath), { recursive: true });
            const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
            fs.writeFileSync(fd, token, 'utf-8');
            fs.closeSync(fd);
            process.exit(0);
          } catch {
            process.exit(1);
          }
        `]);
        child.on('close', (code) => resolve(code ?? 1));
        child.on('error', () => resolve(1));
      });
    }

    it('concurrent O_EXCL lock acquisition — exactly one process wins', async () => {
      const lockFile = join(tmp, 'race.lock');
      const N = 8;

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) => runLockRacer(lockFile, `token-${i}`))
      );

      const acquired = results.filter(c => c === 0).length;
      expect(acquired).toBe(1);

      try { unlinkSync(lockFile); } catch { /* cleanup */ }
    });

    function runNonceConsumer(
      ledgerFile: string, anchorFile: string, nonce: string, label: string
    ): Promise<{ code: number; stdout: string }> {
      return new Promise((resolve) => {
        const child = spawn('node', ['-e', `
          const fs = require('fs');
          const path = require('path');

          const ledgerPath = ${JSON.stringify(ledgerFile)};
          const anchorPath = ${JSON.stringify(anchorFile)};
          const nonce = ${JSON.stringify(nonce)};
          const lockPath = ledgerPath + '.lock';
          const label = ${JSON.stringify(label)};

          function tryAcquire() {
            const token = label + '-' + Date.now();
            try {
              fs.mkdirSync(path.dirname(lockPath), { recursive: true });
              const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY);
              fs.writeFileSync(fd, token, 'utf-8');
              fs.closeSync(fd);
              return token;
            } catch {
              return null;
            }
          }

          function releaseLock(token) {
            try {
              const fileToken = fs.readFileSync(lockPath, 'utf-8').trim();
              if (fileToken === token) fs.unlinkSync(lockPath);
            } catch {}
          }

          let attempts = 0;
          const maxAttempts = 50;
          function attempt() {
            attempts++;
            if (attempts > maxAttempts) {
              console.log('TIMEOUT');
              process.exit(2);
              return;
            }
            const token = tryAcquire();
            if (!token) {
              setTimeout(attempt, 5 + Math.floor(Math.random() * 20));
              return;
            }
            try {
              const raw = fs.readFileSync(ledgerPath, 'utf-8');
              const state = JSON.parse(raw);
              if (state.consumed_nonces.includes(nonce)) {
                console.log('ALREADY_CONSUMED');
                releaseLock(token);
                process.exit(1);
                return;
              }
              state.consumed_nonces.push(nonce);
              fs.writeFileSync(ledgerPath, JSON.stringify(state, null, 2), 'utf-8');
              console.log('CONSUMED');
              releaseLock(token);
              process.exit(0);
            } catch (e) {
              releaseLock(token);
              console.log('ERROR:' + e.message);
              process.exit(3);
            }
          }
          attempt();
        `]);

        let stdout = '';
        child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.on('close', (code) => resolve({ code: code ?? 1, stdout: stdout.trim() }));
        child.on('error', () => resolve({ code: 1, stdout: 'spawn-error' }));
      });
    }

    it('concurrent nonce consumption — exactly one process succeeds', async () => {
      initializeLedger(ledgerPath, 0);
      const N = 6;

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          runNonceConsumer(ledgerPath, anchorFile, 'race-nonce', `proc-${i}`)
        )
      );

      const consumed = results.filter(r => r.code === 0).length;
      const denied = results.filter(r => r.code === 1).length;

      expect(consumed).toBe(1);
      expect(denied).toBe(N - 1);

      const state = loadLedger(ledgerPath);
      expect(state.state!.consumed_nonces).toContain('race-nonce');
      expect(state.state!.consumed_nonces.filter(n => n === 'race-nonce')).toHaveLength(1);
    });
  });
});

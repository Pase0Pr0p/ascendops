import { existsSync, readFileSync, mkdirSync, unlinkSync, openSync, closeSync, constants, statSync } from 'fs';
import { writeFileSync } from 'fs';
import { dirname } from 'path';
import { atomicWriteSync } from '../../utils/atomic.js';

export interface LedgerState {
  install_id: string;
  installed_at: string;
  version: number;
  consumed_nonces: string[];
}

export interface LedgerLoadResult {
  loaded: boolean;
  state: LedgerState | null;
  error?: string;
}

export interface LedgerInitResult {
  success: boolean;
  install_id?: string;
  error?: string;
}

let anchorPath: string | null = null;

export function setInstallAnchorPath(path: string): void {
  anchorPath = path;
}

export function resetAnchorPath(): void {
  anchorPath = null;
}

function generateInstallId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'tl-';
  for (let i = 0; i < 16; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

function markerPath(ledgerPath: string): string {
  return ledgerPath + '.installed';
}

function lockFilePath(ledgerPath: string): string {
  return ledgerPath + '.lock';
}

function isValidLedger(obj: unknown): obj is LedgerState {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.install_id !== 'string' || !o.install_id) return false;
  if (typeof o.installed_at !== 'string') return false;
  if (typeof o.version !== 'number') return false;
  if (!Array.isArray(o.consumed_nonces)) return false;
  for (const n of o.consumed_nonces) {
    if (typeof n !== 'string') return false;
  }
  return true;
}

const STALE_LOCK_MS = 60_000;

function acquireLock(ledgerPath: string): boolean {
  const lp = lockFilePath(ledgerPath);
  try {
    mkdirSync(dirname(lp), { recursive: true });
    const fd = openSync(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
    writeFileSync(fd, String(process.pid), 'utf-8');
    closeSync(fd);
    return true;
  } catch {
    try {
      const stat = statSync(lp);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs > STALE_LOCK_MS) {
        unlinkSync(lp);
        const fd = openSync(lp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        writeFileSync(fd, String(process.pid), 'utf-8');
        closeSync(fd);
        return true;
      }
    } catch {
      // stale-lock recovery failed — fail-closed
    }
    return false;
  }
}

function releaseLock(ledgerPath: string): void {
  const lp = lockFilePath(ledgerPath);
  try { unlinkSync(lp); } catch { /* already removed */ }
}

function withLock<T>(ledgerPath: string, fn: () => T): T | { locked: false; error: string } {
  if (!acquireLock(ledgerPath)) {
    return { locked: false, error: 'Failed to acquire ledger lock — concurrent access denied' };
  }
  try {
    return fn();
  } finally {
    releaseLock(ledgerPath);
  }
}

function isLockError(v: unknown): v is { locked: false; error: string } {
  return v !== null && typeof v === 'object' && 'locked' in v && (v as Record<string, unknown>).locked === false;
}

export function initializeLedger(ledgerPath: string, initialVersion: number): LedgerInitResult {
  if (!anchorPath) {
    return { success: false, error: 'Install anchor path not configured — call setInstallAnchorPath() first' };
  }

  const marker = markerPath(ledgerPath);
  const anchorExists = existsSync(anchorPath);
  const markerExists = existsSync(marker);
  const ledgerExists = existsSync(ledgerPath);

  if (anchorExists || markerExists || ledgerExists) {
    return { success: false, error: 'Install anchor, ledger, or marker already exists — cannot re-initialize' };
  }

  const installId = generateInstallId();
  const state: LedgerState = {
    install_id: installId,
    installed_at: new Date().toISOString(),
    version: initialVersion,
    consumed_nonces: [],
  };

  try {
    atomicWriteSync(anchorPath, installId);
  } catch {
    return { success: false, error: 'Failed to write install anchor' };
  }

  try {
    atomicWriteSync(marker, installId);
  } catch {
    return { success: false, error: 'Failed to write install marker' };
  }

  try {
    atomicWriteSync(ledgerPath, JSON.stringify(state, null, 2));
  } catch {
    return { success: false, error: 'Failed to write ledger' };
  }

  return { success: true, install_id: installId };
}

export function loadLedger(ledgerPath: string): LedgerLoadResult {
  if (!anchorPath) {
    return { loaded: false, state: null, error: 'Install anchor path not configured — fail-closed' };
  }

  const marker = markerPath(ledgerPath);
  const anchorExists = existsSync(anchorPath);
  const markerExists = existsSync(marker);
  const ledgerExists = existsSync(ledgerPath);

  if (!anchorExists && !markerExists && !ledgerExists) {
    return { loaded: false, state: null, error: 'Not initialized — use initializeLedger() for first-run setup' };
  }

  if (!anchorExists) {
    return { loaded: false, state: null, error: 'Install anchor missing — tamper detected, deny' };
  }

  if (!markerExists) {
    return { loaded: false, state: null, error: 'Install marker missing but anchor exists — tamper detected, deny' };
  }

  if (!ledgerExists) {
    return { loaded: false, state: null, error: 'Ledger file missing but anchor/marker exist — tamper detected, deny' };
  }

  let anchorContent: string;
  try {
    anchorContent = readFileSync(anchorPath, 'utf-8').trim();
  } catch {
    return { loaded: false, state: null, error: 'Install anchor unreadable — fail-closed' };
  }

  let markerContent: string;
  try {
    markerContent = readFileSync(marker, 'utf-8').trim();
  } catch {
    return { loaded: false, state: null, error: 'Install marker unreadable — fail-closed' };
  }

  if (anchorContent !== markerContent) {
    return { loaded: false, state: null, error: 'Anchor and marker install_id mismatch — tamper detected, deny' };
  }

  let raw: string;
  try {
    raw = readFileSync(ledgerPath, 'utf-8');
  } catch {
    return { loaded: false, state: null, error: 'Ledger file unreadable — fail-closed' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { loaded: false, state: null, error: 'Ledger file malformed — fail-closed' };
  }

  if (!isValidLedger(parsed)) {
    return { loaded: false, state: null, error: 'Ledger file schema invalid — fail-closed' };
  }

  if (parsed.install_id !== anchorContent) {
    return { loaded: false, state: null, error: 'Ledger install_id does not match anchor — tamper detected, deny' };
  }

  return { loaded: true, state: parsed };
}

export function advanceVersion(ledgerPath: string, newVersion: number): LedgerLoadResult {
  const result = withLock(ledgerPath, () => {
    const loadResult = loadLedger(ledgerPath);
    if (!loadResult.loaded || !loadResult.state) return loadResult;

    if (newVersion < loadResult.state.version) {
      return { loaded: false, state: null, error: `Stale version: ${newVersion} < ledger version ${loadResult.state.version}` } as LedgerLoadResult;
    }

    const updated = { ...loadResult.state, version: newVersion };
    try {
      atomicWriteSync(ledgerPath, JSON.stringify(updated, null, 2));
    } catch {
      return { loaded: false, state: null, error: 'Failed to persist version advance — fail-closed' } as LedgerLoadResult;
    }

    return { loaded: true, state: updated } as LedgerLoadResult;
  });

  if (isLockError(result)) {
    return { loaded: false, state: null, error: result.error };
  }
  return result;
}

export function consumeNonce(ledgerPath: string, nonce: string): LedgerLoadResult {
  const result = withLock(ledgerPath, () => {
    const loadResult = loadLedger(ledgerPath);
    if (!loadResult.loaded || !loadResult.state) return loadResult;

    if (loadResult.state.consumed_nonces.includes(nonce)) {
      return { loaded: false, state: null, error: `Nonce ${nonce} already consumed — replay denied` } as LedgerLoadResult;
    }

    const updated: LedgerState = {
      ...loadResult.state,
      consumed_nonces: [...loadResult.state.consumed_nonces, nonce],
    };
    try {
      atomicWriteSync(ledgerPath, JSON.stringify(updated, null, 2));
    } catch {
      return { loaded: false, state: null, error: 'Failed to persist nonce consumption — fail-closed' } as LedgerLoadResult;
    }

    return { loaded: true, state: updated } as LedgerLoadResult;
  });

  if (isLockError(result)) {
    return { loaded: false, state: null, error: result.error };
  }
  return result;
}

export function unconsumeNonce(ledgerPath: string, nonce: string): LedgerLoadResult {
  const result = withLock(ledgerPath, () => {
    const loadResult = loadLedger(ledgerPath);
    if (!loadResult.loaded || !loadResult.state) return loadResult;

    const updated: LedgerState = {
      ...loadResult.state,
      consumed_nonces: loadResult.state.consumed_nonces.filter(n => n !== nonce),
    };
    try {
      atomicWriteSync(ledgerPath, JSON.stringify(updated, null, 2));
    } catch {
      return { loaded: false, state: null, error: 'Failed to persist nonce unconsumption — fail-closed' } as LedgerLoadResult;
    }

    return { loaded: true, state: updated } as LedgerLoadResult;
  });

  if (isLockError(result)) {
    return { loaded: false, state: null, error: result.error };
  }
  return result;
}

export function isNonceConsumed(ledgerPath: string, nonce: string): boolean {
  const loadResult = loadLedger(ledgerPath);
  if (!loadResult.loaded || !loadResult.state) return true;
  return loadResult.state.consumed_nonces.includes(nonce);
}

export function getLedgerVersion(ledgerPath: string): number | null {
  const loadResult = loadLedger(ledgerPath);
  if (!loadResult.loaded || !loadResult.state) return null;
  return loadResult.state.version;
}

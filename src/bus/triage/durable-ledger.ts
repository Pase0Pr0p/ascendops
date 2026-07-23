import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';

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

function writeLedger(path: string, state: LedgerState): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

function writeMarker(path: string, installId: string): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, installId, 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function initializeLedger(ledgerPath: string, initialVersion: number): LedgerInitResult {
  const marker = markerPath(ledgerPath);
  const markerExists = existsSync(marker);
  const ledgerExists = existsSync(ledgerPath);

  if (markerExists || ledgerExists) {
    return { success: false, error: 'Ledger or install marker already exists — cannot re-initialize' };
  }

  const installId = generateInstallId();
  const state: LedgerState = {
    install_id: installId,
    installed_at: new Date().toISOString(),
    version: initialVersion,
    consumed_nonces: [],
  };

  if (!writeMarker(marker, installId)) {
    return { success: false, error: 'Failed to write install marker' };
  }

  if (!writeLedger(ledgerPath, state)) {
    return { success: false, error: 'Failed to write ledger' };
  }

  return { success: true, install_id: installId };
}

export function loadLedger(ledgerPath: string): LedgerLoadResult {
  const marker = markerPath(ledgerPath);
  const markerExists = existsSync(marker);
  const ledgerExists = existsSync(ledgerPath);

  if (!markerExists && !ledgerExists) {
    return { loaded: false, state: null, error: 'Not initialized — use initializeLedger() for first-run setup' };
  }

  if (markerExists && !ledgerExists) {
    return { loaded: false, state: null, error: 'Ledger file missing but install marker exists — tamper detected, deny' };
  }

  if (!markerExists && ledgerExists) {
    return { loaded: false, state: null, error: 'Install marker missing but ledger exists — tamper detected, deny' };
  }

  let markerContent: string;
  try {
    markerContent = readFileSync(marker, 'utf-8').trim();
  } catch {
    return { loaded: false, state: null, error: 'Install marker unreadable — fail-closed' };
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

  if (parsed.install_id !== markerContent) {
    return { loaded: false, state: null, error: 'Ledger install_id does not match marker — tamper detected, deny' };
  }

  return { loaded: true, state: parsed };
}

export function advanceVersion(ledgerPath: string, newVersion: number): LedgerLoadResult {
  const loadResult = loadLedger(ledgerPath);
  if (!loadResult.loaded || !loadResult.state) return loadResult;

  if (newVersion < loadResult.state.version) {
    return { loaded: false, state: null, error: `Stale version: ${newVersion} < ledger version ${loadResult.state.version}` };
  }

  const updated = { ...loadResult.state, version: newVersion };
  if (!writeLedger(ledgerPath, updated)) {
    return { loaded: false, state: null, error: 'Failed to persist version advance — fail-closed' };
  }

  return { loaded: true, state: updated };
}

export function consumeNonce(ledgerPath: string, nonce: string): LedgerLoadResult {
  const loadResult = loadLedger(ledgerPath);
  if (!loadResult.loaded || !loadResult.state) return loadResult;

  if (loadResult.state.consumed_nonces.includes(nonce)) {
    return { loaded: false, state: null, error: `Nonce ${nonce} already consumed — replay denied` };
  }

  const updated: LedgerState = {
    ...loadResult.state,
    consumed_nonces: [...loadResult.state.consumed_nonces, nonce],
  };
  if (!writeLedger(ledgerPath, updated)) {
    return { loaded: false, state: null, error: 'Failed to persist nonce consumption — fail-closed' };
  }

  return { loaded: true, state: updated };
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

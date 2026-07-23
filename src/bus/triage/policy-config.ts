import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { PolicyConfig, CardConfig } from './types.js';

export interface PolicyLoadResult {
  loaded: boolean;
  config: PolicyConfig | null;
  error?: string;
}

export interface CardAuthResult {
  authorized: boolean;
  reason: string;
}

const DEFAULT_DISABLED_CONFIG: PolicyConfig = {
  version: 0,
  updated_at: '',
  updated_by: '',
  global_auto_send: false,
  cards: {},
};

function isValidPolicyConfig(obj: unknown): obj is PolicyConfig {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  if (typeof o.version !== 'number') return false;
  if (typeof o.updated_at !== 'string') return false;
  if (typeof o.updated_by !== 'string') return false;
  if (typeof o.global_auto_send !== 'boolean') return false;
  if (!o.cards || typeof o.cards !== 'object') return false;
  for (const [, card] of Object.entries(o.cards as Record<string, unknown>)) {
    if (!card || typeof card !== 'object') return false;
    const c = card as Record<string, unknown>;
    if (typeof c.auto_send !== 'boolean') return false;
  }
  return true;
}

let lastSeenVersion = -1;
let versionFilePath: string | null = null;

export function setVersionFilePath(path: string): void {
  versionFilePath = path;
}

export function resetLastSeenVersion(): void {
  lastSeenVersion = -1;
  versionFilePath = null;
}

function loadPersistedVersion(): number {
  if (!versionFilePath) {
    return -2;
  }
  try {
    if (!existsSync(versionFilePath)) return -1;
    const raw = readFileSync(versionFilePath, 'utf-8').trim();
    const v = parseInt(raw, 10);
    if (isNaN(v)) return -2;
    return v;
  } catch {
    return -2;
  }
}

function persistVersion(version: number): boolean {
  if (!versionFilePath) return false;
  try {
    mkdirSync(dirname(versionFilePath), { recursive: true });
    writeFileSync(versionFilePath, String(version), 'utf-8');
    return true;
  } catch {
    return false;
  }
}

export function loadPolicyConfig(configPath: string): PolicyLoadResult {
  if (!versionFilePath) {
    return { loaded: false, config: null, error: 'Version file path not configured — fail-closed' };
  }

  if (!existsSync(configPath)) {
    return { loaded: false, config: null, error: 'Config file missing' };
  }

  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf-8');
  } catch (err) {
    return { loaded: false, config: null, error: `Config file unreadable: ${err}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { loaded: false, config: null, error: 'Config file malformed: invalid JSON' };
  }

  if (!isValidPolicyConfig(parsed)) {
    return { loaded: false, config: null, error: 'Config file malformed: schema violation' };
  }

  if (lastSeenVersion < 0) {
    const persisted = loadPersistedVersion();
    if (persisted === -2) {
      return { loaded: false, config: null, error: 'Version file unreadable or corrupt — fail-closed' };
    }
    lastSeenVersion = persisted;
  }

  if (lastSeenVersion >= 0 && parsed.version < lastSeenVersion) {
    return { loaded: false, config: null, error: `Stale config version: ${parsed.version} < last seen ${lastSeenVersion}` };
  }

  lastSeenVersion = parsed.version;
  if (!persistVersion(parsed.version)) {
    return { loaded: false, config: null, error: 'Failed to persist version — fail-closed' };
  }
  return { loaded: true, config: parsed };
}

export function isAutoSendEnabled(loadResult: PolicyLoadResult): boolean {
  if (!loadResult.loaded || !loadResult.config) return false;
  return loadResult.config.global_auto_send === true;
}

export function isCardEnabled(loadResult: PolicyLoadResult, cardId: string): CardAuthResult {
  if (!loadResult.loaded || !loadResult.config) {
    return { authorized: false, reason: `Policy not loaded: ${loadResult.error}` };
  }

  if (!loadResult.config.global_auto_send) {
    return { authorized: false, reason: 'Global auto-send is disabled' };
  }

  const card = loadResult.config.cards[cardId];
  if (!card) {
    return { authorized: false, reason: `Unknown card ID: ${cardId}` };
  }

  if (typeof card.auto_send !== 'boolean') {
    return { authorized: false, reason: `Card ${cardId} auto_send is not boolean` };
  }

  if (!card.auto_send) {
    return { authorized: false, reason: `Card ${cardId} is disabled` };
  }

  return { authorized: true, reason: 'Card enabled' };
}

export function checkVersionMatch(loadResult: PolicyLoadResult, expectedVersion: number): boolean {
  if (!loadResult.loaded || !loadResult.config) return false;
  return loadResult.config.version === expectedVersion;
}

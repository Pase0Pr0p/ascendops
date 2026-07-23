import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadPolicyConfig,
  isAutoSendEnabled,
  isCardEnabled,
  checkVersionMatch,
  resetPolicyState,
  setLedgerPath,
} from '../../../../src/bus/triage/policy-config';
import { initializeLedger, setInstallAnchorPath, resetAnchorPath } from '../../../../src/bus/triage/durable-ledger';

describe('policy config', () => {
  let tmp: string;
  let configPath: string;
  let ledgerPath: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-config-'));
    configPath = join(tmp, 'triage-policy.json');
    ledgerPath = join(tmp, 'triage-ledger.json');
    resetPolicyState();
    setInstallAnchorPath(join(tmp, 'anchor', 'triage.anchor'));
    initializeLedger(ledgerPath, 0);
    setLedgerPath(ledgerPath);
  });

  afterEach(() => {
    resetAnchorPath();
    rmSync(tmp, { recursive: true, force: true });
  });

  function writeConfig(config: object) {
    writeFileSync(configPath, JSON.stringify(config), 'utf-8');
  }

  const VALID_CONFIG = {
    version: 1,
    updated_at: '2026-07-23T00:00:00Z',
    updated_by: 'albie',
    global_auto_send: true,
    cards: {
      'clogged-drain': { auto_send: true, enabled_at: '2026-07-23T00:00:00Z', enabled_by: 'albie' },
      'no-hot-water': { auto_send: false, enabled_at: '', enabled_by: '' },
    },
  };

  it('returns disabled when config file is missing', () => {
    const result = loadPolicyConfig(join(tmp, 'nonexistent.json'));
    expect(result.loaded).toBe(false);
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled when config is invalid JSON', () => {
    writeFileSync(configPath, 'not json at all', 'utf-8');
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain('invalid JSON');
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled when config has schema violation', () => {
    writeConfig({ global_auto_send: true, cards: {} });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain('schema violation');
  });

  it('returns disabled when global_auto_send is not boolean', () => {
    writeConfig({ version: 1, updated_at: '', updated_by: '', global_auto_send: 'yes', cards: {} });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
  });

  it('returns disabled when card auto_send is not boolean', () => {
    writeConfig({
      version: 1, updated_at: '', updated_by: '', global_auto_send: true,
      cards: { 'bad-card': { auto_send: 'yes' } },
    });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
  });

  it('returns disabled when config file is unreadable', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(join(tmp, '\0invalid-path'));
    expect(result.loaded).toBe(false);
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled for unknown card ID', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    const card = isCardEnabled(result, 'unknown-card-id');
    expect(card.authorized).toBe(false);
    expect(card.reason).toContain('Unknown card ID');
  });

  it('returns disabled when config version is stale', () => {
    writeConfig({ ...VALID_CONFIG, version: 5 });
    const r1 = loadPolicyConfig(configPath);
    expect(r1.loaded).toBe(true);

    writeConfig({ ...VALID_CONFIG, version: 3 });
    const r2 = loadPolicyConfig(configPath);
    expect(r2.loaded).toBe(false);
    expect(r2.error).toContain('Stale');
    expect(isAutoSendEnabled(r2)).toBe(false);
  });

  it('loads valid config and enables authorized cards', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    expect(isAutoSendEnabled(result)).toBe(true);
    expect(isCardEnabled(result, 'clogged-drain').authorized).toBe(true);
    expect(isCardEnabled(result, 'no-hot-water').authorized).toBe(false);
  });

  it('disables all cards when global_auto_send is false', () => {
    writeConfig({ ...VALID_CONFIG, global_auto_send: false });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    expect(isAutoSendEnabled(result)).toBe(false);
    expect(isCardEnabled(result, 'clogged-drain').reason).toContain('Global auto-send is disabled');
  });

  it('detects version mismatch for execute-time check', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(checkVersionMatch(result, 1)).toBe(true);
    expect(checkVersionMatch(result, 2)).toBe(false);
  });

  it('DENIES when ledger path is not set (fail-closed)', () => {
    resetPolicyState();
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain('Ledger path not configured');
  });

  it('new cards must be explicitly enabled, no inheritance', () => {
    writeConfig({
      ...VALID_CONFIG,
      cards: {
        'clogged-drain': { auto_send: true, enabled_at: '2026-07-23T00:00:00Z', enabled_by: 'albie' },
        'clogged-drain-diy': { auto_send: false, enabled_at: '', enabled_by: '' },
      },
    });
    const result = loadPolicyConfig(configPath);
    expect(isCardEnabled(result, 'clogged-drain').authorized).toBe(true);
    expect(isCardEnabled(result, 'clogged-drain-diy').authorized).toBe(false);
  });
});

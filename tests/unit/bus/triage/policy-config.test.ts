import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  loadPolicyConfig,
  isAutoSendEnabled,
  isCardEnabled,
  checkVersionMatch,
  resetLastSeenVersion,
  setVersionFilePath,
} from '../../../../src/bus/triage/policy-config';

describe('policy config', () => {
  let tmp: string;
  let configPath: string;
  let versionFile: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'triage-config-'));
    configPath = join(tmp, 'triage-policy.json');
    versionFile = join(tmp, '.policy-version');
    resetLastSeenVersion();
    setVersionFilePath(versionFile);
  });

  afterEach(() => {
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

  // Test 6: Missing config file -> all auto-send disabled
  it('returns disabled when config file is missing', () => {
    const result = loadPolicyConfig(join(tmp, 'nonexistent.json'));
    expect(result.loaded).toBe(false);
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  // Test 7: Malformed config -> all auto-send disabled
  it('returns disabled when config is invalid JSON', () => {
    writeFileSync(configPath, 'not json at all', 'utf-8');
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain('invalid JSON');
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled when config has schema violation (missing version)', () => {
    writeConfig({ global_auto_send: true, cards: {} });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(result.error).toContain('schema violation');
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled when global_auto_send is not boolean', () => {
    writeConfig({ version: 1, updated_at: '', updated_by: '', global_auto_send: 'yes', cards: {} });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  it('returns disabled when card auto_send is not boolean', () => {
    writeConfig({
      version: 1, updated_at: '', updated_by: '', global_auto_send: true,
      cards: { 'bad-card': { auto_send: 'yes' } },
    });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(false);
  });

  // Test 8: Unreadable config -> all auto-send disabled
  it('returns disabled when config file is unreadable', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(join(tmp, '\0invalid-path'));
    expect(result.loaded).toBe(false);
    expect(isAutoSendEnabled(result)).toBe(false);
  });

  // Test 9: Unknown card ID -> that card disabled
  it('returns disabled for unknown card ID', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    const card = isCardEnabled(result, 'unknown-card-id');
    expect(card.authorized).toBe(false);
    expect(card.reason).toContain('Unknown card ID');
  });

  // Test 10: Stale config version -> all auto-send disabled + alert
  it('returns disabled when config version is stale (lower than last seen)', () => {
    writeConfig({ ...VALID_CONFIG, version: 5 });
    const r1 = loadPolicyConfig(configPath);
    expect(r1.loaded).toBe(true);

    writeConfig({ ...VALID_CONFIG, version: 3 });
    const r2 = loadPolicyConfig(configPath);
    expect(r2.loaded).toBe(false);
    expect(r2.error).toContain('Stale config version');
    expect(isAutoSendEnabled(r2)).toBe(false);
  });

  it('loads valid config and enables authorized cards', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    expect(isAutoSendEnabled(result)).toBe(true);

    const enabled = isCardEnabled(result, 'clogged-drain');
    expect(enabled.authorized).toBe(true);

    const disabled = isCardEnabled(result, 'no-hot-water');
    expect(disabled.authorized).toBe(false);
  });

  it('disables all cards when global_auto_send is false', () => {
    writeConfig({ ...VALID_CONFIG, global_auto_send: false });
    const result = loadPolicyConfig(configPath);
    expect(result.loaded).toBe(true);
    expect(isAutoSendEnabled(result)).toBe(false);

    const card = isCardEnabled(result, 'clogged-drain');
    expect(card.authorized).toBe(false);
    expect(card.reason).toContain('Global auto-send is disabled');
  });

  // Test 12: Version change between review and send -> abort
  it('detects version mismatch for execute-time check', () => {
    writeConfig(VALID_CONFIG);
    const result = loadPolicyConfig(configPath);
    expect(checkVersionMatch(result, 1)).toBe(true);
    expect(checkVersionMatch(result, 2)).toBe(false);
  });

  describe('durable version persistence + fail-closed rollback', () => {
    it('persists version to disk and recovers after resetLastSeenVersion', () => {
      writeConfig({ ...VALID_CONFIG, version: 5 });
      const r1 = loadPolicyConfig(configPath);
      expect(r1.loaded).toBe(true);

      resetLastSeenVersion();
      setVersionFilePath(versionFile);

      writeConfig({ ...VALID_CONFIG, version: 3 });
      const r2 = loadPolicyConfig(configPath);
      expect(r2.loaded).toBe(false);
      expect(r2.error).toContain('Stale config version');
    });

    it('allows forward version advance after restart', () => {
      writeConfig({ ...VALID_CONFIG, version: 5 });
      loadPolicyConfig(configPath);

      resetLastSeenVersion();
      setVersionFilePath(versionFile);

      writeConfig({ ...VALID_CONFIG, version: 6 });
      const r2 = loadPolicyConfig(configPath);
      expect(r2.loaded).toBe(true);
    });

    it('DENIES when version file path is not set (fail-closed, not accept)', () => {
      resetLastSeenVersion();
      writeConfig({ ...VALID_CONFIG, version: 5 });
      const result = loadPolicyConfig(configPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Version file path not configured');
    });

    it('DENIES when version file contains garbage (fail-closed)', () => {
      writeFileSync(versionFile, 'not-a-number', 'utf-8');
      resetLastSeenVersion();
      setVersionFilePath(versionFile);

      writeConfig({ ...VALID_CONFIG, version: 5 });
      const result = loadPolicyConfig(configPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('unreadable or corrupt');
    });

    it('DENIES when version file write fails (fail-closed)', () => {
      setVersionFilePath(join(tmp, '\0bad-path', '.policy-version'));
      writeConfig({ ...VALID_CONFIG, version: 1 });
      const result = loadPolicyConfig(configPath);
      expect(result.loaded).toBe(false);
      expect(result.error).toContain('Failed to persist version');
    });
  });

  // Test 15: New cards start disabled, cannot inherit
  it('new cards must be explicitly enabled, no inheritance from family', () => {
    writeConfig({
      ...VALID_CONFIG,
      cards: {
        'clogged-drain': { auto_send: true, enabled_at: '2026-07-23T00:00:00Z', enabled_by: 'albie' },
        'clogged-drain-diy': { auto_send: false, enabled_at: '', enabled_by: '' },
      },
    });
    const result = loadPolicyConfig(configPath);
    const parent = isCardEnabled(result, 'clogged-drain');
    expect(parent.authorized).toBe(true);

    const child = isCardEnabled(result, 'clogged-drain-diy');
    expect(child.authorized).toBe(false);
  });
});

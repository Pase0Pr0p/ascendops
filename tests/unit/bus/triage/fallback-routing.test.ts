import { describe, it, expect } from 'vitest';
import { checkFallbackRouting } from '../../../../src/bus/triage/fallback-routing';
import type { FallbackHandoff } from '../../../../src/bus/triage/types';

function makeHandoff(overrides: Partial<FallbackHandoff> = {}): FallbackHandoff {
  return {
    active: true,
    set_by: 'albie',
    effective_from: '2026-07-20T00:00:00Z',
    expires_at: '2026-07-30T00:00:00Z',
    reason: 'Albie on PTO',
    set_at: '2026-07-19T00:00:00Z',
    ...overrides,
  };
}

describe('AT-16: Rob receives fallback only with active explicit handoff', () => {
  it('denies Rob routing when no handoff exists (null)', () => {
    const result = checkFallbackRouting(null);
    expect(result.robReceives).toBe(false);
    expect(result.reason).toContain('No active fallback');
  });

  it('denies Rob routing when no handoff exists (undefined)', () => {
    const result = checkFallbackRouting(undefined);
    expect(result.robReceives).toBe(false);
  });

  it('denies Rob routing when handoff is inactive', () => {
    const result = checkFallbackRouting(makeHandoff({ active: false }));
    expect(result.robReceives).toBe(false);
    expect(result.reason).toContain('No active fallback');
  });

  it('allows Rob routing when handoff is active and within time window', () => {
    const now = new Date('2026-07-25T12:00:00Z');
    const result = checkFallbackRouting(makeHandoff(), now);
    expect(result.robReceives).toBe(true);
    expect(result.reason).toContain('Active fallback handoff');
  });

  it('denies Rob routing when handoff has expired', () => {
    const now = new Date('2026-08-01T00:00:00Z');
    const result = checkFallbackRouting(makeHandoff(), now);
    expect(result.robReceives).toBe(false);
    expect(result.reason).toContain('expired');
  });

  it('denies Rob routing when handoff is not yet effective', () => {
    const now = new Date('2026-07-19T00:00:00Z');
    const result = checkFallbackRouting(makeHandoff(), now);
    expect(result.robReceives).toBe(false);
    expect(result.reason).toContain('not yet effective');
  });

  it('denies Rob routing when handoff has invalid dates (fail-closed)', () => {
    const result = checkFallbackRouting(makeHandoff({
      effective_from: 'not-a-date',
      expires_at: 'also-not-a-date',
    }));
    expect(result.robReceives).toBe(false);
    expect(result.reason).toContain('invalid dates');
  });
});

import { describe, it, expect } from 'vitest';
import { checkAutoSendConstraints } from '../../../../src/bus/triage/auto-send-constraints';

describe('AT-20: resident-manager properties deny auto-send', () => {
  it('denies auto-send for property with resident manager', () => {
    const result = checkAutoSendConstraints({
      hasResidentManager: true,
      propertyAddress: '909 E Blithedale Ave',
    });
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe('resident-manager-deny');
    expect(result.reason).toContain('resident manager');
  });

  it('allows auto-send for property without resident manager', () => {
    const result = checkAutoSendConstraints({
      hasResidentManager: false,
      propertyAddress: '123 Main St',
    });
    expect(result.allowed).toBe(true);
    expect(result.rule).toBe('property-clear');
  });

  it('denies auto-send for BirdsNest (known resident-manager property)', () => {
    const result = checkAutoSendConstraints({
      hasResidentManager: true,
      propertyAddress: 'BirdsNest Apartments',
    });
    expect(result.allowed).toBe(false);
    expect(result.rule).toBe('resident-manager-deny');
  });
});

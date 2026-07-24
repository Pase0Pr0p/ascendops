import { describe, it, expect } from 'vitest';
import { checkCapability } from '../../../../src/bus/triage/capability-matrix';
import type { Phase, Tier, ActionPurpose, ActionType, EscalationFlag } from '../../../../src/bus/triage/types';

function check(
  phase: Phase, tier: Tier | undefined, purpose: ActionPurpose, action: ActionType,
  flags: EscalationFlag[] = [], cardId?: string,
) {
  return checkCapability(phase, tier, purpose, action, flags, cardId);
}

describe('capability matrix — acceptance tests', () => {
  // Test 1: Mold always yields ONLY escalation, even with card+global enabled
  it('AT-1: mold flag denies all actions across all phases', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    const actions: ActionType[] = ['SEND_TENANT', 'DIY_OFFER', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED'];
    for (const phase of phases) {
      for (const action of actions) {
        const result = check(phase, 'N', 'ACK', action, ['MOLD_ESCALATE']);
        expect(result.decision).toBe('DENY');
        expect(result.rule).toBe('terminal-invariant');
      }
    }
  });

  // Test 2: (Mold detection breadth tested in mold-detection.test.ts)

  // Test 3: E0 yields alert-only across all phases including 2 and 3
  it('AT-3: E0 flag denies all actions across all phases', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    const actions: ActionType[] = ['SEND_TENANT', 'DIY_OFFER', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED'];
    for (const phase of phases) {
      for (const action of actions) {
        const result = check(phase, 'E0', 'ACK', action, ['LIFE_SAFETY_E0']);
        expect(result.decision).toBe('DENY');
        expect(result.rule).toBe('terminal-invariant');
      }
    }
  });

  // Test 4: Every phase rejects vendor dispatch, status/lifecycle, completion/close
  it('AT-4: vendor dispatch denied in every phase', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'VENDOR_DISPATCH', 'VENDOR_DISPATCH').decision).toBe('DENY');
      expect(check(phase, 'N', 'VENDOR_DISPATCH', 'VENDOR_DISPATCH').rule).toBe('permanent-deny');
    }
  });

  it('AT-4b: status write denied in every phase', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'STATUS', 'STATUS_WRITE').decision).toBe('DENY');
      expect(check(phase, 'N', 'STATUS', 'STATUS_WRITE').rule).toBe('permanent-deny');
    }
  });

  it('AT-4c: lifecycle write denied in every phase', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'STATUS', 'LIFECYCLE_WRITE').decision).toBe('DENY');
      expect(check(phase, 'N', 'STATUS', 'LIFECYCLE_WRITE').rule).toBe('permanent-deny');
    }
  });

  it('AT-4d: completion/close denied in every phase', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'STATUS', 'COMPLETION_CLOSE').decision).toBe('DENY');
      expect(check(phase, 'N', 'STATUS', 'COMPLETION_CLOSE').rule).toBe('permanent-deny');
    }
  });

  // Test 5: Phase 4 tenant confirmation produces CLOSE_REQUEST, not auto-close
  it('AT-5: Phase 4 allows CLOSE_REQUEST but denies COMPLETION_CLOSE', () => {
    expect(check(4, 'N', 'CLOSE_REQUEST', 'CLOSE_REQUEST').decision).toBe('ALLOW');
    expect(check(4, 'N', 'CLOSE_REQUEST', 'COMPLETION_CLOSE').decision).toBe('DENY');
    expect(check(4, 'N', 'CLOSE_REQUEST', 'COMPLETION_CLOSE').rule).toBe('permanent-deny');
  });

  // Tests 6-10, 12, 15: policy-config.test.ts
  // Test 11 (killswitch drains queue): send-queue.test.ts

  // Test 13: Phase 2 DIY_OFFER does not grant anything outside its allowlist
  it('AT-13: Phase 2 allows DIY_OFFER for N/D but denies vendor dispatch', () => {
    expect(check(2, 'N', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('ALLOW');
    expect(check(2, 'D', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('ALLOW');
    expect(check(2, 'N', 'VENDOR_DISPATCH', 'VENDOR_DISPATCH').decision).toBe('DENY');
    expect(check(2, 'N', 'STATUS', 'STATUS_WRITE').decision).toBe('DENY');
    expect(check(2, 'N', 'STATUS', 'COMPLETION_CLOSE').decision).toBe('DENY');
  });

  it('AT-13b: Phase 2 denies DIY_OFFER for E0/E1/U tiers', () => {
    expect(check(2, 'E0', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('DENY');
    expect(check(2, 'E1', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('DENY');
    expect(check(2, 'U', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('DENY');
  });

  // Test 14: Phase 3 contained-U does not grant vendor/status/close/mold/E0
  it('AT-14: Phase 3 allows ACK/INFO/DIY for U but denies vendor/status/close', () => {
    expect(check(3, 'U', 'ACK', 'SEND_TENANT').decision).toBe('ALLOW');
    expect(check(3, 'U', 'INFO_REQUEST', 'SEND_TENANT').decision).toBe('ALLOW');
    expect(check(3, 'U', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('ALLOW');
    expect(check(3, 'U', 'VENDOR_DISPATCH', 'VENDOR_DISPATCH').decision).toBe('DENY');
    expect(check(3, 'U', 'STATUS', 'STATUS_WRITE').decision).toBe('DENY');
    expect(check(3, 'U', 'STATUS', 'COMPLETION_CLOSE').decision).toBe('DENY');
  });

  it('AT-14b: Phase 3 still denies E0/E1 tiers for auto-send', () => {
    expect(check(3, 'E0', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
    expect(check(3, 'E1', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
  });

  // Test 15: policy-config.test.ts (new cards start disabled)
  // Test 16 (Rob fallback routing): fallback-routing.test.ts

  // Test 17: Mold escalation reaches both Albie AND Rob regardless of fallback
  it('AT-17: MOLD_ESCALATE flag denies send in all phases (routing to albie+rob is terminal-invariant level)', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      const result = check(phase, 'N', 'ACK', 'SEND_TENANT', ['MOLD_ESCALATE']);
      expect(result.decision).toBe('DENY');
      expect(result.rule).toBe('terminal-invariant');
    }
  });

  // Test 18: Only reviewed additive notes auto; status writes denied
  it('AT-18: INTERNAL_NOTE_REVIEWED allowed in all phases; INTERNAL_NOTE_OTHER denied', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'ACK', 'INTERNAL_NOTE_REVIEWED').decision).toBe('ALLOW');
      expect(check(phase, 'N', 'ACK', 'INTERNAL_NOTE_OTHER').decision).toBe('DENY');
      expect(check(phase, 'N', 'ACK', 'INTERNAL_NOTE_OTHER').rule).toBe('permanent-deny');
    }
  });

  // Test 19: WO assignment allowed in all phases (sole diagnosis-time ownership exception)
  it('AT-19: WO_ASSIGNMENT allowed in all phases', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      expect(check(phase, 'N', 'ACK', 'WO_ASSIGNMENT').decision).toBe('ALLOW');
    }
  });

  // Test 20 (resident-manager auto-send denied): auto-send-constraints.test.ts

  // Test 21: Scope-excluded -> no triage
  it('AT-21: SCOPE_EXCLUDED flag denies all actions', () => {
    const phases: Phase[] = [0, 1, 2, 3, 4];
    for (const phase of phases) {
      const result = check(phase, 'N', 'ACK', 'SEND_TENANT', ['SCOPE_EXCLUDED']);
      expect(result.decision).toBe('DENY');
      expect(result.rule).toBe('terminal-invariant');
    }
  });

  describe('Phase 0 shadow mode restrictions', () => {
    it('Phase 0 denies SEND_TENANT (shadow produces packets, sends nothing)', () => {
      expect(check(0, 'N', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
      expect(check(0, 'N', 'INFO_REQUEST', 'SEND_TENANT').decision).toBe('DENY');
    });

    it('Phase 0 denies DIY_OFFER', () => {
      expect(check(0, 'N', 'DIY_OFFER', 'DIY_OFFER').decision).toBe('DENY');
    });

    it('Phase 0 allows WO_ASSIGNMENT and INTERNAL_NOTE_REVIEWED only', () => {
      expect(check(0, 'N', 'ACK', 'WO_ASSIGNMENT').decision).toBe('ALLOW');
      expect(check(0, 'N', 'ACK', 'INTERNAL_NOTE_REVIEWED').decision).toBe('ALLOW');
    });
  });

  describe('Phase 1 canary restrictions', () => {
    it('Phase 1 allows ACK/INFO_REQUEST for N/D only', () => {
      expect(check(1, 'N', 'ACK', 'SEND_TENANT').decision).toBe('ALLOW');
      expect(check(1, 'D', 'INFO_REQUEST', 'SEND_TENANT').decision).toBe('ALLOW');
    });

    it('Phase 1 denies ACK/INFO for E0/E1/U', () => {
      expect(check(1, 'E0', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
      expect(check(1, 'E1', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
      expect(check(1, 'U', 'ACK', 'SEND_TENANT').decision).toBe('DENY');
    });

    it('Phase 1 denies DIY_OFFER', () => {
      expect(check(1, 'N', 'DIY_OFFER', 'SEND_TENANT').decision).toBe('DENY');
    });
  });

  describe('escalation flags deny auto-send', () => {
    it('any non-terminal escalation flag denies SEND_TENANT', () => {
      const flags: EscalationFlag[] = ['RESPONSIBILITY_UNCLEAR', 'VENDOR_DISPATCH', 'REPEAT_FAILURE'];
      for (const flag of flags) {
        const result = check(1, 'N', 'ACK', 'SEND_TENANT', [flag]);
        expect(result.decision).toBe('DENY');
      }
    });
  });

  describe('unknown phase defaults to no authority', () => {
    it('phase 99 denies everything', () => {
      const result = check(99 as Phase, 'N', 'ACK', 'SEND_TENANT');
      expect(result.decision).toBe('DENY');
      expect(result.rule).toBe('unknown-phase');
    });
  });

  describe('vendor-related permanent denies', () => {
    it('SEND_VENDOR denied in all phases', () => {
      const phases: Phase[] = [0, 1, 2, 3, 4];
      for (const phase of phases) {
        expect(check(phase, 'N', 'ACK', 'SEND_VENDOR').decision).toBe('DENY');
        expect(check(phase, 'N', 'ACK', 'SEND_VENDOR').rule).toBe('permanent-deny');
      }
    });

    it('SPEND_APPROVE denied in all phases', () => {
      const phases: Phase[] = [0, 1, 2, 3, 4];
      for (const phase of phases) {
        expect(check(phase, 'N', 'ACK', 'SPEND_APPROVE').decision).toBe('DENY');
      }
    });

    it('RESPONSIBILITY_STATEMENT denied in all phases', () => {
      const phases: Phase[] = [0, 1, 2, 3, 4];
      for (const phase of phases) {
        expect(check(phase, 'N', 'ACK', 'RESPONSIBILITY_STATEMENT').decision).toBe('DENY');
      }
    });

    it('LEGAL_COMMITMENT denied in all phases', () => {
      const phases: Phase[] = [0, 1, 2, 3, 4];
      for (const phase of phases) {
        expect(check(phase, 'N', 'ACK', 'LEGAL_COMMITMENT').decision).toBe('DENY');
      }
    });

    it('ENTRY_DECISION denied in all phases', () => {
      const phases: Phase[] = [0, 1, 2, 3, 4];
      for (const phase of phases) {
        expect(check(phase, 'N', 'ACK', 'ENTRY_DECISION').decision).toBe('DENY');
      }
    });
  });
});

import type { Phase, Tier, ActionPurpose, ActionType, EscalationFlag, CapabilityCheckResult, TerminalFlag } from './types.js';

const TERMINAL_FLAGS: Set<string> = new Set<string>([
  'MOLD_ESCALATE',
  'LIFE_SAFETY_E0',
  'SCOPE_EXCLUDED',
]);

interface PermanentDeny {
  action: ActionType;
  reason: string;
}

const PERMANENT_DENIES: PermanentDeny[] = [
  { action: 'VENDOR_DISPATCH', reason: 'Vendor dispatch is ALWAYS human-gated' },
  { action: 'SEND_VENDOR', reason: 'Vendor communication is ALWAYS human-gated' },
  { action: 'VENDOR_SCHEDULE', reason: 'Vendor schedule promises are ALWAYS human-gated' },
  { action: 'SPEND_APPROVE', reason: 'Spend/quote/PO/scope expansion is ALWAYS human-gated' },
  { action: 'RESPONSIBILITY_STATEMENT', reason: 'Responsibility/chargeback/tenant-fault is ALWAYS human-gated' },
  { action: 'LEGAL_COMMITMENT', reason: 'Legal/habitability/health-cause commitment is ALWAYS human-gated' },
  { action: 'ENTRY_DECISION', reason: 'Entry/access decisions are ALWAYS human-gated' },
  { action: 'STATUS_WRITE', reason: 'WO status transitions are ALWAYS human-gated' },
  { action: 'LIFECYCLE_WRITE', reason: 'WO lifecycle writes are ALWAYS human-gated' },
  { action: 'COMPLETION_CLOSE', reason: 'WO completion/close is ALWAYS human-gated (even with tenant confirmation)' },
  { action: 'INTERNAL_NOTE_OTHER', reason: 'Automated internal notes outside reviewed additive path are denied' },
];

interface PhaseAllow {
  phase: Phase;
  tiers: Set<Tier>;
  purposes: Set<ActionPurpose>;
  actions: Set<ActionType>;
}

const PHASE_ALLOWS: PhaseAllow[] = [
  {
    phase: 0,
    tiers: new Set<Tier>(['E0', 'E1', 'U', 'N', 'D']),
    purposes: new Set<ActionPurpose>([]),
    actions: new Set<ActionType>(['WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED']),
  },
  {
    phase: 1,
    tiers: new Set<Tier>(['N', 'D']),
    purposes: new Set<ActionPurpose>(['ACK', 'INFO_REQUEST']),
    actions: new Set<ActionType>(['SEND_TENANT', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED']),
  },
  {
    phase: 2,
    tiers: new Set<Tier>(['N', 'D']),
    purposes: new Set<ActionPurpose>(['ACK', 'INFO_REQUEST', 'DIY_OFFER']),
    actions: new Set<ActionType>(['SEND_TENANT', 'DIY_OFFER', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED']),
  },
  {
    phase: 3,
    tiers: new Set<Tier>(['N', 'D', 'U']),
    purposes: new Set<ActionPurpose>(['ACK', 'INFO_REQUEST', 'DIY_OFFER']),
    actions: new Set<ActionType>(['SEND_TENANT', 'DIY_OFFER', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED']),
  },
  {
    phase: 4,
    tiers: new Set<Tier>(['E0', 'E1', 'U', 'N', 'D']),
    purposes: new Set<ActionPurpose>(['CLOSE_REQUEST']),
    actions: new Set<ActionType>(['CLOSE_REQUEST', 'WO_ASSIGNMENT', 'INTERNAL_NOTE_REVIEWED']),
  },
];

export function checkCapability(
  phase: Phase,
  tier: Tier | undefined,
  purpose: ActionPurpose,
  actionType: ActionType,
  escalationFlags: EscalationFlag[],
  cardId?: string,
): CapabilityCheckResult {
  for (const flag of escalationFlags) {
    if (TERMINAL_FLAGS.has(flag)) {
      return {
        decision: 'DENY',
        reason: `Terminal flag ${flag} is active — only fixed escalation permitted`,
        rule: 'terminal-invariant',
      };
    }
  }

  for (const deny of PERMANENT_DENIES) {
    if (deny.action === actionType) {
      return {
        decision: 'DENY',
        reason: deny.reason,
        rule: 'permanent-deny',
      };
    }
  }

  if (escalationFlags.length > 0 && actionType === 'SEND_TENANT') {
    return {
      decision: 'DENY',
      reason: `Escalation flags present: ${escalationFlags.join(', ')}`,
      rule: 'escalation-flag-deny',
    };
  }

  const phaseAllow = PHASE_ALLOWS.find(p => p.phase === phase);
  if (!phaseAllow) {
    return {
      decision: 'DENY',
      reason: `Unknown phase: ${phase}`,
      rule: 'unknown-phase',
    };
  }

  if (tier && !phaseAllow.tiers.has(tier)) {
    return {
      decision: 'DENY',
      reason: `Tier ${tier} not allowed in Phase ${phase} (allowed: ${[...phaseAllow.tiers].join(', ')})`,
      rule: 'phase-tier-deny',
    };
  }

  if (!phaseAllow.actions.has(actionType)) {
    return {
      decision: 'DENY',
      reason: `Action ${actionType} not allowed in Phase ${phase}`,
      rule: 'phase-action-deny',
    };
  }

  if (actionType === 'SEND_TENANT' || actionType === 'DIY_OFFER') {
    if (!phaseAllow.purposes.has(purpose)) {
      return {
        decision: 'DENY',
        reason: `Purpose ${purpose} not allowed in Phase ${phase} (allowed: ${[...phaseAllow.purposes].join(', ')})`,
        rule: 'phase-purpose-deny',
      };
    }
  }

  return {
    decision: 'ALLOW',
    reason: `Phase ${phase} allows ${actionType} with purpose ${purpose} for tier ${tier ?? 'any'}`,
    rule: 'phase-allow',
  };
}

export function getPermanentDenies(): PermanentDeny[] {
  return [...PERMANENT_DENIES];
}

export function getPhaseAllows(): PhaseAllow[] {
  return PHASE_ALLOWS.map(p => ({
    ...p,
    tiers: new Set(p.tiers),
    purposes: new Set(p.purposes),
    actions: new Set(p.actions),
  }));
}

import type { Phase, Tier, ActionPurpose, ActionType, EscalationFlag, CapabilityCheckResult } from './types.js';
import { reclassifyIfSchedule } from './schedule-classifier.js';
import { checkCapability } from './capability-matrix.js';

export interface GateResult {
  decision: 'ALLOW' | 'DENY';
  finalActionType: ActionType;
  reclassified: boolean;
  reason: string;
  rule: string;
}

export function triageGate(
  phase: Phase,
  tier: Tier | undefined,
  purpose: ActionPurpose,
  actionType: ActionType,
  messageContent: string,
  escalationFlags: EscalationFlag[] = [],
  cardId?: string,
): GateResult {
  const reclassifiedType = reclassifyIfSchedule(messageContent, actionType);
  const wasReclassified = reclassifiedType !== actionType;

  const capResult = checkCapability(phase, tier, purpose, reclassifiedType, escalationFlags, cardId);

  return {
    decision: capResult.decision,
    finalActionType: reclassifiedType,
    reclassified: wasReclassified,
    reason: capResult.reason,
    rule: capResult.rule,
  };
}

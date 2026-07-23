import type { TriageState, TriageWO, TerminalCheckResult, ShadowRecord, ActionPacket, ReviewVerdict } from './types.js';
import { checkTerminalInvariants } from './terminal-invariants.js';

const VALID_TRANSITIONS: Record<TriageState, TriageState[]> = {
  INTAKE: ['READING', 'ESCALATED'],
  READING: ['CLASSIFYING', 'ESCALATED'],
  CLASSIFYING: ['DRAFTING', 'ESCALATED'],
  DRAFTING: ['REVIEW', 'ESCALATED'],
  REVIEW: ['READY_FOR_HUMAN', 'ESCALATED'],
  READY_FOR_HUMAN: ['ESCALATED'],
  ESCALATED: [],
};

export interface TransitionResult {
  success: boolean;
  newState: TriageState;
  terminalCheck?: TerminalCheckResult;
  reason?: string;
}

export function transition(wo: TriageWO, targetState: TriageState): TransitionResult {
  const terminalCheck = checkTerminalInvariants(wo);
  if (terminalCheck.terminal) {
    wo.state = 'ESCALATED';
    wo.terminalFlag = terminalCheck.flag;
    if (terminalCheck.flag && !wo.escalationFlags.includes(terminalCheck.flag)) {
      wo.escalationFlags.push(terminalCheck.flag);
    }
    return {
      success: targetState === 'ESCALATED',
      newState: 'ESCALATED',
      terminalCheck,
      reason: terminalCheck.reason,
    };
  }

  if (wo.state === 'ESCALATED') {
    return {
      success: false,
      newState: 'ESCALATED',
      reason: 'ESCALATED is a terminal state with no outbound transitions',
    };
  }

  const allowed = VALID_TRANSITIONS[wo.state];
  if (!allowed || !allowed.includes(targetState)) {
    return {
      success: false,
      newState: wo.state,
      reason: `Invalid transition: ${wo.state} -> ${targetState}`,
    };
  }

  wo.state = targetState;
  return { success: true, newState: targetState, terminalCheck };
}

export function createTriageWO(woId: string, propertyAddress: string, conversationText: string): TriageWO {
  return {
    woId,
    propertyAddress,
    conversationText,
    photoUrls: [],
    escalationFlags: [],
    facts: [],
    state: 'INTAKE',
  };
}

export function createShadowRecord(
  wo: TriageWO,
  packet: ActionPacket,
  review: ReviewVerdict,
): ShadowRecord {
  return {
    woId: wo.woId,
    shadowVerdict: packet,
    reviewResult: review,
    timestamp: new Date().toISOString(),
  };
}

import type { TriageWO, TerminalCheckResult } from './types.js';
import { detectMold } from './mold-detection.js';

const SCOPE_EXCLUDED_PATTERNS: RegExp[] = [
  /\bbelvedere\b/i,
  /\btiburon\b/i,
  /\bpaloma\b/i,
];

const E0_PATTERNS: RegExp[] = [
  /\bfire\b/i,
  /\bsmoke\b/i,
  /\bgas\s*(leak|smell|odor|odour)\b/i,
  /\bsmell(s|ing)?\s*(of\s+)?gas\b/i,
  /\bcarbon\s*monoxide\b/i,
  /\bco\s*(alarm|detector|alert)\b/i,
  /\belectric(al)?\s*shock\b/i,
  /\belectrocut/i,
  /\barcing\b/i,
  /\bsparking\b.*\b(outlet|wire|panel|switch)\b/i,
  /\bdowned\s*(power\s*)?line/i,
  /\binjur(y|ed|ies)\b/i,
  /\bimmediate\s*danger\b/i,
];

export function checkTerminalInvariants(wo: TriageWO): TerminalCheckResult {
  const scopeResult = checkScopeExcluded(wo);
  if (scopeResult.terminal) return scopeResult;

  const moldResult = checkMold(wo);
  if (moldResult.terminal) return moldResult;

  const e0Result = checkE0(wo);
  if (e0Result.terminal) return e0Result;

  return { terminal: false };
}

function checkScopeExcluded(wo: TriageWO): TerminalCheckResult {
  const address = wo.propertyAddress || '';
  for (const pattern of SCOPE_EXCLUDED_PATTERNS) {
    if (pattern.test(address)) {
      return {
        terminal: true,
        flag: 'SCOPE_EXCLUDED',
        reason: `Property matches scope exclusion: ${address}`,
        recipients: ['albie'],
      };
    }
  }
  return { terminal: false };
}

function checkMold(wo: TriageWO): TerminalCheckResult {
  const moldResult = detectMold(wo.conversationText, wo.visionAnalysis);

  if (moldResult.detected) {
    return {
      terminal: true,
      flag: 'MOLD_ESCALATE',
      reason: `Mold detected (${moldResult.confidence}, ${moldResult.source}): ${moldResult.matches.join(', ')}`,
      recipients: ['albie', 'rob'],
    };
  }

  return { terminal: false };
}

function checkE0(wo: TriageWO): TerminalCheckResult {
  const text = wo.conversationText || '';
  for (const pattern of E0_PATTERNS) {
    if (pattern.test(text)) {
      return {
        terminal: true,
        flag: 'LIFE_SAFETY_E0',
        reason: `Life safety E0 signal in conversation: ${pattern.source}`,
        recipients: ['albie'],
      };
    }
  }
  return { terminal: false };
}

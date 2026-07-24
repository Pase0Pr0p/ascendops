import type { ActionPurpose } from './types.js';

export interface ContentValidationResult {
  valid: boolean;
  violations: string[];
}

interface ProhibitedPattern {
  category: string;
  patterns: RegExp[];
}

const PROHIBITED_TENANT_CONTENT: ProhibitedPattern[] = [
  {
    category: 'internal-classification-label',
    patterns: [
      /\btier\s+[A-Z0-9]+\b/i,
      /\bpriority\s*(:|is|=)\s*(low|medium|high|critical|urgent)\b/i,
      /\bclassified\s*(as|your)\b/i,
      /\btrade\s+[A-Z]+\b/i,
      /\bescalation\s*flag\b/i,
      /\blow\s*priority\b/i,
      /\bhigh\s*priority\b/i,
    ],
  },
  {
    category: 'responsibility-or-chargeback',
    patterns: [
      /\byour\s*(fault|responsibility|negligence|damage)\b/i,
      /\byou\s+will\s+be\s+(charged|billed|invoiced)\b/i,
      /\bchargeback\b/i,
      /\btenant[\s-]*caused\b/i,
      /\btenant[\s-]*responsible\b/i,
      /\bdeduct(ed|ion)?\s*(from|against)\s*(your|the)\s*(deposit|security)\b/i,
    ],
  },
  {
    category: 'entry-or-access-authority',
    patterns: [
      /\bwe\s+(have|got)\s+permission\b/i,
      /\bwe\s+will\s+enter\b/i,
      /\benter\s+your\s+unit\b/i,
      /\baccess\s+your\s+(unit|apartment|home)\b/i,
      /\bauthoriz(e|ed)\s+(entry|access)\b/i,
      /\bforced?\s+entry\b/i,
    ],
  },
  {
    category: 'schedule-promise',
    patterns: [
      /\byour\s+appointment\s+is\b/i,
      /\bscheduled\s+(for|on|at)\b/i,
      /\bwe\s+will\s+(come|send|dispatch|arrive|be\s+there)\b/i,
      /\b(plumber|electrician|technician|vendor|contractor)\s+will\s+(come|arrive|be\s+there)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+\d/i,
      /\btomorrow\s+at\s+\d/i,
      /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i,
    ],
  },
  {
    category: 'legal-or-health-commitment',
    patterns: [
      /\bhabitab(le|ility)\b/i,
      /\bcode\s*(compliance|violation|requirement)\b/i,
      /\bhealth\s*(hazard|risk|concern|violation)\b/i,
      /\blegal(ly)?\s*(required|obligat|compli)/i,
      /\bwarranty\s+(of|for)\s+habitability\b/i,
    ],
  },
];

const TENANT_FACING_PURPOSES: Set<ActionPurpose> = new Set([
  'ACK', 'INFO_REQUEST', 'DIY_OFFER', 'STATUS', 'CLOSE_REQUEST',
]);

export function validateContent(messageBytes: string, purpose: ActionPurpose): ContentValidationResult {
  if (!TENANT_FACING_PURPOSES.has(purpose)) {
    return { valid: true, violations: [] };
  }

  const violations: string[] = [];

  for (const prohibited of PROHIBITED_TENANT_CONTENT) {
    for (const pattern of prohibited.patterns) {
      if (pattern.test(messageBytes)) {
        violations.push(`${prohibited.category}: matched '${pattern.source}'`);
        break;
      }
    }
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

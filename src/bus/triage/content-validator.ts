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
      /\b(repair|cost|bill|charge|expense)\s+(is|are)\s+yours\b/i,
      /\byou\s+(are|will\s+be)\s+(liable|responsible)\b/i,
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
      /\blet\s+(ourselves|us)\s+(in|into)\b/i,
      /\bwe\s+can\s+(access|get\s+into|go\s+into|enter)\b/i,
    ],
  },
  {
    category: 'schedule-promise',
    patterns: [
      /\byour\s+appointment\s+is\b/i,
      /\bscheduled\s+(for|on|at)\b/i,
      /\bwe\s+will\s+(come|send|dispatch|arrive|be\s+there)\b/i,
      /\b(plumber|electrician|technician|vendor|contractor)\s+(will\s+(come|arrive|be\s+there)|is\s+booked)\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+\d/i,
      /\btomorrow\s+at\s+\d/i,
      /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i,
      /\b(is|are)\s+booked\s+(for\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next|this)\b/i,
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

const ALLOWED_ACK_PATTERNS: RegExp[] = [
  /^thank\s+you\s+(for|we)\b/i,
  /^we\s+(have\s+)?(received|got|logged|noted)\s+(your|the|this)\b/i,
  /^your\s+(maintenance\s+)?(request|report|submission)\s+(has\s+been\s+)?(received|logged|noted|recorded)\b/i,
  /^(hi|hello|good\s+(morning|afternoon|evening))\b.*\b(received|noted|logged|looking\s+into)\b/i,
  /^(acknowledged|noted|received)\b/i,
];

const ALLOWED_INFO_REQUEST_PATTERNS: RegExp[] = [
  /\b(could|can|would)\s+you\s+(provide|send|share|take|upload)\b/i,
  /\b(please\s+)?(provide|send|share|take|upload)\s+(us\s+)?(a\s+)?(photo|picture|image|detail|description|more\s+info)/i,
  /\bwhat\s+(is|are|was|were)\b/i,
  /\bwhen\s+did\b/i,
  /\bwhere\s+(exactly|specifically|is|are)\b/i,
  /\bhow\s+(long|often|many)\b/i,
  /\bis\s+(the|this|it|there)\b/i,
  /\bdo\s+you\s+(have|know|see|notice)\b/i,
];

const ALLOWED_DIY_PATTERNS: RegExp[] = [
  /\byou\s+(might|could|can|may)\s+(try|check|look|reset|flip|toggle)\b/i,
  /\b(try|check|look\s+at|reset|flip|toggle)\s+(the|your|a)\b/i,
  /\bsometimes\s+(this|these|it)\b/i,
  /\bif\s+(that|this|it)\s+(doesn't|does\s+not|hasn't)\b/i,
  /\blet\s+us\s+know\s+(if|how|whether)\b/i,
];

function matchesAllowlist(message: string, purpose: ActionPurpose): boolean {
  const trimmed = message.trim();

  if (purpose === 'ACK') {
    return ALLOWED_ACK_PATTERNS.some(p => p.test(trimmed));
  }
  if (purpose === 'INFO_REQUEST') {
    return ALLOWED_INFO_REQUEST_PATTERNS.some(p => p.test(trimmed));
  }
  if (purpose === 'DIY_OFFER') {
    return ALLOWED_DIY_PATTERNS.some(p => p.test(trimmed));
  }

  return false;
}

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

  if (violations.length > 0) {
    return { valid: false, violations };
  }

  if (!matchesAllowlist(messageBytes, purpose)) {
    return {
      valid: false,
      violations: [`content-not-in-allowlist: tenant-facing '${purpose}' content does not match any approved template — requires human review`],
    };
  }

  return { valid: true, violations: [] };
}

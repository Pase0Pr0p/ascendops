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
      /\b(repair|cost|bill|charge|expense)\s+(is|are|belongs)\s+(to\s+)?(yours|you)\b/i,
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
      /\bunlock\s+(the|your)\s+(apartment|unit|door)\b/i,
    ],
  },
  {
    category: 'schedule-promise',
    patterns: [
      /\byour\s+appointment\s+is\b/i,
      /\bscheduled\s+(for|on|at)\b/i,
      /\bwe\s+will\s+(come|send|dispatch|arrive|be\s+there)\b/i,
      /\b(plumber|electrician|technician|vendor|contractor)\s+(will\s+(come|arrive|be\s+there)|is\s+(booked|arriving|coming|scheduled))\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+\d/i,
      /\btomorrow\s+at\s+\d/i,
      /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i,
      /\b(is|are)\s+(booked|arriving|coming|scheduled)\s+(for\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday|tomorrow|next|this)\b/i,
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

interface Template {
  id: string;
  pattern: RegExp;
}

const ACK_TEMPLATES: Template[] = [
  { id: 'ack-thankyou', pattern: /^thank\s+you\s+for\s+(letting\s+us\s+know|your\s+(message|report|request))\s*[.,]?\s*(we\s+have\s+(received|logged|noted)\s+(your|the|this)\s+(maintenance\s+)?(request|report|message|submission)(\s+and\s+will\s+look\s+into\s+it(\s+shortly)?)?)?[.\s]*$/i },
  { id: 'ack-received', pattern: /^we\s+have\s+(received|logged|noted)\s+(your|the|this)\s+(maintenance\s+)?(request|report|message|submission)(\s+and\s+will\s+look\s+into\s+it(\s+shortly)?)?[.\s]*$/i },
  { id: 'ack-your-request', pattern: /^your\s+(maintenance\s+)?(request|report|submission)\s+has\s+been\s+(received|logged|noted|recorded)(\s+and\s+(logged|noted|recorded))?[.\s]*$/i },
  { id: 'ack-greeting', pattern: /^(hi|hello|good\s+(morning|afternoon|evening))\s*[.,]?\s*(we\s+have\s+)?(received|noted|logged)\s+(your|the|this)\s+(maintenance\s+)?(request|report|message)[.\s]*$/i },
  { id: 'ack-simple', pattern: /^(acknowledged|noted|received)[.\s]*$/i },
  { id: 'ack-we-received', pattern: /^we\s+received\s+your\s+(maintenance\s+)?(request|report|message)[.\s]*$/i },
];

const INFO_REQUEST_TEMPLATES: Template[] = [
  { id: 'info-could-you', pattern: /^(could|can|would)\s+you\s+(please\s+)?(provide|send|share|take|upload)\s+(us\s+)?(a\s+)?(photo|picture|image|photos|pictures|images|more\s+(information|details|info)|detail|details|description)\s*(of\s+(the\s+)?(issue|problem|damage|area|situation))?\s*\??\s*$/i },
  { id: 'info-please', pattern: /^(please\s+)?(provide|send|share|take|upload)\s+(us\s+)?(a\s+)?(photo|picture|image|photos|pictures|images|more\s+(information|details|info))\s*(of\s+(the\s+)?(issue|problem|damage|area))?\s*[.\s]*$/i },
  { id: 'info-question-what', pattern: /^what\s+(is|are|was|were)\s+.{3,80}\??\s*$/i },
  { id: 'info-question-when', pattern: /^when\s+did\s+.{3,80}\??\s*$/i },
  { id: 'info-question-where', pattern: /^where\s+(exactly|specifically|is|are)\s+.{3,60}\??\s*$/i },
  { id: 'info-question-how', pattern: /^how\s+(long|often|many)\s+.{3,60}\??\s*$/i },
  { id: 'info-question-is', pattern: /^(is|are|do|does|has|have)\s+(the|this|it|there|you)\s+.{3,60}\??\s*$/i },
];

const DIY_TEMPLATES: Template[] = [
  { id: 'diy-might-try', pattern: /^you\s+(might|could|can|may)\s+(try|check|look\s+at|reset|flip|toggle)\s+.{3,100}[.\s]*$/i },
  { id: 'diy-try', pattern: /^(try|check|look\s+at|reset|flip|toggle)\s+(the|your|a)\s+.{3,80}[.\s]*$/i },
  { id: 'diy-sometimes', pattern: /^sometimes\s+(this|these|it)\s+.{3,100}[.\s]*$/i },
  { id: 'diy-if-that', pattern: /^if\s+(that|this|it)\s+(doesn't|does\s+not|hasn't)\s+.{3,80}[.\s]*$/i },
  { id: 'diy-let-us-know', pattern: /^let\s+us\s+know\s+(if|how|whether)\s+.{3,80}[.\s]*$/i },
];

function matchesTemplate(message: string, purpose: ActionPurpose): { matched: boolean; templateId?: string } {
  const trimmed = message.trim();

  let templates: Template[];
  if (purpose === 'ACK') templates = ACK_TEMPLATES;
  else if (purpose === 'INFO_REQUEST') templates = INFO_REQUEST_TEMPLATES;
  else if (purpose === 'DIY_OFFER') templates = DIY_TEMPLATES;
  else return { matched: false };

  for (const t of templates) {
    if (t.pattern.test(trimmed)) {
      return { matched: true, templateId: t.id };
    }
  }
  return { matched: false };
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

  const templateMatch = matchesTemplate(messageBytes, purpose);
  if (!templateMatch.matched) {
    return {
      valid: false,
      violations: [`content-not-in-template: tenant-facing '${purpose}' content does not match any approved template — requires human review`],
    };
  }

  return { valid: true, violations: [] };
}

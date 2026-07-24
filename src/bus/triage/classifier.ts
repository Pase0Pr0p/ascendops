import type {
  TriageWO, Tier, EscalationFlag, Fact, SufficiencyResult, FactType,
} from './types.js';

export interface ClassificationResult {
  tier: Tier;
  escalationFlags: EscalationFlag[];
  facts: Fact[];
  sufficiency: SufficiencyResult;
  confidence: number;
}

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

const E1_PATTERNS: RegExp[] = [
  /\bflood(ed|ing)?\b/i,
  /\bburst\s*(pipe|line|water)\b/i,
  /\bsewage\b/i,
  /\bsewer\s*(backup|overflow|leak)\b/i,
  /\bmajor\s*(water\s*)?leak\b/i,
  /\bwater\s*(pouring|gushing|streaming)\b/i,
  /\bno\s*(heat|heating)\b/i,
  /\bheater\s*(broken|not\s*working|out)\b/i,
  /\bfurnace\s*(broken|not\s*working|out)\b/i,
  /\bbroken\s*(front\s*)?door\b/i,
  /\block(s|ed)?\s*(broken|not\s*working|jammed)\b/i,
  /\bcan('?t|not)\s*lock\b/i,
  /\belevator\s*(stuck|trapped|not\s*working)\b/i,
  /\bstuck\s*in\s*(the\s*)?elevator\b/i,
  /\bceiling\s*(collapse|caving|falling)\b/i,
  /\bstructural\s*(damage|crack|failure)\b/i,
  /\bpower\s*out(age)?\b/i,
  /\bno\s*(electricity|power)\b/i,
];

const U_PATTERNS: RegExp[] = [
  /\bhot\s*water\s*(out|not\s*working|broken|gone)\b/i,
  /\bno\s*hot\s*water\b/i,
  /\bwater\s*heater\b/i,
  /\bplumbing\s*(leak|issue|problem)\b/i,
  /\b(toilet|sink|faucet)\s*(leak|running|overflow|clog|backed)\b/i,
  /\bclog(ged)?\s*(drain|toilet|sink|pipe)\b/i,
  /\b(drain|toilet|sink|pipe)\s+(is\s+)?(clog|clogged|blocked|backed)\b/i,
  /\bdrain\s*(clog|blocked|slow|backed)\b/i,
  /\belectrical\s*(issue|problem|outlet|switch)\b/i,
  /\boutlet\s*(not\s*working|dead|sparking)\b/i,
  /\bpest(s)?\b/i,
  /\broach(es)?\b/i,
  /\brat(s)?\b/i,
  /\bmice\b/i,
  /\bant\s*infestation\b/i,
  /\bbed\s*bug(s)?\b/i,
  /\b(fridge|refrigerator|stove|oven|dishwasher)\s+(is\s+)?(broken|not\s*working|out|leak)/i,
  /\bappliance\s+(is\s+)?(broken|not\s*working|failure)\b/i,
  /\bac\s*(not\s*working|broken|out)\b/i,
  /\bno\s*(ac|air\s*conditioning)\b/i,
  /\bair\s*condition(er|ing)\s*(not\s*working|broken|out)\b/i,
];

const D_PATTERNS: RegExp[] = [
  /\bpreventive\s*maintenance\b/i,
  /\blandscaping\b/i,
  /\bpaint(ing)?\s*(request|touch|refresh)\b/i,
  /\bcosmetic\s*(improvement|update|repair)\b/i,
  /\bfuture\s*(project|improvement|upgrade)\b/i,
  /\bnon[\s-]*urgent\b/i,
  /\blow\s*priority\b/i,
  /\bwhen\s*you\s*(get|have)\s*(a\s*)?chance\b/i,
  /\bno\s*rush\b/i,
];

interface FlagPattern {
  flag: EscalationFlag;
  patterns: RegExp[];
}

const FLAG_PATTERNS: FlagPattern[] = [
  {
    flag: 'PROPERTY_EMERGENCY_E1',
    patterns: [
      /\bflood(ed|ing)?\b/i,
      /\bburst\s*pipe\b/i,
      /\bsewage\b/i,
      /\bceiling\s*(collapse|caving|falling)\b/i,
      /\bstructural\s*(damage|crack|failure)\b/i,
    ],
  },
  {
    flag: 'VULNERABLE_OCCUPANT',
    patterns: [
      /\b(elderly|senior|old)\s*(resident|tenant|person|woman|man)\b/i,
      /\bdisabl(ed|ility)\b/i,
      /\bwheelchair\b/i,
      /\bchild(ren)?\b/i,
      /\bbab(y|ies)\b/i,
      /\bpregnant\b/i,
      /\binfant\b/i,
      /\bmedical\s*(condition|equipment|device)\b/i,
      /\boxygen\s*(tank|concentrator)\b/i,
    ],
  },
  {
    flag: 'INSURANCE_EVENT',
    patterns: [
      /\binsurance\s*(claim|event|report)\b/i,
      /\bfile\s*(a\s*)?claim\b/i,
      /\bflood\s*damage\b/i,
      /\bfire\s*damage\b/i,
      /\bstorm\s*damage\b/i,
      /\bwater\s*damage\s*(multiple|several|extensive)\b/i,
    ],
  },
  {
    flag: 'LEGAL_HABITABILITY',
    patterns: [
      /\bhabitab(le|ility)\b/i,
      /\buninhabit/i,
      /\bcode\s*violation\b/i,
      /\bhealth\s*(department|inspector|violation)\b/i,
      /\bcity\s*inspector\b/i,
      /\bbuilding\s*inspector\b/i,
      /\bwithhold(ing)?\s*rent\b/i,
      /\brent\s*reduction\b/i,
    ],
  },
  {
    flag: 'CROSS_UNIT_ENTRY',
    patterns: [
      /\b(neighbor|adjacent|upstairs|downstairs|next\s*door)\s*unit\b/i,
      /\bleak(ing)?\s*(from|into)\s*(the\s*)?(neighbor|adjacent|upstairs|downstairs)\b/i,
      /\baccess\s*(to\s*)?(another|neighbor|adjacent)\s*unit\b/i,
    ],
  },
  {
    flag: 'ACCESS_REFUSAL',
    patterns: [
      /\brefus(e|ed|ing)\s*(entry|access)\b/i,
      /\bwon('?t|t)\s*(let|allow)\s*(us\s*)?(in|enter|access)\b/i,
      /\bden(y|ied|ying)\s*(entry|access)\b/i,
      /\bno\s*access\b/i,
    ],
  },
  {
    flag: 'REPEAT_FAILURE',
    patterns: [
      /\bagain\b.*\b(same|this)\s*(issue|problem)\b/i,
      /\b(same|this)\s*(issue|problem)\b.*\bagain\b/i,
      /\bkeep(s)?\s*(happening|coming\s*back|recurring)\b/i,
      /\brepeat(ed|ing)?\s*(issue|problem|failure)\b/i,
      /\b(third|fourth|fifth|multiple)\s*time\b/i,
      /\bnot\s*fixed\s*(properly|correctly|yet)\b/i,
    ],
  },
  {
    flag: 'TENANT_FRICTION',
    patterns: [
      /\b(angry|upset|frustrated|furious|irate)\b/i,
      /\bcomplain(t|ing|ed)\b/i,
      /\bthreat(en|ened|ening)\b/i,
      /\blawyer\b/i,
      /\battorney\b/i,
      /\blegal\s*action\b/i,
      /\bsue\b/i,
      /\brent\s*strike\b/i,
    ],
  },
  {
    flag: 'PERMISSION_TO_ENTER_UNKNOWN',
    patterns: [
      /\bneed(s)?\s*(permission|approval|consent)\s*(to\s*)?(enter|access)\b/i,
      /\bpermission\s*to\s*enter\b/i,
      /\bcan\s*(we|i|they)\s*(enter|access|go\s*in)\b/i,
    ],
  },
  {
    flag: 'AMBIGUOUS_DIAGNOSIS',
    patterns: [
      /\bnot\s*sure\s*(what|why|how)\b/i,
      /\bcan('?t|not)\s*(tell|determine|figure\s*out)\b/i,
      /\bunknown\s*(cause|source|origin)\b/i,
      /\bneed(s)?\s*(diagnosis|inspection|assessment)\b/i,
      /\bhard\s*to\s*(tell|say|determine)\b/i,
    ],
  },
  {
    flag: 'OWNER_DIRECTED_WORK',
    patterns: [
      /\b(owner|landlord)\s*(wants|requested|directed|asked)\b/i,
      /\bowner\s*approval\b/i,
      /\bper\s*(the\s*)?(owner|landlord)\b/i,
    ],
  },
];

function classifyTier(text: string): { tier: Tier; confidence: number } {
  for (const p of E0_PATTERNS) {
    if (p.test(text)) return { tier: 'E0', confidence: 0.9 };
  }
  for (const p of E1_PATTERNS) {
    if (p.test(text)) return { tier: 'E1', confidence: 0.85 };
  }
  for (const p of U_PATTERNS) {
    if (p.test(text)) return { tier: 'U', confidence: 0.8 };
  }
  for (const p of D_PATTERNS) {
    if (p.test(text)) return { tier: 'D', confidence: 0.7 };
  }
  return { tier: 'N', confidence: 0.6 };
}

function detectEscalationFlags(text: string): EscalationFlag[] {
  const flags: EscalationFlag[] = [];
  for (const fp of FLAG_PATTERNS) {
    for (const p of fp.patterns) {
      if (p.test(text)) {
        flags.push(fp.flag);
        break;
      }
    }
  }
  return flags;
}

function extractFacts(wo: TriageWO): Fact[] {
  const facts: Fact[] = [];
  const now = new Date().toISOString();

  if (wo.woId) {
    facts.push({
      type: 'system_fact' as FactType,
      source: 'wo_metadata',
      value: `WO ID: ${wo.woId}`,
      confidence: 1.0,
      timestamp: now,
    });
  }

  if (wo.propertyAddress) {
    facts.push({
      type: 'system_fact' as FactType,
      source: 'wo_metadata',
      value: `Property: ${wo.propertyAddress}`,
      confidence: 1.0,
      timestamp: now,
    });
  }

  if (wo.tenantName) {
    facts.push({
      type: 'system_fact' as FactType,
      source: 'wo_metadata',
      value: `Tenant: ${wo.tenantName}`,
      confidence: 1.0,
      timestamp: now,
    });
  }

  if (wo.unitId) {
    facts.push({
      type: 'system_fact' as FactType,
      source: 'wo_metadata',
      value: `Unit: ${wo.unitId}`,
      confidence: 1.0,
      timestamp: now,
    });
  }

  if (wo.visionAnalysis) {
    facts.push({
      type: 'vision_observation' as FactType,
      source: 'photo_analysis',
      value: wo.visionAnalysis,
      confidence: 0.75,
      timestamp: now,
    });
  }

  const text = wo.conversationText || '';
  if (text.length > 0) {
    const locationPattern = /\b(kitchen|bathroom|bedroom|living\s*room|hallway|garage|basement|laundry|closet|balcony|patio|lobby|stairwell|roof|attic|unit\s*\S+)\b/i;
    const locationMatch = text.match(locationPattern);
    if (locationMatch) {
      const matchIndex = locationMatch.index ?? 0;
      const preceding = text.slice(Math.max(0, matchIndex - 30), matchIndex).toLowerCase();
      const negated = /\bnot\s+(in\s+)?(the\s+)?$/.test(preceding)
        || /\bisn'?t\s+(in\s+)?(the\s+)?$/.test(preceding)
        || /\bno\s+(in\s+)?(the\s+)?$/.test(preceding);

      facts.push({
        type: 'inference' as FactType,
        source: 'conversation_text',
        value: negated
          ? `Inferred NOT location: ${locationMatch[0]}`
          : `Inferred location: ${locationMatch[0]}`,
        confidence: negated ? 0.3 : 0.6,
        timestamp: now,
      });
    }
  }

  return facts;
}

function assessSufficiency(wo: TriageWO, tier: Tier): SufficiencyResult {
  if (tier === 'E0') return 'EMERGENCY_OVERRIDE';

  const text = wo.conversationText || '';
  const hasPhotos = wo.photoUrls.length > 0;
  const hasVision = !!wo.visionAnalysis;
  const wordCount = text.split(/\s+/).filter(w => w.length > 0).length;

  if (wordCount < 5 && !hasPhotos) return 'NEEDS_CLARIFICATION';

  if (!hasPhotos && !hasVision) {
    const photoNeeded = /\b(leak|damage|crack|stain|broken|mold|mildew|pest|bug)\b/i;
    if (photoNeeded.test(text)) return 'NEEDS_PHOTOS';
  }

  return 'CLEAR';
}

export function classify(wo: TriageWO): ClassificationResult {
  const text = wo.conversationText || '';

  const { tier, confidence } = classifyTier(text);
  const escalationFlags = detectEscalationFlags(text);
  const facts = extractFacts(wo);
  const sufficiency = assessSufficiency(wo, tier);

  return { tier, escalationFlags, facts, sufficiency, confidence };
}

export function applyClassification(wo: TriageWO, result: ClassificationResult): void {
  wo.tier = result.tier;
  for (const flag of result.escalationFlags) {
    if (!wo.escalationFlags.includes(flag)) {
      wo.escalationFlags.push(flag);
    }
  }
  wo.facts.push(...result.facts);
}

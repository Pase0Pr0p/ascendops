const MOLD_TEXT_PATTERNS: RegExp[] = [
  /\bmold\b/i,
  /\bmolds\b/i,
  /\bmoldy\b/i,
  /\bmould\b/i,
  /\bmoulds\b/i,
  /\bmouldy\b/i,
  /\bmildew\b/i,
  /\bmildewy\b/i,
  /\bblack\s+spots?\b/i,
  /\bdark\s+spots?\s+(on|around|near|along|behind)\s+(the\s+)?(wall|ceiling|floor|window|door|baseboard|tile|grout|shower|bath|tub|cabinet|closet|vent)/i,
  /\bfung(us|i|al)\b/i,
  /\bmusty\b/i,
  /\bdamp\s+(smell|odor|odour|growth|patch|stain)/i,
  /\bwater\s+damage\b.*\b(growth|spots?|discolor)/i,
];

const MOLD_VISION_KEYWORDS: string[] = [
  'mold',
  'mould',
  'mildew',
  'fungal growth',
  'fungus',
  'black spots',
  'dark spots on wall',
  'dark discoloration',
  'possible mold',
  'suspected mold',
  'organic growth',
];

export interface MoldDetectionResult {
  detected: boolean;
  confidence: 'HIGH' | 'AMBIGUOUS' | 'NONE';
  matches: string[];
  source: 'text' | 'vision' | 'both';
}

export function detectMoldInText(text: string): MoldDetectionResult {
  if (!text) return { detected: false, confidence: 'NONE', matches: [], source: 'text' };

  const matches: string[] = [];
  for (const pattern of MOLD_TEXT_PATTERNS) {
    const match = text.match(pattern);
    if (match) matches.push(match[0]);
  }

  if (matches.length === 0) {
    return { detected: false, confidence: 'NONE', matches: [], source: 'text' };
  }

  return {
    detected: true,
    confidence: 'HIGH',
    matches,
    source: 'text',
  };
}

export function detectMoldInVision(visionAnalysis: string): MoldDetectionResult {
  if (!visionAnalysis) return { detected: false, confidence: 'NONE', matches: [], source: 'vision' };

  const lower = visionAnalysis.toLowerCase();
  const matches: string[] = [];

  for (const keyword of MOLD_VISION_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
      matches.push(keyword);
    }
  }

  if (matches.length === 0) {
    return { detected: false, confidence: 'NONE', matches: [], source: 'vision' };
  }

  const ambiguousIndicators = ['possible', 'suspected', 'unclear', 'uncertain', 'might be', 'could be'];
  const isAmbiguous = ambiguousIndicators.some(ind => lower.includes(ind));

  return {
    detected: true,
    confidence: isAmbiguous ? 'AMBIGUOUS' : 'HIGH',
    matches,
    source: 'vision',
  };
}

export function detectMold(text: string, visionAnalysis?: string): MoldDetectionResult {
  const textResult = detectMoldInText(text);
  const visionResult = visionAnalysis ? detectMoldInVision(visionAnalysis) : null;

  const textDetected = textResult.detected;
  const visionDetected = visionResult?.detected ?? false;

  if (!textDetected && !visionDetected) {
    return { detected: false, confidence: 'NONE', matches: [], source: 'text' };
  }

  const allMatches = [
    ...textResult.matches,
    ...(visionResult?.matches ?? []),
  ];

  if (textDetected && visionDetected) {
    return { detected: true, confidence: 'HIGH', matches: allMatches, source: 'both' };
  }

  if (textDetected) return textResult;

  // Vision-only: ambiguous vision still escalates (conservative)
  return { detected: true, confidence: visionResult!.confidence, matches: allMatches, source: 'vision' };
}

/**
 * post-call-intake.ts — Pure functions for post-call WO intake processing.
 *
 * Shared between post-call-processor.ts and tests. All functions are
 * side-effect-free (no DB, no network, no process.env).
 */

import { createHash } from 'crypto';

// ─── constants ─────────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.7;

export const EMERGENCY_KEYWORDS = [
  'flood', 'flooding', 'water everywhere',
  'gas leak', 'gas smell', 'smell gas', 'smell of gas', 'smells like gas',
  'no heat', 'no hot water',
  'fire', 'smoke', 'sparking', 'electrical fire',
  'carbon monoxide', 'co detector', 'co alarm',
  'sewage', 'raw sewage', 'burst pipe', 'water pouring', 'ceiling collapse',
  'locked out', 'lockout', 'break-in', 'broken window', 'broke in',
];

export const BLOCKED_SCOPES = new Set(['amanda', 'paused']);

// ─── types ─────────────────────────────────────────────────────────────────────

export interface DataCollectionField {
  value: unknown;
  rationale: string;
  data_collection_id: string;
}

export interface ResolvedCaller {
  matched: boolean;
  ambiguous?: boolean;
  display_name?: string;
  contact_id?: string;
  unit_label?: string;
  property_label?: string;
  property_name?: string;
  routing_scope?: string;
  resolved_type?: string;
  has_active_occupancy?: boolean;
  occupancy_id?: string;
  appfolio_unit_id?: number | null;
  appfolio_property_id?: number | null;
  appfolio_occupancy_id?: number | null;
}

export interface IntakeRecord {
  intake_id: string;
  call_id: string;
  caller_phone_e164: string;
  contact_id: string | null;
  timestamp_utc: string;
  unit_address: string;
  tenant_name: string;
  tenant_phone: string;
  issue_summary: string;
  category: string;
  priority: string;
  description_full: string;
  safety_flags: { is_emergency: boolean; detail: string | null };
  permission_to_enter: string;
  troubleshooting_notes: string | null;
  availability_window: string | null;
  photo_attached: boolean | null;
  caller_relationship: string | null;
  repeat_signal: { mentioned_prior: boolean; detail: string | null } | null;
  room_location: string | null;
  transcript_summary: string;
  transcript: unknown[];
  conversation_id: string;
  extractor_version: string;
  confidence: number;
  source_turn_ids: number[];
  manual_review_reason: string | null;
  appfolio_ready: boolean;
  appfolio_unit_id: number | null;
  appfolio_property_id: number | null;
  appfolio_occupancy_id: number | null;
}

export type IntakeClassification = 'one_issue' | 'multiple_issues' | 'insufficient_info' | 'not_maintenance';

export type RouteDecision = 'emergency' | 'manual_review' | 'routine';

// ─── extraction ────────────────────────────────────────────────────────────────

export function extractField(
  dcResults: Record<string, DataCollectionField>,
  fieldId: string,
): { value: unknown; rationale: string } | null {
  const field = dcResults[fieldId];
  if (!field || field.value === null || field.value === undefined || field.value === '') return null;
  return { value: field.value, rationale: field.rationale };
}

export function extractCallerPhone(payload: Record<string, unknown>): string {
  const dynVars = (payload['conversation_initiation_client_data'] as Record<string, unknown>)
    ?.['dynamic_variables'] as Record<string, string> | undefined;
  if (dynVars?.['system__caller_id']) {
    const raw = dynVars['system__caller_id'];
    return raw.startsWith('+') ? raw : '+1' + raw;
  }
  const phoneMeta = (payload['metadata'] as Record<string, unknown>)
    ?.['phone_call'] as Record<string, string> | undefined;
  if (phoneMeta?.['external_number']) {
    const raw = phoneMeta['external_number'];
    return raw.startsWith('+') ? raw : '+1' + raw;
  }
  return '';
}

export function extractConversationId(payload: Record<string, unknown>): string {
  return String(payload['conversation_id'] ?? '');
}

export function extractTranscript(payload: Record<string, unknown>): unknown[] {
  const transcript = payload['transcript'];
  return Array.isArray(transcript) ? transcript : [];
}

export function extractTranscriptSummary(payload: Record<string, unknown>): string {
  const analysis = payload['analysis'] as Record<string, unknown> | undefined;
  return String(analysis?.['transcript_summary'] ?? '');
}

export function extractDataCollection(payload: Record<string, unknown>): Record<string, DataCollectionField> {
  const analysis = payload['analysis'] as Record<string, unknown> | undefined;
  const dcr = analysis?.['data_collection_results'] as Record<string, DataCollectionField> | undefined;
  return dcr ?? {};
}

// ─── classification ────────────────────────────────────────────────────────────

export function detectEmergency(
  isEmergencyField: boolean | null,
  issueDescription: string,
  transcript: unknown[],
): { is_emergency: boolean; detail: string | null } {
  if (isEmergencyField === true) {
    return { is_emergency: true, detail: 'data_collection is_emergency=true' };
  }
  const descLower = issueDescription.toLowerCase();
  for (const kw of EMERGENCY_KEYWORDS) {
    if (descLower.includes(kw)) {
      return { is_emergency: true, detail: `keyword match: "${kw}" in issue description` };
    }
  }
  const transcriptText = transcript
    .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null && (t as Record<string, unknown>)['role'] === 'user')
    .map(t => String((t as Record<string, unknown>)['message'] ?? ''))
    .join(' ')
    .toLowerCase();
  for (const kw of EMERGENCY_KEYWORDS) {
    if (transcriptText.includes(kw)) {
      return { is_emergency: true, detail: `keyword match: "${kw}" in caller transcript` };
    }
  }
  return { is_emergency: false, detail: null };
}

export function classifyIntake(
  issueDescription: string | null,
  transcriptSummary: string,
): IntakeClassification {
  if (!issueDescription || issueDescription.trim().length < 5) return 'insufficient_info';
  const multiSignals = [
    /\band\b.*\b(also|another|second|too)\b/i,
    /\b(two|three|multiple|several)\b.*\b(issue|problem|thing|request)/i,
  ];
  const sumLower = (transcriptSummary + ' ' + issueDescription).toLowerCase();
  for (const re of multiSignals) {
    if (re.test(sumLower)) return 'multiple_issues';
  }
  const nonMaintenanceSignals = [
    /\b(rent|payment|balance|lease|move.?out|move.?in|application)\b/i,
  ];
  for (const re of nonMaintenanceSignals) {
    if (re.test(issueDescription) && !/\b(break|broken|leak|jam|stuck|repair|fix|replace)\b/i.test(issueDescription)) {
      return 'not_maintenance';
    }
  }
  return 'one_issue';
}

// ─── guards ────────────────────────────────────────────────────────────────────

export function applyGuards(
  resolved: ResolvedCaller | null,
  resolverError: string | null,
): { pass: boolean; reason: string | null } {
  if (resolverError) return { pass: false, reason: `resolver_failure: ${resolverError}` };
  if (!resolved) return { pass: false, reason: 'unknown_caller' };
  if (!resolved.matched) return { pass: false, reason: 'unknown_caller' };
  if (resolved.ambiguous) return { pass: false, reason: 'multi_match' };
  const scope = resolved.routing_scope ?? 'fleet';
  if (BLOCKED_SCOPES.has(scope)) return { pass: false, reason: `scope_blocked: ${scope}` };
  if (resolved.resolved_type === 'tenant' && !resolved.has_active_occupancy) {
    return { pass: false, reason: 'inactive_tenant' };
  }
  return { pass: true, reason: null };
}

export function checkAppFolioIds(
  resolved: ResolvedCaller | null,
): { ready: boolean; reason: string | null } {
  if (!resolved?.matched) return { ready: false, reason: 'unresolved_caller' };
  const propertyId = resolved.appfolio_property_id;
  if (!propertyId) {
    return { ready: false, reason: 'missing_appfolio_ids: property_id' };
  }
  if (resolved.appfolio_occupancy_id && !resolved.appfolio_unit_id) {
    return { ready: false, reason: 'invalid_ids: occupancy_id present without unit_id' };
  }
  return { ready: true, reason: null };
}

// ─── mapping ───────────────────────────────────────────────────────────────────

export function mapPriority(severity: string | null, isEmergency: boolean): string {
  if (isEmergency) return 'critical';
  if (!severity) return 'normal';
  const s = severity.toLowerCase().trim();
  if (s === 'urgent' || s === 'high' || s === 'critical') return 'high';
  if (s === 'low') return 'low';
  return 'normal';
}

export function mapPte(pte: unknown): string {
  if (pte === true || pte === 'true' || pte === 'yes' || pte === 'Yes') return 'yes';
  if (pte === false || pte === 'false' || pte === 'no' || pte === 'No') return 'no';
  return 'not-asked';
}

export function guessCategory(description: string): string {
  const map: [RegExp, string][] = [
    [/garbage disposal|disposal/i, 'Garbage Disposal'],
    [/dishwasher/i, 'Dishwasher'],
    [/refrigerator|fridge/i, 'Refrigerator'],
    [/oven|stove|range|burner/i, 'Oven/Stove'],
    [/washer|dryer|laundry/i, 'Washer/Dryer'],
    [/microwave/i, 'Microwave'],
    [/toilet|commode/i, 'Toilet'],
    [/faucet|sink/i, 'Faucet/Sink'],
    [/shower|bathtub|tub/i, 'Shower/Bathtub'],
    [/drain|clog|pipe/i, 'Drain/Pipe Clog'],
    [/water heater|hot water/i, 'Water Heater'],
    [/leak|leaking|water damage/i, 'Leak'],
    [/heat|heater|furnace|hvac|air condition|ac\b|a\/c/i, 'HVAC'],
    [/thermostat/i, 'Thermostat'],
    [/outlet|switch|light|electrical|breaker/i, 'Electrical'],
    [/door|lock|deadbolt|key/i, 'Door/Lock'],
    [/window|blind|shade|screen/i, 'Window/Blind'],
    [/garage/i, 'Garage Door'],
    [/roof|gutter/i, 'Roof/Gutter'],
    [/pest|roach|ant|mouse|rat|bed bug/i, 'Pest Control'],
    [/mold|mildew/i, 'Mold'],
    [/paint|wall|ceiling|floor|carpet|tile/i, 'General Repair'],
    [/smoke detector|fire alarm|co alarm/i, 'Safety Device'],
  ];
  for (const [re, category] of map) {
    if (re.test(description)) return category;
  }
  return 'General Maintenance';
}

// ─── idempotency ───────────────────────────────────────────────────────────────

export function computeSourceIdempotencyKey(conversationId: string): string {
  return createHash('sha256').update(`source:${conversationId}`).digest('hex').substring(0, 16);
}

export function computeRepeatWindowKey(
  callerPhone: string,
  unitAddress: string,
  issueSummary: string,
): string {
  const normalized = [
    callerPhone.replace(/\D/g, ''),
    unitAddress.toLowerCase().trim(),
    issueSummary.toLowerCase().trim().split(/\s+/).slice(0, 5).join(' '),
  ].join('|');
  return createHash('sha256').update(`repeat:${normalized}`).digest('hex').substring(0, 16);
}

// ─── confidence ────────────────────────────────────────────────────────────────

export function computeConfidence(
  dcResults: Record<string, DataCollectionField>,
  resolved: ResolvedCaller | null,
  classification: IntakeClassification,
): { confidence: number; lowFields: string[] } {
  const lowFields: string[] = [];
  let score = 1.0;

  if (!extractField(dcResults, 'maintenance_issue_description')) { score -= 0.4; lowFields.push('issue_description'); }
  if (!resolved?.matched) { score -= 0.2; lowFields.push('caller_identity'); }
  if (!extractField(dcResults, 'unit_number')) { score -= 0.1; lowFields.push('unit_number'); }
  if (!extractField(dcResults, 'permission_to_enter') && !extractField(dcResults, 'pte')) { score -= 0.05; lowFields.push('permission_to_enter'); }
  if (classification === 'multiple_issues') { score -= 0.15; lowFields.push('multiple_issues'); }
  if (classification === 'insufficient_info') { score -= 0.3; lowFields.push('insufficient_info'); }

  return { confidence: Math.max(0, Math.round(score * 100) / 100), lowFields };
}

// ─── route decision ────────────────────────────────────────────────────────────

export function computeRouteDecision(opts: {
  safetyFlags: { is_emergency: boolean };
  guardsPassed: boolean;
  guardReason: string | null;
  classification: IntakeClassification;
  confidence: number;
  lowFields: string[];
  appfolioReady: boolean;
  appfolioIdReason: string | null;
}): { route: RouteDecision; manualReviewReason: string | null } {
  if (opts.safetyFlags.is_emergency) return { route: 'emergency', manualReviewReason: null };

  const reviewReasons: string[] = [];
  if (!opts.guardsPassed) reviewReasons.push(`guard_failed: ${opts.guardReason}`);
  if (opts.classification === 'multiple_issues') reviewReasons.push('multiple_issues_detected');
  if (opts.classification === 'insufficient_info') reviewReasons.push('insufficient_info');
  if (opts.classification === 'not_maintenance') reviewReasons.push('not_maintenance_request');
  if (opts.confidence < CONFIDENCE_THRESHOLD) reviewReasons.push(`low_confidence: ${opts.confidence} (${opts.lowFields.join(', ')})`);
  if (!opts.appfolioReady) reviewReasons.push(`missing_appfolio_ids: ${opts.appfolioIdReason}`);

  if (reviewReasons.length > 0) {
    return { route: 'manual_review', manualReviewReason: reviewReasons.join('; ') };
  }

  return { route: 'routine', manualReviewReason: null };
}

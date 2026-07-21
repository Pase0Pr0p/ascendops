/**
 * post-call-processor.ts — Post-call WO intake processor
 *
 * Picks up elevenlabs_post_call events from voice_events, extracts structured
 * maintenance intake fields from data_collection_results, resolves caller identity,
 * applies fail-closed scope guards, and routes:
 *   - Emergency → immediate alert (Albie + Max)
 *   - Non-emergency → Max's intake-triage queue (bus message)
 *
 * The auto-create pipeline (wo-intake-pickup.ts) is preserved for Option C.
 * This processor writes wo_intake events; it does NOT create AppFolio WOs.
 */

import pg from 'pg';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

// ─── config ────────────────────────────────────────────────────────────────────

const EXTRACTOR_VERSION = 'v1-data-collection';
const CONFIDENCE_THRESHOLD = 0.7;

const CHAT_ALBIE = process.env.TELEGRAM_CHAT_ALBIE ?? '6398997982';
const CHAT_MAX = process.env.TELEGRAM_CHAT_MAX ?? '';

const EMERGENCY_KEYWORDS = [
  'flood', 'flooding', 'gas leak', 'gas smell', 'no heat', 'no hot water',
  'fire', 'smoke', 'sparking', 'electrical fire', 'carbon monoxide', 'co detector',
  'sewage', 'raw sewage', 'burst pipe', 'water pouring', 'ceiling collapse',
  'locked out', 'lockout', 'break-in', 'broken window',
];

// Belvedere/Tiburon = Amanda scope, Paloma = transitioning out
const BLOCKED_SCOPES = new Set(['amanda', 'paused']);

// ─── DB ────────────────────────────────────────────────────────────────────────

function makePool(): pg.Pool {
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  if (!dsn) {
    console.error(JSON.stringify({ error: 'VOICE_GATEWAY_DSN not configured' }));
    process.exit(1);
  }
  return new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
}

// ─── bus helpers ───────────────────────────────────────────────────────────────

function sendTelegram(chatId: string, message: string): void {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '';
  if (!token || !chatId) return;
  try {
    execFileSync('cortextos', ['bus', 'send-telegram', chatId, message, '--skip-lint'], {
      timeout: 15_000, stdio: 'pipe',
    });
  } catch { /* best-effort */ }
}

function sendAgentMessage(agent: string, message: string): void {
  try {
    execFileSync('cortextos', ['bus', 'send-message', agent, 'normal', message], {
      timeout: 15_000, stdio: 'pipe',
    });
  } catch { /* best-effort */ }
}

function logEvent(category: string, action: string, level: string, meta: Record<string, unknown>): void {
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', category, action, level,
      '--meta', JSON.stringify(meta),
    ], { timeout: 10_000, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

// ─── types ─────────────────────────────────────────────────────────────────────

interface DataCollectionField {
  value: unknown;
  rationale: string;
  data_collection_id: string;
}

interface ResolvedCaller {
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
  appfolio_unit_id?: string;
  appfolio_property_id?: string;
  appfolio_occupancy_id?: string;
}

interface IntakeRecord {
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
}

type IntakeClassification = 'one_issue' | 'multiple_issues' | 'insufficient_info' | 'not_maintenance';

// ─── extraction ────────────────────────────────────────────────────────────────

function extractField(
  dcResults: Record<string, DataCollectionField>,
  fieldId: string,
): { value: unknown; rationale: string } | null {
  const field = dcResults[fieldId];
  if (!field || field.value === null || field.value === undefined || field.value === '') return null;
  return { value: field.value, rationale: field.rationale };
}

function extractCallerPhone(payload: Record<string, unknown>): string {
  const data = payload as Record<string, unknown>;
  const dynVars = (data['conversation_initiation_client_data'] as Record<string, unknown>)
    ?.['dynamic_variables'] as Record<string, string> | undefined;
  if (dynVars?.['system__caller_id']) {
    const raw = dynVars['system__caller_id'];
    return raw.startsWith('+') ? raw : '+1' + raw;
  }
  const phoneMeta = (data['metadata'] as Record<string, unknown>)
    ?.['phone_call'] as Record<string, string> | undefined;
  if (phoneMeta?.['external_number']) {
    const raw = phoneMeta['external_number'];
    return raw.startsWith('+') ? raw : '+1' + raw;
  }
  return '';
}

function extractConversationId(payload: Record<string, unknown>): string {
  return String(payload['conversation_id'] ?? '');
}

function extractTranscript(payload: Record<string, unknown>): unknown[] {
  const transcript = payload['transcript'];
  return Array.isArray(transcript) ? transcript : [];
}

function extractTranscriptSummary(payload: Record<string, unknown>): string {
  const analysis = payload['analysis'] as Record<string, unknown> | undefined;
  return String(analysis?.['transcript_summary'] ?? '');
}

function extractDataCollection(payload: Record<string, unknown>): Record<string, DataCollectionField> {
  const analysis = payload['analysis'] as Record<string, unknown> | undefined;
  const dcr = analysis?.['data_collection_results'] as Record<string, DataCollectionField> | undefined;
  return dcr ?? {};
}

function detectEmergency(
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

function classifyIntake(
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

function mapPriority(severity: string | null, isEmergency: boolean): string {
  if (isEmergency) return 'critical';
  if (!severity) return 'normal';
  const s = severity.toLowerCase().trim();
  if (s === 'urgent' || s === 'high' || s === 'critical') return 'high';
  if (s === 'low') return 'low';
  return 'normal';
}

function mapPte(pte: unknown): string {
  if (pte === true || pte === 'true' || pte === 'yes' || pte === 'Yes') return 'yes';
  if (pte === false || pte === 'false' || pte === 'no' || pte === 'No') return 'no';
  return 'not-asked';
}

function computeIdempotencyKey(
  callId: string,
  callerPhone: string,
  unitAddress: string,
  issueSummary: string,
): string {
  const normalized = [
    callId,
    callerPhone.replace(/\D/g, ''),
    unitAddress.toLowerCase().trim(),
    issueSummary.toLowerCase().trim().split(/\s+/).slice(0, 5).join(' '),
  ].join('|');
  return createHash('sha256').update(normalized).digest('hex').substring(0, 16);
}

function computeConfidence(
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

// ─── resolver ──────────────────────────────────────────────────────────────────

async function resolveCaller(
  pool: pg.Pool,
  phoneE164: string,
): Promise<{ resolved: ResolvedCaller | null; error: string | null }> {
  if (!phoneE164) return { resolved: null, error: 'no_phone_number' };
  try {
    const cacheHit = await pool.query(
      `SELECT resolved FROM caller_sessions WHERE phone_e164 = $1 AND expires_at > now() LIMIT 1`,
      [phoneE164],
    );
    if (cacheHit.rows[0]) {
      return { resolved: cacheHit.rows[0].resolved as ResolvedCaller, error: null };
    }
    const resolveRow = await pool.query(
      `SELECT voice_resolve_caller($1) AS r`,
      [phoneE164],
    );
    return { resolved: resolveRow.rows[0]?.r as ResolvedCaller | null, error: null };
  } catch (e) {
    return { resolved: null, error: `resolver_db_failure: ${String(e).substring(0, 200)}` };
  }
}

function applyGuards(
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

// ─── main processor ────────────────────────────────────────────────────────────

async function processPostCallEvents(): Promise<void> {
  const pool = makePool();

  try {
    const rows = await pool.query(`
      SELECT id, payload, created_at
      FROM voice_events
      WHERE event_type = 'elevenlabs_post_call'
        AND (lifecycle_status IS NULL OR lifecycle_status = 'pending')
      ORDER BY created_at ASC
      LIMIT 10
      FOR UPDATE SKIP LOCKED
    `);

    if (rows.rows.length === 0) {
      console.log(JSON.stringify({ status: 'no_events' }));
      await pool.end();
      return;
    }

    for (const row of rows.rows) {
      const eventId = row.id as string;
      const payload = (typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Record<string, unknown>;
      const eventData = (payload['data'] ?? payload) as Record<string, unknown>;

      try {
        await processOneEvent(pool, eventId, eventData);
      } catch (e) {
        console.error(JSON.stringify({
          error: 'event_processing_failed',
          event_id: eventId,
          detail: String(e).substring(0, 500),
        }));
        await pool.query(
          `UPDATE voice_events SET lifecycle_status = 'process_error' WHERE id = $1`,
          [eventId],
        ).catch(() => {});
      }
    }
  } finally {
    await pool.end().catch(() => {});
  }
}

async function processOneEvent(
  pool: pg.Pool,
  eventId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const conversationId = extractConversationId(payload);
  const callerPhone = extractCallerPhone(payload);
  const transcript = extractTranscript(payload);
  const transcriptSummary = extractTranscriptSummary(payload);
  const dcResults = extractDataCollection(payload);

  // Mark as processing
  await pool.query(
    `UPDATE voice_events SET lifecycle_status = 'processing' WHERE id = $1`,
    [eventId],
  );

  // Extract fields from data_collection
  const issueField = extractField(dcResults, 'maintenance_issue_description');
  const callerNameField = extractField(dcResults, 'caller_name');
  const unitField = extractField(dcResults, 'unit_number');
  const propertyField = extractField(dcResults, 'property_address');
  const emergencyField = extractField(dcResults, 'is_emergency');
  const severityField = extractField(dcResults, 'severity');
  const pteField = extractField(dcResults, 'permission_to_enter') ?? extractField(dcResults, 'pte');
  const locationField = extractField(dcResults, 'location_detail') ?? extractField(dcResults, 'room_location');
  const availabilityField = extractField(dcResults, 'availability_window');
  const troubleshootField = extractField(dcResults, 'troubleshooting_notes');

  const issueDescription = issueField ? String(issueField.value) : '';
  const callerName = callerNameField ? String(callerNameField.value) : '';
  const unitNumber = unitField ? String(unitField.value) : '';
  const propertyAddress = propertyField ? String(propertyField.value) : '';
  const isEmergencyRaw = emergencyField ? emergencyField.value as boolean : null;
  const severityRaw = severityField ? String(severityField.value) : null;
  const pteRaw = pteField ? pteField.value : null;
  const locationRaw = locationField ? String(locationField.value) : null;
  const availabilityRaw = availabilityField ? String(availabilityField.value) : null;
  const troubleshootRaw = troubleshootField ? String(troubleshootField.value) : null;

  // Collect source turn IDs (turns that contributed to extraction)
  const sourceTurnIds = transcript
    .map((t, i) => ({ turn: t as Record<string, unknown>, idx: i }))
    .filter(({ turn }) => turn['role'] === 'user')
    .map(({ idx }) => idx);

  // Detect emergency
  const safetyFlags = detectEmergency(isEmergencyRaw, issueDescription, transcript);

  // Classify intake
  const classification = classifyIntake(issueDescription, transcriptSummary);

  // Resolve caller
  const { resolved, error: resolverError } = await resolveCaller(pool, callerPhone);
  const guards = applyGuards(resolved, resolverError);

  // Build unit address from resolver (preferred) or data_collection
  const unitAddress = resolved?.matched
    ? [resolved.unit_label, resolved.property_label ?? resolved.property_name].filter(Boolean).join(', ')
    : [unitNumber ? '#' + unitNumber : '', propertyAddress].filter(Boolean).join(', ');

  // Tenant name from resolver (preferred) or data_collection
  const tenantName = resolved?.matched
    ? (resolved.display_name ?? callerName)
    : callerName;

  // Priority mapping
  const priority = mapPriority(severityRaw, safetyFlags.is_emergency);

  // PTE mapping
  const permissionToEnter = mapPte(pteRaw);

  // Confidence
  const { confidence, lowFields } = computeConfidence(dcResults, resolved, classification);

  // Build manual_review_reason
  const reviewReasons: string[] = [];
  if (!guards.pass) reviewReasons.push(`guard_failed: ${guards.reason}`);
  if (classification === 'multiple_issues') reviewReasons.push('multiple_issues_detected');
  if (classification === 'insufficient_info') reviewReasons.push('insufficient_info');
  if (classification === 'not_maintenance') reviewReasons.push('not_maintenance_request');
  if (confidence < CONFIDENCE_THRESHOLD) reviewReasons.push(`low_confidence: ${confidence} (${lowFields.join(', ')})`);
  const manualReviewReason = reviewReasons.length > 0 ? reviewReasons.join('; ') : null;

  // Idempotency check
  const idempotencyKey = computeIdempotencyKey(conversationId, callerPhone, unitAddress, issueDescription);
  const existingIntake = await pool.query(
    `SELECT id FROM voice_events
     WHERE event_type = 'wo_intake'
       AND payload->>'idempotency_key' = $1
     LIMIT 1`,
    [idempotencyKey],
  ).catch(() => null);

  if (existingIntake?.rows[0]) {
    await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'duplicate_skipped' WHERE id = $1`,
      [eventId],
    );
    console.log(JSON.stringify({
      status: 'duplicate_skipped',
      event_id: eventId,
      existing_intake: existingIntake.rows[0].id,
      idempotency_key: idempotencyKey,
    }));
    return;
  }

  // Build the enriched intake record
  const intakeId = randomUUID();
  const intake: IntakeRecord = {
    intake_id: intakeId,
    call_id: conversationId,
    caller_phone_e164: callerPhone,
    contact_id: resolved?.contact_id ?? null,
    timestamp_utc: new Date().toISOString(),
    unit_address: unitAddress,
    tenant_name: tenantName,
    tenant_phone: callerPhone,
    issue_summary: issueDescription.split('.')[0]?.trim() || issueDescription.substring(0, 100),
    category: guessCategory(issueDescription),
    priority,
    description_full: issueDescription,
    safety_flags: safetyFlags,
    permission_to_enter: permissionToEnter,
    troubleshooting_notes: troubleshootRaw,
    availability_window: availabilityRaw,
    photo_attached: null,
    caller_relationship: resolved?.matched ? 'tenant' : null,
    repeat_signal: null,
    room_location: locationRaw,
    transcript_summary: transcriptSummary,
    transcript,
    conversation_id: conversationId,
    extractor_version: EXTRACTOR_VERSION,
    confidence,
    source_turn_ids: sourceTurnIds,
    manual_review_reason: manualReviewReason,
  };

  // Write wo_intake event
  const intakePayload = {
    ...intake,
    source_post_call_event_id: eventId,
    idempotency_key: idempotencyKey,
    guards_passed: guards.pass,
    classification,
  };

  await pool.query(
    `INSERT INTO voice_events (event_type, source_event_id, payload)
     VALUES ('wo_intake', $1, $2)`,
    [conversationId, JSON.stringify(intakePayload)],
  );

  // Mark original event as processed
  await pool.query(
    `UPDATE voice_events SET lifecycle_status = 'processed' WHERE id = $1`,
    [eventId],
  );

  // Route
  if (safetyFlags.is_emergency) {
    // EMERGENCY: immediate alert, do NOT queue
    const alertMsg = `EMERGENCY INTAKE from voice call:\n${tenantName} at ${unitAddress}\nIssue: ${issueDescription}\nSafety: ${safetyFlags.detail}\nCall ID: ${conversationId}\nAction needed immediately.`;
    sendTelegram(CHAT_ALBIE, alertMsg);
    sendAgentMessage('maintenance-coordinator', JSON.stringify({
      type: 'emergency_intake',
      ...intake,
    }));
    logEvent('action', 'emergency_intake_detected', 'critical', {
      event_id: eventId,
      intake_id: intakeId,
      call_id: conversationId,
      safety_detail: safetyFlags.detail,
      agent: 'claudia',
    });
    console.log(JSON.stringify({ status: 'emergency_routed', event_id: eventId, intake_id: intakeId }));
    return;
  }

  if (manualReviewReason) {
    // Manual review: alert Albie, do not send to Max routine queue
    sendTelegram(CHAT_ALBIE, `Voice intake needs manual review:\n${tenantName} at ${unitAddress}\nIssue: ${issueDescription}\nReason: ${manualReviewReason}\nCall ID: ${conversationId}`);
    logEvent('action', 'intake_manual_review', 'warning', {
      event_id: eventId,
      intake_id: intakeId,
      call_id: conversationId,
      reason: manualReviewReason,
      agent: 'claudia',
    });
    console.log(JSON.stringify({ status: 'manual_review', event_id: eventId, intake_id: intakeId, reason: manualReviewReason }));
    return;
  }

  // Non-emergency, all guards passed, sufficient confidence → Max routine queue
  sendAgentMessage('maintenance-coordinator', JSON.stringify({
    type: 'voice_intake',
    ...intake,
  }));
  logEvent('action', 'intake_routed_to_max', 'info', {
    event_id: eventId,
    intake_id: intakeId,
    call_id: conversationId,
    tenant: tenantName,
    priority,
    agent: 'claudia',
  });
  console.log(JSON.stringify({ status: 'routed_to_max', event_id: eventId, intake_id: intakeId, tenant: tenantName, priority }));
}

// ─── category mapping ──────────────────────────────────────────────────────────

function guessCategory(description: string): string {
  const d = description.toLowerCase();
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
    if (re.test(d)) return category;
  }
  return 'General Maintenance';
}

// ─── entry point ───────────────────────────────────────────────────────────────

processPostCallEvents().catch((e) => {
  console.error(JSON.stringify({ error: 'processor_fatal', detail: String(e).substring(0, 500) }));
  process.exit(1);
});

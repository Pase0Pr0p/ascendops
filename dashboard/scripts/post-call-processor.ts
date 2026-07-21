/**
 * post-call-processor.ts — Post-call WO intake processor (Option A)
 *
 * Picks up elevenlabs_post_call events from voice_events, extracts structured
 * maintenance intake fields from data_collection_results, resolves caller identity,
 * applies fail-closed scope guards, and routes:
 *   - Emergency → immediate alert (Albie + Max), send-then-mark
 *   - Manual review → Albie alert (guards failed, low confidence, missing IDs)
 *   - Routine → Max's intake-triage queue (bus message)
 *
 * Option A: processor → Max bus message. Max triages and creates WOs.
 * The auto-create pipeline (wo-intake-pickup.ts) is preserved for Option C.
 * wo_intake events carry appfolio_ready + numeric IDs for forward-compatibility.
 */

import pg from 'pg';
import { execFileSync } from 'child_process';
import { randomUUID } from 'crypto';
import {
  type ResolvedCaller,
  type IntakeRecord,
  extractField,
  extractCallerPhone,
  extractConversationId,
  extractTranscript,
  extractTranscriptSummary,
  extractDataCollection,
  detectEmergency,
  classifyIntake,
  applyGuards,
  checkAppFolioIds,
  mapPriority,
  mapPte,
  guessCategory,
  computeSourceIdempotencyKey,
  computeRepeatWindowKey,
  computeConfidence,
  computeRouteDecision,
} from './lib/post-call-intake';

// ─── config ────────────────────────────────────────────────────────────────────

const EXTRACTOR_VERSION = 'v1-data-collection';
const REPEAT_WINDOW_HOURS = 4;

const CHAT_ALBIE = process.env.TELEGRAM_CHAT_ALBIE ?? '6398997982';

// ─── DB ────────────────────────────────────────────────────────────────────────

function makePool(): pg.Pool {
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  if (!dsn) {
    console.error(JSON.stringify({ error: 'VOICE_GATEWAY_DSN not configured' }));
    process.exit(1);
  }
  return new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
}

// ─── bus helpers (return success boolean for emergency delivery check) ─────────

function sendTelegram(chatId: string, message: string): boolean {
  const token = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '';
  if (!token || !chatId) return false;
  try {
    execFileSync('cortextos', ['bus', 'send-telegram', chatId, message, '--skip-lint'], {
      timeout: 15_000, stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function sendAgentMessage(agent: string, message: string): boolean {
  try {
    execFileSync('cortextos', ['bus', 'send-message', agent, 'normal', message], {
      timeout: 15_000, stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

function logEvent(category: string, action: string, level: string, meta: Record<string, unknown>): void {
  try {
    execFileSync('cortextos', [
      'bus', 'log-event', category, action, level,
      '--meta', JSON.stringify(meta),
    ], { timeout: 10_000, stdio: 'pipe' });
  } catch { /* best-effort for logging */ }
}

// ─── resolver + AppFolio ID lookup ─────────────────────────────────────────────

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

async function lookupAppFolioIds(
  pool: pg.Pool,
  resolved: ResolvedCaller,
): Promise<ResolvedCaller> {
  if (!resolved.matched || !resolved.occupancy_id) return resolved;
  try {
    const row = await pool.query(
      `SELECT u.appfolio_unit_id, p.appfolio_property_id, o.appfolio_occupancy_id
       FROM occupancies o
       JOIN units u ON u.id = o.unit_id
       JOIN properties p ON p.id = u.property_id
       WHERE o.id = $1
       LIMIT 1`,
      [resolved.occupancy_id],
    );
    if (row.rows[0]) {
      return {
        ...resolved,
        appfolio_unit_id: row.rows[0].appfolio_unit_id ?? null,
        appfolio_property_id: row.rows[0].appfolio_property_id ?? null,
        appfolio_occupancy_id: row.rows[0].appfolio_occupancy_id ?? null,
      };
    }
  } catch { /* IDs stay null — checkAppFolioIds will flag */ }
  return resolved;
}

// ─── main processor ────────────────────────────────────────────────────────────

async function processPostCallEvents(): Promise<void> {
  const pool = makePool();

  try {
    // 5a FIX: atomic claim via UPDATE...RETURNING inside a transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const claimed = await client.query(`
        UPDATE voice_events
        SET lifecycle_status = 'processing'
        WHERE id IN (
          SELECT id FROM voice_events
          WHERE event_type = 'elevenlabs_post_call'
            AND (lifecycle_status IS NULL OR lifecycle_status = 'pending')
          ORDER BY created_at ASC
          LIMIT 10
          FOR UPDATE SKIP LOCKED
        )
        RETURNING id, payload, created_at
      `);
      await client.query('COMMIT');
      client.release();

      if (claimed.rows.length === 0) {
        console.log(JSON.stringify({ status: 'no_events' }));
        await pool.end();
        return;
      }

      for (const row of claimed.rows) {
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
    } catch (e) {
      client.release();
      throw e;
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

  // 5b FIX: blank conversation_id falls back to source event ID
  const effectiveSourceId = conversationId || eventId;

  // Layer 1 dedup: same source already processed (fail-closed: DB error = reject)
  const sourceKey = computeSourceIdempotencyKey(effectiveSourceId);
  let sourceIsDuplicate = false;
  try {
    const existing = await pool.query(
      `SELECT id FROM voice_events
       WHERE event_type = 'wo_intake'
         AND payload->>'source_idempotency_key' = $1
       LIMIT 1`,
      [sourceKey],
    );
    sourceIsDuplicate = !!existing.rows[0];
  } catch {
    // F2 FIX: dedup fail-CLOSED — if we can't verify uniqueness, mark error
    await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'dedup_check_error' WHERE id = $1`,
      [eventId],
    ).catch(() => {});
    console.error(JSON.stringify({
      error: 'source_dedup_db_failure',
      event_id: eventId,
      source_id: effectiveSourceId,
    }));
    return;
  }

  if (sourceIsDuplicate) {
    await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'duplicate_skipped' WHERE id = $1`,
      [eventId],
    );
    console.log(JSON.stringify({
      status: 'source_duplicate_skipped',
      event_id: eventId,
    }));
    return;
  }

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

  const sourceTurnIds = transcript
    .map((t, i) => ({ turn: t as Record<string, unknown>, idx: i }))
    .filter(({ turn }) => turn['role'] === 'user')
    .map(({ idx }) => idx);

  // Detect emergency
  const safetyFlags = detectEmergency(isEmergencyRaw, issueDescription, transcript);

  // Classify intake
  const classification = classifyIntake(issueDescription, transcriptSummary);

  // Resolve caller
  const { resolved: rawResolved, error: resolverError } = await resolveCaller(pool, callerPhone);
  const guards = applyGuards(rawResolved, resolverError);

  // AppFolio ID lookup (only if resolver matched)
  const resolved = (rawResolved?.matched)
    ? await lookupAppFolioIds(pool, rawResolved)
    : rawResolved;

  const afIds = checkAppFolioIds(resolved);

  // Build unit address from resolver (preferred) or data_collection
  const unitAddress = resolved?.matched
    ? [resolved.unit_label, resolved.property_label ?? resolved.property_name].filter(Boolean).join(', ')
    : [unitNumber ? '#' + unitNumber : '', propertyAddress].filter(Boolean).join(', ');

  const tenantName = resolved?.matched
    ? (resolved.display_name ?? callerName)
    : callerName;

  const priority = mapPriority(severityRaw, safetyFlags.is_emergency);
  const permissionToEnter = mapPte(pteRaw);
  const { confidence, lowFields } = computeConfidence(dcResults, resolved, classification);

  // Route decision (single function, testable)
  const { route, manualReviewReason } = computeRouteDecision({
    safetyFlags,
    guardsPassed: guards.pass,
    guardReason: guards.reason,
    classification,
    confidence,
    lowFields,
    appfolioReady: afIds.ready,
    appfolioIdReason: afIds.reason,
  });

  // Layer 2 dedup: repeat-window (same caller + issue within time window)
  // Fail-closed: DB error = flag as possible repeat (safer than silently passing)
  const repeatKey = computeRepeatWindowKey(callerPhone, unitAddress, issueDescription);
  let repeatCheck = { isRepeat: false, priorIntakeId: undefined as string | undefined };
  try {
    const existing = await pool.query(
      `SELECT id FROM voice_events
       WHERE event_type = 'wo_intake'
         AND payload->>'repeat_window_key' = $1
         AND created_at > now() - interval '${REPEAT_WINDOW_HOURS} hours'
       LIMIT 1`,
      [repeatKey],
    );
    if (existing.rows[0]) repeatCheck = { isRepeat: true, priorIntakeId: existing.rows[0].id as string };
  } catch {
    repeatCheck = { isRepeat: true, priorIntakeId: 'dedup_check_failed' };
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
    repeat_signal: repeatCheck.isRepeat
      ? { mentioned_prior: true, detail: `prior intake ${repeatCheck.priorIntakeId} within ${REPEAT_WINDOW_HOURS}h window` }
      : null,
    room_location: locationRaw,
    transcript_summary: transcriptSummary,
    transcript,
    conversation_id: conversationId,
    extractor_version: EXTRACTOR_VERSION,
    confidence,
    source_turn_ids: sourceTurnIds,
    manual_review_reason: repeatCheck.isRepeat
      ? (manualReviewReason ? `${manualReviewReason}; possible_repeat_call` : 'possible_repeat_call')
      : manualReviewReason,
    appfolio_ready: afIds.ready,
    appfolio_unit_id: resolved?.appfolio_unit_id ?? null,
    appfolio_property_id: resolved?.appfolio_property_id ?? null,
    appfolio_occupancy_id: resolved?.appfolio_occupancy_id ?? null,
  };

  // Effective route: repeat calls always go to manual review
  const effectiveRoute = repeatCheck.isRepeat && route === 'routine' ? 'manual_review' as const : route;
  const effectiveReviewReason = intake.manual_review_reason;

  // Write wo_intake event (source_idempotency_key for unique index enforcement)
  const intakePayload = {
    ...intake,
    source_post_call_event_id: eventId,
    source_idempotency_key: sourceKey,
    repeat_window_key: repeatKey,
    guards_passed: guards.pass,
    classification,
  };

  await pool.query(
    `INSERT INTO voice_events (event_type, source_event_id, payload)
     VALUES ('wo_intake', $1, $2)`,
    [effectiveSourceId, JSON.stringify(intakePayload)],
  );

  // F1 FIX: SEND-THEN-MARK for emergency — do NOT mark processed until
  // at least one emergency notification channel confirms delivery
  if (effectiveRoute === 'emergency') {
    const alertMsg = `EMERGENCY INTAKE from voice call:\n${tenantName} at ${unitAddress}\nIssue: ${issueDescription}\nSafety: ${safetyFlags.detail}\nCall ID: ${conversationId}\nAction needed immediately.`;
    const telegramSent = sendTelegram(CHAT_ALBIE, alertMsg);
    const maxSent = sendAgentMessage('maintenance-coordinator', JSON.stringify({
      type: 'emergency_intake',
      ...intake,
    }));

    if (!telegramSent && !maxSent) {
      // BOTH channels failed — do NOT mark processed, leave for retry
      await pool.query(
        `UPDATE voice_events SET lifecycle_status = 'emergency_send_failed' WHERE id = $1`,
        [eventId],
      );
      console.error(JSON.stringify({
        error: 'emergency_alert_delivery_failed',
        event_id: eventId,
        intake_id: intakeId,
        call_id: conversationId,
        safety_detail: safetyFlags.detail,
      }));
      return;
    }

    // At least one channel confirmed — mark processed
    await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'processed' WHERE id = $1`,
      [eventId],
    );
    logEvent('action', 'emergency_intake_detected', 'critical', {
      event_id: eventId,
      intake_id: intakeId,
      call_id: conversationId,
      safety_detail: safetyFlags.detail,
      telegram_sent: telegramSent,
      max_sent: maxSent,
      agent: 'claudia',
    });
    console.log(JSON.stringify({
      status: 'emergency_routed',
      event_id: eventId,
      intake_id: intakeId,
      telegram_sent: telegramSent,
      max_sent: maxSent,
    }));
    return;
  }

  // Non-emergency: mark processed, then send (best-effort delivery acceptable)
  await pool.query(
    `UPDATE voice_events SET lifecycle_status = 'processed' WHERE id = $1`,
    [eventId],
  );

  if (effectiveRoute === 'manual_review') {
    sendTelegram(CHAT_ALBIE, `Voice intake needs manual review:\n${tenantName} at ${unitAddress}\nIssue: ${issueDescription}\nReason: ${effectiveReviewReason}\nCall ID: ${conversationId}`);
    logEvent('action', 'intake_manual_review', 'warning', {
      event_id: eventId,
      intake_id: intakeId,
      call_id: conversationId,
      reason: effectiveReviewReason,
      agent: 'claudia',
    });
    console.log(JSON.stringify({ status: 'manual_review', event_id: eventId, intake_id: intakeId, reason: effectiveReviewReason }));
    return;
  }

  // Routine: all guards + IDs + confidence passed → Max's intake-triage queue
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

// ─── entry point ───────────────────────────────────────────────────────────────

processPostCallEvents().catch((e) => {
  console.error(JSON.stringify({ error: 'processor_fatal', detail: String(e).substring(0, 500) }));
  process.exit(1);
});

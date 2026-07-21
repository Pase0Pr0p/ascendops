#!/usr/bin/env node
/**
 * WO intake pickup — claudia cron script (every 5 minutes).
 *
 * Polls voice_events for pending wo_intake rows where appfolio_ready=true,
 * claims them atomically (lifecycle_status pending→staged), dry-runs the
 * AppFolio WO creation, and sends a Telegram approval message to Albie
 * with an inline keyboard. On approval callback, the agent calls
 * createWorkOrder live and hands off to Max.
 *
 * Usage: npx tsx scripts/wo-intake-pickup.ts
 *        npx tsx scripts/wo-intake-pickup.ts --approve <event_id>
 *        npx tsx scripts/wo-intake-pickup.ts --auto (skip approval, future toggle)
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import pg from 'pg';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

const STATE_PATH = resolve(process.cwd(), '.wo-intake-state.json');
const CHAT_ALBIE = '6398997982';

interface IntakeState {
  staged: Record<string, StagedEntry>;
  last_run: string;
}

interface StagedEntry {
  event_id: string;
  approval_hash: string;
  tenant_name: string;
  unit_label: string;
  property_label: string;
  issue_description: string;
  severity: string;
  staged_at: string;
  appfolio_property_id: string;
  appfolio_unit_id: string;
  appfolio_occupancy_id: string;
  caller_number: string;
  permission_to_enter: boolean | null;
  location_detail: string;
  contact_id: string | null;
  call_id: string | null;
  creating_at?: string;
}

function readState(): IntakeState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as IntakeState;
  } catch {
    return { staged: {}, last_run: new Date(0).toISOString() };
  }
}

const EVICTION_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function writeState(state: IntakeState): void {
  const now = Date.now();
  const entries = Object.entries(state.staged);
  const kept = entries.filter(([, e]) => {
    const age = now - new Date(e.staged_at).getTime();
    return age < EVICTION_AGE_MS;
  });
  if (kept.length < entries.length) {
    console.log(JSON.stringify({ evicted: entries.length - kept.length, reason: 'older_than_7_days' }));
  }
  state.staged = Object.fromEntries(kept);
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

function sendTelegramWithKeyboard(chatId: string, message: string, keyboard: object): boolean {
  const botToken = process.env.TELEGRAM_BOT_TOKEN ?? process.env.BOT_TOKEN ?? '';
  if (!botToken) {
    console.error(JSON.stringify({ error: 'no_bot_token' }));
    return false;
  }
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body = JSON.stringify({
    chat_id: chatId,
    text: message,
    reply_markup: keyboard,
  });
  try {
    const raw = execFileSync('curl', ['-s', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      '-d', body,
    ], { timeout: 15_000, stdio: 'pipe' }).toString('utf-8');
    try {
      const resp = JSON.parse(raw);
      if (resp.ok !== true) {
        console.error(JSON.stringify({ error: 'telegram_api_rejected', description: resp.description }));
        return false;
      }
    } catch {
      console.error(JSON.stringify({ error: 'telegram_response_unparseable', raw: raw.substring(0, 200) }));
      return false;
    }
    return true;
  } catch (e) {
    console.error(JSON.stringify({ error: 'telegram_send_failed', detail: String(e) }));
    return false;
  }
}

function sendTelegram(chatId: string, message: string): void {
  try {
    execFileSync('cortextos', ['bus', 'send-telegram', chatId, message, '--skip-lint'], { timeout: 10_000, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

function sendToMax(message: string): boolean {
  try {
    execFileSync('cortextos', ['bus', 'send-message', 'maintenance-coordinator', 'normal', message, '--skip-lint'], { timeout: 15_000, stdio: 'pipe' });
    return true;
  } catch (e) {
    console.error(JSON.stringify({ error: 'max_dispatch_failed', detail: String(e) }));
    return false;
  }
}

function logEvent(action: string, eventType: string, level: string, meta: Record<string, unknown>): void {
  try {
    execFileSync('cortextos', ['bus', 'log-event', action, eventType, level, '--meta', JSON.stringify(meta)], { timeout: 10_000, stdio: 'pipe' });
  } catch { /* best-effort */ }
}

interface IntakeRow {
  id: string;
  source_event_id: string | null;
  received_at: string;
  payload: Record<string, unknown>;
}

function makePool(): pg.Pool {
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  if (!dsn) {
    console.error(JSON.stringify({ error: 'VOICE_GATEWAY_DSN not configured' }));
    process.exit(1);
  }
  return new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
}

function extractJson(raw: string): string {
  let last = '';
  let pos = raw.length;
  while (pos > 0) {
    const idx = raw.lastIndexOf('{', pos - 1);
    if (idx < 0) break;
    try {
      JSON.parse(raw.slice(idx));
      last = raw.slice(idx);
      break;
    } catch { pos = idx; }
  }
  return last || raw.trim();
}

function formatLocationRef(payload: Record<string, unknown>): string {
  const addr = String(payload['property_label'] ?? '');
  const unit = String(payload['unit_label'] ?? '');
  const addrParts = addr.split(/\s+/);
  const first2addr = (addrParts[0] ?? '').substring(0, 2);
  const first2street = (addrParts[1] ?? '').substring(0, 2);
  const unitShort = unit.replace(/^Unit\s*/i, '').trim();
  return `${first2addr}-${first2street}${unitShort ? '-' + unitShort : ''}`;
}

async function pollAndStage() {
  const state = readState();
  const pool = makePool();

  let rows: IntakeRow[] = [];
  try {
    const res = await pool.query<IntakeRow>(
      `UPDATE voice_events
         SET lifecycle_status = 'staged',
             payload = payload || jsonb_build_object('staged_at', to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))
       WHERE id IN (
         SELECT id FROM voice_events
          WHERE event_type = 'wo_intake'
            AND lifecycle_status = 'pending'
            AND (payload->>'appfolio_ready')::boolean = true
          ORDER BY received_at ASC
          LIMIT 5
          FOR UPDATE SKIP LOCKED
       )
       RETURNING id::text, source_event_id, received_at, payload`,
    );
    rows = res.rows;
  } catch (e) {
    console.error(JSON.stringify({ error: 'db_claim_failed', detail: String(e) }));
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // Also mark appfolio_ready=false events as skipped
  try {
    await pool.query(
      `UPDATE voice_events
         SET lifecycle_status = 'skipped'
       WHERE event_type = 'wo_intake'
         AND lifecycle_status = 'pending'
         AND (
           (payload->>'appfolio_ready')::boolean = false
           OR payload->>'appfolio_ready' IS NULL
         )`,
    );
  } catch { /* best-effort — main path is more important */ }

  // Detect rows stuck in 'creating' — check state file creating_at, not DB received_at
  try {
    const creating = await pool.query(
      `SELECT id::text, payload->>'tenant_name' as tenant_name
       FROM voice_events
       WHERE event_type = 'wo_intake'
         AND lifecycle_status = 'creating'`,
    );
    const now = Date.now();
    for (const row of creating.rows) {
      const entry = state.staged[row.id];
      const creatingAt = entry?.creating_at;
      const age = creatingAt ? now - new Date(creatingAt).getTime() : Infinity;
      if (age > 10 * 60 * 1000) {
        sendTelegram(CHAT_ALBIE, `WO intake event ${row.id} (${row.tenant_name ?? 'unknown'}) stuck in 'creating' status for >10 min. Likely crash during create. Manual check needed.`);
        logEvent('action', 'wo_intake_stuck_creating', 'error', { event_id: row.id, agent: 'claudia' });
      }
    }
  } catch { /* best-effort */ }

  // Expire stale staged rows — prevents zombie DB rows when local state evicts.
  // Both DB sweep and local eviction use the same staged_at timestamp (written to
  // payload during pending→staged claim) with matching 7-day cutoff.
  // Legacy rows without payload.staged_at fall back to received_at.
  try {
    const stale = await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'failed'
       WHERE event_type = 'wo_intake'
         AND lifecycle_status = 'staged'
         AND COALESCE((payload->>'staged_at')::timestamptz, received_at) < NOW() - INTERVAL '7 days'
       RETURNING id::text, payload->>'tenant_name' as tenant_name`,
    );
    if (stale.rows.length > 0) {
      const names = stale.rows.map(r => `${r.id} (${r.tenant_name ?? 'unknown'})`).slice(0, 5).join(', ');
      const suffix = stale.rows.length > 5 ? ` +${stale.rows.length - 5} more` : '';
      sendTelegram(CHAT_ALBIE, `${stale.rows.length} stale WO intake(s) expired (staged >7 days without approval): ${names}${suffix}. Marked failed.`);
      for (const row of stale.rows) {
        logEvent('action', 'wo_intake_expired', 'error', { event_id: row.id, agent: 'claudia' });
      }
    }
  } catch { /* best-effort */ }

  await pool.end().catch(() => {});

  if (rows.length === 0) {
    writeState({ ...state, last_run: new Date().toISOString() });
    console.log(JSON.stringify({ status: 'ok', new_intakes: 0, staged: 0 }));
    return;
  }

  let staged = 0;
  for (const row of rows) {
    const p = row.payload;
    const tenantName = String(p['tenant_name'] ?? 'Unknown');
    const unitLabel = String(p['unit_label'] ?? '');
    const propertyLabel = String(p['property_label'] ?? '');
    const issueDescription = String(p['issue_description'] ?? '');
    const severity = String(p['severity'] ?? 'normal');
    const permissionToEnter = p['permission_to_enter'] as boolean | null;
    const locationDetail = String(p['location_detail'] ?? '');
    const callerNumber = String(p['caller_number'] ?? '');
    const contactId = (p['contact_id'] as string | null) ?? null;
    const callId = (p['call_id'] as string | null) ?? row.source_event_id;
    const appfolioPropertyId = String(p['appfolio_property_id'] ?? '');
    const appfolioUnitId = String(p['appfolio_unit_id'] ?? '');
    const appfolioOccupancyId = String(p['appfolio_occupancy_id'] ?? '');

    // Dry-run createWorkOrder to get the approval hash
    const pteFlag = String(permissionToEnter).toLowerCase() === 'true' ? 'true' : String(permissionToEnter).toLowerCase() === 'false' ? 'false' : 'not_applicable';
    const priority = severity === 'urgent' ? 'Urgent' : 'Normal';
    const description = `Voice intake from ${tenantName}: ${issueDescription}${locationDetail ? ' (' + locationDetail + ')' : ''}`;

    const dryRunArgs = [
      'scripts/appfolio-browser-read.ts', 'create-work-order',
      '--property-id', appfolioPropertyId,
      '--unit-id', appfolioUnitId,
      '--occupancy-id', appfolioOccupancyId,
      '--description', description,
      '--priority', priority,
      '--permission-to-enter', pteFlag,
      '--request-type', 'tenant_requested',
    ];

    let dryRunResult: Record<string, unknown> = {};
    try {
      const output = execFileSync('npx', ['tsx', ...dryRunArgs], {
        timeout: 60_000,
        stdio: 'pipe',
        cwd: resolve(process.cwd()),
      }).toString('utf-8');
      dryRunResult = JSON.parse(extractJson(output));
    } catch (e) {
      const childOut = (e as { stdout?: Buffer })?.stdout?.toString('utf-8') ?? '';
      console.error(JSON.stringify({ error: 'dry_run_failed', event_id: row.id, detail: String(e), child_stdout: childOut.substring(0, 500) }));
      const failPool = makePool();
      await failPool.query(
        `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      await failPool.end().catch(() => {});
      logEvent('action', 'wo_intake_dry_run_failed', 'error', { event_id: row.id, agent: 'claudia' });
      sendTelegram(CHAT_ALBIE, `WO intake dry-run FAILED for ${tenantName} at ${unitLabel}, ${propertyLabel} (event ${row.id}). Error: ${String(e).substring(0, 200)}. Manual WO needed.`);
      continue;
    }

    if (dryRunResult['error']) {
      console.error(JSON.stringify({ error: 'dry_run_error', event_id: row.id, result: dryRunResult }));
      const failPool = makePool();
      await failPool.query(
        `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      await failPool.end().catch(() => {});
      logEvent('action', 'wo_intake_dry_run_failed', 'error', { event_id: row.id, error: dryRunResult['error'], agent: 'claudia' });
      sendTelegram(CHAT_ALBIE, `WO intake dry-run error for ${tenantName} at ${unitLabel}, ${propertyLabel} (event ${row.id}). Result: ${String(dryRunResult['error']).substring(0, 200)}. Manual WO needed.`);
      continue;
    }

    const approvalHash = String(dryRunResult['approval_hash'] ?? '');
    if (!approvalHash) {
      console.error(JSON.stringify({ error: 'no_approval_hash', event_id: row.id }));
      const failPool = makePool();
      await failPool.query(
        `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      await failPool.end().catch(() => {});
      logEvent('action', 'wo_intake_dry_run_failed', 'error', { event_id: row.id, reason: 'no_approval_hash', agent: 'claudia' });
      sendTelegram(CHAT_ALBIE, `WO intake dry-run produced no approval hash for event ${row.id} (${tenantName}). Marked failed, manual review needed.`);
      continue;
    }

    // Save staged entry
    const entry: StagedEntry = {
      event_id: row.id,
      approval_hash: approvalHash,
      tenant_name: tenantName,
      unit_label: unitLabel,
      property_label: propertyLabel,
      issue_description: issueDescription,
      severity,
      staged_at: String(row.payload['staged_at'] ?? new Date().toISOString()),
      appfolio_property_id: appfolioPropertyId,
      appfolio_unit_id: appfolioUnitId,
      appfolio_occupancy_id: appfolioOccupancyId,
      caller_number: callerNumber,
      permission_to_enter: permissionToEnter,
      location_detail: locationDetail,
      contact_id: contactId,
      call_id: callId,
    };
    state.staged[row.id] = entry;

    // Send Telegram approval to Albie with inline keyboard
    const locationRef = formatLocationRef(p);
    const pteStr = permissionToEnter === true ? 'Yes' : permissionToEnter === false ? 'No' : 'Not specified';
    const approvalMsg = [
      `WO Intake Approval`,
      ``,
      `Tenant: ${tenantName}`,
      `Location: ${unitLabel}, ${propertyLabel} (${locationRef})`,
      `Issue: ${issueDescription}`,
      locationDetail ? `Where: ${locationDetail}` : null,
      `Priority: ${priority}`,
      `Permission to enter: ${pteStr}`,
      `Source: Voice/Alex${callId ? ' (call ' + callId.substring(0, 8) + ')' : ''}`,
      ``,
      `Tap Approve to create this WO in AppFolio.`,
    ].filter(Boolean).join('\n');

    // callback_data: 64-byte limit. Use prefix + event_id
    const keyboard = {
      inline_keyboard: [[
        { text: 'Approve', callback_data: `wo_ok_${row.id}` },
        { text: 'Skip', callback_data: `wo_skip_${row.id}` },
      ]],
    };

    const sent = sendTelegramWithKeyboard(CHAT_ALBIE, approvalMsg, keyboard);
    if (!sent) {
      const failPool = makePool();
      await failPool.query(
        `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
        [row.id],
      ).catch(() => {});
      await failPool.end().catch(() => {});
      logEvent('action', 'wo_intake_approval_send_failed', 'error', { event_id: row.id, agent: 'claudia' });
      sendTelegram(CHAT_ALBIE, `WO approval message failed to send for ${tenantName} at ${propertyLabel} (event ${row.id}). Marked failed, manual WO needed.`);
      console.error(JSON.stringify({ error: 'approval_send_failed', event_id: row.id }));
      continue;
    }
    logEvent('action', 'wo_intake_staged', 'info', { event_id: row.id, tenant: tenantName, agent: 'claudia' });
    staged++;
    console.log(JSON.stringify({ staged: true, event_id: row.id, tenant: tenantName, approval_hash: approvalHash.substring(0, 8) + '...' }));
  }

  writeState({ ...state, last_run: new Date().toISOString() });
  console.log(JSON.stringify({ status: 'ok', new_intakes: rows.length, staged }));
}

async function executeApproval(eventId: string) {
  const state = readState();
  const entry = state.staged[eventId];
  if (!entry) {
    console.error(JSON.stringify({ error: 'not_staged', event_id: eventId }));
    process.exit(1);
  }

  const pool = makePool();

  // Event-level idempotency: refuse re-create if a WO/SR ID is already persisted on this event.
  // This prevents duplicates even when a reporting bug marks a successfully-created WO as failed.
  const existingCheck = await pool.query(
    `SELECT payload->>'created_wo_id' as wo_id, payload->>'created_sr_id' as sr_id, lifecycle_status
     FROM voice_events WHERE id = $1`,
    [eventId],
  ).catch(() => null);

  if (existingCheck?.rows[0]?.wo_id || existingCheck?.rows[0]?.sr_id) {
    const existing = existingCheck.rows[0];
    console.error(JSON.stringify({
      error: 'already_created',
      event_id: eventId,
      wo_id: existing.wo_id,
      sr_id: existing.sr_id,
      lifecycle_status: existing.lifecycle_status,
      message: 'This event already has a WO/SR ID persisted. Refusing re-create.',
    }));
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // Atomic claim: staged→creating. Prevents double-tap / duplicate callback race.
  const claim = await pool.query(
    `UPDATE voice_events SET lifecycle_status = 'creating'
     WHERE id = $1 AND lifecycle_status = 'staged'
     RETURNING id`,
    [eventId],
  ).catch(() => null);

  if (!claim?.rows[0]) {
    console.error(JSON.stringify({ error: 'atomic_claim_failed', event_id: eventId, message: 'Event not in staged status — duplicate callback or already processed' }));
    await pool.end().catch(() => {});
    process.exit(1);
  }

  // Record creating start time for stuck-creating detection
  entry.creating_at = new Date().toISOString();
  writeState(state);

  // Execute live create with the stored approval hash
  const pteFlag = String(entry.permission_to_enter).toLowerCase() === 'true' ? 'true' : String(entry.permission_to_enter).toLowerCase() === 'false' ? 'false' : 'not_applicable';
  const priority = entry.severity === 'urgent' ? 'Urgent' : 'Normal';
  const description = `Voice intake from ${entry.tenant_name}: ${entry.issue_description}${entry.location_detail ? ' (' + entry.location_detail + ')' : ''}`;

  const liveArgs = [
    'scripts/appfolio-browser-read.ts', 'create-work-order',
    '--property-id', entry.appfolio_property_id,
    '--unit-id', entry.appfolio_unit_id,
    '--occupancy-id', entry.appfolio_occupancy_id,
    '--description', description,
    '--priority', priority,
    '--permission-to-enter', pteFlag,
    '--request-type', 'tenant_requested',
    '--execute',
    '--approval-hash', entry.approval_hash,
  ];

  let createResult: Record<string, unknown> = {};
  try {
    const output = execFileSync('npx', ['tsx', ...liveArgs], {
      timeout: 120_000,
      stdio: 'pipe',
      cwd: resolve(process.cwd()),
    }).toString('utf-8');
    createResult = JSON.parse(extractJson(output));
  } catch (e) {
    // Child exited non-zero — but may have still created the WO successfully
    // (e.g., verified=false causes exit 1 even after a successful submit).
    // Try to parse the child's stdout for a valid result before treating as failure.
    const childStdout = (e as { stdout?: Buffer })?.stdout?.toString('utf-8') ?? '';
    const childStderr = (e as { stderr?: Buffer })?.stderr?.toString('utf-8') ?? '';

    try {
      const recovered = JSON.parse(extractJson(childStdout));
      if (recovered.live === true && recovered.hash_consumed === true) {
        createResult = recovered;
      }
    } catch { /* child output not parseable, treat as real failure */ }

    if (!createResult['live']) {
      await pool.query(
        `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
        [eventId],
      ).catch(() => {});
      await pool.end().catch(() => {});

      logEvent('action', 'wo_create_failed', 'error', { event_id: eventId, agent: 'claudia' });
      sendTelegram(CHAT_ALBIE, `WO creation FAILED for ${entry.tenant_name} at ${entry.unit_label}, ${entry.property_label}. Error: ${String(e).substring(0, 200)}. Manual WO needed.`);
      console.error(JSON.stringify({ error: 'live_create_failed', event_id: eventId, detail: String(e), child_stdout: childStdout.substring(0, 500), child_stderr: childStderr.substring(0, 500) }));
      process.exit(1);
    }
  }

  if (createResult['error']) {
    await pool.query(
      `UPDATE voice_events SET lifecycle_status = 'failed' WHERE id = $1`,
      [eventId],
    ).catch(() => {});
    await pool.end().catch(() => {});

    logEvent('action', 'wo_create_failed', 'error', { event_id: eventId, error: createResult['error'], agent: 'claudia' });
    sendTelegram(CHAT_ALBIE, `WO creation FAILED for ${entry.tenant_name} at ${entry.unit_label}, ${entry.property_label}. Error: ${String(createResult['error'])}. Manual WO needed.`);
    console.error(JSON.stringify({ error: 'create_failed', event_id: eventId, result: createResult }));
    process.exit(1);
  }

  const woId = String(createResult['wo_id'] ?? '');
  const srId = String(createResult['sr_id'] ?? '');

  // Persist WO/SR ID to the event IMMEDIATELY, before any verification check.
  // This is the idempotency anchor: once a WO ID is persisted, no re-create can happen.
  await pool.query(
    `UPDATE voice_events
     SET payload = payload || jsonb_build_object('created_wo_id', $2::text, 'created_sr_id', $3::text)
     WHERE id = $1`,
    [eventId, woId, srId],
  ).catch(() => {
    sendTelegram(CHAT_ALBIE, `WO was CREATED (WO#${woId || srId}) but failed to persist WO ID to event ${eventId}. Manual DB update needed.`);
  });

  // Determine final lifecycle state based on verification
  const verified = createResult['verified'] === true;
  const finalStatus = verified ? 'created' : 'created_unverified';

  const markResult = await pool.query(
    `UPDATE voice_events SET lifecycle_status = $2 WHERE id = $1 RETURNING id`,
    [eventId, finalStatus],
  ).catch(() => null);
  await pool.end().catch(() => {});

  if (!markResult?.rows[0]) {
    logEvent('action', 'wo_created_mark_failed', 'error', { event_id: eventId, agent: 'claudia' });
    sendTelegram(CHAT_ALBIE, `WO was CREATED for ${entry.tenant_name} but status update to '${finalStatus}' failed in DB. WO ID persisted (no double-create risk). Manual DB update needed: UPDATE voice_events SET lifecycle_status='${finalStatus}' WHERE id='${eventId}'`);
  }

  if (!verified) {
    logEvent('action', 'wo_created_unverified', 'warning', { event_id: eventId, wo_id: woId, sr_id: srId, agent: 'claudia' });
    sendTelegram(CHAT_ALBIE, `WO#${woId || srId} CREATED for ${entry.tenant_name} at ${entry.unit_label}, ${entry.property_label} but post-create verification did not pass. Please verify WO details in AppFolio.`);
  }
  const woUrl = srId ? `https://paseoproperties.appfolio.com/maintenance/service_requests/${srId}` : '';

  logEvent('action', 'wo_created', 'info', {
    event_id: eventId,
    wo_id: woId,
    sr_id: srId,
    tenant: entry.tenant_name,
    agent: 'claudia',
  });

  // Notify Albie
  sendTelegram(CHAT_ALBIE, `WO created for ${entry.tenant_name} at ${entry.unit_label}, ${entry.property_label}. WO#${woId || srId}${woUrl ? '\n' + woUrl : ''}`);

  // Hand off to Max
  const locationRef = formatLocationRef(entry as unknown as Record<string, unknown>);
  const maxHandoff = JSON.stringify({
    type: 'wo_voice_intake',
    wo_id: woId || null,
    sr_id: srId || null,
    wo_url: woUrl || null,
    location_ref: locationRef,
    full_address: `${entry.unit_label}, ${entry.property_label}`,
    tenant_name: entry.tenant_name,
    callback_number: entry.caller_number,
    unit_id: entry.appfolio_unit_id,
    issue_description: entry.issue_description,
    severity: entry.severity,
    permission_to_enter: entry.permission_to_enter,
    location_detail: entry.location_detail,
    source: 'voice/Alex',
    call_id: entry.call_id,
    availability_window: null,
    photo_submitted: null,
  });

  const maxSent = sendToMax(maxHandoff);
  if (!maxSent) {
    logEvent('action', 'wo_max_handoff_failed', 'error', { event_id: eventId, wo_id: woId, agent: 'claudia' });
    sendTelegram(CHAT_ALBIE, `WO#${woId || srId} created for ${entry.tenant_name} but Max handoff FAILED. Manual handoff needed.`);
  } else {
    logEvent('action', 'wo_handoff_to_max', 'info', {
      event_id: eventId,
      wo_id: woId,
      tenant: entry.tenant_name,
      agent: 'claudia',
    });
  }

  // Clean up staged entry
  delete state.staged[eventId];
  writeState(state);

  console.log(JSON.stringify({
    status: 'created',
    event_id: eventId,
    wo_id: woId,
    sr_id: srId,
    tenant: entry.tenant_name,
    handed_to_max: true,
  }));
}

async function skipIntake(eventId: string) {
  const state = readState();
  const pool = makePool();

  await pool.query(
    `UPDATE voice_events SET lifecycle_status = 'skipped' WHERE id = $1`,
    [eventId],
  ).catch(() => {});
  await pool.end().catch(() => {});

  logEvent('action', 'wo_intake_skipped', 'info', { event_id: eventId, agent: 'claudia' });

  if (state.staged[eventId]) {
    delete state.staged[eventId];
    writeState(state);
  }

  console.log(JSON.stringify({ status: 'skipped', event_id: eventId }));
}

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === '--approve' && args[1]) {
    await executeApproval(args[1]);
    return;
  }

  if (args[0] === '--skip' && args[1]) {
    await skipIntake(args[1]);
    return;
  }

  await pollAndStage();
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});

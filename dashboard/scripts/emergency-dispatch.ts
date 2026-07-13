#!/usr/bin/env node
/**
 * Emergency dispatch — claudia cron script (every 1 minute).
 *
 * Queries voice_events for new emergency_alert rows, dispatches each to
 * maintenance-coordinator via cortextos bus (high priority). Tracks dispatched
 * IDs in a local state file to prevent double-dispatch.
 *
 * Staleness guard: if any emergency_alert row is >5 minutes old and still
 * unforwarded (poller was down), sends Telegram directly to Rob+Albie as a
 * failsafe in addition to normal Max dispatch.
 *
 * Usage: npx tsx scripts/emergency-dispatch.ts
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';
import pg from 'pg';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

const STATE_PATH = resolve(process.cwd(), '.emergency-dispatch-state.json');
const LOOK_BACK_MINUTES = 60;        // scan window for unforwarded rows
const STALE_THRESHOLD_MINUTES = 5;  // rows older than this trigger staleness Telegram

const CHAT_ROB = '8913224519';
const CHAT_ALBIE = '6398997982';

interface DispatchState {
  dispatched_ids: string[];
  last_run: string;
}

interface EmergencyRow {
  id: string;
  source_event_id: string | null;
  received_at: string;
  age_minutes: number;
  payload: Record<string, unknown>;
}

function readState(): DispatchState {
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf-8')) as DispatchState;
  } catch {
    return { dispatched_ids: [], last_run: new Date(0).toISOString() };
  }
}

function writeState(state: DispatchState): void {
  state.dispatched_ids = state.dispatched_ids.slice(-200);
  try { writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch { /* best-effort */ }
}

function sendTelegram(chatId: string, message: string): void {
  try {
    execSync(
      `cortextos bus send-telegram ${chatId} ${JSON.stringify(message)}`,
      { timeout: 10_000, stdio: 'pipe' },
    );
  } catch { /* best-effort */ }
}

function sendToBoth(message: string): void {
  sendTelegram(CHAT_ROB, message);
  sendTelegram(CHAT_ALBIE, message);
}

async function main() {
  const state = readState();
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  if (!dsn) {
    console.error(JSON.stringify({ error: 'VOICE_GATEWAY_DSN not configured' }));
    process.exit(1);
  }

  const pool = new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });

  let rows: EmergencyRow[] = [];
  try {
    const res = await pool.query<EmergencyRow>(
      `SELECT id::text, source_event_id, received_at,
              EXTRACT(EPOCH FROM (now() - received_at)) / 60 AS age_minutes,
              payload
         FROM voice_events
        WHERE event_type = 'emergency_alert'
          AND received_at > now() - interval '${LOOK_BACK_MINUTES} minutes'
        ORDER BY received_at ASC`,
    );
    rows = res.rows;
  } catch (e) {
    console.error(JSON.stringify({ error: 'db_query_failed', detail: String(e) }));
    await pool.end().catch(() => {});
    process.exit(1);
  }

  await pool.end().catch(() => {});

  const newRows = rows.filter(r => !state.dispatched_ids.includes(r.id));

  let dispatched = 0;
  for (const row of newRows) {
    const p = row.payload;
    const scenario = p['scenario'] as string;
    const tier = p['tier'] as number;
    const property = p['property'] as string;
    const unit = (p['unit'] as string | null) ?? null;
    const tenantName = (p['tenant_name'] as string) ?? '';
    const callbackNumber = (p['callback_number'] as string) ?? '';
    const locationDetail = (p['location_detail'] as string) ?? '';
    const notes = (p['notes'] as string) ?? '';
    const timestampUtc = (p['timestamp_utc'] as string) ?? row.received_at;
    const callId = row.source_event_id ?? '';
    const ageMin = Math.round(Number(row.age_minutes));

    // Staleness guard: row older than threshold means the poller was down during an emergency.
    // Send Telegram directly to Rob+Albie as a failsafe before the normal Max dispatch.
    if (ageMin >= STALE_THRESHOLD_MINUTES) {
      const staleMsg = `EMERGENCY ALERT (DELAYED ${ageMin}min): TIER ${tier} ${scenario.toUpperCase()} | ${property} Unit ${unit ?? 'UNKNOWN'} | Tenant: ${tenantName} | CB: ${callbackNumber}${notes ? ' | ' + notes : ''}\n\n(Alert was delayed — emergency dispatcher was offline. WO dispatch to Max in progress.)`;
      sendToBoth(staleMsg);
      console.log(JSON.stringify({ staleness_alert_sent: true, id: row.id, age_minutes: ageMin }));
    }

    const busMsg = JSON.stringify({
      type: 'emergency_alert',
      scenario, tier, property,
      unit: unit ?? null,
      tenant_name: tenantName,
      callback_number: callbackNumber,
      location_detail: locationDetail,
      notes,
      timestamp_utc: timestampUtc,
      call_id: callId,
      voice_events_id: row.id,
      age_minutes: ageMin,
    });

    try {
      execSync(
        `cortextos bus send-message maintenance-coordinator high ${JSON.stringify(busMsg)}`,
        { timeout: 15_000, stdio: 'pipe' },
      );
      state.dispatched_ids.push(row.id);
      dispatched++;
      console.log(JSON.stringify({ dispatched: true, id: row.id, scenario, tier, tenant: tenantName, age_minutes: ageMin }));
    } catch (e) {
      console.error(JSON.stringify({ dispatch_failed: true, id: row.id, error: String(e) }));
    }
  }

  writeState({ ...state, last_run: new Date().toISOString() });

  // Heartbeat: logged every run so scout can detect if this poller goes dark
  try {
    execSync(
      `cortextos bus log-event heartbeat emergency_poller_heartbeat info --meta '{"agent":"claudia"}'`,
      { timeout: 10_000, stdio: 'pipe' },
    );
  } catch { /* best-effort */ }

  console.log(JSON.stringify({ status: 'ok', new_emergencies: newRows.length, dispatched }));
}

main().catch(err => {
  console.error(JSON.stringify({ error: String(err) }));
  process.exit(1);
});

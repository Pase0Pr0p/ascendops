/**
 * Contact sync orchestrator — Supabase → Google Contacts → Quo (native sync).
 *
 * Cadence: daily at 4am PT, right after Albie's 3am PT AppFolio→Supabase refresh.
 *
 * Deploy gate: GOOGLE_PEOPLE_ACCESS_TOKEN (or refresh-token flow) from Albie
 *   (Workspace admin must authorize People API write on info@paseopropertymanagement.com).
 *
 * current-prospect tag: STUBBED — requires Albie to add an AppFolio applicants/guest-cards
 *   report to the daily Supabase scrape. Un-stub fetchAllContacts() in fetch.ts when that
 *   data lands. The 21-day drop + immediate-drop-on-close lifecycle is fully implemented
 *   in types.ts (shouldArchive) and people-api.ts (effectiveTag = 'inactive') — it will
 *   activate automatically once prospects are present in the contacts table.
 */

import { fetchAllContacts } from './fetch';
import { syncContactsToGoogle } from './people-api';
import type { SyncReport } from './types';

export interface SyncOptions {
  /** Google People API OAuth2 access token for info@paseopropertymanagement.com */
  accessToken: string;
  /** Dry run: fetch + transform but skip People API writes */
  dryRun?: boolean;
  /** ISO 8601 timestamp to use as "now" (defaults to current time) */
  nowIso?: string;
}

export async function runContactSync(opts: SyncOptions): Promise<SyncReport> {
  const nowIso = opts.nowIso ?? new Date().toISOString();

  // 1. Fetch all contacts from Supabase with occupancy context
  const contacts = await fetchAllContacts();

  // 2. Deduplicate by appfolioId — multiple Supabase records can share one appfolio_id
  //    (e.g. co-tenants). Keep the one with the highest-priority occupancy (first in fetch order).
  const seen = new Set<string>();
  const deduped = contacts.filter((c) => {
    if (!c.appfolioId) return true; // no key → keep (will be skipped in people-api)
    if (seen.has(c.appfolioId)) return false;
    seen.add(c.appfolioId);
    return true;
  });
  if (deduped.length !== contacts.length) {
    console.log(`[contact-sync] deduped ${contacts.length} → ${deduped.length} (${contacts.length - deduped.length} duplicates removed)`);
  }

  // 3. Tag breakdown for logging
  const tagCounts: Record<string, number> = {};
  for (const c of deduped) {
    tagCounts[c.tag] = (tagCounts[c.tag] ?? 0) + 1;
  }
  console.log(`[contact-sync] ${deduped.length} contacts to sync:`, tagCounts);

  // 4. Dry-run short-circuit
  if (opts.dryRun) {
    console.log('[contact-sync] dry-run: skipping People API writes');
    return {
      total: deduped.length,
      created: 0,
      updated: 0,
      archived: 0,
      skipped: deduped.length,
      errors: 0,
      results: deduped.map((c) => ({
        appfolioId: c.appfolioId,
        displayName: c.displayName,
        action: 'skipped',
        resourceName: null,
        error: 'dry-run',
      })),
    };
  }

  // 5. Upsert to Google Contacts
  const report = await syncContactsToGoogle(deduped, opts.accessToken, nowIso);

  console.log(
    `[contact-sync] done — created:${report.created} updated:${report.updated} archived:${report.archived} skipped:${report.skipped} errors:${report.errors}`,
  );
  if (report.errors > 0) {
    const failed = report.results.filter((r) => r.error).slice(0, 5);
    console.error('[contact-sync] sample errors:', failed);
  }

  return report;
}

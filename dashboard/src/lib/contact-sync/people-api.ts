/**
 * Google People API write layer.
 *
 * Upsert strategy:
 *   1. Fetch ALL existing connections once, build externalId → resource index.
 *   2. For each contact: if index has our appfolio:{id} key → PATCH, else → POST.
 *   3. Never touches contacts without our externalId marker (safe-guard for manually-added contacts).
 *
 * Rate limit: Google People API ~200 req/min per user. Batches of 20 with 500ms delay
 * between batches keeps us safely under.
 */

import type {
  DerivedContact,
  GoogleContactBody,
  GoogleContactResource,
  SyncReport,
  UpsertResult,
} from './types';
import { shouldArchive } from './types';

const PEOPLE_API = 'https://people.googleapis.com/v1';
const EXTERNAL_ID_TYPE = 'appfolio';

// Composite key: "tenant:123", "vendor:123", "owner:123"
// Prevents numeric ID collisions across AF entity types (same number can appear in tenant+vendor+owner tables)
function afExternalId(contact: { appfolioIdType: string | null; appfolioId: string | null }): string | null {
  if (!contact.appfolioId || !contact.appfolioIdType) return null;
  return `${contact.appfolioIdType}:${contact.appfolioId}`;
}

const TAG_GROUP_NAMES: Record<string, string> = {
  'current-prospect': 'AF-Prospect',
  'future-tenant':    'AF-Future-Tenant',
  'current-tenant':   'AF-Tenant',
  'former-tenant':    'AF-Former-Tenant',
  'owner':            'AF-Owner',
  'vendor':           'AF-Vendor',
  'inactive':         'AF-Inactive',
};

interface ContactGroupMap { [tagName: string]: string }

// ---------------------------------------------------------------------------
// Contact Group bootstrap
// ---------------------------------------------------------------------------

async function ensureContactGroups(token: string): Promise<ContactGroupMap> {
  const res = await fetch(`${PEOPLE_API}/contactGroups?pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`contactGroups list failed: ${res.status} ${await res.text()}`);
  const { contactGroups = [] } = await res.json() as { contactGroups?: { resourceName: string; name: string }[] };

  const existing: ContactGroupMap = {};
  for (const g of contactGroups) {
    const tagEntry = Object.entries(TAG_GROUP_NAMES).find(([, name]) => name === g.name);
    if (tagEntry) existing[tagEntry[0]] = g.resourceName;
  }

  for (const [tag, groupName] of Object.entries(TAG_GROUP_NAMES)) {
    if (!existing[tag]) {
      const createRes = await fetch(`${PEOPLE_API}/contactGroups`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contactGroup: { name: groupName } }),
      });
      if (!createRes.ok) throw new Error(`contactGroup create failed for ${groupName}: ${createRes.status}`);
      const created = await createRes.json() as { resourceName: string };
      existing[tag] = created.resourceName;
    }
  }

  return existing;
}

// ---------------------------------------------------------------------------
// Build externalId index — ONE full scan of info@ connections
// ---------------------------------------------------------------------------

async function buildExternalIdIndex(token: string): Promise<Map<string, GoogleContactResource>> {
  const index = new Map<string, GoogleContactResource>();
  let pageToken: string | undefined;
  let page = 0;

  do {
    const url = new URL(`${PEOPLE_API}/people/me/connections`);
    url.searchParams.set('personFields', 'externalIds,names,phoneNumbers,emailAddresses,memberships,biographies');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);

    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`connections list failed (page ${page}): ${res.status} ${await res.text()}`);

    const body = await res.json() as { connections?: GoogleContactResource[]; nextPageToken?: string };
    for (const c of body.connections ?? []) {
      // Accept both namespaced ("tenant:123") and legacy bare ("123") keys
      const afId = c.externalIds?.find((e) => e.type === EXTERNAL_ID_TYPE)?.value;
      if (afId) index.set(afId, c);
    }

    pageToken = body.nextPageToken;
    page++;
    console.log(`[people-api] indexed page ${page}: ${body.connections?.length ?? 0} contacts (${index.size} with our marker so far)`);
  } while (pageToken);

  return index;
}

// ---------------------------------------------------------------------------
// Build People API body
// ---------------------------------------------------------------------------

function buildBody(contact: DerivedContact, groupResourceName: string): GoogleContactBody {
  const phones = [
    ...(contact.phoneE164 ? [{ value: contact.phoneE164, type: 'mobile' as const }] : []),
    ...contact.allPhones.filter((p) => p !== contact.phoneE164).map((p) => ({ value: p, type: 'other' as const })),
  ];
  const emails = [
    ...(contact.primaryEmail ? [{ value: contact.primaryEmail, type: 'work' as const }] : []),
    ...contact.allEmails.filter((e) => e !== contact.primaryEmail).map((e) => ({ value: e, type: 'other' as const })),
  ];

  const noteLines: string[] = [];
  if (contact.unitName) noteLines.push(`Unit: ${contact.unitName}`);
  if (contact.propertyName) noteLines.push(`Property: ${contact.propertyName}`);
  if (contact.propertyAddress) noteLines.push(`Address: ${contact.propertyAddress}`);
  if (contact.tag) noteLines.push(`Tag: ${contact.tag}`);
  if (contact.appfolioId) noteLines.push(`AppFolio ID: ${contact.appfolioId}`);

  return {
    names: [{ givenName: contact.firstName ?? undefined, familyName: contact.lastName ?? undefined, displayName: contact.displayName }],
    phoneNumbers: phones.length ? phones : undefined,
    emailAddresses: emails.length ? emails : undefined,
    externalIds: afExternalId(contact) ? [{ type: EXTERNAL_ID_TYPE, value: afExternalId(contact)! }] : undefined,
    biographies: noteLines.length ? [{ value: noteLines.join('\n'), contentType: 'TEXT_PLAIN' }] : undefined,
    memberships: [{ contactGroupMembership: { contactGroupResourceName: groupResourceName } }],
  };
}

// ---------------------------------------------------------------------------
// Single contact upsert (uses pre-built index — no extra API calls)
// ---------------------------------------------------------------------------

async function upsertContact(
  token: string,
  contact: DerivedContact,
  groupMap: ContactGroupMap,
  index: Map<string, GoogleContactResource>,
  claimedBareIds: Set<string>,   // tracks which bare numeric IDs have been claimed this run
  nowIso: string,
): Promise<UpsertResult> {
  const base: Omit<UpsertResult, 'action'> = {
    appfolioId: contact.appfolioId,
    displayName: contact.displayName,
    resourceName: null,
    error: null,
  };

  const compositeKey = afExternalId(contact);
  if (!compositeKey) {
    return { ...base, action: 'skipped', error: 'no appfolio_id / appfolioIdType' };
  }

  const effectiveTag = shouldArchive(contact, nowIso) ? 'inactive' : contact.tag;
  const groupResourceName = groupMap[effectiveTag];
  if (!groupResourceName) {
    return { ...base, action: 'skipped', error: `no group for tag: ${effectiveTag}` };
  }

  const body = buildBody({ ...contact, tag: effectiveTag as typeof contact.tag }, groupResourceName);

  try {
    // 1. Namespaced key (normal daily-cron path after migration)
    let existing = index.get(compositeKey);

    // 2. Bare-key migration fallback — first contact to claim a bare ID wins.
    //    Subsequent contacts with the same number but different type skip the fallback
    //    and go to CREATE, producing separate Google Contacts (fixes 20 collision groups).
    if (!existing && contact.appfolioId) {
      const bareKey = contact.appfolioId;
      if (!claimedBareIds.has(bareKey) && index.has(bareKey)) {
        claimedBareIds.add(bareKey);
        existing = index.get(bareKey);
      }
    }

    if (existing) {
      const updateMask = 'names,phoneNumbers,emailAddresses,externalIds,biographies,memberships';
      let currentEtag = existing.etag;

      const attempt = await withRetry(async () => {
        const r = await fetch(
          `${PEOPLE_API}/${existing.resourceName}:updateContact?updatePersonFields=${updateMask}`,
          {
            method: 'PATCH',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ ...body, resourceName: existing.resourceName, etag: currentEtag }),
          },
        );
        if (r.status === 400) {
          // Stale etag — re-fetch current resource and retry once
          const fresh = await fetch(`${PEOPLE_API}/${existing.resourceName}?personFields=metadata`, {
            headers: { Authorization: `Bearer ${token}` },
          });
          if (fresh.ok) {
            const freshPerson = await fresh.json() as { etag?: string };
            if (freshPerson.etag) currentEtag = freshPerson.etag;
          }
        }
        return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() };
      });
      if (!attempt.ok) {
        return { ...base, action: 'updated', resourceName: existing.resourceName, error: `update failed: ${attempt.body}` };
      }
      return { ...base, action: 'updated', resourceName: existing.resourceName };
    } else {
      const attempt = await withRetry(async () => {
        const r = await fetch(`${PEOPLE_API}/people:createContact`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return { ok: r.ok, status: r.status, body: r.ok ? await r.json() : await r.text() };
      });
      if (!attempt.ok) {
        return { ...base, action: 'created', error: `create failed: ${attempt.body}` };
      }
      const created = attempt.body as { resourceName: string };
      return { ...base, action: 'created', resourceName: created.resourceName };
    }
  } catch (err) {
    return { ...base, action: 'skipped', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Batch upsert with rate-limit throttle
// ---------------------------------------------------------------------------

// Google People API: 90 critical reads + 90 critical writes per minute per user.
// Each createContact counts as both a read and a write, so effective limit is 90/min.
// 10 concurrent * 7s gap = 10/8s ≈ 75/min — safely under.
const BATCH_SIZE = 10;
const BATCH_DELAY_MS = 7000;

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function withRetry<T>(fn: () => Promise<{ ok: boolean; status: number; body: T | string }>, maxRetries = 5): Promise<{ ok: boolean; status: number; body: T | string }> {
  let delay = 8000;
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const res = await fn();
    if (res.status !== 429) return res;
    if (attempt === maxRetries - 1) return res;
    console.log(`[people-api] 429 rate limited — backoff ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
    await sleep(delay);
    delay = Math.min(delay * 2, 60_000);
  }
  return fn();
}

export async function syncContactsToGoogle(
  contacts: DerivedContact[],
  accessToken: string,
  nowIso: string,
): Promise<SyncReport> {
  // Ensure label groups exist
  const groupMap = await ensureContactGroups(accessToken);

  // Build index ONCE — the critical optimization
  console.log('[people-api] building externalId index from existing connections...');
  const index = await buildExternalIdIndex(accessToken);
  console.log(`[people-api] index built: ${index.size} existing AF-marked contacts`);

  // Tracks which bare numeric IDs have been claimed by a contact this run.
  // First contact to claim a bare key gets the migrate-in-place path;
  // subsequent contacts with the same number but different type go to CREATE.
  const claimedBareIds = new Set<string>();

  const report: SyncReport = { total: contacts.length, created: 0, updated: 0, archived: 0, skipped: 0, errors: 0, results: [] };

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((c) => upsertContact(accessToken, c, groupMap, index, claimedBareIds, nowIso)),
    );
    for (const r of results) {
      report.results.push(r);
      if (r.error) { report.errors++; continue; }
      if (r.action === 'created') report.created++;
      else if (r.action === 'updated') report.updated++;
      else if (r.action === 'archived') report.archived++;
      else report.skipped++;
    }
    if (i % (BATCH_SIZE * 5) === 0) {
      console.log(`[people-api] progress: ${i + batch.length}/${contacts.length} processed`);
    }
    if (i + BATCH_SIZE < contacts.length) await sleep(BATCH_DELAY_MS);
  }

  return report;
}

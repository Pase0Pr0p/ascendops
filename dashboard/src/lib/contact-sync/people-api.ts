/**
 * Google People API write layer.
 *
 * Upsert strategy:
 *   1. Search for existing contact by externalId (appfolio:{id}) — our marker.
 *   2. If found: PATCH (update) — never mutates manually-added contacts.
 *   3. If not found: POST (create) and add to the correct label group.
 *
 * Deploy gate: Albie must authorize People API write access on the
 * info@paseopropertymanagement.com Google Workspace account and provide
 * an OAuth2 refresh token or a service-account key with domain-wide delegation.
 *
 * Auth: pass a valid Bearer access_token obtained from the Google OAuth2 flow.
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

// Google Contact Group names — must exist in the info@ account (created on first sync)
const TAG_GROUP_NAMES: Record<string, string> = {
  'current-prospect': 'AF-Prospect',
  'future-tenant':    'AF-Future-Tenant',
  'current-tenant':   'AF-Tenant',
  'former-tenant':    'AF-Former-Tenant',
  'owner':            'AF-Owner',
  'vendor':           'AF-Vendor',
  'inactive':         'AF-Inactive',
};

interface ContactGroupMap { [tagName: string]: string } // tag → resourceName

// ---------------------------------------------------------------------------
// Contact Group bootstrap — ensure all label groups exist
// ---------------------------------------------------------------------------

async function ensureContactGroups(token: string): Promise<ContactGroupMap> {
  const res = await fetch(`${PEOPLE_API}/contactGroups?pageSize=200`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`contactGroups list failed: ${res.status}`);
  const { contactGroups = [] } = await res.json() as { contactGroups?: { resourceName: string; name: string }[] };

  const existing: ContactGroupMap = {};
  for (const g of contactGroups) {
    const tagEntry = Object.entries(TAG_GROUP_NAMES).find(([, name]) => name === g.name);
    if (tagEntry) existing[tagEntry[0]] = g.resourceName;
  }

  // Create any missing groups
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
// Find existing Google Contact by AppFolio externalId
// ---------------------------------------------------------------------------

async function findByExternalId(
  token: string,
  appfolioId: string,
): Promise<GoogleContactResource | null> {
  // People API doesn't support externalId search directly — search by name then filter,
  // OR store a known-contacts index in Supabase. For V1 we use a broader search and filter.
  // Pragmatic approach: use the contacts.list with readMask=externalIds and scan.
  // (Capped at 1000 per page — sufficient for Paseo's ~2344 contacts.)
  const res = await fetch(
    `${PEOPLE_API}/people/me/connections?personFields=externalIds,names,phoneNumbers&pageSize=1000`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) throw new Error(`connections list failed: ${res.status}`);
  const { connections = [] } = await res.json() as { connections?: GoogleContactResource[] };
  return connections.find((c) =>
    c.externalIds?.some((e) => e.type === EXTERNAL_ID_TYPE && e.value === appfolioId),
  ) ?? null;
}

// ---------------------------------------------------------------------------
// Build the People API body for a contact
// ---------------------------------------------------------------------------

function buildBody(contact: DerivedContact, groupResourceName: string): GoogleContactBody {
  const phones = [
    ...(contact.phoneE164 ? [{ value: contact.phoneE164, type: 'mobile' as const }] : []),
    ...contact.allPhones
      .filter((p) => p !== contact.phoneE164)
      .map((p) => ({ value: p, type: 'other' as const })),
  ];
  const emails = [
    ...(contact.primaryEmail ? [{ value: contact.primaryEmail, type: 'work' as const }] : []),
    ...contact.allEmails
      .filter((e) => e !== contact.primaryEmail)
      .map((e) => ({ value: e, type: 'other' as const })),
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
    externalIds: contact.appfolioId
      ? [{ type: EXTERNAL_ID_TYPE, value: contact.appfolioId }]
      : undefined,
    biographies: noteLines.length
      ? [{ value: noteLines.join('\n'), contentType: 'TEXT_PLAIN' }]
      : undefined,
    memberships: [{ contactGroupMembership: { contactGroupResourceName: groupResourceName } }],
  };
}

// ---------------------------------------------------------------------------
// Single contact upsert
// ---------------------------------------------------------------------------

async function upsertContact(
  token: string,
  contact: DerivedContact,
  groupMap: ContactGroupMap,
  nowIso: string,
): Promise<UpsertResult> {
  const base: Omit<UpsertResult, 'action'> = {
    appfolioId: contact.appfolioId,
    displayName: contact.displayName,
    resourceName: null,
    error: null,
  };

  // Apply lifecycle: prospect past 21 days → soft-archive to inactive
  const effectiveTag = shouldArchive(contact, nowIso) ? 'inactive' : contact.tag;
  const groupResourceName = groupMap[effectiveTag];
  if (!groupResourceName) {
    return { ...base, action: 'skipped', error: `no group for tag: ${effectiveTag}` };
  }

  const body = buildBody({ ...contact, tag: effectiveTag as typeof contact.tag }, groupResourceName);

  // Skip contacts with no AppFolio ID — we can't safely upsert without a stable key
  if (!contact.appfolioId) {
    return { ...base, action: 'skipped', error: 'no appfolio_id — cannot safely upsert' };
  }

  try {
    const existing = await findByExternalId(token, contact.appfolioId);

    if (existing) {
      // Update existing contact
      const updateMask = 'names,phoneNumbers,emailAddresses,externalIds,biographies,memberships';
      const res = await fetch(
        `${PEOPLE_API}/${existing.resourceName}:updateContact?updatePersonFields=${updateMask}`,
        {
          method: 'PATCH',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...body, resourceName: existing.resourceName, etag: existing.etag }),
        },
      );
      if (!res.ok) {
        const err = await res.text();
        return { ...base, action: 'updated', resourceName: existing.resourceName, error: `update failed: ${err}` };
      }
      return { ...base, action: 'updated', resourceName: existing.resourceName };
    } else {
      // Create new contact
      const res = await fetch(`${PEOPLE_API}/people:createContact`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.text();
        return { ...base, action: 'created', error: `create failed: ${err}` };
      }
      const created = await res.json() as { resourceName: string };
      return { ...base, action: 'created', resourceName: created.resourceName };
    }
  } catch (err) {
    return { ...base, action: 'skipped', error: String(err) };
  }
}

// ---------------------------------------------------------------------------
// Batch upsert with rate-limit throttle
// ---------------------------------------------------------------------------

const BATCH_SIZE = 20;
const BATCH_DELAY_MS = 500; // Google People API: 200 req/min per user

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export async function syncContactsToGoogle(
  contacts: DerivedContact[],
  accessToken: string,
  nowIso: string,
): Promise<SyncReport> {
  const groupMap = await ensureContactGroups(accessToken);

  const report: SyncReport = { total: contacts.length, created: 0, updated: 0, archived: 0, skipped: 0, errors: 0, results: [] };

  for (let i = 0; i < contacts.length; i += BATCH_SIZE) {
    const batch = contacts.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map((c) => upsertContact(accessToken, c, groupMap, nowIso)));
    for (const r of results) {
      report.results.push(r);
      if (r.error) { report.errors++; continue; }
      if (r.action === 'created') report.created++;
      else if (r.action === 'updated') report.updated++;
      else if (r.action === 'archived') report.archived++;
      else report.skipped++;
    }
    if (i + BATCH_SIZE < contacts.length) await sleep(BATCH_DELAY_MS);
  }

  return report;
}

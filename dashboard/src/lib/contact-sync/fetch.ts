import { getPaseoPool } from '../phone/pool';
import type { ContactSyncTag, DerivedContact } from './types';

interface ContactRow {
  id: string;
  contact_type: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  primary_phone_e164: string | null;
  all_phones: string[];
  primary_email: string | null;
  all_emails: string[];
  appfolio_tenant_id: string | null;
  appfolio_vendor_id: string | null;
  appfolio_owner_id: string | null;
  last_seen_at: string | null;
  occupancy_status: string | null;
  unit_name: string | null;
  property_name: string | null;
  property_address: string | null;
}

function deriveTag(row: ContactRow): ContactSyncTag {
  const ct = row.contact_type;
  if (ct === 'owner') return 'owner';
  if (ct === 'vendor') return 'vendor';
  // Tenant — derive from occupancy status (best/most-recent occupancy pre-selected in query)
  const status = row.occupancy_status;
  if (status === 'current' || status === 'notice') return 'current-tenant';
  if (status === 'future') return 'future-tenant';
  if (status === 'past') return 'former-tenant';
  // Tenant with no active occupancy (vacant or unknown) — treat as former-tenant
  return 'former-tenant';
}

/**
 * Fetch all Paseo contacts from Supabase with their occupancy/unit/property context.
 * Returns one row per contact (best occupancy pre-selected by priority).
 * current-prospect (applicants) is STUBBED — not yet in Supabase; Albie to add later.
 */
export async function fetchAllContacts(): Promise<DerivedContact[]> {
  const pool = getPaseoPool();

  // Each contact joined to their single best active occupancy.
  // DISTINCT ON (c.id) picks the highest-priority occupancy per contact.
  const { rows } = await pool.query<ContactRow>(`
    SELECT DISTINCT ON (c.id)
      c.id,
      c.contact_type::text,
      c.display_name,
      c.first_name,
      c.last_name,
      c.company_name,
      c.primary_phone_e164,
      c.all_phones,
      c.primary_email,
      c.all_emails,
      c.appfolio_tenant_id,
      c.appfolio_vendor_id,
      c.appfolio_owner_id,
      c.last_seen_at::text,
      o.status::text AS occupancy_status,
      u.unit_name,
      p.name          AS property_name,
      p.address_full  AS property_address
    FROM contacts c
    LEFT JOIN occupancies o ON o.primary_tenant_id = c.id
    LEFT JOIN units u       ON u.id = o.unit_id
    LEFT JOIN properties p  ON p.id = u.property_id
    WHERE
      -- Must have at least one contact method so Google Contacts is useful
      (c.primary_phone_e164 IS NOT NULL OR c.primary_email IS NOT NULL)
    ORDER BY
      c.id,
      -- Prefer active/upcoming occupancy over past
      CASE o.status::text
        WHEN 'current' THEN 0
        WHEN 'notice'  THEN 1
        WHEN 'future'  THEN 2
        WHEN 'past'    THEN 3
        ELSE 4
      END,
      o.lease_from DESC NULLS LAST
  `);

  return rows.map((row) => {
    const appfolioId =
      row.appfolio_tenant_id ?? row.appfolio_vendor_id ?? row.appfolio_owner_id ?? null;
    const appfolioIdType = row.appfolio_tenant_id
      ? 'tenant'
      : row.appfolio_vendor_id
        ? 'vendor'
        : row.appfolio_owner_id
          ? 'owner'
          : null;

    return {
      supabaseId: row.id,
      appfolioId,
      appfolioIdType,
      displayName: row.display_name ?? 'Unknown',
      firstName: row.first_name,
      lastName: row.last_name,
      companyName: row.company_name,
      phoneE164: row.primary_phone_e164,
      allPhones: row.all_phones ?? [],
      primaryEmail: row.primary_email,
      allEmails: row.all_emails ?? [],
      tag: deriveTag(row),
      unitName: row.unit_name,
      propertyName: row.property_name,
      propertyAddress: row.property_address,
      lastSeenAt: row.last_seen_at,
      occupancyStatus: row.occupancy_status,
    } satisfies DerivedContact;
  });
}

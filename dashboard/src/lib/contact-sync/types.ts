// ---------------------------------------------------------------------------
// Contact sync tags — map to Google Contact labels
// ---------------------------------------------------------------------------

export type ContactSyncTag =
  | 'current-prospect'  // active applicant — STUB: requires Albie to add applicants table to Supabase
  | 'future-tenant'     // occupancy.status = 'future' — EXEMPT from 21-day drop
  | 'current-tenant'    // occupancy.status = 'current' or 'notice'
  | 'former-tenant'     // occupancy.status = 'past' with no current/future occupancy
  | 'owner'             // contact_type = 'owner'
  | 'vendor'            // contact_type = 'vendor'
  | 'inactive';         // soft-archived prospects awaiting purge

// ---------------------------------------------------------------------------
// Derived contact shape — output of fetch + transform
// ---------------------------------------------------------------------------

export interface DerivedContact {
  // Supabase identity
  supabaseId: string;
  // AppFolio identity (used as upsert key in Google Contacts)
  appfolioId: string | null;          // first non-null of tenant/vendor/owner id
  appfolioIdType: 'tenant' | 'vendor' | 'owner' | null;

  // People data
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  companyName: string | null;
  phoneE164: string | null;
  allPhones: string[];
  primaryEmail: string | null;
  allEmails: string[];

  // Tag derived from occupancy + contact_type
  tag: ContactSyncTag;

  // Unit/property context (written to Google Contact notes)
  unitName: string | null;
  propertyName: string | null;
  propertyAddress: string | null;

  // Lifecycle
  lastSeenAt: string | null;          // ISO — used for 21-day drop check on prospects
  occupancyStatus: string | null;
}

// ---------------------------------------------------------------------------
// Lifecycle rules
// ---------------------------------------------------------------------------

export const PROSPECT_DROP_DAYS = 21;

/** Returns true if this contact should be soft-archived to 'inactive'. */
export function shouldArchive(contact: DerivedContact, nowIso: string): boolean {
  if (contact.tag !== 'current-prospect') return false;
  if (!contact.lastSeenAt) return true;
  const ageMs = new Date(nowIso).getTime() - new Date(contact.lastSeenAt).getTime();
  return ageMs > PROSPECT_DROP_DAYS * 86_400_000;
}

// ---------------------------------------------------------------------------
// Google People API types
// ---------------------------------------------------------------------------

export interface GoogleContactName {
  givenName?: string;
  familyName?: string;
  displayName?: string;
}

export interface GoogleContactPhone {
  value: string;
  type?: 'mobile' | 'home' | 'work' | 'other';
}

export interface GoogleContactEmail {
  value: string;
  type?: 'home' | 'work' | 'other';
}

export interface GoogleContactExternalId {
  value: string;
  type: string;   // 'appfolio' — marks this contact as ours
}

export interface GoogleContactBiography {
  value: string;
  contentType: 'TEXT_PLAIN';
}

export interface GoogleContactMembership {
  contactGroupMembership: { contactGroupResourceName: string };
}

export interface GoogleContactBody {
  names?: GoogleContactName[];
  phoneNumbers?: GoogleContactPhone[];
  emailAddresses?: GoogleContactEmail[];
  externalIds?: GoogleContactExternalId[];
  biographies?: GoogleContactBiography[];
  memberships?: GoogleContactMembership[];
}

export interface GoogleContactResource extends GoogleContactBody {
  resourceName: string;
  etag: string;
}

export type UpsertAction = 'created' | 'updated' | 'skipped' | 'archived';

export interface UpsertResult {
  appfolioId: string | null;
  displayName: string;
  action: UpsertAction;
  resourceName: string | null;
  error: string | null;
}

export interface SyncReport {
  total: number;
  created: number;
  updated: number;
  archived: number;
  skipped: number;
  errors: number;
  results: UpsertResult[];
}

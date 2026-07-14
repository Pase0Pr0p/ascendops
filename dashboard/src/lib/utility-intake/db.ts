/**
 * Supabase REST write layer for utility_bills intake.
 * Uses service_role key for RLS bypass (same key as pge-bills pipeline).
 * PostgREST API — no SDK, just fetch.
 *
 * Required env vars:
 *   SUPABASE_URL             — https://fqjtsfjskqortayrmypp.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service_role JWT (bypasses RLS; NOT the anon key)
 */

export interface UtilityProvider {
  id: string;
  name: string;
  slug: string;
  acquisition_method: string | null;
}

function supabaseHeaders(): Record<string, string> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  return {
    'Content-Type': 'application/json',
    apikey: key,
    Authorization: `Bearer ${key}`,
    Prefer: 'return=representation',
  };
}

function restUrl(table: string): string {
  const url = process.env.SUPABASE_URL;
  if (!url) throw new Error('SUPABASE_URL must be set');
  return `${url}/rest/v1/${table}`;
}

// Normalize for alias matching: lowercase + trim + collapse internal whitespace
function normalizeAlias(s: string): string {
  return s.toLowerCase().trim().replace(/\s+/g, ' ');
}

// Look up provider via utility_provider_aliases (Anna's seed, source of truth).
// Normalizes both the incoming hint and alias_raw before comparing — no hardcoded slug map.
export async function lookupProvider(providerHint: string | null): Promise<UtilityProvider | null> {
  if (!providerHint) return null;
  const normalizedHint = normalizeAlias(providerHint);
  const headers = supabaseHeaders();

  // Fetch all aliases (small table — normalize + match client-side)
  const aliasRes = await fetch(`${restUrl('utility_provider_aliases')}?select=alias_raw,provider_id`, { headers });
  if (!aliasRes.ok) {
    console.warn(`[utility-intake/db] alias fetch failed (${aliasRes.status}): ${await aliasRes.text()}`);
    return null;
  }
  const aliases = await aliasRes.json() as Array<{ alias_raw: string; provider_id: string }>;

  // Match: normalized alias_raw must be contained in (or contain) the normalized hint
  const match = aliases.find((a) => {
    const normalized = normalizeAlias(a.alias_raw);
    return normalizedHint.includes(normalized) || normalized.includes(normalizedHint);
  });
  if (!match) return null;

  // Fetch the provider row by UUID
  const provRes = await fetch(
    `${restUrl('utility_providers')}?id=eq.${match.provider_id}&select=id,name,slug,acquisition_method&limit=1`,
    { headers },
  );
  if (!provRes.ok) {
    console.warn(`[utility-intake/db] provider fetch failed (${provRes.status}): ${await provRes.text()}`);
    return null;
  }
  const providers = await provRes.json() as UtilityProvider[];
  return providers[0] ?? null;
}

// Returns true if a bill with this pdf_hash OR bill_hash already exists
export async function checkDedup(pdfHash: string | null, billHash: string | null): Promise<boolean> {
  if (!pdfHash && !billHash) return false;

  const headers = supabaseHeaders();
  const checks: Promise<boolean>[] = [];

  if (pdfHash) {
    checks.push(
      fetch(`${restUrl('utility_bills')}?pdf_hash=eq.${pdfHash}&select=id&limit=1`, { headers })
        .then((r) => r.ok ? r.json() as Promise<unknown[]> : Promise.resolve([]))
        .then((rows) => (rows as unknown[]).length > 0),
    );
  }
  if (billHash) {
    checks.push(
      fetch(`${restUrl('utility_bills')}?bill_hash=eq.${billHash}&select=id&limit=1`, { headers })
        .then((r) => r.ok ? r.json() as Promise<unknown[]> : Promise.resolve([]))
        .then((rows) => (rows as unknown[]).length > 0),
    );
  }

  const results = await Promise.all(checks);
  return results.some(Boolean);
}

export interface BillInsertData {
  provider_id: string | null;
  account_number: string | null;
  pdf_hash: string | null;
  bill_hash: string | null;
  period_start: string | null;
  period_end: string | null;
  amount_due: number | null;     // dollar decimal (e.g. 150.25) — matches existing numeric column
  delivery_channel: string;
  source_email_id: string;
  flag_type: string | null;
}

// Insert a new utility_bill row. Returns the new row's UUID.
export async function insertBill(data: BillInsertData): Promise<string> {
  const body = {
    ...(data.provider_id ? { provider_id: data.provider_id } : {}),
    ...(data.account_number ? { account_number: data.account_number } : {}),
    ...(data.pdf_hash ? { pdf_hash: data.pdf_hash } : {}),
    ...(data.bill_hash ? { bill_hash: data.bill_hash } : {}),
    ...(data.period_start ? { period_start: data.period_start } : {}),
    ...(data.period_end ? { period_end: data.period_end } : {}),
    ...(data.amount_due != null ? { amount_due: data.amount_due } : {}),
    delivery_channel: data.delivery_channel,
    source_email_id: data.source_email_id,
    ...(data.flag_type ? { flag_type: data.flag_type } : {}),
  };

  const res = await fetch(restUrl('utility_bills'), {
    method: 'POST',
    headers: supabaseHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`insertBill failed (${res.status}): ${errText}`);
  }

  const rows = await res.json() as Array<{ id: string }>;
  const id = rows[0]?.id;
  if (!id) throw new Error('insertBill: no id returned');
  return id;
}

// Update an existing bill after Telegram approval
export async function approveBill(billId: string, approvedBy: string): Promise<void> {
  const res = await fetch(`${restUrl('utility_bills')}?id=eq.${billId}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      approved_by: approvedBy,
      approved_at: new Date().toISOString(),
      flag_type: null,
    }),
  });
  if (!res.ok) throw new Error(`approveBill ${billId} failed (${res.status}): ${await res.text()}`);
}

export async function rejectBill(billId: string, rejectedBy: string): Promise<void> {
  const res = await fetch(`${restUrl('utility_bills')}?id=eq.${billId}`, {
    method: 'PATCH',
    headers: supabaseHeaders(),
    body: JSON.stringify({
      approved_by: rejectedBy,
      approved_at: new Date().toISOString(),
      flag_type: 'REJECTED',
    }),
  });
  if (!res.ok) throw new Error(`rejectBill ${billId} failed (${res.status}): ${await res.text()}`);
}

// Fetch a bill row by ID (for use at approval callback time)
export async function getBill(billId: string): Promise<{ source_email_id: string; account_number: string | null; period_start: string | null; provider_id: string | null } | null> {
  const res = await fetch(
    `${restUrl('utility_bills')}?id=eq.${billId}&select=source_email_id,account_number,period_start,provider_id&limit=1`,
    { headers: supabaseHeaders() },
  );
  if (!res.ok) return null;
  const rows = await res.json() as Array<{ source_email_id: string; account_number: string | null; period_start: string | null; provider_id: string | null }>;
  return rows[0] ?? null;
}

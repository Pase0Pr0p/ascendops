/**
 * Scoped emit for pre-approved bill IDs — bypasses pipeline dedup gate.
 * Use ONLY for rows already inserted by a STUB_EMIT run that Albie has authorized.
 *
 * Safety: per-bill amount check before each send.
 * Ledger-first: reserve (epoch sentinel) → send → stamp (real timestamp + message_id).
 *
 * AppFolio intake target: paseoproperties@invoices.appfolio.com
 *
 * Usage:
 *   npx tsx scripts/targeted-emit.ts e21c7d0f-... 59dff3e6-... 9a099cbc-...
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const APPFOLIO_INTAKE_EMAIL = 'paseoproperties@invoices.appfolio.com';
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? '';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signRs256(data: string, key: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function log(msg: string) { console.log(`[targeted-emit ${new Date().toISOString()}] ${msg}`); }

interface SA { client_email: string; private_key: string }

async function mintToken(saKeyPath: string, scope: string, subject?: string): Promise<string> {
  const sa: SA = JSON.parse(readFileSync(resolve(process.cwd(), saKeyPath), 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims: Record<string, string | number> = { iss: sa.client_email, scope, aud: TOKEN_ENDPOINT, iat: now, exp: now + 3600 };
  if (subject) claims['sub'] = subject;
  const payload = b64url(JSON.stringify(claims));
  const assertion = `${header}.${payload}.${signRs256(`${header}.${payload}`, sa.private_key)}`;
  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Token mint failed (${res.status}): ${await res.text()}`);
  const { access_token, error } = await res.json() as { access_token?: string; error?: string };
  if (!access_token) throw new Error(`No access_token: ${error}`);
  return access_token;
}

interface BillRow {
  id: string;
  account_number: string;
  statement_date: string;
  amount_due: number;
  drive_file_id: string | null;
  original_filename: string;
  provider_id: string;
  submitted_to_appfolio_at: string | null;
}

async function fetchBill(billId: string): Promise<BillRow> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/utility_bills?id=eq.${billId}&select=id,account_number,statement_date,amount_due,drive_file_id,original_filename,provider_id,submitted_to_appfolio_at`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!res.ok) throw new Error(`DB fetch failed (${res.status}): ${await res.text()}`);
  const rows = await res.json() as BillRow[];
  if (!rows.length) throw new Error(`Bill ${billId} not found`);
  return rows[0];
}

async function downloadFromDrive(driveToken: string, fileId: string): Promise<Buffer> {
  const res = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
    { headers: { Authorization: `Bearer ${driveToken}` } },
  );
  if (!res.ok) throw new Error(`Drive download failed (${res.status}): ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

async function reserveRow(billId: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/utility_bills?id=eq.${billId}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ submitted_to_appfolio_at: '1970-01-01T00:00:00.000Z' }),
  });
  if (!res.ok) throw new Error(`reserve ${billId} failed (${res.status}): ${await res.text()}`);
}

async function stampRow(billId: string, msgId: string): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/utility_bills?id=eq.${billId}`, {
    method: 'PATCH',
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ submitted_to_appfolio_at: new Date().toISOString(), appfolio_message_id: msgId }),
  });
  if (!res.ok) throw new Error(`stamp ${billId} failed (${res.status}): ${await res.text()}`);
}

async function sendToAppFolio(
  gmailToken: string,
  pdfBuf: Buffer,
  pdfFilename: string,
  subject: string,
  bodyText: string,
): Promise<string> {
  const boundary = `boundary_${Date.now()}`;
  const fromAddr = process.env.GOOGLE_UTILITY_BILLS_SUBJECT ?? 'utility-bills@paseoproperties.com';
  const pdfB64 = pdfBuf.toString('base64');
  const raw = [
    `From: ${fromAddr}`,
    `To: ${APPFOLIO_INTAKE_EMAIL}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    '',
    bodyText,
    '',
    `--${boundary}`,
    `Content-Type: application/pdf; name="${pdfFilename}"`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: attachment; filename="${pdfFilename}"`,
    '',
    pdfB64,
    '',
    `--${boundary}--`,
  ].join('\r\n');
  const encoded = Buffer.from(raw).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(`${GMAIL_API}/messages/send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gmailToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!res.ok) throw new Error(`Gmail send failed (${res.status}): ${await res.text()}`);
  const body = await res.json() as { id: string };
  return body.id;
}

// Per-bill safety check — aborts if amount looks wrong
function safetyCheck(bill: BillRow, label: string): void {
  // Bay Cities Refuse: amount_due must be current charge (291.15), not account balance (582.30)
  if (bill.account_number === '01-3286 1') {
    if (Math.abs(bill.amount_due - 291.15) > 0.01) {
      throw new Error(`SAFETY ABORT ${label}: Bay Cities amount_due=${bill.amount_due} expected 291.15 (current charge only). Check for account balance contamination.`);
    }
    log(`  [SAFETY] Bay Cities Refuse: amount_due=${bill.amount_due} == 291.15 ✓`);
  }
  // All bills: reject negative or zero
  if (bill.amount_due <= 0) {
    throw new Error(`SAFETY ABORT ${label}: amount_due=${bill.amount_due} is zero or negative — would be a credit/zero bill`);
  }
  // All bills: reject if already stamped (non-epoch submitted_to_appfolio_at)
  if (bill.submitted_to_appfolio_at && bill.submitted_to_appfolio_at !== '1970-01-01T00:00:00+00:00') {
    throw new Error(`SAFETY ABORT ${label}: already stamped (submitted_to_appfolio_at=${bill.submitted_to_appfolio_at})`);
  }
}

async function emitOne(
  billId: string,
  gmailToken: string,
  driveToken: string,
  providerName: string,
): Promise<{ billId: string; msgId: string; amountDue: number }> {
  const bill = await fetchBill(billId);
  log(`  Bill ${billId}: account=${bill.account_number} stmt=${bill.statement_date} amount_due=${bill.amount_due}`);

  safetyCheck(bill, billId);

  if (!bill.drive_file_id) throw new Error(`Bill ${billId} has no drive_file_id — cannot fetch PDF`);

  log(`  Downloading PDF from Drive (file_id=${bill.drive_file_id})...`);
  const pdfBuf = await downloadFromDrive(driveToken, bill.drive_file_id);
  log(`  Downloaded ${pdfBuf.length} bytes`);

  const subject = `${providerName} bill ${bill.account_number} statement ${bill.statement_date}`;
  const bodyText = `${providerName} utility bill — account ${bill.account_number}, statement ${bill.statement_date}`;

  // Ledger-first: reserve → send → stamp
  log(`  Reserving (epoch sentinel)...`);
  await reserveRow(billId);

  log(`  Sending to ${APPFOLIO_INTAKE_EMAIL}...`);
  const msgId = await sendToAppFolio(gmailToken, pdfBuf, bill.original_filename, subject, bodyText);
  log(`  Sent — gmail_msg_id=${msgId}`);

  log(`  Stamping submitted_to_appfolio_at=now() + appfolio_message_id=${msgId}...`);
  await stampRow(billId, msgId);

  return { billId, msgId, amountDue: bill.amount_due };
}

async function fetchProviderName(providerId: string): Promise<string> {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/utility_providers?id=eq.${providerId}&select=name`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!res.ok) return 'Unknown Provider';
  const rows = await res.json() as Array<{ name: string }>;
  return rows[0]?.name ?? 'Unknown Provider';
}

async function main() {
  const billIds = process.argv.slice(2);
  if (!billIds.length) {
    console.error('Usage: npx tsx scripts/targeted-emit.ts <bill-id> [bill-id ...]');
    process.exit(1);
  }

  // Hard guard: City of Petaluma Water must never ride this emit
  const PETALUMA_ID = 'e059a057-b79a-433f-9a23-4854811311eb';
  if (billIds.includes(PETALUMA_ID)) {
    console.error(`ABORT: ${PETALUMA_ID} (City of Petaluma Water) is in the list — manually submitted by Albie, must NEVER emit via pipeline.`);
    process.exit(1);
  }

  log(`Targeted emit — ${billIds.length} bill(s)`);
  log(`AppFolio intake target: ${APPFOLIO_INTAKE_EMAIL}`);

  const saKeyPath = process.env.GOOGLE_CONTACTS_SA_KEY_PATH ?? '';
  const pgeKeyPath = process.env.PGE_SA_KEY_PATH ?? resolve(process.cwd(), '../../paseo/pge-bills/service_account.json');
  const subject = process.env.GOOGLE_UTILITY_BILLS_SUBJECT ?? 'utility-bills@paseoproperties.com';

  log(`Minting Gmail token (DWD as ${subject})...`);
  const gmailToken = await mintToken(saKeyPath, GMAIL_SCOPES, subject);
  log('Gmail token minted');

  log('Minting Drive token (pge-bills SA)...');
  const driveToken = await mintToken(pgeKeyPath, DRIVE_SCOPE);
  log('Drive token minted');

  const results: Array<{ billId: string; msgId: string; amountDue: number }> = [];
  const failures: Array<{ billId: string; error: string }> = [];

  for (const billId of billIds) {
    log(`\n--- Emitting ${billId} ---`);
    try {
      // Fetch bill to get provider name
      const bill = await fetchBill(billId);
      const providerName = await fetchProviderName(bill.provider_id);
      const result = await emitOne(billId, gmailToken, driveToken, providerName);
      results.push(result);
      log(`  DONE: ${billId} → gmail_msg_id=${result.msgId} amount=$${result.amountDue}`);
    } catch (err) {
      const msg = String(err);
      log(`  FAILED: ${billId} — ${msg}`);
      failures.push({ billId, error: msg });
    }
  }

  log('\n=== SUMMARY ===');
  log(`Emitted: ${results.length}`);
  for (const r of results) {
    log(`  ${r.billId}: gmail_msg_id=${r.msgId} amount=$${r.amountDue}`);
  }
  if (failures.length) {
    log(`Failed: ${failures.length}`);
    for (const f of failures) {
      log(`  ${f.billId}: ${f.error}`);
    }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[targeted-emit] fatal:', err);
  process.exit(1);
});

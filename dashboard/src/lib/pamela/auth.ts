/**
 * Google DWD token minter for Pamela.
 * Reuses the existing contacts-sync SA key — Rob must authorize the new scopes
 * in Workspace Admin console (admin.google.com → Security → API controls → DWD).
 *
 * Required env vars (already in secrets.env):
 *   GOOGLE_CONTACTS_SA_KEY_PATH  — path to SA JSON key (gitignored, chmod 600)
 *   PAMELA_GMAIL_SUBJECT         — Rob@paseopropertymanagement.com
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function b64url(s: string): string {
  return Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signRs256(data: string, key: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  return signer.sign(key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const ALLOWED_SCOPES = new Set([GMAIL_SCOPE, CALENDAR_SCOPE]);
const REQUIRED_SUBJECT = 'rob@paseopropertymanagement.com';

export async function mintPamelaToken(scope: string): Promise<string> {
  // [fix-1] Scope allowlist: reject anything not exactly gmail.readonly or calendar.readonly.
  // Prevents callers from minting DWD tokens for broader scopes on this SA.
  if (!ALLOWED_SCOPES.has(scope)) {
    throw new Error(`mintPamelaToken: scope not allowed: ${scope}`);
  }

  const keyPath = process.env.GOOGLE_CONTACTS_SA_KEY_PATH;
  const rawSubject = process.env.PAMELA_GMAIL_SUBJECT;
  if (!keyPath || !rawSubject) {
    throw new Error('GOOGLE_CONTACTS_SA_KEY_PATH and PAMELA_GMAIL_SUBJECT must be set');
  }

  // [fix-2] Subject exact-match: normalize and fail closed. The sub claim in the DWD JWT
  // determines which Workspace account the SA impersonates. Any value other than Rob's
  // mailbox must be rejected — a mis-set env var must not silently impersonate another user.
  const subject = rawSubject.trim().toLowerCase();
  if (subject !== REQUIRED_SUBJECT) {
    throw new Error(`mintPamelaToken: subject must be ${REQUIRED_SUBJECT}, got: ${subject}`);
  }

  const sa: ServiceAccountKey = JSON.parse(readFileSync(resolve(process.cwd(), keyPath), 'utf8'));
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: sa.client_email,
    sub: subject,
    scope,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const assertion = `${header}.${payload}.${signRs256(`${header}.${payload}`, sa.private_key)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token mint failed (${res.status}): ${err}`);
  }

  const { access_token, error } = await res.json() as { access_token?: string; error?: string };
  if (!access_token) throw new Error(`No access_token: ${error}`);
  return access_token;
}

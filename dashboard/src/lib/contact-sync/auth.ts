/**
 * Google Service Account JWT token mint for domain-wide delegation (DWD).
 * No external dependencies — uses Node.js built-in crypto.
 *
 * Required env vars (set in secrets.env):
 *   GOOGLE_CONTACTS_SA_KEY_PATH  — path to SA JSON key (gitignored, chmod 600)
 *   GOOGLE_CONTACTS_SUBJECT      — info@paseopropertymanagement.com
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
}

function b64url(str: string): string {
  return Buffer.from(str).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function signRs256(data: string, privateKey: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(data);
  const sig = signer.sign(privateKey, 'base64');
  return sig.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Mint a short-lived Google OAuth2 access token via SA + DWD.
 * Returns the access_token string valid for ~1 hour.
 */
export async function mintGoogleAccessToken(): Promise<string> {
  const keyPath = process.env.GOOGLE_CONTACTS_SA_KEY_PATH;
  const subject = process.env.GOOGLE_CONTACTS_SUBJECT;
  if (!keyPath || !subject) {
    throw new Error('GOOGLE_CONTACTS_SA_KEY_PATH and GOOGLE_CONTACTS_SUBJECT must be set');
  }

  const saKey: ServiceAccountKey = JSON.parse(
    readFileSync(resolve(process.cwd(), keyPath), 'utf8'),
  );

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: saKey.client_email,
    sub: subject,
    scope: CONTACTS_SCOPE,
    aud: TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const assertion = `${unsigned}.${signRs256(unsigned, saKey.private_key)}`;

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Token mint failed (${res.status}): ${err}`);
  }

  const { access_token, error } = await res.json() as { access_token?: string; error?: string };
  if (!access_token) throw new Error(`No access_token in response: ${error}`);
  return access_token;
}

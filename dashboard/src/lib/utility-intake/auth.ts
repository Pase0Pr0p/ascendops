/**
 * Gmail token mint for utility-bills@paseoproperties.com via domain-wide delegation.
 * Uses the same SA key as contacts-sync (GOOGLE_CONTACTS_SA_KEY_PATH) with Gmail scopes.
 *
 * Required env vars:
 *   GOOGLE_CONTACTS_SA_KEY_PATH — path to SA JSON key (reused from contacts-sync)
 *   GOOGLE_UTILITY_BILLS_SUBJECT — utility-bills@paseoproperties.com
 */

import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GMAIL_SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.send',
].join(' ');

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
  return signer.sign(privateKey, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function mintGmailToken(): Promise<string> {
  const keyPath = process.env.GOOGLE_CONTACTS_SA_KEY_PATH;
  const subject = process.env.GOOGLE_UTILITY_BILLS_SUBJECT;
  if (!keyPath || !subject) {
    throw new Error('GOOGLE_CONTACTS_SA_KEY_PATH and GOOGLE_UTILITY_BILLS_SUBJECT must be set');
  }

  const saKey: ServiceAccountKey = JSON.parse(
    readFileSync(resolve(process.cwd(), keyPath), 'utf8'),
  );

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({
    iss: saKey.client_email,
    sub: subject,
    scope: GMAIL_SCOPES,
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
    throw new Error(`Gmail token mint failed (${res.status}): ${await res.text()}`);
  }

  const { access_token, error } = await res.json() as { access_token?: string; error?: string };
  if (!access_token) throw new Error(`No access_token in response: ${error}`);
  return access_token;
}

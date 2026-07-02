import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

if (process.env.GOOGLE_CONTACTS_SA_KEY_PATH && !process.env.GOOGLE_CONTACTS_SA_KEY_PATH.startsWith('/')) {
  process.env.GOOGLE_CONTACTS_SA_KEY_PATH = resolve(process.cwd(), '..', process.env.GOOGLE_CONTACTS_SA_KEY_PATH);
}

import { mintGoogleAccessToken } from '../src/lib/contact-sync/auth';

async function main() {
  const token = await mintGoogleAccessToken();
  let total = 0, afMarked = 0;
  let pageToken: string | undefined;
  let page = 0;
  do {
    const url = new URL('https://people.googleapis.com/v1/people/me/connections');
    url.searchParams.set('personFields', 'externalIds,phoneNumbers');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as { connections?: any[]; nextPageToken?: string; totalPeople?: number };
    const conns = body.connections ?? [];
    total += conns.length;
    afMarked += conns.filter((c: any) => c.externalIds?.some((e: any) => e.type === 'appfolio')).length;
    pageToken = body.nextPageToken;
    page++;
  } while (pageToken);
  console.log(`Total connections in info@: ${total}`);
  console.log(`AF-marked (our contacts):   ${afMarked}`);
}
main().catch((err) => { console.error(err); process.exit(1); });

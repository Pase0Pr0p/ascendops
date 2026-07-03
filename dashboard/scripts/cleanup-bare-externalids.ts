/**
 * Cleanup script: delete Google Contacts still carrying a bare numeric appfolio externalId
 * (i.e. value has no ":" — these are orphan duplicates from the pre-migration runs).
 *
 * After migration pass 3, all legitimate contacts should have "tenant:X" / "vendor:X" / "owner:X".
 * Any contact still carrying bare "353" etc. is a duplicate that was not reached by the migration.
 *
 * DRY RUN by default. Pass --live to actually delete.
 */
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

if (process.env.GOOGLE_CONTACTS_SA_KEY_PATH && !process.env.GOOGLE_CONTACTS_SA_KEY_PATH.startsWith('/')) {
  process.env.GOOGLE_CONTACTS_SA_KEY_PATH = resolve(process.cwd(), '..', process.env.GOOGLE_CONTACTS_SA_KEY_PATH);
}

import { mintGoogleAccessToken } from '../src/lib/contact-sync/auth';

const PEOPLE_API = 'https://people.googleapis.com/v1';
const EXTERNAL_ID_TYPE = 'appfolio';
const LIVE = process.argv.includes('--live');

function sleep(ms: number) { return new Promise<void>((r) => setTimeout(r, ms)); }

async function main() {
  const token = await mintGoogleAccessToken();

  // Collect all contacts with bare numeric appfolio externalId
  const bare: { resourceName: string; displayName: string; bareId: string }[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    const url = new URL(`${PEOPLE_API}/people/me/connections`);
    url.searchParams.set('personFields', 'externalIds,names');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`list failed: ${res.status} ${await res.text()}`);
    const body = await res.json() as { connections?: any[]; nextPageToken?: string };
    for (const c of body.connections ?? []) {
      const afId = c.externalIds?.find((e: any) => e.type === EXTERNAL_ID_TYPE)?.value;
      if (afId && !afId.includes(':')) {
        // Bare numeric ID — orphan duplicate
        bare.push({
          resourceName: c.resourceName,
          displayName: c.names?.[0]?.displayName ?? '(unnamed)',
          bareId: afId,
        });
      }
    }
    pageToken = body.nextPageToken;
    page++;
  } while (pageToken);

  console.log(`Found ${bare.length} contacts with bare appfolio externalId (orphan duplicates)`);
  bare.slice(0, 10).forEach(c => console.log(`  ${c.resourceName} "${c.displayName}" bareId=${c.bareId}`));
  if (bare.length > 10) console.log(`  ... and ${bare.length - 10} more`);

  if (!LIVE) {
    console.log('\nDRY RUN — pass --live to delete. No changes made.');
    return;
  }

  console.log('\nDeleting...');
  let deleted = 0, errors = 0;
  for (let i = 0; i < bare.length; i++) {
    const c = bare[i];
    const res = await fetch(`${PEOPLE_API}/${c.resourceName}:deleteContact`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.ok || res.status === 204) {
      deleted++;
    } else {
      console.error(`  FAILED to delete ${c.resourceName}: ${res.status} ${await res.text()}`);
      errors++;
    }
    // Stay under rate limit: ~1 delete/700ms = 85/min
    await sleep(700);
    if ((i + 1) % 20 === 0) console.log(`  ${i + 1}/${bare.length} processed`);
  }

  console.log(`\nDone: deleted=${deleted} errors=${errors}`);
}

main().catch((err) => { console.error(err); process.exit(1); });

#!/usr/bin/env node
/**
 * Contact sync dry-run runner.
 * Usage: npx tsx scripts/contact-sync-dry-run.ts
 *
 * Reads GOOGLE_CONTACTS_SA_KEY_PATH + GOOGLE_CONTACTS_SUBJECT from env.
 * With dryRun:true the People API is never called — just fetch + transform.
 */

import 'dotenv/config';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

// Load dashboard .env.local + secrets.env
dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

import { runContactSync } from '../src/lib/contact-sync/sync';

async function main() {
  console.log('[dry-run] starting contact sync dry-run...');

  const report = await runContactSync({
    accessToken: 'dry-run-token-unused',
    dryRun: true,
  });

  console.log('\n=== DRY-RUN REPORT ===');
  console.log(`Total contacts fetched:  ${report.total}`);
  console.log(`Would create:  ${report.created}`);
  console.log(`Would update:  ${report.updated}`);
  console.log(`Would archive: ${report.archived}`);
  console.log(`Would skip:    ${report.skipped}`);
  console.log(`Errors:        ${report.errors}`);

  // Tag breakdown from the skipped results (dry-run sets action=skipped for all)
  // Re-fetch to get tag breakdown from the fetch layer output
  console.log('\n(tag breakdown logged above by sync.ts)');
  process.exit(0);
}

main().catch((err) => { console.error('[dry-run] FAILED:', err); process.exit(1); });

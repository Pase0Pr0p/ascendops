#!/usr/bin/env node
/**
 * Contact sync LIVE runner — pushes to Google Contacts (info@).
 * Usage: npx tsx scripts/contact-sync-run.ts
 * Rob-approved go required before running. Do NOT run without chief/Rob confirmation.
 */

import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

// SA key path in secrets.env is relative to monorepo root — resolve to absolute
if (process.env.GOOGLE_CONTACTS_SA_KEY_PATH && !process.env.GOOGLE_CONTACTS_SA_KEY_PATH.startsWith('/')) {
  process.env.GOOGLE_CONTACTS_SA_KEY_PATH = resolve(process.cwd(), '..', process.env.GOOGLE_CONTACTS_SA_KEY_PATH);
}

import { mintGoogleAccessToken } from '../src/lib/contact-sync/auth';
import { runContactSync } from '../src/lib/contact-sync/sync';

async function main() {
  console.log('[live-sync] minting Google access token...');
  const accessToken = await mintGoogleAccessToken();
  console.log('[live-sync] token minted, starting sync (dryRun:false)...');

  const report = await runContactSync({ accessToken, dryRun: false });

  console.log('\n=== LIVE SYNC REPORT ===');
  console.log(`Total:    ${report.total}`);
  console.log(`Created:  ${report.created}`);
  console.log(`Updated:  ${report.updated}`);
  console.log(`Archived: ${report.archived}`);
  console.log(`Skipped:  ${report.skipped}`);
  console.log(`Errors:   ${report.errors}`);

  if (report.errors > 0) {
    console.error('\nError sample:');
    report.results.filter(r => r.error).slice(0, 10).forEach(r =>
      console.error(`  ${r.displayName} (${r.appfolioId}): ${r.error}`)
    );
  }
  process.exit(report.errors > 0 ? 1 : 0);
}

main().catch((err) => { console.error('[live-sync] FAILED:', err); process.exit(1); });

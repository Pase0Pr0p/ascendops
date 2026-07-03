import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

import { getPaseoPool } from '../src/lib/phone/pool';

async function main() {
  const pool = getPaseoPool();

  // Groups where multiple Supabase contacts share one appfolio_tenant_id
  const { rows } = await pool.query(`
    SELECT
      appfolio_tenant_id,
      COUNT(*)::int AS contact_count,
      array_agg(display_name ORDER BY display_name) AS names,
      array_agg(primary_phone_e164) FILTER (WHERE primary_phone_e164 IS NOT NULL) AS phones
    FROM contacts
    WHERE appfolio_tenant_id IS NOT NULL
      AND (primary_phone_e164 IS NOT NULL OR primary_email IS NOT NULL)
    GROUP BY appfolio_tenant_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `);

  console.log(`Co-tenant groups sharing an appfolio_tenant_id: ${rows.length}`);
  rows.forEach(r => {
    const uniquePhones = [...new Set((r.phones ?? []).filter(Boolean))];
    console.log(`  af_id=${r.appfolio_tenant_id} (${r.contact_count} contacts, ${uniquePhones.length} distinct phones): ${uniquePhones.join(', ')} | names: ${r.names.join(' / ')}`);
  });

  // Total affected contacts
  const { rows: totals } = await pool.query(`
    SELECT COUNT(*)::int AS dupe_contacts
    FROM contacts c
    WHERE (primary_phone_e164 IS NOT NULL OR primary_email IS NOT NULL)
      AND appfolio_tenant_id IN (
        SELECT appfolio_tenant_id FROM contacts
        WHERE appfolio_tenant_id IS NOT NULL
        GROUP BY appfolio_tenant_id HAVING COUNT(*) > 1
      )
  `);
  console.log(`Total contacts in duplicate groups: ${totals[0].dupe_contacts}`);
}
main().catch(console.error);

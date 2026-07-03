import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'node:path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });
dotenvConfig({ path: resolve(process.cwd(), '.env.local'), override: false });

import { getPaseoPool } from '../src/lib/phone/pool';

async function main() {
  const pool = getPaseoPool();

  // Check for contacts where the derived appfolioId (tenant ?? vendor ?? owner) collides across rows
  const { rows } = await pool.query(`
    WITH derived AS (
      SELECT
        id,
        display_name,
        COALESCE(appfolio_tenant_id, appfolio_vendor_id, appfolio_owner_id) AS af_id,
        CASE
          WHEN appfolio_tenant_id IS NOT NULL THEN 'tenant'
          WHEN appfolio_vendor_id IS NOT NULL THEN 'vendor'
          WHEN appfolio_owner_id  IS NOT NULL THEN 'owner'
          ELSE 'none'
        END AS id_type
      FROM contacts
      WHERE primary_phone_e164 IS NOT NULL OR primary_email IS NOT NULL
    )
    SELECT af_id, COUNT(*)::int AS count,
      array_agg(display_name ORDER BY display_name) AS names,
      array_agg(id_type ORDER BY id_type) AS types
    FROM derived
    WHERE af_id IS NOT NULL
    GROUP BY af_id
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `);

  console.log(`AppFolio ID collisions (same derived appfolio_id across rows): ${rows.length}`);
  rows.slice(0, 10).forEach(r =>
    console.log(`  af_id=${r.af_id} count=${r.count} types=${r.types.join('+')} | ${r.names.join(' / ')}`)
  );
}
main().catch(console.error);

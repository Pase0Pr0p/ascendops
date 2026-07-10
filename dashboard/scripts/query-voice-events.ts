import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });

void (async () => {
  // Strip sslmode from DSN and pass ssl option directly to avoid pg v8 sslmode conflict
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  const pool = new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });
  const res = await pool.query(
    "SELECT id, event_type, source_event_id, received_at FROM voice_events ORDER BY received_at DESC LIMIT 10"
  );
  console.log(JSON.stringify(res.rows, null, 2));
  await pool.end();
})();

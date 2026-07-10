import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';
import { resolve } from 'path';

dotenvConfig({ path: resolve(process.cwd(), '../orgs/paseo-pm/secrets.env'), override: false });

void (async () => {
  const dsn = (process.env.VOICE_GATEWAY_DSN ?? '').replace(/[?&]sslmode=[^&]*/g, '');
  const pool = new pg.Pool({ connectionString: dsn, ssl: { rejectUnauthorized: false } });

  console.log('Testing direct write to voice_events...');
  const res = await pool.query(
    "INSERT INTO voice_events (event_type, source_event_id, payload) VALUES ($1, $2, $3) RETURNING id, received_at",
    ['test_direct_write', 'claudia-isolation-test', JSON.stringify({ source: 'claudia-direct-test', ts: new Date().toISOString() })]
  );
  console.log('INSERT OK:', JSON.stringify(res.rows[0]));

  const check = await pool.query(
    "SELECT event_type, source_event_id, received_at FROM voice_events ORDER BY received_at DESC LIMIT 5"
  );
  console.log('Recent rows:', JSON.stringify(check.rows, null, 2));

  await pool.end();
})();

import { Pool } from 'pg';

let _pool: Pool | null = null;

export function getPaseoPool(): Pool {
  if (_pool) return _pool;
  const url = process.env.PASEO_OPS_READONLY_URL;
  if (!url) throw new Error('PASEO_OPS_READONLY_URL is not set');
  _pool = new Pool({ connectionString: url, max: 3, idleTimeoutMillis: 30_000 });
  return _pool;
}

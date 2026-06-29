// Factory — swap between mock and live connector via APPFOLIO_CONNECTOR_PATH env var.
//
// Default: 'mock' (no credentials needed — works in dev and CI).
// Production: set APPFOLIO_CONNECTOR_PATH=stack-api + credentials in secrets.env.

import type { AppFolioConnector } from './types';
import { MockConnector } from './mock.connector';
import { StackApiConnector } from './stack-api.connector';

export type ConnectorPath = 'stack-api' | 'mock';

export function createAppFolioConnector(
  path: ConnectorPath = (process.env.APPFOLIO_CONNECTOR_PATH as ConnectorPath) || 'mock',
): AppFolioConnector {
  switch (path) {
    case 'stack-api':
      return new StackApiConnector({
        clientId: requireEnv('APPFOLIO_CLIENT_ID'),
        clientSecret: requireEnv('APPFOLIO_CLIENT_SECRET'),
        accountId: requireEnv('APPFOLIO_ACCOUNT_ID'),
        writeEnabled: process.env.APPFOLIO_WRITE_ENABLED === 'true',
      });
    case 'mock':
      return new MockConnector();
    default:
      return new MockConnector();
  }
}

function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
}

export type { AppFolioConnector } from './types';
export { MockConnector } from './mock.connector';

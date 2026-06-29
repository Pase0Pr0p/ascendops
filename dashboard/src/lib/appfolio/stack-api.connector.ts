// Stack API connector stub — fill in when Rob's credentials land.
// Swap APPFOLIO_CONNECTOR_PATH=stack-api to activate.

import type {
  AppFolioConnector,
  WorkOrder,
  Lease,
  Tenant,
  RentRollEntry,
  OwnerStatement,
  ListOptions,
} from './types';
import { NotSupportedError } from './types';

interface StackApiConfig {
  clientId: string;
  clientSecret: string;
  accountId: string;
  baseUrl?: string;
  writeEnabled?: boolean;
}

export class StackApiConnector implements AppFolioConnector {
  readonly isDemo = false;
  private readonly baseUrl: string;
  private token: string | null = null;
  private tokenExpiresAt = 0;

  constructor(private readonly config: StackApiConfig) {
    this.baseUrl = config.baseUrl ?? 'https://api.appfolio.com/api/v1';
  }

  private async getToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExpiresAt - 60_000) return this.token;
    // TODO: POST /oauth/token with client_credentials grant
    void this.baseUrl;
    throw new Error('StackApiConnector.getToken: awaiting credentials from Rob');
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const token = await this.getToken();
    void token; void path; void params;
    throw new Error('StackApiConnector.get: not yet implemented');
  }

  private requireWrite(): void {
    if (!this.config.writeEnabled) {
      throw new NotSupportedError('Requires AppFolio Max subscription (write-back not enabled)');
    }
  }

  async ping() { return { ok: false, latencyMs: 0 }; }
  async listWorkOrders(_opts?: ListOptions): Promise<WorkOrder[]> { return this.get('/work_orders'); }
  async getWorkOrder(id: string): Promise<WorkOrder> { return this.get(`/work_orders/${id}`); }
  async listLeases(_opts?: ListOptions): Promise<Lease[]> { return this.get('/leases'); }
  async getLease(id: string): Promise<Lease> { return this.get(`/leases/${id}`); }
  async listTenants(_opts?: ListOptions): Promise<Tenant[]> { return this.get('/tenants'); }
  async getTenant(id: string): Promise<Tenant> { return this.get(`/tenants/${id}`); }
  async getRentRoll(_opts?: { propertyId?: string }): Promise<RentRollEntry[]> { return this.get('/rent_roll'); }
  async getOwnerStatement(_o: string, _s: string, _e: string): Promise<OwnerStatement> {
    return this.get('/owner_statements/current');
  }
  async listOwnerStatements(_o: string, _opts?: ListOptions): Promise<OwnerStatement[]> {
    return this.get('/owner_statements');
  }

  updateWorkOrderStatus(id: string): Promise<WorkOrder> {
    this.requireWrite();
    return this.get(`/work_orders/${id}`);
  }
}

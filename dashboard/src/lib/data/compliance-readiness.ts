export interface ComplianceIssue {
  code: string;
  label: string;
  severity: 'blocker' | 'warning';
  source: string;
  evidence: string;
  workflow_run_id?: string;
  workflow_slug?: string | null;
}

export interface ComplianceReadinessReport {
  property: {
    id: string;
    org_id: string;
    property_name: string | null;
    address: string | null;
  };
  score: number;
  blockers: ComplianceIssue[];
  warnings: ComplianceIssue[];
  formula: {
    starting_score: 100;
    blocker_penalty: 25;
    warning_penalty: 10;
  };
  workflow_runs: Array<{
    id: string;
    template_slug: string | null;
    title: string;
    status: string;
    blocked_task_count: number;
  }>;
  generated_at: string;
}

export type ComplianceReadinessData =
  | {
      state: 'ready';
      report: ComplianceReadinessReport;
    }
  | {
      state: 'unconfigured' | 'error';
      reason: string;
    };

function apiBase(): string | null {
  return (
    process.env.PULSE_API_BASE_URL ??
    process.env.PULSE_API_BASE_URL ??
    null
  )?.replace(/\/$/, '') ?? null;
}

function adminKey(): string | null {
  return (
    process.env.PULSE_API_KEY ??
    process.env.PULSE_API_KEY ??
    process.env.VITE_API_ADMIN_KEY ??
    null
  );
}

function orgId(): string | null {
  return process.env.PULSE_ORG_ID ?? process.env.PULSE_ORG_ID ?? null;
}

export async function getComplianceReadinessForProperty(propertyId: string | number): Promise<ComplianceReadinessData> {
  const base = apiBase();
  const key = adminKey();
  const org = orgId();

  if (!base || !key || !org) {
    return {
      state: 'unconfigured',
      reason: 'Set PULSE_API_BASE_URL, PULSE_API_KEY, and PULSE_ORG_ID to show compliance readiness.',
    };
  }

  try {
    const response = await fetch(
      `${base}/admin/orgs/${encodeURIComponent(org)}/properties/${encodeURIComponent(String(propertyId))}/compliance-readiness`,
      {
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': key,
        },
        cache: 'no-store',
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`HTTP ${response.status}${body ? `: ${body.slice(0, 120)}` : ''}`);
    }
    const payload = (await response.json()) as { compliance_readiness: ComplianceReadinessReport };
    return { state: 'ready', report: payload.compliance_readiness };
  } catch (error) {
    return { state: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

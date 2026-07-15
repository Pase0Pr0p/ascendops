export type WorkflowTaskStatus = 'pending' | 'active' | 'completed' | 'skipped' | 'blocked';

export interface WorkflowTemplateSummary {
  id: string | null;
  slug: string;
  name: string;
  description: string | null;
  subject_type: string;
  materialized: boolean;
  stage_count: number;
  task_count: number;
  is_active: boolean;
}

export interface WorkflowRunSummary {
  id: string;
  template_slug: string;
  template_name: string;
  subject_type: string;
  subject_id: string;
  title: string;
  status: 'active' | 'completed' | 'cancelled';
  task_count: number;
  completed_count: number;
  blocked_count: number;
  started_at: string;
  created_at: string;
  updated_at: string;
}

export interface WorkflowTaskProgress {
  id: string;
  run_id: string;
  status: WorkflowTaskStatus;
  assigned_role: string;
  assigned_agent: string | null;
  bus_task_id: string | null;
  blocker_reason: string | null;
  notes: string | null;
  completed_at: string | null;
  completed_by: string | null;
  task_key: string;
  title: string;
  instructions: string | null;
  is_automated: boolean;
  depends_on: string[];
  stage_key: string;
  stage_name: string;
  template_slug: string;
  template_name: string;
  run_title: string;
  subject_type: string;
  subject_id: string;
  org_id: string | null;
}

export interface WorkflowDriftIssue {
  type: 'missing_stage' | 'extra_stage' | 'missing_task' | 'extra_task' | 'field_mismatch';
  key: string;
  message: string;
}

export interface WorkflowDriftReport {
  slug: string;
  template_id: string | null;
  materialized: boolean;
  status: 'missing_db_template' | 'not_materialized' | 'in_sync' | 'drift_detected';
  issue_count: number;
  issues: WorkflowDriftIssue[];
}

export interface WorkflowEventSummary {
  id: string;
  event_type: string;
  actor: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
  template_slug: string | null;
  template_name: string | null;
  run_title: string | null;
  task_key: string | null;
  task_title: string | null;
}

export type WorkflowCockpitData =
  | {
      state: 'ready';
      baseUrl: string;
      templates: WorkflowTemplateSummary[];
      runs: WorkflowRunSummary[];
      humanQueue: WorkflowTaskProgress[];
      driftReports: WorkflowDriftReport[];
      events: WorkflowEventSummary[];
      fetchedAt: string;
    }
  | {
      state: 'unconfigured' | 'error';
      baseUrl: string | null;
      reason: string;
      fetchedAt: string;
    };

export interface OwnerWorkflowStatus {
  owner_id: string;
  property_ids: string[];
  generated_at: string;
  summary: {
    active_runs: number;
    completed_runs: number;
    blocked_steps: number;
    needed_from_you: number;
  };
  runs: Array<{
    run_id: string;
    title: string;
    template_slug: string;
    template_name: string;
    status: 'active' | 'completed' | 'cancelled' | string;
    current_stage_name: string | null;
    property_id: string | null;
    property_name: string | null;
    task_count: number;
    completed_count: number;
    blocked_count: number;
    started_at: string;
    updated_at: string;
  }>;
  needed_from_you: Array<{
    run_id: string;
    run_title: string;
    task_key: string;
    title: string;
    status: WorkflowTaskStatus | string;
    needed_from_you: string;
    property_id: string | null;
    property_name: string | null;
  }>;
}

export type OwnerWorkflowStatusData =
  | {
      state: 'ready';
      baseUrl: string;
      status: OwnerWorkflowStatus;
      fetchedAt: string;
    }
  | {
      state: 'unconfigured' | 'error';
      baseUrl: string | null;
      reason: string;
      fetchedAt: string;
    };

function workflowApiBase(): string | null {
  return (
    process.env.PULSE_API_BASE_URL ??
    process.env.PULSE_API_BASE_URL ??
    null
  )?.replace(/\/$/, '') ?? null;
}

function workflowAdminKey(): string | null {
  return (
    process.env.PULSE_API_KEY ??
    process.env.PULSE_API_KEY ??
    process.env.VITE_API_ADMIN_KEY ??
    null
  );
}

async function getJson<T>(baseUrl: string, path: string, adminKey: string): Promise<T> {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': adminKey,
    },
    cache: 'no-store',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${path} returned HTTP ${response.status}${body ? `: ${body.slice(0, 180)}` : ''}`);
  }

  return response.json() as Promise<T>;
}

export async function getOwnerWorkflowStatus(token: string): Promise<OwnerWorkflowStatusData> {
  const fetchedAt = new Date().toISOString();
  const baseUrl = workflowApiBase();

  if (!baseUrl) {
    return {
      state: 'unconfigured',
      baseUrl,
      reason: 'The owner status service is not configured.',
      fetchedAt,
    };
  }

  try {
    const payload = await getJson<{ status: OwnerWorkflowStatus }>(
      baseUrl,
      `/owner/status/${encodeURIComponent(token)}`,
      '',
    );
    return { state: 'ready', baseUrl, status: payload.status, fetchedAt };
  } catch (error) {
    return {
      state: 'error',
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
      fetchedAt,
    };
  }
}

export async function getWorkflowCockpitData(): Promise<WorkflowCockpitData> {
  const fetchedAt = new Date().toISOString();
  const baseUrl = workflowApiBase();
  const adminKey = workflowAdminKey();

  if (!baseUrl) {
    return {
      state: 'unconfigured',
      baseUrl,
      reason: 'Set PULSE_API_BASE_URL so Pulse can read the workflow engine API.',
      fetchedAt,
    };
  }

  if (!adminKey) {
    return {
      state: 'unconfigured',
      baseUrl,
      reason: 'Set PULSE_API_KEY so Pulse can authenticate to /admin/workflows.',
      fetchedAt,
    };
  }

  try {
    const [templates, runs, humanQueue, driftReports, events] = await Promise.all([
      getJson<{ templates: WorkflowTemplateSummary[] }>(baseUrl, '/admin/workflows/templates', adminKey),
      getJson<{ runs: WorkflowRunSummary[] }>(baseUrl, '/admin/workflows/runs?limit=25', adminKey),
      getJson<{ items: WorkflowTaskProgress[] }>(baseUrl, '/admin/workflows/human-queue?limit=50', adminKey),
      getJson<{ reports: WorkflowDriftReport[] }>(baseUrl, '/admin/workflows/templates/drift', adminKey),
      getJson<{ events: WorkflowEventSummary[] }>(baseUrl, '/admin/workflows/events?limit=25', adminKey),
    ]);

    return {
      state: 'ready',
      baseUrl,
      templates: templates.templates,
      runs: runs.runs,
      humanQueue: humanQueue.items,
      driftReports: driftReports.reports,
      events: events.events,
      fetchedAt,
    };
  } catch (error) {
    return {
      state: 'error',
      baseUrl,
      reason: error instanceof Error ? error.message : String(error),
      fetchedAt,
    };
  }
}

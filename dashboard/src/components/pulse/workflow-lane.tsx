import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { WorkflowCockpitData, WorkflowDriftReport, WorkflowEventSummary, WorkflowTaskProgress } from '@/lib/data/workflows';
import { LaneHeader, StatCard } from './pulse-ui';

function shortId(id: string): string {
  return id.length > 10 ? id.slice(0, 8) : id;
}

function formatEt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Presentational only: "task_completed" -> "task completed". */
function humanize(s: string): string {
  return s.replace(/_/g, ' ');
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'blocked' || status === 'cancelled') return 'destructive';
  if (status === 'active') return 'default';
  if (status === 'completed') return 'secondary';
  return 'outline';
}

// Panel title row — same anatomy across every workflow panel so the lane
// reads as one system: semibold title, optional tabular count chip, optional
// right-aligned meta (e.g. fetched-at).
function PanelHeader({ title, count, meta }: { title: string; count?: number; meta?: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        {count != null && count > 0 && (
          <span className="rounded-full border border-border bg-secondary/40 px-2 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">
            {count}
          </span>
        )}
      </div>
      {meta && <span className="shrink-0 text-[11px] text-muted-foreground">{meta}</span>}
    </div>
  );
}

function EmptyTable({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed py-8 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function HumanQueueTable({ items }: { items: WorkflowTaskProgress[] }) {
  if (items.length === 0) return <EmptyTable label="No human workflow steps waiting in the queue." />;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Step</TableHead>
          <TableHead>Run</TableHead>
          <TableHead>Role</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Blocker</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {items.slice(0, 8).map((item) => (
          <TableRow key={item.id}>
            <TableCell className="max-w-[260px] whitespace-normal">
              <p className="font-medium leading-snug">{item.title}</p>
              <p className="mt-0.5 text-xs text-muted-foreground">{item.stage_name}</p>
            </TableCell>
            <TableCell className="max-w-[220px] whitespace-normal">
              <p className="leading-snug">{item.run_title}</p>
              <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
                {item.subject_type}/{item.subject_id}
              </p>
            </TableCell>
            <TableCell>
              <div className="flex flex-col gap-0.5">
                <span className="font-medium">{item.assigned_role}</span>
                <span className="text-xs text-muted-foreground">{item.assigned_agent ?? 'human'}</span>
              </div>
            </TableCell>
            <TableCell>
              <Badge variant={statusVariant(item.status)} className="capitalize">{item.status}</Badge>
            </TableCell>
            <TableCell className="max-w-[260px] whitespace-normal text-xs text-muted-foreground">
              {item.blocker_reason ?? (item.depends_on.length ? `Depends on ${item.depends_on.join(', ')}` : 'Ready')}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function DriftPanel({ reports }: { reports: WorkflowDriftReport[] }) {
  const drifted = reports.filter((report) => report.status === 'drift_detected');
  const pending = reports.filter((report) => report.status === 'missing_db_template' || report.status === 'not_materialized');

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-0.5">
            <p className="text-sm font-semibold tracking-tight">SOP drift</p>
            <p className="text-xs text-muted-foreground">
              Committed JSON snapshots compared with materialized DB templates.
            </p>
          </div>
          {drifted.length > 0 ? (
            <Badge variant="destructive" className="shrink-0 tabular-nums">{drifted.length} drifted</Badge>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-0.5 text-[11px] font-medium text-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Clean
            </span>
          )}
        </div>

        {drifted.length === 0 ? (
          <div className="rounded-lg border border-dashed py-6 text-center text-sm text-muted-foreground">
            No materialized template drift detected.
          </div>
        ) : (
          <div className="space-y-2">
            {drifted.slice(0, 4).map((report) => (
              <div key={report.slug} className="rounded-lg border bg-secondary/20 px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <p className="font-mono text-sm font-medium">{report.slug}</p>
                  <Badge variant="destructive" className="shrink-0 tabular-nums">
                    {report.issue_count} {report.issue_count === 1 ? 'issue' : 'issues'}
                  </Badge>
                </div>
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {report.issues.slice(0, 3).map((issue) => (
                    <li key={`${report.slug}-${issue.type}-${issue.key}`} className="flex items-baseline gap-1.5">
                      <span className="capitalize">{humanize(issue.type)}</span>
                      <span className="font-mono text-[11px]">{issue.key}</span>
                    </li>
                  ))}
                  {report.issues.length > 3 && (
                    <li className="text-[11px]">+{report.issues.length - 3} more</li>
                  )}
                </ul>
              </div>
            ))}
          </div>
        )}

        {pending.length > 0 && (
          <p className="text-[11px] text-muted-foreground">
            {pending.length} {pending.length === 1 ? 'snapshot is' : 'snapshots are'} still JSON-only or not yet materialized.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function eventVariant(eventType: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (eventType.includes('blocked') || eventType.includes('failed')) return 'destructive';
  if (eventType.includes('completed')) return 'secondary';
  if (eventType.includes('dispatched') || eventType.includes('started')) return 'default';
  return 'outline';
}

function EventPanel({ events }: { events: WorkflowEventSummary[] }) {
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <PanelHeader title="Recent workflow events" count={events.length} />
        {events.length === 0 ? (
          <EmptyTable label="No workflow events have been recorded yet." />
        ) : (
          <div className="grid gap-2 md:grid-cols-2">
            {events.slice(0, 8).map((event) => (
              <div key={event.id} className="rounded-lg border bg-secondary/20 px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      {event.run_title ?? event.template_name ?? event.template_slug ?? 'Workflow event'}
                    </p>
                    <p className="truncate text-xs text-muted-foreground">
                      {event.task_title ?? event.task_key ?? event.actor ?? 'run event'}
                    </p>
                  </div>
                  <Badge variant={eventVariant(event.event_type)} className="max-w-[150px] shrink-0">
                    <span className="truncate capitalize">{humanize(event.event_type)}</span>
                  </Badge>
                </div>
                <p className="mt-2 text-[11px] tabular-nums text-muted-foreground">{formatEt(event.created_at)} ET</p>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkflowLane({ data }: { data: WorkflowCockpitData }) {
  if (data.state !== 'ready') {
    return (
      <section className="space-y-4">
        <LaneHeader label="Workflow Runs" sub="an agent IQ engine · cortextOS bus dispatch" />
        <Card className="border-dashed">
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-lg font-semibold">
              Workflow engine {data.state === 'unconfigured' ? 'not configured' : 'unavailable'}
            </p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">{data.reason}</p>
            {data.baseUrl && (
              <p className="font-mono text-xs text-muted-foreground">Backend: {data.baseUrl}</p>
            )}
          </CardContent>
        </Card>
      </section>
    );
  }

  const activeRuns = data.runs.filter((run) => run.status === 'active');
  const automatedTemplates = data.templates.filter((template) => template.materialized);
  const driftedTemplates = data.driftReports.filter((report) => report.status === 'drift_detected');

  return (
    <section className="space-y-4">
      <LaneHeader label="Workflow Runs" sub="an agent IQ engine · cortextOS bus dispatch" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Templates captured" value={String(data.templates.length)} sub={`${automatedTemplates.length} materialized`} />
        <StatCard label="Active runs" value={String(activeRuns.length)} sub={`${data.runs.length} recent runs`} accent={activeRuns.length > 0} />
        <StatCard label="Human queue" value={String(data.humanQueue.length)} sub="steps surfaced in Pulse" accent={data.humanQueue.length > 0} />
        <StatCard label="SOP drift" value={String(driftedTemplates.length)} sub="materialized templates changed" accent={driftedTemplates.length > 0} />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]">
        <Card>
          <CardContent className="space-y-3 py-4">
            <PanelHeader
              title="Human steps"
              count={data.humanQueue.length}
              meta={`Fetched ${formatEt(data.fetchedAt)} ET`}
            />
            <HumanQueueTable items={data.humanQueue} />
          </CardContent>
        </Card>

        <DriftPanel reports={data.driftReports} />

        <Card>
          <CardContent className="space-y-3 py-4">
            <PanelHeader title="Recent runs" count={data.runs.length} />
            {data.runs.length === 0 ? (
              <EmptyTable label="No workflow runs have been started yet." />
            ) : (
              <div className="space-y-2">
                {data.runs.slice(0, 8).map((run) => {
                  const runPct = run.task_count > 0 ? Math.round((run.completed_count / run.task_count) * 100) : 0;
                  return (
                    <div key={run.id} className="rounded-lg border bg-secondary/20 px-3 py-2.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 space-y-0.5">
                          <p className="truncate text-sm font-medium">{run.title}</p>
                          <p className="truncate text-xs text-muted-foreground">
                            {run.template_name} · {run.subject_type}/{run.subject_id}
                          </p>
                        </div>
                        <Badge variant={statusVariant(run.status)} className="shrink-0 capitalize">{run.status}</Badge>
                      </div>
                      <div className="mt-2.5 h-1.5 w-full rounded-full bg-muted/40">
                        <div
                          className="h-1.5 rounded-full bg-primary transition-all"
                          style={{ width: `${Math.max(runPct, 2)}%` }}
                        />
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
                        <span className="tabular-nums">{run.completed_count}/{run.task_count} complete</span>
                        {run.blocked_count > 0 && (
                          <span className="font-medium text-destructive tabular-nums">{run.blocked_count} blocked</span>
                        )}
                        <span className="ml-auto font-mono">run {shortId(run.id)}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <EventPanel events={data.events} />

      <Card>
        <CardContent className="space-y-3 py-4">
          <PanelHeader title="Template catalog" count={data.templates.length} />
          {data.templates.length === 0 ? (
            <EmptyTable label="No workflow templates have been captured yet." />
          ) : (
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
              {data.templates.map((template) => (
                <div key={template.slug} className="flex h-full flex-col rounded-lg border bg-secondary/20 p-3">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-medium leading-snug">{template.name}</p>
                    <Badge variant={template.materialized ? 'secondary' : 'outline'} className="shrink-0">
                      {template.materialized ? 'DB' : 'JSON'}
                    </Badge>
                  </div>
                  <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">{template.description}</p>
                  <p className="mt-auto pt-2 text-[11px] tabular-nums text-muted-foreground">
                    {template.stage_count} stages · {template.task_count} tasks · {template.subject_type}
                  </p>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

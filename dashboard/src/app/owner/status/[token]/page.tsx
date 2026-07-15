import Link from 'next/link';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress, ProgressLabel } from '@/components/ui/progress';
import { getOwnerWorkflowStatus } from '@/lib/data/workflows';

export const dynamic = 'force-dynamic';

function formatEt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function statusVariant(status: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (status === 'blocked' || status === 'cancelled') return 'destructive';
  if (status === 'completed') return 'secondary';
  if (status === 'active') return 'default';
  return 'outline';
}

function StatusShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-background px-4 py-6 text-foreground sm:px-6 lg:px-8">
      <div className="mx-auto max-w-5xl space-y-6">{children}</div>
    </main>
  );
}

// Portal summary stat — same anatomy as the cockpit StatCard (uppercase
// tracked label, big tabular number) so the two surfaces read as one product.
function PortalStat({
  label,
  value,
  sub,
  alert,
}: {
  label: string;
  value: string;
  sub?: string;
  alert?: boolean;
}) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-1 py-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className={`text-3xl font-semibold tracking-tight tabular-nums ${alert ? 'text-red-500' : 'text-foreground'}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

function Unavailable({ reason }: { reason: string }) {
  return (
    <StatusShell>
      <Card className="border-dashed">
        <CardContent className="space-y-3 py-10 text-center">
          <p className="text-lg font-semibold">Status link unavailable</p>
          <p className="mx-auto max-w-xl text-sm text-muted-foreground">
            This status link is invalid, expired, or temporarily unavailable. Contact the property
            management team for a fresh link.
          </p>
          <p className="mx-auto max-w-xl text-xs text-muted-foreground">{reason}</p>
        </CardContent>
      </Card>
    </StatusShell>
  );
}

export default async function OwnerStatusPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const data = await getOwnerWorkflowStatus(token);

  if (data.state !== 'ready') return <Unavailable reason={data.reason} />;

  const status = data.status;
  const totalTasks = status.runs.reduce((sum, run) => sum + run.task_count, 0);
  const completedTasks = status.runs.reduce((sum, run) => sum + run.completed_count, 0);
  const pct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;
  const needed = status.summary.needed_from_you;

  return (
    <StatusShell>
      <header className="rounded-2xl border bg-card px-5 py-6 shadow-sm sm:px-7">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Property Status
            </p>
            <h1 className="text-3xl font-bold tracking-tight">Your property workstream</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Current progress, completed work, and anything needed from you.
            </p>
          </div>
          {needed > 0 ? (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-500">
              <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
              {needed} item{needed === 1 ? '' : 's'} need{needed === 1 ? 's' : ''} your attention
            </span>
          ) : (
            <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-[12px] font-medium text-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              No action needed
            </span>
          )}
        </div>
      </header>

      <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <PortalStat label="Active runs" value={String(status.summary.active_runs)} sub="in progress now" />
        <PortalStat label="Completed runs" value={String(status.summary.completed_runs)} sub="finished workstreams" />
        <PortalStat
          label="Blocked steps"
          value={String(status.summary.blocked_steps)}
          sub={status.summary.blocked_steps > 0 ? 'waiting on a dependency' : 'nothing is stuck'}
          alert={status.summary.blocked_steps > 0}
        />
        <Card className="h-full">
          <CardContent className="space-y-1 py-4">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">Updated</p>
            <p className="text-lg font-semibold tracking-tight tabular-nums">
              {formatEt(status.generated_at)}
            </p>
            <p className="text-xs text-muted-foreground">Eastern time</p>
          </CardContent>
        </Card>
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Overall progress</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-semibold tracking-tight tabular-nums text-primary">{pct}%</span>
            <span className="text-xs text-muted-foreground tabular-nums">
              {completedTasks} of {totalTasks} steps complete
            </span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted/40">
            <div
              className="h-1.5 rounded-full bg-primary transition-all"
              style={{ width: `${Math.max(pct, 1)}%` }}
            />
          </div>
        </CardContent>
      </Card>

      <section className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Needed from you</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.needed_from_you.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                Nothing is needed from you right now.
              </div>
            ) : (
              status.needed_from_you.map((item) => (
                <div key={`${item.run_id}-${item.task_key}`} className="rounded-lg border bg-secondary/20 px-3 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-medium leading-snug">{item.title}</p>
                      <p className="truncate text-xs text-muted-foreground">{item.property_name ?? item.run_title}</p>
                    </div>
                    <Badge variant={statusVariant(item.status)} className="shrink-0 capitalize">{item.status}</Badge>
                  </div>
                  <p className="mt-2 text-sm leading-snug text-muted-foreground">{item.needed_from_you}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workstreams</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {status.runs.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                No active workstreams are linked to this owner yet.
              </div>
            ) : (
              status.runs.map((run) => {
                const runPct = run.task_count > 0 ? Math.round((run.completed_count / run.task_count) * 100) : 0;
                return (
                  <div key={run.run_id} className="rounded-lg border bg-secondary/20 px-3 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 space-y-0.5">
                        <p className="font-medium leading-snug">{run.title}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {run.property_name ?? run.template_name}
                          {run.current_stage_name ? ` · ${run.current_stage_name}` : ''}
                        </p>
                      </div>
                      <Badge variant={statusVariant(run.status)} className="shrink-0 capitalize">{run.status}</Badge>
                    </div>
                    <div className="mt-3">
                      <Progress value={runPct}>
                        <ProgressLabel className="text-xs text-muted-foreground">
                          {run.completed_count} of {run.task_count} complete
                        </ProgressLabel>
                        <span className="ml-auto text-xs font-medium text-muted-foreground tabular-nums">{runPct}%</span>
                      </Progress>
                    </div>
                    {run.blocked_count > 0 && (
                      <p className="mt-2 text-xs font-medium text-destructive tabular-nums">
                        {run.blocked_count} blocked step{run.blocked_count === 1 ? '' : 's'}
                      </p>
                    )}
                  </div>
                );
              })
            )}
          </CardContent>
        </Card>
      </section>

      <footer className="text-center text-xs text-muted-foreground">
        This link is private. If anything looks stale, contact the property management team for an update.{' '}
        <Link href="/login" className="text-primary underline-offset-2 hover:underline">
          Staff login
        </Link>
      </footer>
    </StatusShell>
  );
}

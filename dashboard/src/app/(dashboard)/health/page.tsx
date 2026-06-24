import { getAllHeartbeats, getHealthStatus } from '@/lib/data/heartbeats';
import { getTasks } from '@/lib/data/tasks';
import { getEventCountsByAgent } from '@/lib/data/events';
import { getOrgs } from '@/lib/config';
import { formatDistanceToNow } from 'date-fns';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

function healthDot(status: 'healthy' | 'stale' | 'down') {
  return cn(
    'inline-block h-2 w-2 rounded-full',
    status === 'healthy' && 'bg-emerald-500',
    status === 'stale' && 'bg-amber-400',
    status === 'down' && 'bg-destructive'
  );
}

function healthLabel(status: 'healthy' | 'stale' | 'down') {
  return cn(
    'text-xs font-medium',
    status === 'healthy' && 'text-emerald-600 dark:text-emerald-400',
    status === 'stale' && 'text-amber-600 dark:text-amber-400',
    status === 'down' && 'text-destructive'
  );
}

export default async function HealthPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgs = getOrgs();
  const orgParam = typeof params.org === 'string' ? params.org : undefined;
  const org = orgParam && orgs.includes(orgParam) ? orgParam : undefined;

  const [heartbeats, allTasks, eventCounts] = await Promise.all([
    getAllHeartbeats(),
    getTasks({ org }),
    getEventCountsByAgent(org),
  ]);

  const filteredHeartbeats = org
    ? heartbeats.filter((hb) => !hb.org || hb.org === org)
    : heartbeats;

  // Task counts per agent
  const tasksByAgent: Record<string, { pending: number; in_progress: number; blocked: number; completed: number }> = {};
  for (const task of allTasks) {
    const agent = task.assignee ?? 'unassigned';
    if (!tasksByAgent[agent]) {
      tasksByAgent[agent] = { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
    }
    const s = task.status as keyof typeof tasksByAgent[string];
    if (s in tasksByAgent[agent]) tasksByAgent[agent][s]++;
  }

  const healthy = filteredHeartbeats.filter((hb) => getHealthStatus(hb) === 'healthy').length;
  const stale = filteredHeartbeats.filter((hb) => getHealthStatus(hb) === 'stale').length;
  const down = filteredHeartbeats.filter((hb) => getHealthStatus(hb) === 'down').length;
  const totalEventsToday = Object.values(eventCounts).reduce((a, b) => a + b, 0);
  const totalTasksActive = allTasks.filter((t) => t.status === 'in_progress' || t.status === 'pending').length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Fleet Health</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {org ? `Org: ${org}` : 'All organizations'} — read-only snapshot
        </p>
      </div>

      {/* Summary strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Online</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600 dark:text-emerald-400">{healthy}</p>
          <p className="text-xs text-muted-foreground">of {filteredHeartbeats.length} agents</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Stale / Down</p>
          <p className={cn('mt-1 text-2xl font-semibold', (stale + down) > 0 ? 'text-amber-500' : 'text-muted-foreground')}>
            {stale + down}
          </p>
          <p className="text-xs text-muted-foreground">{stale} stale, {down} down</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Active Tasks</p>
          <p className="mt-1 text-2xl font-semibold">{totalTasksActive}</p>
          <p className="text-xs text-muted-foreground">pending + in progress</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Events Today</p>
          <p className="mt-1 text-2xl font-semibold">{totalEventsToday}</p>
          <p className="text-xs text-muted-foreground">across all agents</p>
        </div>
      </div>

      {/* Per-agent table */}
      <div className="rounded-lg border bg-card overflow-hidden">
        <div className="px-4 py-3 border-b">
          <h2 className="text-sm font-medium">Agent Status</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b bg-muted/30">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Agent</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Health</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Last Beat</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Mode</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Current Task</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Pending</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">In Progress</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Blocked</th>
                <th className="px-4 py-2.5 text-center text-xs font-medium text-muted-foreground uppercase tracking-wide">Events Today</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {filteredHeartbeats.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No agents found
                  </td>
                </tr>
              ) : (
                filteredHeartbeats
                  .sort((a, b) => a.agent.localeCompare(b.agent))
                  .map((hb) => {
                    const status = getHealthStatus(hb);
                    const tasks = tasksByAgent[hb.agent] ?? { pending: 0, in_progress: 0, blocked: 0, completed: 0 };
                    const eventsToday = eventCounts[hb.agent] ?? 0;
                    const lastBeat = hb.last_heartbeat
                      ? formatDistanceToNow(new Date(hb.last_heartbeat), { addSuffix: true })
                      : 'never';

                    return (
                      <tr key={hb.agent} className="hover:bg-muted/20 transition-colors">
                        <td className="px-4 py-3">
                          <div className="font-medium">{hb.agent}</div>
                          {hb.org && (
                            <div className="text-xs text-muted-foreground">{hb.org}</div>
                          )}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-1.5">
                            <span className={healthDot(status)} />
                            <span className={healthLabel(status)}>{status}</span>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground whitespace-nowrap">
                          {lastBeat}
                        </td>
                        <td className="px-4 py-3">
                          {hb.mode ? (
                            <span className={cn(
                              'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
                              hb.mode === 'day'
                                ? 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400'
                            )}>
                              {hb.mode}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-sm text-muted-foreground max-w-xs truncate">
                          {hb.current_task || <span className="text-muted-foreground/50">idle</span>}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('text-sm font-medium', tasks.pending > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                            {tasks.pending}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('text-sm font-medium', tasks.in_progress > 0 ? 'text-blue-600 dark:text-blue-400' : 'text-muted-foreground')}>
                            {tasks.in_progress}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('text-sm font-medium', tasks.blocked > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground')}>
                            {tasks.blocked}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={cn('text-sm font-medium', eventsToday > 0 ? 'text-foreground' : 'text-muted-foreground')}>
                            {eventsToday}
                          </span>
                        </td>
                      </tr>
                    );
                  })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

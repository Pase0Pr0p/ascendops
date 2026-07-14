import Link from 'next/link';
import { discoverAgents } from '@/lib/data/agents';
import { DEPARTMENTS } from '@/lib/departments';
import { Card, CardContent } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import type { HealthStatus } from '@/lib/types';

export const dynamic = 'force-dynamic';

interface AgentLite {
  systemName: string;
  name: string;
  emoji: string;
  health: HealthStatus;
  currentTask?: string;
}

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgFilter = typeof params.org === 'string' ? params.org : undefined;

  const raw = (await discoverAgents(orgFilter)) as unknown as AgentLite[];
  const bySystemName = new Map(raw.map((a) => [a.systemName, a]));

  function deptHref(slug: string) {
    return orgFilter
      ? `/departments/${slug}?org=${encodeURIComponent(orgFilter)}`
      : `/departments/${slug}`;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Departments</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Each department, the agent that runs it, and its live status.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {DEPARTMENTS.map((dept) => {
          const agent = bySystemName.get(dept.agent);
          return (
            <Link key={dept.slug} href={deptHref(dept.slug)}>
              <Card className="group h-full cursor-pointer transition-all hover:shadow-md hover:border-primary/20">
                <CardContent className="space-y-3">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-semibold tracking-tight">{dept.label}</p>
                    {agent ? (
                      <HealthDot status={agent.health} />
                    ) : (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        To build
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-snug">{dept.blurb}</p>
                  <div className="flex items-center gap-2 pt-1">
                    {agent ? (
                      <>
                        <AgentAvatar name={agent.name} emoji={agent.emoji} size="sm" />
                        <span className="text-xs font-medium">{agent.name}</span>
                      </>
                    ) : (
                      <span className="text-xs text-muted-foreground italic">
                        {dept.agent}: not yet stood up
                      </span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

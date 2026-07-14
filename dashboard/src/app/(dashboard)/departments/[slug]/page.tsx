import Link from 'next/link';
import { notFound } from 'next/navigation';
import { discoverAgents } from '@/lib/data/agents';
import { getDepartment } from '@/lib/departments';
import { AgentCard, type AgentCardData } from '@/components/agents/agent-card';
import { SkillsTab } from '@/components/agents/skills-tab';
import { Card, CardContent } from '@/components/ui/card';
import { IconMessage, IconExternalLink, IconArrowLeft } from '@tabler/icons-react';

// Outline-button look as a literal class string. We can't call buttonVariants()
// here because it's a client-only export and this is a server component.
const btnOutline =
  'inline-flex flex-1 items-center justify-center gap-1.5 rounded-md border bg-transparent px-3 h-8 text-xs font-medium text-foreground hover:bg-muted/50 transition-colors';

export const dynamic = 'force-dynamic';

export default async function DepartmentPage({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { slug } = await params;
  const sp = await searchParams;
  const orgFilter = typeof sp.org === 'string' ? sp.org : undefined;

  const dept = getDepartment(slug);
  if (!dept) notFound();

  const raw = await discoverAgents(orgFilter);
  const found = raw.find(
    (a) => (a as unknown as Record<string, string>).systemName === dept.agent,
  );

  const orgSuffix = orgFilter ? `?org=${encodeURIComponent(orgFilter)}` : '';

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Link
          href={`/departments${orgSuffix}`}
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <IconArrowLeft size={13} /> Departments
        </Link>
        <h1 className="text-2xl font-semibold">{dept.label}</h1>
        <p className="text-sm text-muted-foreground">{dept.blurb}</p>
      </div>

      {!found ? (
        <Card>
          <CardContent className="py-8 text-center space-y-1">
            <p className="text-sm font-medium">Not yet stood up</p>
            <p className="text-xs text-muted-foreground">
              The <span className="font-mono">{dept.agent}</span> agent for {dept.label} has not
              been created yet. Once it is, it appears here automatically.
            </p>
          </CardContent>
        </Card>
      ) : (
        (() => {
          const a = found as unknown as Record<string, string | number | undefined>;
          const agent: AgentCardData = {
            name: String(a.name ?? dept.agent),
            systemName: String(a.systemName ?? dept.agent),
            org: String(a.org ?? ''),
            emoji: String(a.emoji ?? ''),
            role: String(a.role ?? ''),
            health: found.health,
            currentTask: found.currentTask,
            tasksToday: Number(a.tasksToday ?? 0),
            runtime: found.runtime,
          };

          return (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,360px)_1fr]">
              <div className="space-y-3">
                <AgentCard agent={agent} />
                <div className="flex gap-2">
                  <Link
                    href={`/comms?agent=${encodeURIComponent(agent.systemName)}`}
                    className={btnOutline}
                  >
                    <IconMessage size={14} /> Chat
                  </Link>
                  <Link
                    href={`/agents/${encodeURIComponent(agent.systemName)}`}
                    className={btnOutline}
                  >
                    <IconExternalLink size={14} /> Open agent
                  </Link>
                </div>
              </div>

              <SkillsTab agentName={agent.systemName} org={agent.org} />
            </div>
          );
        })()
      )}
    </div>
  );
}

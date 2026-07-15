import { discoverAgents } from '@/lib/data/agents';
import { AgentsGrid } from '@/components/agents/agents-grid';
import type { AgentCardData } from '@/components/agents/agent-card';
import { loadVoiceAgent } from '@/lib/data/voice-agent';

export const dynamic = 'force-dynamic';

/**
 * Build the external voice-agent card data from the descriptor. Returns null if
 * the descriptor is missing/malformed so the roster still renders the fleet.
 * `health` is a required field on AgentCardData but is never read for external
 * cards (the card swaps in a no-heartbeat marker), so it carries a placeholder.
 */
function loadVoiceAgentCard(): AgentCardData | null {
  try {
    const v = loadVoiceAgent();
    return {
      name: v.name,
      systemName: v.systemName,
      org: v.org,
      emoji: v.emoji,
      role: v.role,
      health: 'down', // placeholder, never rendered for external cards
      tasksToday: 0,
      runtime: v.runtime,
      external: true,
      externalDetail: v.number,
      externalFooter: v.channels.summary,
      externalTooltip: 'External service, no heartbeat',
    };
  } catch {
    return null;
  }
}

export default async function AgentsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;
  const orgFilter = typeof params.org === 'string' ? params.org : undefined;

  const raw = await discoverAgents(orgFilter);

  const agents: AgentCardData[] = raw.map((a) => ({
    name: a.name,
    systemName: (a as unknown as Record<string, string>).systemName ?? a.name,
    org: a.org,
    emoji: (a as unknown as Record<string, string>).emoji ?? '',
    role: (a as unknown as Record<string, string>).role ?? '',
    health: a.health,
    currentTask: a.currentTask,
    tasksToday: (a as unknown as Record<string, number>).tasksToday ?? 0,
    runtime: a.runtime,
  }));

  const voiceAgent = loadVoiceAgentCard();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Agents</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {orgFilter ? `Org: ${orgFilter}` : 'All organizations'} - {agents.length} agent
          {agents.length !== 1 ? 's' : ''}
        </p>
      </div>

      <AgentsGrid initialAgents={agents} voiceAgent={voiceAgent} />
    </div>
  );
}

import { getAgentDetail } from '@/lib/data/agents';
import { getTasksByAgent } from '@/lib/data/tasks';
import { getAllAgents } from '@/lib/config';
import { parseSoulMd } from '@/lib/markdown-parser';
import { AgentDetailTabs } from '@/components/agents/agent-detail-tabs';
import { AgentDetailHeader } from '@/components/agents/agent-detail-header';
import { HealthDot } from '@/components/shared/health-dot';
import { VoiceAgentDetail } from '@/components/agents/voice-agent-detail';
import type { SoulFields } from '@/lib/types';

export const dynamic = 'force-dynamic';

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ name: string }>;
}) {
  const { name } = await params;
  const decoded = decodeURIComponent(name);

  // Alex is an external Telnyx voice agent, not a fleet agent, so it has no
  // agent dir for getAgentDetail to read. It takes a dedicated branch that
  // reuses the shared AgentDetailHeader but renders voice-only tabs. Any other
  // name (including a nonexistent one) still flows through getAgentDetail below,
  // so /agents/nonexistent still errors as before.
  if (decoded.toLowerCase() === 'alex') {
    return <VoiceAgentDetail />;
  }

  // Look up org from enabled-agents.json (case-insensitive to handle legacy URLs)
  const allAgentsList = getAllAgents();
  const agentEntry = allAgentsList.find(
    a => a.name.toLowerCase() === decoded.toLowerCase()
  );
  // Use the canonical system name from config, not the URL param
  const systemName = agentEntry?.name ?? decoded;
  const org = agentEntry?.org || undefined;

  const detail = await getAgentDetail(systemName, org);

  // Parse soul fields
  let soulFields: SoulFields = {
    autonomyRules: '',
    communicationStyle: '',
    dayMode: '',
    nightMode: '',
    coreTruths: '',
  };
  if (detail.soulRaw) {
    const { fields } = parseSoulMd(detail.soulRaw);
    soulFields = fields;
  }

  // Get tasks for this agent (use system name to match task assignee field)
  let tasks: import('@/lib/types').Task[] = [];
  try {
    tasks = getTasksByAgent(systemName, detail.org || undefined);
  } catch {
    tasks = [];
  }

  return (
    <div className="space-y-6">
      <AgentDetailHeader
        name={detail.identity.name}
        emoji={detail.identity.emoji}
        role={detail.identity.role}
        org={detail.org || undefined}
        runtime={detail.runtime}
        status={<HealthDot status={detail.health} showLabel />}
      />

      {/* Tabbed content */}
      <AgentDetailTabs
        detail={{ ...detail, systemName }}
        soulFields={soulFields}
        tasks={tasks}
      />
    </div>
  );
}

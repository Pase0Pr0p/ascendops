import { AgentDetailHeader } from './agent-detail-header';
import { VoiceAgentDetailTabs } from './voice-agent-detail-tabs';
import { loadVoiceAgent } from '@/lib/data/voice-agent';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';

/**
 * Detail page for the external voice agent (Alex). Reuses the shared
 * AgentDetailHeader (so it cannot drift from fleet detail pages) but renders
 * voice-only tabs and a no-heartbeat status marker instead of a HealthDot.
 */
export function VoiceAgentDetail() {
  const v = loadVoiceAgent();

  return (
    <div className="space-y-6">
      <AgentDetailHeader
        name={v.name}
        emoji={v.emoji}
        role={v.role}
        org={v.org}
        runtime={v.runtime}
        status={
          <Tooltip>
            <TooltipTrigger className="inline-flex items-center gap-1.5">
              <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
              <span className="text-xs text-muted-foreground">External</span>
            </TooltipTrigger>
            <TooltipContent>External service, no heartbeat</TooltipContent>
          </Tooltip>
        }
      />

      <VoiceAgentDetailTabs agent={v} />
    </div>
  );
}

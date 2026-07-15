'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Card, CardContent } from '@/components/ui/card';
import { HealthDot } from '@/components/shared/health-dot';
import { OrgBadge } from '@/components/shared/org-badge';
import { RuntimeBadge } from '@/components/shared/runtime-badge';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { AgentActions } from './agent-actions';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { IconChecklist, IconPhone } from '@tabler/icons-react';
import type { AgentRuntime, HealthStatus } from '@/lib/types';

export interface AgentCardData {
  name: string;
  /** Filesystem / config key (e.g. "devbot"). Used for URL routing. */
  systemName: string;
  org: string;
  emoji: string;
  role: string;
  health: HealthStatus;
  currentTask?: string;
  tasksToday: number;
  runtime?: AgentRuntime;
  /**
   * External (non-fleet) service like the Telnyx voice agent: no heartbeat, no
   * tasks, no lifecycle actions. When set, the card swaps the health dot for a
   * gray no-heartbeat marker, shows `externalDetail` in the working-on slot and
   * `externalFooter` in the footer, and hides the restart/stop kebab. External
   * cards are rendered OUTSIDE the counted agents[] array so tallies stay honest.
   */
  external?: boolean;
  /** External only: text for the working-on slot (e.g. the public number). */
  externalDetail?: string;
  /** External only: footer label (e.g. "Voice and SMS"). */
  externalFooter?: string;
  /** External only: tooltip on the gray marker. */
  externalTooltip?: string;
}

interface AgentCardProps {
  agent: AgentCardData;
}

export function AgentCard({ agent }: AgentCardProps) {
  const router = useRouter();

  const healthLabel =
    agent.health === 'healthy' ? 'Online' :
    agent.health === 'stale' ? 'Stale' : 'Offline';

  return (
    <Link href={`/agents/${encodeURIComponent(agent.systemName)}`}>
      <Card className="group relative h-full cursor-pointer transition-all hover:shadow-md hover:border-primary/20">
        <CardContent className="space-y-3">
          {/* Header: avatar + name + health */}
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <AgentAvatar name={agent.name} emoji={agent.emoji} size="md" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold leading-tight">{agent.name}</p>
                  {agent.external ? (
                    <Tooltip>
                      <TooltipTrigger>
                        <span className="inline-block h-2.5 w-2.5 rounded-full bg-muted-foreground/40" />
                      </TooltipTrigger>
                      <TooltipContent>
                        {agent.externalTooltip ?? 'External service, no heartbeat'}
                      </TooltipContent>
                    </Tooltip>
                  ) : (
                    <HealthDot status={agent.health} />
                  )}
                </div>
                {agent.systemName && agent.systemName !== agent.name && (
                  <p className="text-[10px] font-mono text-muted-foreground/60 mt-0.5">
                    {agent.systemName}
                  </p>
                )}
                {agent.role && (
                  <p className="text-[11px] text-muted-foreground truncate max-w-[180px] mt-0.5">
                    {agent.role}
                  </p>
                )}
              </div>
            </div>
            {!agent.external && (
              <AgentActions
                agentName={agent.systemName}
                org={agent.org}
                health={agent.health}
                onAction={() => router.refresh()}
              />
            )}
          </div>

          {/* Org + runtime badges */}
          <div className="flex items-center gap-1.5">
            {agent.org && <OrgBadge org={agent.org} />}
            {agent.runtime && <RuntimeBadge runtime={agent.runtime} />}
          </div>

          {/* Working-on slot (external cards show the number instead) */}
          {agent.external ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground mb-0.5">Reachable at</p>
              <p className="text-xs leading-snug">{agent.externalDetail}</p>
            </div>
          ) : agent.currentTask ? (
            <div className="rounded-md bg-muted/40 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground mb-0.5">Working on</p>
              <p className="text-xs leading-snug line-clamp-2">
                {agent.currentTask.replace(/^WORKING ON:\s*/i, '')}
              </p>
            </div>
          ) : (
            <div className="rounded-md bg-muted/20 px-2.5 py-2">
              <p className="text-[11px] text-muted-foreground">
                {agent.health === 'healthy' ? 'Idle' : healthLabel}
              </p>
            </div>
          )}

          {/* Footer: tasks count (external cards show their channels) */}
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {agent.external ? (
              <>
                <IconPhone size={13} />
                <span>{agent.externalFooter}</span>
              </>
            ) : (
              <>
                <IconChecklist size={13} />
                <span>
                  {agent.tasksToday} task{agent.tasksToday !== 1 ? 's' : ''} today
                </span>
              </>
            )}
          </div>
        </CardContent>
      </Card>
    </Link>
  );
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import { AgentAvatar } from '@/components/shared/agent-avatar';
import { OrgBadge } from '@/components/shared/org-badge';
import { RuntimeBadge } from '@/components/shared/runtime-badge';
import { Button } from '@/components/ui/button';
import type { AgentRuntime } from '@/lib/types';

interface AgentDetailHeaderProps {
  name: string;
  emoji: string;
  role: string;
  org?: string;
  runtime?: AgentRuntime;
  /**
   * Status indicator rendered next to the name. Fleet agents pass a HealthDot;
   * the external voice agent passes its own no-heartbeat marker. Extracting this
   * header keeps the voice detail page and the fleet detail pages from drifting.
   */
  status?: ReactNode;
}

export function AgentDetailHeader({
  name,
  emoji,
  role,
  org,
  runtime,
  status,
}: AgentDetailHeaderProps) {
  return (
    <div className="flex items-start justify-between">
      <div className="flex items-center gap-3">
        <AgentAvatar name={name} emoji={emoji} size="lg" />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{name}</h1>
            {status}
          </div>
          <p className="text-sm text-muted-foreground">{role || 'No role set'}</p>
          <div className="mt-1 flex items-center gap-1.5">
            {org && <OrgBadge org={org} />}
            {runtime && <RuntimeBadge runtime={runtime} />}
          </div>
        </div>
      </div>

      <Link href="/agents">
        <Button variant="outline" size="sm">
          Back to Roster
        </Button>
      </Link>
    </div>
  );
}

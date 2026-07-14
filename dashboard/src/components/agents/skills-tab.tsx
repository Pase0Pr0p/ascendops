'use client';

import { useState, useEffect, useCallback } from 'react';
import { IconPuzzle } from '@tabler/icons-react';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface AgentSkill {
  slug: string;
  name: string;
  description: string;
}

interface SkillsTabProps {
  agentName: string;
  org: string;
}

export function SkillsTab({ agentName, org }: SkillsTabProps) {
  const [skills, setSkills] = useState<AgentSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // The agent's real skills live in .claude/skills/ — read-only display for now.
  // Enable/disable + attach-from-catalog is a deferred fast-follow (pending the
  // .claude/skills/ write mechanism).
  const load = useCallback((signal?: AbortSignal) => {
    setError(false);
    return fetch(
      `/api/agents/${encodeURIComponent(agentName)}/skills?org=${encodeURIComponent(org)}`,
      { signal },
    )
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(d => {
        if (signal?.aborted) return;
        setSkills(Array.isArray(d.skills) ? d.skills : []);
        setLoading(false);
      })
      .catch(err => {
        if (err.name === 'AbortError') return;
        setError(true);
        setLoading(false);
      });
  }, [agentName, org]);

  useEffect(() => {
    const controller = new AbortController();
    load(controller.signal);
    return () => controller.abort();
  }, [load]);

  if (loading) {
    return <div className="p-6 text-muted-foreground">Loading skills...</div>;
  }

  if (error) {
    return (
      <div className="space-y-3 p-1">
        <div className="rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-500">
          Failed to load skills.
        </div>
        <Button size="sm" onClick={() => { setLoading(true); load(); }}>Retry</Button>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-1">
      <Card>
        <CardHeader>
          <div className="flex items-center gap-2">
            <IconPuzzle size={16} className="text-muted-foreground" />
            <CardTitle className="text-sm font-medium">
              Skills
              <Badge variant="secondary" className="ml-2">{skills.length}</Badge>
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-xs text-muted-foreground">
            Skills this agent loads from <code>.claude/skills/</code>. Enable/disable and
            attach-from-catalog are coming next.
          </p>
          {skills.length === 0 ? (
            <p className="text-xs text-muted-foreground">No skills found for this agent.</p>
          ) : (
            skills.map(s => (
              <div key={s.slug} className="rounded-md border px-3 py-2">
                <p className="text-sm font-medium">{s.name}</p>
                {s.description && (
                  <p className="mt-0.5 text-xs text-muted-foreground line-clamp-2">{s.description}</p>
                )}
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}

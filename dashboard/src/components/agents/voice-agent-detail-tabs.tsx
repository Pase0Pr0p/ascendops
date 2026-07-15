'use client';

import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { VoiceAgentDescriptor } from '@/lib/data/voice-agent';

/**
 * Three real tabs for the voice agent: Profile, Channels, Rules. No empty
 * fleet-only tabs (no memory/goals/skills/crons) since Alex is an external
 * Telnyx assistant, not a fleet agent.
 */
export function VoiceAgentDetailTabs({ agent }: { agent: VoiceAgentDescriptor }) {
  return (
    <Tabs defaultValue="profile">
      <TabsList variant="line">
        <TabsTrigger value="profile">Profile</TabsTrigger>
        <TabsTrigger value="channels">Channels</TabsTrigger>
        <TabsTrigger value="rules">Rules</TabsTrigger>
      </TabsList>

      <TabsContent value="profile">
        <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Persona">
              <p className="text-sm leading-relaxed">{agent.persona}</p>
            </Field>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <Field label="Platform">
                <p className="text-sm">{agent.platform}</p>
              </Field>
              <Field label="Owner">
                <p className="text-sm">{agent.owner}</p>
              </Field>
            </div>
            <p className="text-xs text-muted-foreground border-t border-border/60 pt-3">
              Alex is an external Telnyx voice assistant, not a cortextos fleet
              agent, so it has no memory, goals, skills, crons, or heartbeat, and
              is excluded from the fleet health tallies.
            </p>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="channels">
        <Card>
          <CardHeader>
            <CardTitle>Channels</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Field label="Reachable at">
              <p className="text-sm font-medium">{agent.number}</p>
              <p className="text-xs text-muted-foreground">{agent.numberNote}</p>
            </Field>
            <Field label={agent.channels.summary}>
              <p className="text-sm">{agent.channels.detail}</p>
            </Field>
            <Field label="Voicemail">
              <p className="text-sm leading-relaxed">{agent.channels.voicemailPivot}</p>
            </Field>
          </CardContent>
        </Card>
      </TabsContent>

      <TabsContent value="rules">
        <Card>
          <CardHeader>
            <CardTitle>Rules</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {agent.rules.map((rule) => (
              <div key={rule.label} className="rounded-md border border-border/60 px-3 py-2.5">
                <p className="text-sm font-medium">{rule.label}</p>
                <p className="text-sm text-muted-foreground leading-relaxed mt-0.5">
                  {rule.detail}
                </p>
              </div>
            ))}
          </CardContent>
        </Card>
      </TabsContent>
    </Tabs>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </p>
      {children}
    </div>
  );
}

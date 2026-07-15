import fs from 'fs';
import path from 'path';
import type { AgentRuntime } from '@/lib/types';

/**
 * Typed loader for the external voice agent (Alex).
 *
 * Alex is NOT a cortextos fleet agent: no agent dir, no heartbeat, no
 * getAllAgents() entry. Its descriptor lives in config/voice-agent.json and is
 * read here at request time (server-only). This loader is the hinge for a
 * future edit layer: v1 is read-only, but the JSON-plus-loader shape means an
 * editor can later write the same file without touching call sites. No live
 * Telnyx / gateway calls, no secrets.
 */
export interface VoiceAgentRule {
  label: string;
  detail: string;
}

export interface VoiceAgentChannels {
  summary: string;
  detail: string;
  /** Verbatim voicemail-to-SMS pivot line from the persona doc. */
  voicemailPivot: string;
}

export interface VoiceAgentDescriptor {
  name: string;
  systemName: string;
  org: string;
  emoji: string;
  role: string;
  runtime: AgentRuntime;
  platform: string;
  owner: string;
  persona: string;
  number: string;
  numberNote: string;
  channels: VoiceAgentChannels;
  rules: VoiceAgentRule[];
}

function descriptorPath(): string {
  return path.join(process.cwd(), 'config', 'voice-agent.json');
}

/**
 * Read + validate the descriptor. Throws on missing file or malformed shape
 * rather than returning a half-built object, so a bad edit surfaces loudly
 * instead of rendering a silently-empty card.
 */
export function loadVoiceAgent(): VoiceAgentDescriptor {
  const raw = JSON.parse(fs.readFileSync(descriptorPath(), 'utf-8')) as Partial<VoiceAgentDescriptor>;

  const missing: string[] = [];
  for (const key of ['name', 'systemName', 'role', 'runtime', 'number', 'persona'] as const) {
    if (!raw[key]) missing.push(key);
  }
  if (!raw.channels?.summary || !raw.channels?.voicemailPivot) missing.push('channels');
  if (!Array.isArray(raw.rules) || raw.rules.length === 0) missing.push('rules');
  if (missing.length > 0) {
    throw new Error(`voice-agent.json: missing/invalid fields: ${missing.join(', ')}`);
  }

  return raw as VoiceAgentDescriptor;
}

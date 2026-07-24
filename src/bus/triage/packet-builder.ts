import { createHash, randomBytes } from 'node:crypto';
import type {
  TriageWO, ActionPacket, ActionPurpose, Tier,
} from './types.js';

export interface PacketBuildOptions {
  purpose: ActionPurpose;
  messageBytes: string;
  channel?: string;
  cardId?: string;
  policyVersion?: number;
}

export interface PacketBuildResult {
  packet: ActionPacket | null;
  rejected: boolean;
  rejectReason?: string;
}

const TIER_EXPIRY_HOURS: Record<Tier, number> = {
  E0: 1,
  E1: 4,
  U: 24,
  N: 72,
  D: 168,
};

const DEFAULT_EXPIRY_HOURS = 72;

const TENANT_FACING_PURPOSES: Set<ActionPurpose> = new Set([
  'ACK', 'INFO_REQUEST', 'DIY_OFFER', 'STATUS', 'CLOSE_REQUEST',
]);

const ALLOWED_TENANT_CHANNELS: Set<string> = new Set([
  'appfolio_wo_message',
]);

const ALLOWED_ESCALATION_CHANNELS: Set<string> = new Set([
  'telegram',
]);

function resolveRecipient(wo: TriageWO, purpose: ActionPurpose): { recipient: string; recipientRole: string } | null {
  if (purpose === 'ESCALATION' || purpose === 'VENDOR_DISPATCH') {
    return { recipient: 'albie', recipientRole: 'operations_manager' };
  }

  if (TENANT_FACING_PURPOSES.has(purpose)) {
    if (!wo.tenantName) return null;
    return { recipient: wo.tenantName, recipientRole: 'tenant' };
  }

  return { recipient: 'albie', recipientRole: 'operations_manager' };
}

function resolveChannel(purpose: ActionPurpose, explicitChannel?: string): string | null {
  if (purpose === 'ESCALATION' || purpose === 'VENDOR_DISPATCH') {
    if (explicitChannel && !ALLOWED_ESCALATION_CHANNELS.has(explicitChannel)) return null;
    return explicitChannel || 'telegram';
  }

  if (TENANT_FACING_PURPOSES.has(purpose)) {
    if (explicitChannel && !ALLOWED_TENANT_CHANNELS.has(explicitChannel)) return null;
    return explicitChannel || 'appfolio_wo_message';
  }

  return explicitChannel || 'telegram';
}

export function computeFingerprint(wo: TriageWO): string {
  const parts = [
    wo.woId,
    wo.propertyAddress,
    wo.conversationText,
    wo.tenantName || '',
    wo.tenantContact || '',
    wo.unitId || '',
    wo.photoUrls.join(','),
    wo.visionAnalysis || '',
  ];
  return createHash('sha256').update(parts.join('\x00')).digest('hex').slice(0, 16);
}

function generateNonce(): string {
  return randomBytes(16).toString('hex');
}

function computeExpiry(tier: Tier | undefined, issuedAt: string): string {
  const hours = tier ? TIER_EXPIRY_HOURS[tier] : DEFAULT_EXPIRY_HOURS;
  const issued = new Date(issuedAt);
  issued.setHours(issued.getHours() + hours);
  return issued.toISOString();
}

export function computeCanonicalHash(packet: Omit<ActionPacket, 'canonicalHash'>): string {
  const canonical = JSON.stringify({
    woId: packet.woId,
    recipient: packet.recipient,
    recipientRole: packet.recipientRole,
    channel: packet.channel,
    messageBytes: packet.messageBytes,
    purpose: packet.purpose,
    tier: packet.tier,
    policyVersion: packet.policyVersion,
    cardId: packet.cardId,
    conversationFingerprint: packet.conversationFingerprint,
    escalationFlags: packet.escalationFlags,
    issuedAt: packet.issuedAt,
    expiresAt: packet.expiresAt,
    nonce: packet.nonce,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export function buildPacket(wo: TriageWO, options: PacketBuildOptions): PacketBuildResult {
  const resolved = resolveRecipient(wo, options.purpose);
  if (!resolved) {
    return {
      packet: null,
      rejected: true,
      rejectReason: 'Unknown tenant identity — cannot build tenant-facing packet',
    };
  }

  const channel = resolveChannel(options.purpose, options.channel);
  if (!channel) {
    return {
      packet: null,
      rejected: true,
      rejectReason: `Channel '${options.channel}' not authorized for purpose '${options.purpose}'`,
    };
  }

  const issuedAt = new Date().toISOString();

  const partial = {
    woId: wo.woId,
    recipient: resolved.recipient,
    recipientRole: resolved.recipientRole,
    channel,
    messageBytes: options.messageBytes,
    purpose: options.purpose,
    facts: [...wo.facts],
    escalationFlags: [...wo.escalationFlags],
    tier: wo.tier,
    policyVersion: options.policyVersion ?? 0,
    cardId: options.cardId,
    conversationFingerprint: computeFingerprint(wo),
    issuedAt,
    expiresAt: computeExpiry(wo.tier, issuedAt),
    nonce: generateNonce(),
  };

  return {
    packet: { ...partial, canonicalHash: computeCanonicalHash(partial) },
    rejected: false,
  };
}

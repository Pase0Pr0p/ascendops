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

const TIER_EXPIRY_HOURS: Record<Tier, number> = {
  E0: 1,
  E1: 4,
  U: 24,
  N: 72,
  D: 168,
};

const DEFAULT_EXPIRY_HOURS = 72;

function resolveRecipient(wo: TriageWO, purpose: ActionPurpose): { recipient: string; recipientRole: string } {
  if (purpose === 'ESCALATION') {
    return { recipient: 'albie', recipientRole: 'operations_manager' };
  }

  if (purpose === 'VENDOR_DISPATCH') {
    return { recipient: 'albie', recipientRole: 'operations_manager' };
  }

  if (purpose === 'ACK' || purpose === 'INFO_REQUEST' || purpose === 'DIY_OFFER' || purpose === 'STATUS') {
    return {
      recipient: wo.tenantName || 'tenant',
      recipientRole: 'tenant',
    };
  }

  if (purpose === 'CLOSE_REQUEST') {
    return {
      recipient: wo.tenantName || 'tenant',
      recipientRole: 'tenant',
    };
  }

  return { recipient: 'albie', recipientRole: 'operations_manager' };
}

function resolveChannel(purpose: ActionPurpose, explicitChannel?: string): string {
  if (explicitChannel) return explicitChannel;

  if (purpose === 'ESCALATION' || purpose === 'VENDOR_DISPATCH') {
    return 'telegram';
  }

  return 'appfolio_wo_message';
}

function computeFingerprint(wo: TriageWO): string {
  const content = `${wo.woId}:${wo.conversationText}:${wo.propertyAddress}`;
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
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

export function buildPacket(wo: TriageWO, options: PacketBuildOptions): ActionPacket {
  const issuedAt = new Date().toISOString();
  const { recipient, recipientRole } = resolveRecipient(wo, options.purpose);
  const channel = resolveChannel(options.purpose, options.channel);

  return {
    woId: wo.woId,
    recipient,
    recipientRole,
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
}

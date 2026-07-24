import { createHash } from 'node:crypto';
import type { TriageWO, ActionPacket, ActionPurpose } from './types.js';

export const INDEPENDENT_REVIEWER_VERSION = 'independent-reviewer-v2';

export interface IndependentReviewResult {
  result: 'PASS' | 'FAIL' | 'ESCALATE';
  violations: string[];
  reviewerVersion: string;
  reviewedAt: string;
}

const TENANT_FACING_PURPOSES: Set<ActionPurpose> = new Set([
  'ACK', 'INFO_REQUEST', 'DIY_OFFER', 'STATUS', 'CLOSE_REQUEST',
]);

const PURPOSE_ROLE: Record<string, string> = {
  ACK: 'tenant', INFO_REQUEST: 'tenant', DIY_OFFER: 'tenant',
  STATUS: 'tenant', CLOSE_REQUEST: 'tenant',
  ESCALATION: 'operations_manager', VENDOR_DISPATCH: 'operations_manager',
  CONTAINMENT: 'operations_manager',
};

const MOLD_PATTERNS = [/\bmold\b/i, /\bmildew\b/i, /\bfung(us|al|i)\b/i];
const E0_PATTERNS = [
  /\b(fire|flame|burning|smoke)\b/i,
  /\b(gas\s*leak|smell\s*(of\s*)?gas)\b/i,
  /\b(arc(ing)?|electrical\s*(fire|spark))\b/i,
  /\b(flood|water\s*gush|burst\s*pipe)\b/i,
  /\b(carbon\s*monoxide|CO\s*detector)\b/i,
  /\b(collapse|structural\s*failure)\b/i,
];
const SCOPE_EXCLUDED = [/\bbelvedere\b/i, /\btiburon\b/i, /\bpaloma\b/i];

const CONTENT_DENYLIST: Array<{ category: string; patterns: RegExp[] }> = [
  {
    category: 'internal-label',
    patterns: [
      /\btier\s+[A-Z0-9]+\b/i, /\bpriority\s*(:|is|=)\s*(low|medium|high|critical|urgent)\b/i,
      /\bclassified\s*(as|your)\b/i, /\btrade\s+[A-Z]+\b/i, /\bescalation\s*flag\b/i,
      /\blow\s*priority\b/i, /\bhigh\s*priority\b/i,
    ],
  },
  {
    category: 'responsibility',
    patterns: [
      /\byour\s*(fault|responsibility|negligence|damage)\b/i,
      /\byou\s+will\s+be\s+(charged|billed|invoiced)\b/i, /\bchargeback\b/i,
      /\btenant[\s-]*caused\b/i, /\btenant[\s-]*responsible\b/i,
      /\bdeduct(ed|ion)?\s*(from|against)\s*(your|the)\s*(deposit|security)\b/i,
      /\b(repair|cost|bill|charge|expense)\s+(is|are|belongs)\s+(to\s+)?(yours|you)\b/i,
      /\byou\s+(are|will\s+be)\s+(liable|responsible)\b/i,
    ],
  },
  {
    category: 'entry-authority',
    patterns: [
      /\bwe\s+(have|got)\s+permission\b/i, /\bwe\s+will\s+enter\b/i,
      /\benter\s+your\s+unit\b/i, /\baccess\s+your\s+(unit|apartment|home)\b/i,
      /\bforced?\s+entry\b/i, /\blet\s+(ourselves|us)\s+(in|into)\b/i,
      /\bwe\s+can\s+(access|get\s+into|go\s+into|enter)\b/i,
      /\bunlock\s+(the|your)\s+(apartment|unit|door)\b/i,
    ],
  },
  {
    category: 'schedule-promise',
    patterns: [
      /\byour\s+appointment\s+is\b/i, /\bscheduled\s+(for|on|at)\b/i,
      /\bwe\s+will\s+(come|send|dispatch|arrive|be\s+there)\b/i,
      /\b(plumber|electrician|technician|vendor|contractor)\s+(will\s+(come|arrive|be\s+there)|is\s+(booked|arriving|coming|scheduled))\b/i,
      /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+\d/i,
      /\btomorrow\s+at\s+\d/i, /\bnext\s+(week|monday|tuesday|wednesday|thursday|friday)\b/i,
    ],
  },
  {
    category: 'legal-health',
    patterns: [
      /\bhabitab(le|ility)\b/i, /\bcode\s*(compliance|violation|requirement)\b/i,
      /\bhealth\s*(hazard|risk|concern|violation)\b/i, /\blegal(ly)?\s*(required|obligat|compli)/i,
    ],
  },
];

function reviewerFingerprint(wo: TriageWO): string {
  const factsSorted = wo.facts
    .map(f => `${f.type}:${f.source}:${f.value}:${f.confidence}`)
    .sort()
    .join('|');
  const material = [
    wo.woId, wo.propertyAddress, wo.conversationText,
    wo.tenantName || '', wo.tenantContact || '', wo.unitId || '',
    wo.photoUrls.join(','), wo.visionAnalysis || '', factsSorted,
  ];
  return createHash('sha256').update(material.join('\x00')).digest('hex').slice(0, 16);
}

function reviewerCanonicalHash(packet: ActionPacket): string {
  const obj = {
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
    facts: packet.facts,
    issuedAt: packet.issuedAt,
    expiresAt: packet.expiresAt,
    nonce: packet.nonce,
  };
  return createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function reviewerTerminalCheck(wo: TriageWO): string | null {
  if (MOLD_PATTERNS.some(p => p.test(wo.conversationText))) return 'Mold detected';
  if (wo.visionAnalysis && MOLD_PATTERNS.some(p => p.test(wo.visionAnalysis!))) return 'Mold detected in vision';
  if (E0_PATTERNS.some(p => p.test(wo.conversationText))) return 'Life safety E0';
  if (SCOPE_EXCLUDED.some(p => p.test(wo.propertyAddress))) return 'Scope excluded';
  return null;
}

function reviewerContentCheck(message: string, purpose: ActionPurpose): string[] {
  if (!TENANT_FACING_PURPOSES.has(purpose)) return [];
  const violations: string[] = [];
  for (const group of CONTENT_DENYLIST) {
    for (const pattern of group.patterns) {
      if (pattern.test(message)) {
        violations.push(`Prohibited ${group.category} content detected`);
        break;
      }
    }
  }
  return violations;
}

export function independentReview(wo: TriageWO, packet: ActionPacket): IndependentReviewResult {
  const violations: string[] = [];
  const now = new Date().toISOString();

  const terminalReason = reviewerTerminalCheck(wo);
  if (terminalReason) {
    violations.push(`Terminal invariant: ${terminalReason}`);
  }

  if (packet.woId !== wo.woId) {
    violations.push(`WO ID mismatch: packet='${packet.woId}' wo='${wo.woId}'`);
  }

  const fp = reviewerFingerprint(wo);
  if (fp !== packet.conversationFingerprint) {
    violations.push('Source fingerprint does not match current WO state');
  }

  const ch = reviewerCanonicalHash(packet);
  if (ch !== packet.canonicalHash) {
    violations.push('Canonical hash does not match packet contents');
  }

  const expires = new Date(packet.expiresAt);
  const issued = new Date(packet.issuedAt);
  if (isNaN(expires.getTime()) || isNaN(issued.getTime())) {
    violations.push('Packet has invalid date fields');
  } else if (expires <= new Date()) {
    violations.push('Packet is expired');
  }

  if (TENANT_FACING_PURPOSES.has(packet.purpose)) {
    const expectedRole = PURPOSE_ROLE[packet.purpose];
    if (expectedRole && packet.recipientRole !== expectedRole) {
      violations.push(`Purpose '${packet.purpose}' requires role '${expectedRole}', got '${packet.recipientRole}'`);
    }
    if (packet.channel !== 'appfolio_wo_message') {
      violations.push(`Purpose '${packet.purpose}' requires channel 'appfolio_wo_message', got '${packet.channel}'`);
    }
    if (!wo.tenantName || packet.recipient !== wo.tenantName) {
      violations.push('Tenant recipient identity does not match current WO');
    }
  }

  const contentViolations = reviewerContentCheck(packet.messageBytes, packet.purpose);
  violations.push(...contentViolations.map(v => `Content: ${v}`));

  const hasTerminal = terminalReason !== null;

  return {
    result: violations.length === 0 ? 'PASS' : (hasTerminal ? 'ESCALATE' : 'FAIL'),
    violations,
    reviewerVersion: INDEPENDENT_REVIEWER_VERSION,
    reviewedAt: now,
  };
}

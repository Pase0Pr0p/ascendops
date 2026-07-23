import type { ActionPacket } from './types.js';
import { loadPolicyConfig, isAutoSendEnabled } from './policy-config.js';
import { consumeNonce as durableConsumeNonce, isNonceConsumed as durableIsConsumed } from './durable-ledger.js';

export type QueuedSendStatus = 'QUEUED' | 'IN_FLIGHT' | 'CANCELLED' | 'SENT';

export interface QueuedSend {
  packet: ActionPacket;
  status: QueuedSendStatus;
  queuedAt: string;
  reservedAt?: string;
  cancelledAt?: string;
  cancelReason?: string;
  sentAt?: string;
  policyVersionAtQueue: number;
}

export interface DrainResult {
  cancelled: number;
  releasedNonces: string[];
  items: QueuedSend[];
}

export interface ReserveResult {
  reserved: boolean;
  nonce?: string;
  entry?: QueuedSend;
  reason?: string;
}

export interface SendResult {
  sent: boolean;
  error?: string;
}

const queue: QueuedSend[] = [];
const activeNonces = new Set<string>();
let ledgerPathForQueue: string | null = null;

export function setQueueLedgerPath(path: string): void {
  ledgerPathForQueue = path;
}

export function enqueue(packet: ActionPacket, policyVersion: number): QueuedSend {
  const entry: QueuedSend = {
    packet,
    status: 'QUEUED',
    queuedAt: new Date().toISOString(),
    policyVersionAtQueue: policyVersion,
  };
  queue.push(entry);
  return entry;
}

export function reserveForSend(entry: QueuedSend): ReserveResult {
  if (entry.status !== 'QUEUED') {
    return { reserved: false, reason: `Cannot reserve: status is ${entry.status}, not QUEUED` };
  }
  const nonce = entry.packet.nonce;
  if (activeNonces.has(nonce)) {
    return { reserved: false, reason: `Nonce ${nonce} already reserved` };
  }
  if (ledgerPathForQueue && durableIsConsumed(ledgerPathForQueue, nonce)) {
    return { reserved: false, reason: `Nonce ${nonce} already consumed (durable) — replay denied` };
  }
  activeNonces.add(nonce);
  entry.status = 'IN_FLIGHT';
  entry.reservedAt = new Date().toISOString();
  return { reserved: true, nonce, entry };
}

export function releaseNonce(entry: QueuedSend): boolean {
  const nonce = entry.packet.nonce;
  const wasActive = activeNonces.delete(nonce);
  if (entry.status === 'IN_FLIGHT') {
    entry.status = 'QUEUED';
    entry.reservedAt = undefined;
  }
  return wasActive;
}

export function isNonceReserved(nonce: string): boolean {
  return activeNonces.has(nonce);
}

export function getReservedNonces(): Set<string> {
  return new Set(activeNonces);
}

export function drainOnKillswitch(reason: string): DrainResult {
  const cancelled: QueuedSend[] = [];
  const releasedNonces: string[] = [];
  for (const entry of queue) {
    if (entry.status === 'IN_FLIGHT') {
      const nonce = entry.packet.nonce;
      activeNonces.delete(nonce);
      releasedNonces.push(nonce);
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    } else if (entry.status === 'QUEUED') {
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    }
  }
  return { cancelled: cancelled.length, releasedNonces, items: cancelled };
}

export function drainOnVersionChange(newVersion: number, reason: string): DrainResult {
  const cancelled: QueuedSend[] = [];
  const releasedNonces: string[] = [];
  for (const entry of queue) {
    if ((entry.status === 'QUEUED' || entry.status === 'IN_FLIGHT') && entry.policyVersionAtQueue !== newVersion) {
      if (entry.status === 'IN_FLIGHT') {
        const nonce = entry.packet.nonce;
        activeNonces.delete(nonce);
        releasedNonces.push(nonce);
      }
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    }
  }
  return { cancelled: cancelled.length, releasedNonces, items: cancelled };
}

export function markSent(entry: QueuedSend): SendResult {
  if (entry.status !== 'IN_FLIGHT') {
    return { sent: false, error: `Cannot mark sent: status is ${entry.status}, not IN_FLIGHT` };
  }

  const nonce = entry.packet.nonce;

  if (ledgerPathForQueue) {
    const consumeResult = durableConsumeNonce(ledgerPathForQueue, nonce);
    if (!consumeResult.loaded) {
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = `Nonce consumption failed: ${consumeResult.error}`;
      activeNonces.delete(nonce);
      return { sent: false, error: consumeResult.error ?? 'Nonce consumption failed' };
    }
  }

  activeNonces.delete(nonce);
  entry.status = 'SENT';
  entry.sentAt = new Date().toISOString();
  return { sent: true };
}

export function getQueue(): QueuedSend[] {
  return [...queue];
}

export function getQueuedCount(): number {
  return queue.filter(e => e.status === 'QUEUED').length;
}

export function getInFlightCount(): number {
  return queue.filter(e => e.status === 'IN_FLIGHT').length;
}

export function getActiveCount(): number {
  return queue.filter(e => e.status === 'QUEUED' || e.status === 'IN_FLIGHT').length;
}

export function clearQueue(): void {
  queue.length = 0;
  activeNonces.clear();
  ledgerPathForQueue = null;
}

export function checkAndDrain(configPath: string): DrainResult | null {
  const result = loadPolicyConfig(configPath);
  if (!result.loaded || !isAutoSendEnabled(result)) {
    return drainOnKillswitch('Policy disabled or unloadable');
  }
  return null;
}

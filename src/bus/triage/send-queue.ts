import type { ActionPacket } from './types.js';
import { loadPolicyConfig, isAutoSendEnabled } from './policy-config.js';

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
  items: QueuedSend[];
}

export interface ReserveResult {
  reserved: boolean;
  entry?: QueuedSend;
  reason?: string;
}

const queue: QueuedSend[] = [];

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
  entry.status = 'IN_FLIGHT';
  entry.reservedAt = new Date().toISOString();
  return { reserved: true, entry };
}

export function releaseNonce(entry: QueuedSend): void {
  if (entry.status === 'IN_FLIGHT') {
    entry.status = 'QUEUED';
    entry.reservedAt = undefined;
  }
}

export function drainOnKillswitch(reason: string): DrainResult {
  const cancelled: QueuedSend[] = [];
  for (const entry of queue) {
    if (entry.status === 'QUEUED' || entry.status === 'IN_FLIGHT') {
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    }
  }
  return { cancelled: cancelled.length, items: cancelled };
}

export function drainOnVersionChange(newVersion: number, reason: string): DrainResult {
  const cancelled: QueuedSend[] = [];
  for (const entry of queue) {
    if ((entry.status === 'QUEUED' || entry.status === 'IN_FLIGHT') && entry.policyVersionAtQueue !== newVersion) {
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    }
  }
  return { cancelled: cancelled.length, items: cancelled };
}

export function markSent(entry: QueuedSend): void {
  if (entry.status === 'IN_FLIGHT') {
    entry.status = 'SENT';
    entry.sentAt = new Date().toISOString();
  }
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
}

export function checkAndDrain(configPath: string): DrainResult | null {
  const result = loadPolicyConfig(configPath);
  if (!result.loaded || !isAutoSendEnabled(result)) {
    return drainOnKillswitch('Policy disabled or unloadable');
  }
  return null;
}

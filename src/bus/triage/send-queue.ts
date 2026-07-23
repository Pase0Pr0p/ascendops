import type { ActionPacket } from './types.js';
import { loadPolicyConfig, isAutoSendEnabled, type PolicyLoadResult } from './policy-config.js';

export type QueuedSendStatus = 'QUEUED' | 'CANCELLED' | 'SENT';

export interface QueuedSend {
  packet: ActionPacket;
  status: QueuedSendStatus;
  queuedAt: string;
  cancelledAt?: string;
  cancelReason?: string;
  policyVersionAtQueue: number;
}

export interface DrainResult {
  cancelled: number;
  items: QueuedSend[];
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

export function drainOnKillswitch(reason: string): DrainResult {
  const cancelled: QueuedSend[] = [];
  for (const entry of queue) {
    if (entry.status === 'QUEUED') {
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
    if (entry.status === 'QUEUED' && entry.policyVersionAtQueue !== newVersion) {
      entry.status = 'CANCELLED';
      entry.cancelledAt = new Date().toISOString();
      entry.cancelReason = reason;
      cancelled.push(entry);
    }
  }
  return { cancelled: cancelled.length, items: cancelled };
}

export function markSent(entry: QueuedSend): void {
  entry.status = 'SENT';
}

export function getQueue(): QueuedSend[] {
  return [...queue];
}

export function getQueuedCount(): number {
  return queue.filter(e => e.status === 'QUEUED').length;
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

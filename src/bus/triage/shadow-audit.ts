import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { ShadowRecord, ReviewVerdict, ActionPacket, TriageWO } from './types.js';
import type { IndependentReviewResult } from './independent-reviewer.js';
import type { GateResult } from './triage-gate.js';
import { computeCanonicalHash } from './packet-builder.js';

export interface DurableAuditRecord {
  recordId: string;
  shadowRecord: ShadowRecord;
  gateResult: GateResult;
  independentReview: IndependentReviewResult;
  appendedAt: string;
  contentHash: string;
}

export interface AppendResult {
  acknowledged: boolean;
  recordId: string;
  appendedAt: string;
}

export interface ReplayResult {
  matches: boolean;
  originalVerdict: string;
  replayedVerdict: string;
  drifts: string[];
}

function generateRecordId(): string {
  return `sr-${randomBytes(8).toString('hex')}`;
}

function computeContentHash(record: Omit<DurableAuditRecord, 'contentHash' | 'recordId' | 'appendedAt'>): string {
  const serialized = JSON.stringify({
    shadowRecord: record.shadowRecord,
    gateResult: record.gateResult,
    independentReview: record.independentReview,
  });
  return createHash('sha256').update(serialized).digest('hex');
}

export function appendShadowAudit(
  auditPath: string,
  shadowRecord: ShadowRecord,
  gateResult: GateResult,
  independentReview: IndependentReviewResult,
): AppendResult {
  const recordId = generateRecordId();
  const appendedAt = new Date().toISOString();

  const contentHash = computeContentHash({ shadowRecord, gateResult, independentReview });

  const auditRecord: DurableAuditRecord = {
    recordId,
    shadowRecord,
    gateResult,
    independentReview,
    appendedAt,
    contentHash,
  };

  const dir = dirname(auditPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const line = JSON.stringify(auditRecord) + '\n';
  appendFileSync(auditPath, line, 'utf-8');

  return { acknowledged: true, recordId, appendedAt };
}

export function readAuditRecords(auditPath: string): DurableAuditRecord[] {
  if (!existsSync(auditPath)) return [];
  const content = readFileSync(auditPath, 'utf-8').trim();
  if (!content) return [];
  return content.split('\n').map(line => JSON.parse(line) as DurableAuditRecord);
}

export function replayFromRecord(record: DurableAuditRecord): ReplayResult {
  const drifts: string[] = [];

  const recomputedHash = computeContentHash({
    shadowRecord: record.shadowRecord,
    gateResult: record.gateResult,
    independentReview: record.independentReview,
  });

  if (recomputedHash !== record.contentHash) {
    drifts.push(`Content hash drift: stored='${record.contentHash}' recomputed='${recomputedHash}'`);
  }

  const packet = record.shadowRecord.shadowVerdict;
  const recomputedCanonical = computeCanonicalHash(packet);
  if (recomputedCanonical !== packet.canonicalHash) {
    drifts.push(`Packet canonical hash invalid: stored='${packet.canonicalHash}' recomputed='${recomputedCanonical}'`);
  }

  if (record.shadowRecord.packetHash !== recomputedCanonical) {
    drifts.push(`Shadow record packetHash does not match recomputed canonical: stored='${record.shadowRecord.packetHash}' recomputed='${recomputedCanonical}'`);
  }

  const gateVerdict = record.gateResult.decision === 'ALLOW' ? 'PASS' : 'FAIL';
  const reviewVerdict = record.shadowRecord.reviewResult.result;

  if (gateVerdict !== reviewVerdict) {
    drifts.push(`Gate/review disagreement: gate='${gateVerdict}' review='${reviewVerdict}'`);
  }

  if (record.independentReview.result !== 'PASS' && reviewVerdict === 'PASS') {
    drifts.push(`Independent reviewer ${record.independentReview.result} but review passed`);
  }

  return {
    matches: drifts.length === 0,
    originalVerdict: reviewVerdict,
    replayedVerdict: drifts.length === 0 ? reviewVerdict : 'DRIFT',
    drifts,
  };
}

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { appendShadowAudit, readAuditRecords, replayFromRecord } from '../../../../src/bus/triage/shadow-audit';
import type { ShadowRecord, ReviewVerdict, ActionPacket } from '../../../../src/bus/triage/types';
import type { GateResult } from '../../../../src/bus/triage/triage-gate';
import type { IndependentReviewResult } from '../../../../src/bus/triage/independent-reviewer';

const TEST_DIR = join(process.cwd(), 'tests', 'unit', 'bus', 'triage', '.test-audit');
const AUDIT_PATH = join(TEST_DIR, 'shadow-audit.jsonl');

function makePacket(): ActionPacket {
  return {
    woId: 'WO-6000',
    recipient: 'Test Tenant',
    recipientRole: 'tenant',
    channel: 'appfolio_wo_message',
    messageBytes: 'We have received your request.',
    purpose: 'ACK',
    facts: [],
    escalationFlags: [],
    tier: 'N',
    policyVersion: 1,
    conversationFingerprint: 'abc123',
    issuedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 72 * 3600 * 1000).toISOString(),
    nonce: 'test-nonce',
    canonicalHash: 'hash123',
  };
}

function makeVerdict(): ReviewVerdict {
  return {
    result: 'PASS',
    reasons: ['Gate ALLOW: Phase 0 allows WO_ASSIGNMENT'],
    reviewedAt: new Date().toISOString(),
    reviewerVersion: 'review-gate-runner-v3',
  };
}

function makeShadowRecord(): ShadowRecord {
  return {
    woId: 'WO-6000',
    shadowVerdict: makePacket(),
    reviewResult: makeVerdict(),
    timestamp: new Date().toISOString(),
    packetHash: 'hash123',
  };
}

function makeGateResult(): GateResult {
  return {
    decision: 'ALLOW',
    finalActionType: 'SEND_TENANT',
    reclassified: false,
    reason: 'Phase 1 allows SEND_TENANT for tier N',
    rule: 'phase-allow',
  };
}

function makeIndependentReview(): IndependentReviewResult {
  return {
    approved: true,
    violations: [],
    reviewerVersion: 'independent-reviewer-v1',
    reviewedAt: new Date().toISOString(),
  };
}

describe('shadow-audit', () => {
  beforeEach(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
    if (existsSync(AUDIT_PATH)) unlinkSync(AUDIT_PATH);
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('appendShadowAudit', () => {
    it('creates the file and appends a record', () => {
      const result = appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());

      expect(result.acknowledged).toBe(true);
      expect(result.recordId).toMatch(/^sr-[a-f0-9]{16}$/);
      expect(result.appendedAt).toBeTruthy();
      expect(existsSync(AUDIT_PATH)).toBe(true);
    });

    it('appends multiple records (append-only)', () => {
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());

      const records = readAuditRecords(AUDIT_PATH);
      expect(records).toHaveLength(3);
      const ids = new Set(records.map(r => r.recordId));
      expect(ids.size).toBe(3);
    });

    it('each record has a unique content hash', () => {
      const sr1 = makeShadowRecord();
      const sr2 = makeShadowRecord();
      sr2.woId = 'WO-7000';

      appendShadowAudit(AUDIT_PATH, sr1, makeGateResult(), makeIndependentReview());
      appendShadowAudit(AUDIT_PATH, sr2, makeGateResult(), makeIndependentReview());

      const records = readAuditRecords(AUDIT_PATH);
      expect(records[0].contentHash).not.toBe(records[1].contentHash);
    });

    it('creates parent directories if needed', () => {
      const deepPath = join(TEST_DIR, 'deep', 'nested', 'audit.jsonl');
      const result = appendShadowAudit(deepPath, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      expect(result.acknowledged).toBe(true);
      expect(existsSync(deepPath)).toBe(true);
    });
  });

  describe('readAuditRecords', () => {
    it('returns empty array for nonexistent file', () => {
      const records = readAuditRecords('/tmp/nonexistent-audit.jsonl');
      expect(records).toEqual([]);
    });

    it('reads back all appended records with correct structure', () => {
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      const records = readAuditRecords(AUDIT_PATH);

      expect(records).toHaveLength(1);
      const record = records[0];
      expect(record.recordId).toMatch(/^sr-/);
      expect(record.shadowRecord.woId).toBe('WO-6000');
      expect(record.gateResult.decision).toBe('ALLOW');
      expect(record.independentReview.approved).toBe(true);
      expect(record.appendedAt).toBeTruthy();
      expect(record.contentHash).toHaveLength(64);
    });
  });

  describe('replayFromRecord', () => {
    it('reports match for a valid untampered record', () => {
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      const records = readAuditRecords(AUDIT_PATH);
      const replay = replayFromRecord(records[0]);

      expect(replay.matches).toBe(true);
      expect(replay.drifts).toHaveLength(0);
      expect(replay.originalVerdict).toBe('PASS');
      expect(replay.replayedVerdict).toBe('PASS');
    });

    it('detects content hash tamper', () => {
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), makeIndependentReview());
      const records = readAuditRecords(AUDIT_PATH);
      const tampered = { ...records[0], contentHash: 'deadbeef' };
      const replay = replayFromRecord(tampered);

      expect(replay.matches).toBe(false);
      expect(replay.drifts.some(d => d.includes('Content hash drift'))).toBe(true);
      expect(replay.replayedVerdict).toBe('DRIFT');
    });

    it('detects gate/review disagreement', () => {
      const sr = makeShadowRecord();
      const gr = makeGateResult();
      gr.decision = 'DENY';
      appendShadowAudit(AUDIT_PATH, sr, gr, makeIndependentReview());
      const records = readAuditRecords(AUDIT_PATH);
      const replay = replayFromRecord(records[0]);

      expect(replay.matches).toBe(false);
      expect(replay.drifts.some(d => d.includes('Gate/review disagreement'))).toBe(true);
    });

    it('detects independent reviewer rejection on PASS record', () => {
      const ir = makeIndependentReview();
      ir.approved = false;
      ir.violations = ['WO ID mismatch'];
      appendShadowAudit(AUDIT_PATH, makeShadowRecord(), makeGateResult(), ir);
      const records = readAuditRecords(AUDIT_PATH);
      const replay = replayFromRecord(records[0]);

      expect(replay.matches).toBe(false);
      expect(replay.drifts.some(d => d.includes('Independent reviewer rejected'))).toBe(true);
    });
  });
});

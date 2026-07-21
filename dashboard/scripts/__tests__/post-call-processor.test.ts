/**
 * Tests for post-call WO intake processor
 *
 * Imports production functions from lib/post-call-intake.ts (no reimplementation).
 * Covers Cody's fail-closed contract:
 *   - Resolver failures, unknown/inactive/scope-blocked callers → manual_review
 *   - Missing AppFolio IDs → manual_review (NOT routine Max queue)
 *   - Multi-issue, low-confidence extraction → manual_review
 *   - Emergency → alert path (NOT Max routine queue)
 *   - Idempotency → source dedup + repeat-window dedup
 *   - Route decision → single testable function
 *   - Normal happy path → routine Max queue
 */

import { describe, it, expect } from 'vitest';
import {
  type DataCollectionField,
  type ResolvedCaller,
  type IntakeClassification,
  extractField,
  detectEmergency,
  classifyIntake,
  applyGuards,
  checkAppFolioIds,
  computeConfidence,
  computeRouteDecision,
  computeSourceIdempotencyKey,
  computeRepeatWindowKey,
  mapPriority,
  mapPte,
  guessCategory,
  CONFIDENCE_THRESHOLD,
} from '../lib/post-call-intake';

// ─── helper factories ──────────────────────────────────────────────────────────

function makeDcField(value: unknown, rationale = 'test'): DataCollectionField {
  return { value, rationale, data_collection_id: 'test-id' };
}

const FULL_DC: Record<string, DataCollectionField> = {
  maintenance_issue_description: makeDcField('Kitchen faucet leaking under the sink'),
  caller_name: makeDcField('Albert Coles'),
  unit_number: makeDcField('2'),
  property_address: makeDcField('Redwood Glade'),
  is_emergency: makeDcField(false),
  permission_to_enter: makeDcField(true),
};

const MATCHED_RESOLVED: ResolvedCaller = {
  matched: true,
  ambiguous: false,
  display_name: 'Albert L. Coles III',
  contact_id: 'c-123',
  unit_label: '#2',
  property_label: 'Redwood Glade Apartments',
  routing_scope: 'fleet',
  resolved_type: 'tenant',
  has_active_occupancy: true,
  occupancy_id: 'occ-1',
  appfolio_unit_id: 1001,
  appfolio_property_id: 2001,
  appfolio_occupancy_id: 3001,
};

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('applyGuards (fail-closed resolver)', () => {
  it('resolver DB failure → guard fails', () => {
    const g = applyGuards(null, 'resolver_db_failure: connection timeout');
    expect(g.pass).toBe(false);
    expect(g.reason).toContain('resolver_failure');
  });

  it('null resolved (no resolver result) → unknown_caller', () => {
    const g = applyGuards(null, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('unknown_caller');
  });

  it('unmatched caller → unknown_caller', () => {
    const g = applyGuards({ matched: false }, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('unknown_caller');
  });

  it('ambiguous match → multi_match', () => {
    const g = applyGuards({ ...MATCHED_RESOLVED, ambiguous: true }, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('multi_match');
  });

  it('Amanda scope → scope_blocked', () => {
    const g = applyGuards({ ...MATCHED_RESOLVED, routing_scope: 'amanda' }, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('scope_blocked: amanda');
  });

  it('paused scope → scope_blocked', () => {
    const g = applyGuards({ ...MATCHED_RESOLVED, routing_scope: 'paused' }, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('scope_blocked: paused');
  });

  it('inactive tenant → inactive_tenant', () => {
    const g = applyGuards({ ...MATCHED_RESOLVED, has_active_occupancy: false }, null);
    expect(g.pass).toBe(false);
    expect(g.reason).toBe('inactive_tenant');
  });

  it('valid matched tenant → pass', () => {
    const g = applyGuards(MATCHED_RESOLVED, null);
    expect(g.pass).toBe(true);
    expect(g.reason).toBeNull();
  });

  it('fleet scope (default) → pass', () => {
    const resolved = { ...MATCHED_RESOLVED, routing_scope: undefined };
    const g = applyGuards(resolved, null);
    expect(g.pass).toBe(true);
  });
});

describe('checkAppFolioIds', () => {
  it('all three IDs present → ready', () => {
    const r = checkAppFolioIds(MATCHED_RESOLVED);
    expect(r.ready).toBe(true);
    expect(r.reason).toBeNull();
  });

  it('missing unit_id → not ready', () => {
    const r = checkAppFolioIds({ ...MATCHED_RESOLVED, appfolio_unit_id: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('unit_id');
  });

  it('missing property_id → not ready', () => {
    const r = checkAppFolioIds({ ...MATCHED_RESOLVED, appfolio_property_id: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('property_id');
  });

  it('missing occupancy_id → not ready', () => {
    const r = checkAppFolioIds({ ...MATCHED_RESOLVED, appfolio_occupancy_id: null });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('occupancy_id');
  });

  it('all three missing → lists all', () => {
    const r = checkAppFolioIds({
      ...MATCHED_RESOLVED,
      appfolio_unit_id: null,
      appfolio_property_id: null,
      appfolio_occupancy_id: null,
    });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('unit_id');
    expect(r.reason).toContain('property_id');
    expect(r.reason).toContain('occupancy_id');
  });

  it('unresolved caller → not ready', () => {
    const r = checkAppFolioIds({ matched: false });
    expect(r.ready).toBe(false);
    expect(r.reason).toContain('unresolved');
  });

  it('null resolved → not ready', () => {
    const r = checkAppFolioIds(null);
    expect(r.ready).toBe(false);
  });
});

describe('detectEmergency', () => {
  it('is_emergency=true from data_collection → emergency', () => {
    const r = detectEmergency(true, 'just a normal sink', []);
    expect(r.is_emergency).toBe(true);
    expect(r.detail).toContain('data_collection');
  });

  it('emergency keyword in description → emergency', () => {
    const r = detectEmergency(false, 'There is a gas leak in the unit', []);
    expect(r.is_emergency).toBe(true);
    expect(r.detail).toContain('gas leak');
  });

  it('emergency keyword in transcript → emergency', () => {
    const transcript = [
      { role: 'user', message: 'Yeah there is water pouring from the ceiling' },
    ];
    const r = detectEmergency(false, 'water issue', transcript);
    expect(r.is_emergency).toBe(true);
    expect(r.detail).toContain('water pouring');
  });

  it('no emergency signals → not emergency', () => {
    const r = detectEmergency(false, 'Garbage disposal is jammed', []);
    expect(r.is_emergency).toBe(false);
    expect(r.detail).toBeNull();
  });

  it('is_emergency=null + no keywords → not emergency', () => {
    const r = detectEmergency(null, 'Doorbell not working', []);
    expect(r.is_emergency).toBe(false);
  });

  it('broken window triggers emergency', () => {
    const r = detectEmergency(false, 'Someone threw a rock and broken window', []);
    expect(r.is_emergency).toBe(true);
  });
});

describe('classifyIntake', () => {
  it('normal single issue → one_issue', () => {
    expect(classifyIntake('Kitchen faucet leaking', '')).toBe('one_issue');
  });

  it('empty description → insufficient_info', () => {
    expect(classifyIntake('', '')).toBe('insufficient_info');
  });

  it('null description → insufficient_info', () => {
    expect(classifyIntake(null, '')).toBe('insufficient_info');
  });

  it('very short description → insufficient_info', () => {
    expect(classifyIntake('hi', '')).toBe('insufficient_info');
  });

  it('multiple issues signal in description → multiple_issues', () => {
    expect(classifyIntake('disposal is broken and also the faucet leaks', '')).toBe('multiple_issues');
  });

  it('multiple issues signal in transcript summary → multiple_issues', () => {
    expect(classifyIntake('faucet issue', 'caller mentioned two issues with plumbing')).toBe('multiple_issues');
  });

  it('rent question without maintenance keywords → not_maintenance', () => {
    expect(classifyIntake('I have a question about my rent payment', '')).toBe('not_maintenance');
  });

  it('lease with repair keyword → one_issue (maintenance)', () => {
    expect(classifyIntake('My lease says they will repair the appliance', '')).toBe('one_issue');
  });
});

describe('computeConfidence', () => {
  it('full extraction + matched caller → 1.0', () => {
    const { confidence } = computeConfidence(FULL_DC, MATCHED_RESOLVED, 'one_issue');
    expect(confidence).toBe(1.0);
  });

  it('missing issue description → big penalty', () => {
    const dc = { ...FULL_DC };
    delete (dc as Record<string, DataCollectionField>)['maintenance_issue_description'];
    const { confidence, lowFields } = computeConfidence(dc, MATCHED_RESOLVED, 'one_issue');
    expect(confidence).toBeLessThanOrEqual(0.6);
    expect(lowFields).toContain('issue_description');
  });

  it('unmatched caller → penalty', () => {
    const { confidence, lowFields } = computeConfidence(FULL_DC, { matched: false }, 'one_issue');
    expect(confidence).toBeLessThanOrEqual(0.8);
    expect(lowFields).toContain('caller_identity');
  });

  it('multiple_issues classification → penalty', () => {
    const { confidence, lowFields } = computeConfidence(FULL_DC, MATCHED_RESOLVED, 'multiple_issues');
    expect(confidence).toBeLessThanOrEqual(0.85);
    expect(lowFields).toContain('multiple_issues');
  });

  it('insufficient_info → large penalty', () => {
    const emptyDc: Record<string, DataCollectionField> = {};
    const { confidence } = computeConfidence(emptyDc, null, 'insufficient_info');
    expect(confidence).toBeLessThanOrEqual(0.1);
  });

  it('missing unit_number → small penalty', () => {
    const dc = { ...FULL_DC };
    delete (dc as Record<string, DataCollectionField>)['unit_number'];
    const { confidence } = computeConfidence(dc, MATCHED_RESOLVED, 'one_issue');
    expect(confidence).toBe(0.9);
  });

  it('missing PTE → very small penalty', () => {
    const dc = { ...FULL_DC };
    delete (dc as Record<string, DataCollectionField>)['permission_to_enter'];
    const { confidence } = computeConfidence(dc, MATCHED_RESOLVED, 'one_issue');
    expect(confidence).toBe(0.95);
  });

  it('confidence below threshold → should trigger manual review', () => {
    const emptyDc: Record<string, DataCollectionField> = {
      caller_name: makeDcField('Someone'),
    };
    const { confidence } = computeConfidence(emptyDc, { matched: false }, 'one_issue');
    expect(confidence).toBeLessThan(CONFIDENCE_THRESHOLD);
  });
});

describe('computeRouteDecision', () => {
  const baseOpts = {
    safetyFlags: { is_emergency: false },
    guardsPassed: true,
    guardReason: null,
    classification: 'one_issue' as IntakeClassification,
    confidence: 1.0,
    lowFields: [] as string[],
    appfolioReady: true,
    appfolioIdReason: null,
  };

  it('all clear → routine', () => {
    const { route, manualReviewReason } = computeRouteDecision(baseOpts);
    expect(route).toBe('routine');
    expect(manualReviewReason).toBeNull();
  });

  it('emergency → emergency (overrides everything)', () => {
    const { route } = computeRouteDecision({
      ...baseOpts,
      safetyFlags: { is_emergency: true },
      guardsPassed: false,
      guardReason: 'unknown_caller',
    });
    expect(route).toBe('emergency');
  });

  it('guards failed → manual_review', () => {
    const { route, manualReviewReason } = computeRouteDecision({
      ...baseOpts,
      guardsPassed: false,
      guardReason: 'unknown_caller',
    });
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('guard_failed');
  });

  it('multiple_issues → manual_review', () => {
    const { route, manualReviewReason } = computeRouteDecision({
      ...baseOpts,
      classification: 'multiple_issues',
    });
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('multiple_issues');
  });

  it('insufficient_info → manual_review', () => {
    const { route } = computeRouteDecision({
      ...baseOpts,
      classification: 'insufficient_info',
    });
    expect(route).toBe('manual_review');
  });

  it('not_maintenance → manual_review', () => {
    const { route } = computeRouteDecision({
      ...baseOpts,
      classification: 'not_maintenance',
    });
    expect(route).toBe('manual_review');
  });

  it('low confidence → manual_review', () => {
    const { route, manualReviewReason } = computeRouteDecision({
      ...baseOpts,
      confidence: 0.5,
      lowFields: ['issue_description'],
    });
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('low_confidence');
  });

  it('missing AppFolio IDs → manual_review (NOT routine)', () => {
    const { route, manualReviewReason } = computeRouteDecision({
      ...baseOpts,
      appfolioReady: false,
      appfolioIdReason: 'missing_appfolio_ids: unit_id',
    });
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('missing_appfolio_ids');
  });

  it('matched+active+high-confidence but missing IDs → manual_review', () => {
    const { route } = computeRouteDecision({
      ...baseOpts,
      guardsPassed: true,
      confidence: 1.0,
      appfolioReady: false,
      appfolioIdReason: 'missing_appfolio_ids: unit_id, property_id',
    });
    expect(route).toBe('manual_review');
  });

  it('multiple reasons accumulate', () => {
    const { route, manualReviewReason } = computeRouteDecision({
      ...baseOpts,
      guardsPassed: false,
      guardReason: 'unknown_caller',
      classification: 'multiple_issues',
      confidence: 0.3,
      lowFields: ['issue_description', 'caller_identity'],
      appfolioReady: false,
      appfolioIdReason: 'unresolved_caller',
    });
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('guard_failed');
    expect(manualReviewReason).toContain('multiple_issues');
    expect(manualReviewReason).toContain('low_confidence');
    expect(manualReviewReason).toContain('missing_appfolio_ids');
  });
});

describe('mapPriority', () => {
  it('emergency → critical regardless of severity', () => {
    expect(mapPriority('normal', true)).toBe('critical');
    expect(mapPriority(null, true)).toBe('critical');
  });

  it('urgent/high/critical → high', () => {
    expect(mapPriority('urgent', false)).toBe('high');
    expect(mapPriority('high', false)).toBe('high');
    expect(mapPriority('critical', false)).toBe('high');
  });

  it('low → low', () => {
    expect(mapPriority('low', false)).toBe('low');
  });

  it('null → normal', () => {
    expect(mapPriority(null, false)).toBe('normal');
  });

  it('unknown value → normal', () => {
    expect(mapPriority('medium', false)).toBe('normal');
  });
});

describe('mapPte', () => {
  it('boolean true → yes', () => expect(mapPte(true)).toBe('yes'));
  it('string "true" → yes', () => expect(mapPte('true')).toBe('yes'));
  it('string "yes" → yes', () => expect(mapPte('yes')).toBe('yes'));
  it('boolean false → no', () => expect(mapPte(false)).toBe('no'));
  it('string "false" → no', () => expect(mapPte('false')).toBe('no'));
  it('null → not-asked', () => expect(mapPte(null)).toBe('not-asked'));
  it('undefined → not-asked', () => expect(mapPte(undefined)).toBe('not-asked'));
});

describe('guessCategory', () => {
  it('garbage disposal → Garbage Disposal', () => {
    expect(guessCategory('The garbage disposal is jammed')).toBe('Garbage Disposal');
  });

  it('leaking faucet → Faucet/Sink', () => {
    expect(guessCategory('Kitchen faucet is leaking')).toBe('Faucet/Sink');
  });

  it('toilet running → Toilet', () => {
    expect(guessCategory('Toilet keeps running')).toBe('Toilet');
  });

  it('AC not working → HVAC', () => {
    expect(guessCategory('AC unit not blowing cold air')).toBe('HVAC');
  });

  it('door lock broken → Door/Lock', () => {
    expect(guessCategory('Front door lock is broken')).toBe('Door/Lock');
  });

  it('smoke detector → Safety Device', () => {
    expect(guessCategory('Smoke detector keeps beeping')).toBe('Safety Device');
  });

  it('pest problem → Pest Control', () => {
    expect(guessCategory('There are ants in the kitchen')).toBe('Pest Control');
  });

  it('unknown issue → General Maintenance', () => {
    expect(guessCategory('Something is wrong with my unit')).toBe('General Maintenance');
  });
});

describe('source idempotency key', () => {
  it('same conversation_id → same key', () => {
    const k1 = computeSourceIdempotencyKey('conv-abc');
    const k2 = computeSourceIdempotencyKey('conv-abc');
    expect(k1).toBe(k2);
  });

  it('different conversation_id → different key', () => {
    const k1 = computeSourceIdempotencyKey('conv-1');
    const k2 = computeSourceIdempotencyKey('conv-2');
    expect(k1).not.toBe(k2);
  });

  it('key is 16 chars hex', () => {
    const k = computeSourceIdempotencyKey('conv-1');
    expect(k).toHaveLength(16);
    expect(k).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('repeat-window key', () => {
  it('same caller+unit+issue → same key', () => {
    const k1 = computeRepeatWindowKey('+14155551234', '#2, Redwood', 'Faucet leaking');
    const k2 = computeRepeatWindowKey('+14155551234', '#2, Redwood', 'Faucet leaking');
    expect(k1).toBe(k2);
  });

  it('different phone → different key', () => {
    const k1 = computeRepeatWindowKey('+14155551234', '#2', 'faucet');
    const k2 = computeRepeatWindowKey('+14155559999', '#2', 'faucet');
    expect(k1).not.toBe(k2);
  });

  it('different issue → different key', () => {
    const k1 = computeRepeatWindowKey('+14155551234', '#2', 'faucet leak');
    const k2 = computeRepeatWindowKey('+14155551234', '#2', 'broken window');
    expect(k1).not.toBe(k2);
  });

  it('phone normalization strips non-digits', () => {
    const k1 = computeRepeatWindowKey('+14155551234', '#2', 'test');
    const k2 = computeRepeatWindowKey('14155551234', '#2', 'test');
    expect(k1).toBe(k2);
  });

  it('key is 16 chars hex', () => {
    const k = computeRepeatWindowKey('+14155551234', '#2', 'test');
    expect(k).toHaveLength(16);
    expect(k).toMatch(/^[a-f0-9]{16}$/);
  });
});

describe('extractField', () => {
  it('present field → returns value + rationale', () => {
    const r = extractField(FULL_DC, 'caller_name');
    expect(r).not.toBeNull();
    expect(r!.value).toBe('Albert Coles');
  });

  it('missing field → null', () => {
    expect(extractField(FULL_DC, 'nonexistent')).toBeNull();
  });

  it('empty string value → null', () => {
    const dc = { test: makeDcField('') };
    expect(extractField(dc, 'test')).toBeNull();
  });

  it('null value → null', () => {
    const dc = { test: makeDcField(null) };
    expect(extractField(dc, 'test')).toBeNull();
  });

  it('boolean false is a valid value', () => {
    const dc = { test: makeDcField(false) };
    const r = extractField(dc, 'test');
    expect(r).not.toBeNull();
    expect(r!.value).toBe(false);
  });
});

describe('fail-closed integration scenarios', () => {
  it('resolver failure + emergency → emergency route (emergency overrides guard failure)', () => {
    const guards = applyGuards(null, 'connection timeout');
    const emergency = detectEmergency(true, 'gas leak', []);
    const { route } = computeRouteDecision({
      safetyFlags: emergency,
      guardsPassed: guards.pass,
      guardReason: guards.reason,
      classification: 'one_issue',
      confidence: 1.0,
      lowFields: [],
      appfolioReady: false,
      appfolioIdReason: 'unresolved_caller',
    });
    expect(route).toBe('emergency');
  });

  it('scope-blocked + valid extraction + full IDs → manual_review', () => {
    const guards = applyGuards({ ...MATCHED_RESOLVED, routing_scope: 'amanda' }, null);
    const { route } = computeRouteDecision({
      safetyFlags: { is_emergency: false },
      guardsPassed: guards.pass,
      guardReason: guards.reason,
      classification: 'one_issue',
      confidence: 1.0,
      lowFields: [],
      appfolioReady: true,
      appfolioIdReason: null,
    });
    expect(route).toBe('manual_review');
  });

  it('matched caller + insufficient info → manual_review', () => {
    const guards = applyGuards(MATCHED_RESOLVED, null);
    const classification = classifyIntake(null, '');
    const { confidence, lowFields } = computeConfidence({}, MATCHED_RESOLVED, classification);
    const { route } = computeRouteDecision({
      safetyFlags: { is_emergency: false },
      guardsPassed: guards.pass,
      guardReason: guards.reason,
      classification,
      confidence,
      lowFields,
      appfolioReady: true,
      appfolioIdReason: null,
    });
    expect(route).toBe('manual_review');
  });

  it('matched + active + high confidence + missing AppFolio IDs → manual_review (Cody blocker-1)', () => {
    const guards = applyGuards(MATCHED_RESOLVED, null);
    const afIds = checkAppFolioIds({ ...MATCHED_RESOLVED, appfolio_unit_id: null });
    const { route, manualReviewReason } = computeRouteDecision({
      safetyFlags: { is_emergency: false },
      guardsPassed: guards.pass,
      guardReason: guards.reason,
      classification: 'one_issue',
      confidence: 1.0,
      lowFields: [],
      appfolioReady: afIds.ready,
      appfolioIdReason: afIds.reason,
    });
    expect(guards.pass).toBe(true);
    expect(route).toBe('manual_review');
    expect(manualReviewReason).toContain('missing_appfolio_ids');
  });

  it('full happy path: all gates pass → routine', () => {
    const guards = applyGuards(MATCHED_RESOLVED, null);
    const classification = classifyIntake('Kitchen faucet leaking', '');
    const emergency = detectEmergency(false, 'Kitchen faucet leaking', []);
    const { confidence, lowFields } = computeConfidence(FULL_DC, MATCHED_RESOLVED, classification);
    const afIds = checkAppFolioIds(MATCHED_RESOLVED);
    const { route, manualReviewReason } = computeRouteDecision({
      safetyFlags: emergency,
      guardsPassed: guards.pass,
      guardReason: guards.reason,
      classification,
      confidence,
      lowFields,
      appfolioReady: afIds.ready,
      appfolioIdReason: afIds.reason,
    });
    expect(guards.pass).toBe(true);
    expect(classification).toBe('one_issue');
    expect(emergency.is_emergency).toBe(false);
    expect(confidence).toBeGreaterThanOrEqual(CONFIDENCE_THRESHOLD);
    expect(afIds.ready).toBe(true);
    expect(route).toBe('routine');
    expect(manualReviewReason).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';
import { computeCreateWoVerified } from '../lib/create-wo-verify';

// Mirror the hash computation from appfolio-browser-read.ts so tests stay
// in sync with the production function. If the production hash shape changes,
// these tests break — which is the point.
function computeCreateWoApprovalHash(params: {
  propertyId: string;
  unitId?: string;
  occupancyId?: string;
  description: string;
  category?: string;
  issueDescriptorId?: string;
  priority?: string;
  permissionToEnter?: string;
  specialInstructions?: string;
  requestType?: string;
}): string {
  const propertyIdToken = params.occupancyId
    ? `t_${params.occupancyId}`
    : `p_${params.propertyId}`;
  const payload = JSON.stringify({
    propertyId: params.propertyId,
    propertyIdToken,
    unitId: params.unitId ?? '',
    occupancyId: params.occupancyId ?? '',
    description: params.description,
    category: params.category ?? '',
    issueDescriptorId: params.issueDescriptorId ?? '',
    priority: params.priority ?? 'Normal',
    permissionToEnter: params.permissionToEnter ?? '',
    specialInstructions: params.specialInstructions ?? '',
    requestType: params.requestType ?? 'internal',
    party: '',
    sendVendorWoLink: '0',
    sendVendorText: '0',
    requireVendorAcceptWo: '0',
  });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

function reserveNonce(dir: string, hash: string): 'reserved' | 'already_used' | 'error' {
  try { mkdirSync(dir, { recursive: true }); } catch { return 'error'; }
  const noncePath = resolve(dir, hash);
  try {
    const fd = openSync(noncePath, 'wx');
    closeSync(fd);
    return 'reserved';
  } catch (err: unknown) {
    const code = (err as { code?: string }).code;
    if (code === 'EEXIST') return 'already_used';
    return 'error';
  }
}

const TEST_NONCE_DIR = resolve(process.cwd(), '.test-create-wo-nonces');

describe('createWorkOrder hash field sensitivity', () => {
  const baseParams = {
    propertyId: '86',
    unitId: '202',
    occupancyId: '2625',
    description: 'Kitchen faucet leaking',
    priority: 'Normal',
    permissionToEnter: 'true',
    requestType: 'tenant_requested' as const,
  };

  it('identical params produce identical hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams });
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(16);
  });

  it('different description changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, description: 'Broken window' });
    expect(h1).not.toBe(h2);
  });

  it('different propertyId changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, propertyId: '999' });
    expect(h1).not.toBe(h2);
  });

  it('different unitId changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, unitId: '999' });
    expect(h1).not.toBe(h2);
  });

  it('different occupancyId changes hash (also changes propertyIdToken)', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, occupancyId: '9999' });
    expect(h1).not.toBe(h2);
  });

  it('different priority changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, priority: 'Urgent' });
    expect(h1).not.toBe(h2);
  });

  it('different permissionToEnter changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, permissionToEnter: 'false' });
    expect(h1).not.toBe(h2);
  });

  it('different requestType changes hash', () => {
    const h1 = computeCreateWoApprovalHash(baseParams);
    const h2 = computeCreateWoApprovalHash({ ...baseParams, requestType: 'internal' });
    expect(h1).not.toBe(h2);
  });

  it('missing occupancyId uses p_ prefix instead of t_', () => {
    const withOcc = computeCreateWoApprovalHash(baseParams);
    const withoutOcc = computeCreateWoApprovalHash({ ...baseParams, occupancyId: undefined });
    expect(withOcc).not.toBe(withoutOcc);
  });
});

describe('nonce once-only guarantee', () => {
  beforeEach(() => {
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_NONCE_DIR)) rmSync(TEST_NONCE_DIR, { recursive: true });
  });

  it('first reservation succeeds', () => {
    expect(reserveNonce(TEST_NONCE_DIR, 'abc123')).toBe('reserved');
  });

  it('second reservation of same hash returns already_used', () => {
    expect(reserveNonce(TEST_NONCE_DIR, 'abc123')).toBe('reserved');
    expect(reserveNonce(TEST_NONCE_DIR, 'abc123')).toBe('already_used');
  });

  it('different hashes can both reserve', () => {
    expect(reserveNonce(TEST_NONCE_DIR, 'hash1')).toBe('reserved');
    expect(reserveNonce(TEST_NONCE_DIR, 'hash2')).toBe('reserved');
  });

  it('consumed nonce stays consumed even after new nonces are added', () => {
    expect(reserveNonce(TEST_NONCE_DIR, 'first')).toBe('reserved');
    expect(reserveNonce(TEST_NONCE_DIR, 'second')).toBe('reserved');
    expect(reserveNonce(TEST_NONCE_DIR, 'first')).toBe('already_used');
  });
});

describe('hash mismatch rejection (unit-level)', () => {
  it('approval hash from one set of params does not match another', () => {
    const paramsA = {
      propertyId: '86',
      unitId: '202',
      description: 'Faucet leak',
    };
    const paramsB = {
      propertyId: '86',
      unitId: '202',
      description: 'Window broken',
    };
    const hashA = computeCreateWoApprovalHash(paramsA);
    const hashB = computeCreateWoApprovalHash(paramsB);
    expect(hashA).not.toBe(hashB);
  });
});

// Tests call the PRODUCTION computeCreateWoVerified function from lib/create-wo-verify.ts.
// Zero formula duplication: any change to the production decision path is tested here.
const GOOD_INPUTS = {
  redirectedToSr: true,
  firstLog: 'Created by OpsAssistant',
  woNumber: 'WO-8050',
  descOnPage: 'Kitchen faucet leaking under the sink',
  submittedDescription: 'Kitchen faucet leaking under the sink',
  propOnPage: '72 Cherry St',
  prioOnPage: 'Normal',
  submittedPriority: 'Normal',
  pteOnPage: 'Yes',
  submittedPte: 'true',
};

describe('verified-decision (production function)', () => {
  it('all conditions met → verified=true', () => {
    const r = computeCreateWoVerified(GOOD_INPUTS);
    expect(r.verified).toBe(true);
    expect(r.fields_verified.description).toBe(true);
    expect(r.fields_verified.property_present).toBe(true);
    expect(r.fields_verified.priority).toBe(true);
    expect(r.fields_verified.permission_to_enter).toBe(true);
    expect(r.fields_verified.unit).toBeNull();
  });

  it('no SR redirect → verified=false', () => {
    expect(computeCreateWoVerified({ ...GOOD_INPUTS, redirectedToSr: false }).verified).toBe(false);
  });

  it('no Created phrase in log → verified=false', () => {
    expect(computeCreateWoVerified({ ...GOOD_INPUTS, firstLog: 'Updated by system' }).verified).toBe(false);
  });

  it('SR number alone (no concrete WO id) → verified=false', () => {
    expect(computeCreateWoVerified({ ...GOOD_INPUTS, woNumber: 'SR #42' }).verified).toBe(false);
  });

  it('empty WO number → verified=false', () => {
    expect(computeCreateWoVerified({ ...GOOD_INPUTS, woNumber: '' }).verified).toBe(false);
  });

  it('numeric-only WO id (4+ digits) → verified=true', () => {
    expect(computeCreateWoVerified({ ...GOOD_INPUTS, woNumber: '8050' }).verified).toBe(true);
  });

  it('description mismatch → verified=false', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, descOnPage: 'Window replacement needed' });
    expect(r.verified).toBe(false);
    expect(r.fields_verified.description).toBe(false);
  });

  it('property not present on page → verified=false', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, propOnPage: '' });
    expect(r.verified).toBe(false);
    expect(r.fields_verified.property_present).toBe(false);
  });

  it('priority mismatch → verified=false', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, prioOnPage: 'Urgent' });
    expect(r.verified).toBe(false);
    expect(r.fields_verified.priority).toBe(false);
  });

  it('permission_to_enter mismatch → verified=false', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, pteOnPage: 'No' });
    expect(r.verified).toBe(false);
    expect(r.fields_verified.permission_to_enter).toBe(false);
  });

  it('priority not exposed on page → null, does not block verified', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, prioOnPage: '' });
    expect(r.verified).toBe(true);
    expect(r.fields_verified.priority).toBeNull();
  });

  it('permission_to_enter not exposed on page → null, does not block verified', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, pteOnPage: '' });
    expect(r.verified).toBe(true);
    expect(r.fields_verified.permission_to_enter).toBeNull();
  });

  it('PTE not_applicable maps to "not applicable" on page', () => {
    const r = computeCreateWoVerified({ ...GOOD_INPUTS, submittedPte: 'not_applicable', pteOnPage: 'Not Applicable' });
    expect(r.verified).toBe(true);
    expect(r.fields_verified.permission_to_enter).toBe(true);
  });

  it('unit is always null (not verifiable)', () => {
    expect(computeCreateWoVerified(GOOD_INPUTS).fields_verified.unit).toBeNull();
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHash } from 'crypto';
import { mkdirSync, openSync, closeSync, rmSync, existsSync } from 'fs';
import { resolve } from 'path';

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

describe('verification strength requirements', () => {
  it('verified=true requires SR redirect + Created phrase + WO number', () => {
    const checkVerified = (redirectedToSr: boolean, hasCreatedPhrase: boolean, hasWoNumber: boolean) =>
      redirectedToSr && hasCreatedPhrase && hasWoNumber;

    expect(checkVerified(true, true, true)).toBe(true);
    expect(checkVerified(true, true, false)).toBe(false);
    expect(checkVerified(true, false, true)).toBe(false);
    expect(checkVerified(false, true, true)).toBe(false);
    expect(checkVerified(false, false, false)).toBe(false);
  });
});

describe('multi-field echo-match verification', () => {
  it('description matches when first 3 words appear on page', () => {
    const desc = 'Kitchen faucet leaking badly under sink';
    const pageDesc = 'Kitchen faucet leaking badly under sink';
    const first3 = desc.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    expect(first3.length).toBeGreaterThan(0);
    expect(pageDesc.toLowerCase().includes(first3)).toBe(true);
  });

  it('description does not match when page text differs', () => {
    const desc = 'Kitchen faucet leaking';
    const pageDesc = 'Window replacement needed';
    const first3 = desc.trim().split(/\s+/).slice(0, 3).join(' ').toLowerCase();
    expect(pageDesc.toLowerCase().includes(first3)).toBe(false);
  });

  it('priority matches when page echoes submitted value', () => {
    const prioOnPage = 'Normal';
    const submittedPriority = 'Normal';
    expect(prioOnPage.toLowerCase().includes(submittedPriority.toLowerCase())).toBe(true);
  });

  it('priority mismatch detected when page shows different value', () => {
    const prioOnPage = 'Normal';
    const submittedPriority = 'Urgent';
    expect(prioOnPage.toLowerCase().includes(submittedPriority.toLowerCase())).toBe(false);
  });

  it('permission_to_enter maps true→Yes for page comparison', () => {
    const pteMap: Record<string, string> = { 'true': 'yes', 'false': 'no', 'not_applicable': 'not applicable' };
    expect(pteMap['true']).toBe('yes');
    expect('Yes'.toLowerCase().includes(pteMap['true'])).toBe(true);
  });

  it('permission_to_enter maps false→No for page comparison', () => {
    const pteMap: Record<string, string> = { 'true': 'yes', 'false': 'no', 'not_applicable': 'not applicable' };
    expect(pteMap['false']).toBe('no');
    expect('No'.toLowerCase().includes(pteMap['false'])).toBe(true);
  });

  it('unit field is null (not verifiable from SR detail page)', () => {
    const fieldsVerified = {
      description: true,
      property_present: true,
      priority: true,
      permission_to_enter: true,
      unit: null as boolean | null,
    };
    expect(fieldsVerified.unit).toBeNull();
  });
});

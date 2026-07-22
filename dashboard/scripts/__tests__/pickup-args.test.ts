import { describe, it, expect } from 'vitest';
import {
  buildPickupArgs,
  buildPickupLiveArgs,
  mapPteFlag,
  mapPickupPriority,
  buildPickupDescription,
  type PickupIntakeParams,
} from '../lib/pickup-args';

const FULL_TENANT: PickupIntakeParams = {
  appfolioPropertyId: '24',
  appfolioUnitId: '51',
  appfolioOccupancyId: '2625',
  tenantName: 'Maria Santos',
  issueDescription: 'Kitchen faucet leaking',
  locationDetail: 'under the sink',
  severity: 'normal',
  permissionToEnter: true,
};

const VACANT_UNIT: PickupIntakeParams = {
  appfolioPropertyId: '24',
  appfolioUnitId: '51',
  appfolioOccupancyId: '',
  tenantName: 'Staff',
  issueDescription: 'Unit turn paint touch-up needed',
  locationDetail: 'living room',
  severity: 'normal',
  permissionToEnter: 'not_applicable',
};

const PROPERTY_ONLY: PickupIntakeParams = {
  appfolioPropertyId: '24',
  appfolioUnitId: '',
  appfolioOccupancyId: '',
  tenantName: 'Staff',
  issueDescription: 'Basement knob-and-tube wiring inspection',
  locationDetail: '',
  severity: 'urgent',
  permissionToEnter: null,
};

describe('buildPickupArgs — full tenant (property + unit + occupancy)', () => {
  it('includes --unit-id and --occupancy-id', () => {
    const args = buildPickupArgs(FULL_TENANT);
    expect(args).toContain('--unit-id');
    expect(args).toContain('51');
    expect(args).toContain('--occupancy-id');
    expect(args).toContain('2625');
  });

  it('uses tenant_requested request type', () => {
    const args = buildPickupArgs(FULL_TENANT);
    const rtIdx = args.indexOf('--request-type');
    expect(args[rtIdx + 1]).toBe('tenant_requested');
  });

  it('always includes --property-id', () => {
    const args = buildPickupArgs(FULL_TENANT);
    const pidIdx = args.indexOf('--property-id');
    expect(args[pidIdx + 1]).toBe('24');
  });
});

describe('buildPickupArgs — vacant unit (property + unit, no occupancy)', () => {
  it('includes --unit-id but omits --occupancy-id', () => {
    const args = buildPickupArgs(VACANT_UNIT);
    expect(args).toContain('--unit-id');
    expect(args).toContain('51');
    expect(args).not.toContain('--occupancy-id');
  });

  it('uses internal request type', () => {
    const args = buildPickupArgs(VACANT_UNIT);
    const rtIdx = args.indexOf('--request-type');
    expect(args[rtIdx + 1]).toBe('internal');
  });
});

describe('buildPickupArgs — property only (common-area, no unit or occupancy)', () => {
  it('omits both --unit-id and --occupancy-id', () => {
    const args = buildPickupArgs(PROPERTY_ONLY);
    expect(args).not.toContain('--unit-id');
    expect(args).not.toContain('--occupancy-id');
  });

  it('uses internal request type', () => {
    const args = buildPickupArgs(PROPERTY_ONLY);
    const rtIdx = args.indexOf('--request-type');
    expect(args[rtIdx + 1]).toBe('internal');
  });

  it('maps urgent severity to Urgent priority', () => {
    const args = buildPickupArgs(PROPERTY_ONLY);
    const priIdx = args.indexOf('--priority');
    expect(args[priIdx + 1]).toBe('Urgent');
  });

  it('omits location detail from description when empty', () => {
    const args = buildPickupArgs(PROPERTY_ONLY);
    const descIdx = args.indexOf('--description');
    expect(args[descIdx + 1]).toBe('Voice intake from Staff: Basement knob-and-tube wiring inspection');
    expect(args[descIdx + 1]).not.toContain('(');
  });
});

describe('buildPickupArgs — invalid shape: occupancy without unit', () => {
  const INVALID: PickupIntakeParams = {
    appfolioPropertyId: '24',
    appfolioUnitId: '',
    appfolioOccupancyId: '2625',
    tenantName: 'Ghost',
    issueDescription: 'Should not happen',
    locationDetail: '',
    severity: 'normal',
    permissionToEnter: true,
  };

  it('includes --occupancy-id when passed (production guard is in checkAppFolioIds)', () => {
    const args = buildPickupArgs(INVALID);
    expect(args).toContain('--occupancy-id');
    expect(args).not.toContain('--unit-id');
    expect(args.indexOf('--request-type') > -1).toBe(true);
    const rtIdx = args.indexOf('--request-type');
    expect(args[rtIdx + 1]).toBe('tenant_requested');
  });
});

describe('buildPickupLiveArgs', () => {
  it('appends --execute and --approval-hash', () => {
    const args = buildPickupLiveArgs(FULL_TENANT, 'abc123hash');
    expect(args).toContain('--execute');
    expect(args).toContain('--approval-hash');
    expect(args).toContain('abc123hash');
    const exeIdx = args.indexOf('--execute');
    const hashIdx = args.indexOf('--approval-hash');
    expect(exeIdx).toBeGreaterThan(0);
    expect(hashIdx).toBe(exeIdx + 1);
    expect(args[hashIdx + 1]).toBe('abc123hash');
  });

  it('dry-run args are prefix of live args', () => {
    const dryArgs = buildPickupArgs(FULL_TENANT);
    const liveArgs = buildPickupLiveArgs(FULL_TENANT, 'hash');
    expect(liveArgs.slice(0, dryArgs.length)).toEqual(dryArgs);
  });
});

describe('mapPteFlag', () => {
  it('true → "true"', () => expect(mapPteFlag(true)).toBe('true'));
  it('"true" → "true"', () => expect(mapPteFlag('true')).toBe('true'));
  it('false → "false"', () => expect(mapPteFlag(false)).toBe('false'));
  it('"false" → "false"', () => expect(mapPteFlag('false')).toBe('false'));
  it('null → "not_applicable"', () => expect(mapPteFlag(null)).toBe('not_applicable'));
  it('"maybe" → "not_applicable"', () => expect(mapPteFlag('maybe')).toBe('not_applicable'));
});

describe('mapPickupPriority', () => {
  it('urgent → Urgent', () => expect(mapPickupPriority('urgent')).toBe('Urgent'));
  it('normal → Normal', () => expect(mapPickupPriority('normal')).toBe('Normal'));
  it('anything else → Normal', () => expect(mapPickupPriority('high')).toBe('Normal'));
});

describe('buildPickupDescription', () => {
  it('includes location when present', () => {
    expect(buildPickupDescription('Alice', 'Leak', 'kitchen'))
      .toBe('Voice intake from Alice: Leak (kitchen)');
  });

  it('omits parenthetical when location empty', () => {
    expect(buildPickupDescription('Alice', 'Leak', ''))
      .toBe('Voice intake from Alice: Leak');
  });
});

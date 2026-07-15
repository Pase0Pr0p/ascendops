// AL-1 owner-inputs validator tests (master plan §4.4). One assertion per
// bad-input class: the escrow/via_pm mutual-exclusion, missing required fields,
// staleness flagging, the escrow→P&I warning, and the free-and-clear happy path.
// Also validates the committed synthetic example template parses clean.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateOwnerInputs } from '@/lib/data/owner-inputs-validate';

const ASOF = '2026-07-05';

// A fully valid financed property (carry paid via PM, not escrowed).
function financedProperty() {
  return {
    loan: {
      lender: 'Test CU',
      balance: 214500,
      balance_as_of: '2026-06-30',
      rate_pct: 6.25,
      monthly_pi: 1580,
      term_months: 360,
      origination: '2021-03-01',
    },
    carry: {
      hoa_monthly: 0,
      tax_annual: 2900,
      taxes_via_pm: true,
      tax_escrowed: false,
      insurance_annual: 1450,
      insurance_via_pm: true,
      insurance_escrowed: false,
    },
  };
}

function store(props: Record<string, unknown>) {
  return { properties: props };
}

describe('happy paths', () => {
  it('a clean financed property validates ok with no issues', () => {
    const res = validateOwnerInputs(store({ '118': financedProperty() }), ASOF);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
    expect(res.warnings).toEqual([]);
  });

  it('free & clear (loan: null) is valid', () => {
    const p = financedProperty();
    const res = validateOwnerInputs(store({ '204': { ...p, loan: null } }), ASOF);
    expect(res.ok).toBe(true);
    expect(res.errors).toEqual([]);
  });
});

describe('rule 1 — escrowed and via_pm are mutually exclusive', () => {
  it('tax escrowed + taxes_via_pm both true → error', () => {
    const p = financedProperty();
    p.carry.tax_escrowed = true;
    p.carry.taxes_via_pm = true;
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'escrow_viapm_conflict' && e.field === 'carry.tax')).toBe(true);
  });

  it('insurance escrowed + insurance_via_pm both true → error', () => {
    const p = financedProperty();
    p.carry.insurance_escrowed = true;
    p.carry.insurance_via_pm = true;
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'escrow_viapm_conflict' && e.field === 'carry.insurance')).toBe(true);
  });
});

describe('rule 2 — escrowed ⇒ monthly_pi must be P&I-only (warning)', () => {
  it('tax_escrowed=true warns to confirm P&I-only, stays ok', () => {
    const p = financedProperty();
    p.carry.tax_escrowed = true;
    p.carry.taxes_via_pm = false; // not a conflict, so it is a warning not an error
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(true);
    expect(res.warnings.some((w) => w.code === 'escrow_pi_note')).toBe(true);
  });
});

describe('required-field validation', () => {
  it('missing loan.balance → error', () => {
    const p = financedProperty();
    delete (p.loan as Record<string, unknown>).balance;
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_field' && e.field === 'loan.balance')).toBe(true);
  });

  it('missing carry object → error', () => {
    const p = financedProperty() as Record<string, unknown>;
    delete p.carry;
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.field === 'carry')).toBe(true);
  });

  it('wrong type (rate_pct as string) → error', () => {
    const p = financedProperty();
    (p.loan as Record<string, unknown>).rate_pct = '6.25';
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'wrong_type' && e.field === 'loan.rate_pct')).toBe(true);
  });

  it('missing properties root → error', () => {
    const res = validateOwnerInputs({}, ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'missing_properties')).toBe(true);
  });

  it('non-object input → error', () => {
    const res = validateOwnerInputs('nope', ASOF);
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.code === 'not_an_object')).toBe(true);
  });
});

describe('rule 3 — staleness flagging', () => {
  it('balance_as_of older than 15 months → stale warning (not an error)', () => {
    const p = financedProperty();
    p.loan.balance_as_of = '2025-01-01'; // ~18 months before ASOF
    const res = validateOwnerInputs(store({ '118': p }), ASOF);
    expect(res.ok).toBe(true); // staleness never blocks
    expect(res.warnings.some((w) => w.code === 'loan_stale')).toBe(true);
  });

  it('a recent balance_as_of is not flagged stale', () => {
    const res = validateOwnerInputs(store({ '118': financedProperty() }), ASOF);
    expect(res.warnings.some((w) => w.code === 'loan_stale')).toBe(false);
  });
});

describe('committed example template', () => {
  it('config/owner-inputs.example.json parses and validates clean', () => {
    const path = fileURLToPath(new URL('../../../config/owner-inputs.example.json', import.meta.url));
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    // Use a fixed asOf so the template's 2026-06-30 balance is not flagged stale.
    const res = validateOwnerInputs(parsed, '2026-07-05');
    expect(res.errors).toEqual([]);
    expect(res.ok).toBe(true);
  });
});

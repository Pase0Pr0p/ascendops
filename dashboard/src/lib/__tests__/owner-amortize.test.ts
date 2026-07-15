// AL-1 amortization tests (master plan §4.4). The load-bearing assertion: our
// roll-forward matches a PUBLISHED amortization table — 30yr, 6.25%, $220k loan
// → month-12 balance to the dollar. Standard payment for those terms is
// $1,354.58/mo; a published schedule leaves $217,422 owed after 12 payments.
// Plus: free & clear (null loan) path, staleness, and payoff clamping.
import { describe, it, expect } from 'vitest';
import {
  currentBalance,
  amortizationSchedule,
  isLoanStale,
  monthsElapsed,
  loanAgeMonths,
  STALE_LOAN_MONTHS,
  type Loan,
} from '@/lib/data/owner-amortize';

// 30-year, 6.25%, $220,000, standard P&I payment $1,354.58 (published table).
const REF_LOAN: Loan = {
  lender: 'Reference Bank',
  balance: 220000,
  balance_as_of: '2026-01-01',
  rate_pct: 6.25,
  monthly_pi: 1354.58,
  term_months: 360,
  origination: '2026-01-01',
};

describe('amortization vs published reference table', () => {
  it('30yr 6.25% $220k → month-12 balance is $217,422 to the dollar', () => {
    // Exactly 12 whole months after balance_as_of.
    const bal = currentBalance(REF_LOAN, '2027-01-01');
    expect(Math.round(bal)).toBe(217422);
  });

  it('schedule row 12 balance matches the same reference figure', () => {
    const rows = amortizationSchedule(REF_LOAN, 12);
    expect(rows).toHaveLength(12);
    expect(Math.round(rows[11].balance)).toBe(217422);
    // First payment on a $220k / 6.25% loan: interest $1,145.83, principal $208.75.
    expect(rows[0].interest).toBeCloseTo(1145.83, 2);
    expect(rows[0].principal).toBeCloseTo(208.75, 2);
  });

  it('interest + principal always sums to the payment for a normal month', () => {
    const rows = amortizationSchedule(REF_LOAN, 12);
    for (const r of rows) {
      expect(r.interest + r.principal).toBeCloseTo(REF_LOAN.monthly_pi, 6);
    }
  });
});

describe('free & clear (null loan)', () => {
  it('balance is always 0', () => {
    expect(currentBalance(null, '2027-01-01')).toBe(0);
    expect(currentBalance(null, '2099-12-31')).toBe(0);
  });
  it('schedule is empty and is never stale', () => {
    expect(amortizationSchedule(null, 24)).toEqual([]);
    expect(isLoanStale(null, '2099-01-01')).toBe(false);
    expect(loanAgeMonths(null, '2099-01-01')).toBe(0);
  });
});

describe('roll-forward edge cases', () => {
  it('a date at/before balance_as_of returns the reported balance unchanged', () => {
    expect(currentBalance(REF_LOAN, '2026-01-01')).toBe(220000);
    expect(currentBalance(REF_LOAN, '2025-06-01')).toBe(220000);
  });

  it('clamps at 0 — never amortizes past payoff', () => {
    // Roll far beyond the 360-month term; balance must be exactly 0, not negative.
    const bal = currentBalance(REF_LOAN, '2100-01-01');
    expect(bal).toBe(0);
    const rows = amortizationSchedule(REF_LOAN, 600);
    expect(rows[rows.length - 1].balance).toBe(0);
    // Once it hits 0 it stops rolling, so the schedule is shorter than 600.
    expect(rows.length).toBeLessThan(600);
  });

  it('monthsElapsed floors on day-of-month and never goes negative', () => {
    expect(monthsElapsed('2026-01-01', '2027-01-01')).toBe(12);
    expect(monthsElapsed('2026-01-15', '2026-02-14')).toBe(0); // day not yet reached
    expect(monthsElapsed('2026-01-15', '2026-02-15')).toBe(1);
    expect(monthsElapsed('2027-01-01', '2026-01-01')).toBe(0); // backwards ⇒ 0
  });
});

describe('staleness (§4.4, 15-month rule)', () => {
  it('flags a balance older than 15 months', () => {
    // balance_as_of 16 months before asOf ⇒ stale.
    expect(isLoanStale(REF_LOAN, '2027-05-01')).toBe(true);
    expect(loanAgeMonths(REF_LOAN, '2027-05-01')).toBe(16);
  });
  it('does NOT flag a balance 14 months old', () => {
    expect(isLoanStale(REF_LOAN, '2027-03-01')).toBe(false);
    expect(loanAgeMonths(REF_LOAN, '2027-03-01')).toBe(14);
  });
  it('exactly 15 months is the boundary (not yet stale)', () => {
    expect(STALE_LOAN_MONTHS).toBe(15);
    expect(isLoanStale(REF_LOAN, '2027-04-01')).toBe(false); // 15 months, > is the test
    expect(loanAgeMonths(REF_LOAN, '2027-04-01')).toBe(15);
  });
});

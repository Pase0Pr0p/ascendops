// Owner loan amortization — pure, no I/O (master plan §4.4 "amortization
// roll-forward", AL-1). Owners hand us a loan balance once a year; this library
// rolls that balance forward month-by-month so the equity/DSCR/wealth math in
// owner-aggregate.ts never needs a fresh statement.
//
// Standard amortization, per §4.4: each month
//   interest  = balance × (rate_pct / 100 / 12)
//   principal = monthly_pi − interest
//   balance   = balance − principal   (stop at 0; final payment is clamped)
//
// A null loan means the property is owned free & clear — balance is always 0
// and equity == value (§4.5-E). This module is deliberately pure (no fs, no
// network, no clock) so it is trivially unit-testable and reusable by both the
// internal owner view and the future owner portal (§8.1 single-module rule).

/** Owner-supplied loan, per the §4.4 schema. `null` ⇒ owned free & clear. */
export interface Loan {
  lender?: string | null;
  /** Principal balance as reported by the owner, as of `balance_as_of`. */
  balance: number;
  /** ISO date (YYYY-MM-DD) the `balance` figure was accurate. */
  balance_as_of: string;
  /** Annual interest rate as a percent, e.g. 6.25 (not 0.0625). */
  rate_pct: number;
  /** Monthly principal + interest payment — P&I ONLY, excluding any escrow. */
  monthly_pi: number;
  /** Original amortization term in months, e.g. 360 for a 30-year loan. */
  term_months: number;
  origination?: string | null;
}

/** One row of an amortization schedule. */
export interface AmortRow {
  /** 1-based payment number counted from `balance_as_of`. */
  month: number;
  interest: number;
  principal: number;
  /** Remaining balance AFTER this payment. */
  balance: number;
}

/** Number of months (default 15, per §4.4) after which a balance is stale. */
export const STALE_LOAN_MONTHS = 15;

/** Parse a YYYY-MM-DD string to a UTC date. Throws on an unparseable value. */
function parseISODate(iso: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) throw new Error(`owner-amortize: unparseable date "${iso}" (want YYYY-MM-DD)`);
  const [, y, mo, d] = m;
  return new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
}

function toDate(d: string | Date): Date {
  return typeof d === 'string' ? parseISODate(d) : d;
}

/**
 * Whole payment periods elapsed from `from` to `to`. A month only counts once
 * its day-of-month is reached (calendar-month floor); never negative — a target
 * before `balance_as_of` yields 0 (you can't un-amortize a reported balance).
 */
export function monthsElapsed(from: string | Date, to: string | Date): number {
  const a = toDate(from);
  const b = toDate(to);
  let months = (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  if (b.getUTCDate() < a.getUTCDate()) months -= 1;
  return Math.max(0, months);
}

/**
 * Build the amortization schedule for `months` payments starting from
 * `balance_as_of`. Stops early (shorter array) once the balance reaches 0.
 * Returns [] for a null loan or a non-positive month count.
 */
export function amortizationSchedule(loan: Loan | null, months: number): AmortRow[] {
  if (!loan || months <= 0) return [];
  const monthlyRate = loan.rate_pct / 100 / 12;
  const rows: AmortRow[] = [];
  let balance = loan.balance;
  for (let m = 1; m <= months; m++) {
    if (balance <= 0) break;
    const interest = balance * monthlyRate;
    let principal = loan.monthly_pi - interest;
    // Guard the final payment: never pay down past zero.
    if (principal > balance) principal = balance;
    // Negative-amortization guard: if the payment does not even cover interest,
    // clamp principal to 0 so the balance holds flat rather than silently
    // growing — an honest floor, and a signal the loan inputs are inconsistent.
    if (principal < 0) principal = 0;
    balance = balance - principal;
    if (balance < 0) balance = 0;
    rows.push({ month: m, interest, principal, balance });
  }
  return rows;
}

/**
 * Current loan balance rolled forward from `balance_as_of` to `asOf`.
 * Null loan (free & clear) ⇒ 0. A date at/before `balance_as_of` ⇒ the reported
 * balance unchanged. This is the primary consumer entry point (equity = value −
 * this, §4.5-E).
 */
export function currentBalance(loan: Loan | null, asOf: string | Date): number {
  if (!loan) return 0;
  const months = monthsElapsed(loan.balance_as_of, asOf);
  if (months <= 0) return loan.balance;
  const schedule = amortizationSchedule(loan, months);
  if (schedule.length === 0) return loan.balance;
  return schedule[schedule.length - 1].balance;
}

/**
 * Staleness check (§4.4): true when the reported balance is older than
 * `thresholdMonths` (default 15). Null loan is never stale. Drives the
 * "loan data stale — reconfirm" badge on the equity card.
 */
export function isLoanStale(
  loan: Loan | null,
  asOf: string | Date,
  thresholdMonths: number = STALE_LOAN_MONTHS,
): boolean {
  if (!loan) return false;
  return monthsElapsed(loan.balance_as_of, asOf) > thresholdMonths;
}

/** How many months old the reported balance is, as of `asOf`. Null loan ⇒ 0. */
export function loanAgeMonths(loan: Loan | null, asOf: string | Date): number {
  if (!loan) return 0;
  return monthsElapsed(loan.balance_as_of, asOf);
}

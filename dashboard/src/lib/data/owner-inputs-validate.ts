// Owner-inputs store: schema + validator (master plan §4.4, AL-1).
//
// `config/owner-inputs.json` (GITIGNORED — real loan balances are
// owner-confidential) holds per-property, owner-supplied loan + carry-cost data
// that no API gives us: current loan balance, rate, P&I, and the tax/insurance
// carry costs. This module is the validator the capture step runs before the
// data is ever trusted.
//
// It enforces the three §4.4 rules:
//   1. escrowed and via_pm are MUTUALLY EXCLUSIVE per item (tax, insurance).
//      Both true is a contradiction: a cost can't ride inside the mortgage
//      escrow AND be paid through the PM ledger.
//   2. If escrowed=true, monthly_pi must be P&I-ONLY (excluding escrow) — the
//      double-count trap of §4.4. We can't verify the number, so we WARN the
//      capturer to confirm it excludes escrow.
//   3. Staleness: a balance_as_of older than 15 months is flagged so equity
//      renders with a "reconfirm" badge instead of a wrong number.
//
// Pure (no I/O): callers read the JSON, this validates the parsed object.

import type { Loan } from './owner-amortize';
import { STALE_LOAN_MONTHS, monthsElapsed } from './owner-amortize';

/** Per-property carry costs outside the loan P&I (§4.4). */
export interface Carry {
  hoa_monthly: number;
  tax_annual: number;
  /** Taxes paid THROUGH the PM (already in AppFolio expenses / NOI). */
  taxes_via_pm: boolean;
  /** Taxes ride inside monthly_pi's escrow (so monthly_pi must be P&I-only). */
  tax_escrowed: boolean;
  insurance_annual: number;
  /** Insurance paid THROUGH the PM (already in AppFolio expenses / NOI). */
  insurance_via_pm: boolean;
  /** Insurance rides inside monthly_pi's escrow. */
  insurance_escrowed: boolean;
}

/** Optional per-property acquisition data (unlocks CoC + since-purchase). */
export interface OwnerOptional {
  purchase_price?: number;
  purchase_date?: string;
  cash_invested?: number;
}

/** One property's owner-supplied inputs. `loan: null` ⇒ owned free & clear. */
export interface OwnerPropertyInputs {
  loan: Loan | null;
  carry: Carry;
  optional?: OwnerOptional;
}

/** The whole store: keyed by AppFolio property id (string key). */
export interface OwnerInputs {
  properties: Record<string, OwnerPropertyInputs>;
}

export type IssueCode =
  | 'not_an_object'
  | 'missing_properties'
  | 'missing_field'
  | 'wrong_type'
  | 'escrow_viapm_conflict'
  | 'escrow_pi_note'
  | 'loan_stale';

/** A single validation finding, scoped to a property (and field where known). */
export interface ValidationIssue {
  property_id: string;
  field: string;
  code: IssueCode;
  message: string;
}

export interface ValidationResult {
  /** false if there is ANY error; warnings alone keep this true. */
  ok: boolean;
  errors: ValidationIssue[];
  /** Non-blocking: escrow P&I notes + staleness flags. */
  warnings: ValidationIssue[];
}

const LOAN_NUMERIC_FIELDS: (keyof Loan)[] = ['balance', 'rate_pct', 'monthly_pi', 'term_months'];
const CARRY_NUMERIC_FIELDS: (keyof Carry)[] = ['hoa_monthly', 'tax_annual', 'insurance_annual'];
const CARRY_BOOL_FIELDS: (keyof Carry)[] = [
  'taxes_via_pm',
  'tax_escrowed',
  'insurance_via_pm',
  'insurance_escrowed',
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed owner-inputs object against the §4.4 schema + rules.
 *
 * @param raw  the JSON.parse'd config (unknown shape — fully guarded here)
 * @param asOf the reference date for staleness (defaults to now)
 */
export function validateOwnerInputs(raw: unknown, asOf: string | Date = new Date()): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const err = (property_id: string, field: string, code: IssueCode, message: string) =>
    errors.push({ property_id, field, code, message });
  const warn = (property_id: string, field: string, code: IssueCode, message: string) =>
    warnings.push({ property_id, field, code, message });

  if (!isObject(raw)) {
    err('<root>', '<root>', 'not_an_object', 'owner-inputs must be a JSON object');
    return { ok: false, errors, warnings };
  }
  if (!isObject(raw.properties)) {
    err('<root>', 'properties', 'missing_properties', 'owner-inputs must have a `properties` object');
    return { ok: false, errors, warnings };
  }

  for (const [pid, entryUnknown] of Object.entries(raw.properties)) {
    if (!isObject(entryUnknown)) {
      err(pid, '<property>', 'wrong_type', `property "${pid}" must be an object`);
      continue;
    }
    const entry = entryUnknown as Record<string, unknown>;

    // ---- loan (null = free & clear is valid) ----
    if (!('loan' in entry)) {
      err(pid, 'loan', 'missing_field', `property "${pid}" is missing \`loan\` (use null for free & clear)`);
    } else if (entry.loan !== null) {
      const loan = entry.loan;
      if (!isObject(loan)) {
        err(pid, 'loan', 'wrong_type', `property "${pid}" \`loan\` must be an object or null`);
      } else {
        for (const f of LOAN_NUMERIC_FIELDS) {
          if (!(f in loan)) {
            err(pid, `loan.${f}`, 'missing_field', `property "${pid}" loan is missing \`${f}\``);
          } else if (typeof loan[f] !== 'number' || Number.isNaN(loan[f])) {
            err(pid, `loan.${f}`, 'wrong_type', `property "${pid}" loan.${f} must be a number`);
          }
        }
        if (!('balance_as_of' in loan)) {
          err(pid, 'loan.balance_as_of', 'missing_field', `property "${pid}" loan is missing \`balance_as_of\``);
        } else if (typeof loan.balance_as_of !== 'string') {
          err(pid, 'loan.balance_as_of', 'wrong_type', `property "${pid}" loan.balance_as_of must be a YYYY-MM-DD string`);
        } else {
          // Staleness (§4.4) — a warning, not an error; equity still renders,
          // badged. Guard bad date strings so validation never throws.
          try {
            if (monthsElapsed(loan.balance_as_of, asOf) > STALE_LOAN_MONTHS) {
              warn(
                pid,
                'loan.balance_as_of',
                'loan_stale',
                `property "${pid}" loan balance is older than ${STALE_LOAN_MONTHS} months (as of ${loan.balance_as_of}); reconfirm before showing equity`,
              );
            }
          } catch {
            err(pid, 'loan.balance_as_of', 'wrong_type', `property "${pid}" loan.balance_as_of is not a valid date`);
          }
        }
      }
    }

    // ---- carry (always required) ----
    if (!('carry' in entry) || !isObject(entry.carry)) {
      err(pid, 'carry', 'missing_field', `property "${pid}" is missing a \`carry\` object`);
      continue;
    }
    const carry = entry.carry as Record<string, unknown>;
    for (const f of CARRY_NUMERIC_FIELDS) {
      if (!(f in carry)) {
        err(pid, `carry.${f}`, 'missing_field', `property "${pid}" carry is missing \`${f}\``);
      } else if (typeof carry[f] !== 'number' || Number.isNaN(carry[f])) {
        err(pid, `carry.${f}`, 'wrong_type', `property "${pid}" carry.${f} must be a number`);
      }
    }
    for (const f of CARRY_BOOL_FIELDS) {
      if (!(f in carry)) {
        err(pid, `carry.${f}`, 'missing_field', `property "${pid}" carry is missing \`${f}\``);
      } else if (typeof carry[f] !== 'boolean') {
        err(pid, `carry.${f}`, 'wrong_type', `property "${pid}" carry.${f} must be a boolean`);
      }
    }

    // ---- rule 1: escrowed ⊕ via_pm, per item (only when both are booleans) ----
    if (carry.tax_escrowed === true && carry.taxes_via_pm === true) {
      err(
        pid,
        'carry.tax',
        'escrow_viapm_conflict',
        `property "${pid}": tax cannot be both escrowed and paid via PM; these are mutually exclusive (§4.4)`,
      );
    }
    if (carry.insurance_escrowed === true && carry.insurance_via_pm === true) {
      err(
        pid,
        'carry.insurance',
        'escrow_viapm_conflict',
        `property "${pid}": insurance cannot be both escrowed and paid via PM; these are mutually exclusive (§4.4)`,
      );
    }

    // ---- rule 2: escrowed ⇒ monthly_pi must be P&I-only (warn) ----
    if (carry.tax_escrowed === true) {
      warn(
        pid,
        'loan.monthly_pi',
        'escrow_pi_note',
        `property "${pid}": tax is escrowed; confirm monthly_pi is P&I ONLY (excludes tax escrow), else NCF double-counts (§4.4)`,
      );
    }
    if (carry.insurance_escrowed === true) {
      warn(
        pid,
        'loan.monthly_pi',
        'escrow_pi_note',
        `property "${pid}": insurance is escrowed; confirm monthly_pi is P&I ONLY (excludes insurance escrow), else NCF double-counts (§4.4)`,
      );
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

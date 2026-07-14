/**
 * Email body parser for utility bills.
 * Best-effort regex extraction — flags PARSE_INCOMPLETE when key fields missing.
 * bill_hash = SHA256(provider_slug || account_number || period_start)
 */

import { createHash } from 'node:crypto';

export interface ParsedBill {
  providerHint: string | null;
  accountNumber: string | null;
  periodStart: string | null;   // YYYY-MM-DD
  periodEnd: string | null;     // YYYY-MM-DD
  amountDue: number | null;     // dollar decimal, e.g. 150.25 — matches amount_due numeric column
  parseComplete: boolean;       // false = flag_type PARSE_INCOMPLETE
}

// Parse amount strings → dollar decimal (e.g. 150.25, -592.31, 0.00).
// Handles: "$123.45", "-$592.31", "($592.31)" (accounting notation = negative), "0.00".
function parseDollars(s: string): number | null {
  const trimmed = s.trim();
  // Accounting notation: (amount) → negative
  const isAccounting = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed.replace(/[$()\s,]/g, '');
  const n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  const value = isAccounting ? -Math.abs(n) : n;
  return Math.round(value * 100) / 100; // 2dp dollar decimal
}

// Parse date strings into YYYY-MM-DD. Handles "MM/DD/YYYY", "Month DD, YYYY", "YYYY-MM-DD"
function parseDate(s: string): string | null {
  // ISO format
  if (/^\d{4}-\d{2}-\d{2}$/.test(s.trim())) return s.trim();

  // MM/DD/YYYY
  const mdyMatch = s.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const [, m, d, y] = mdyMatch;
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }

  // "Month DD, YYYY" or "Month DD YYYY"
  const months: Record<string, string> = {
    january: '01', february: '02', march: '03', april: '04',
    may: '05', june: '06', july: '07', august: '08',
    september: '09', october: '10', november: '11', december: '12',
  };
  const longMatch = s.trim().match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (longMatch) {
    const [, mon, d, y] = longMatch;
    const monthNum = months[mon.toLowerCase()];
    if (monthNum) return `${y}-${monthNum}-${d.padStart(2, '0')}`;
  }

  return null;
}

// Identify provider from sender email domain or subject keywords
function detectProvider(from: string, subject: string): string | null {
  const fromLower = from.toLowerCase();
  const subjLower = subject.toLowerCase();

  if (fromLower.includes('pge.com') || fromLower.includes('pg&e') || subjLower.includes('pg&e') || subjLower.includes('pacific gas')) {
    return 'PG&E';
  }
  if (fromLower.includes('marinwater') || fromLower.includes('marin water') || subjLower.includes('marin water')) {
    return 'Marin Water';
  }
  if (fromLower.includes('mcstopwater') || subjLower.includes('marin municipal water')) {
    return 'Marin Water';
  }
  if (fromLower.includes('recology') || subjLower.includes('recology')) {
    return 'Recology';
  }
  if (fromLower.includes('comcast') || fromLower.includes('xfinity') || subjLower.includes('xfinity')) {
    return 'Comcast/Xfinity';
  }
  if (fromLower.includes('sonic.net') || subjLower.includes('sonic')) {
    return 'Sonic';
  }
  return null;
}

// Extract account number — various utility formats
function extractAccountNumber(text: string): string | null {
  const patterns = [
    /account\s+(?:number|#|no\.?)[:.\s]+([0-9\-]{4,20})/i,
    /acct\.?\s*(?:no\.?|#)?[:.\s]+([0-9\-]{4,20})/i,
    /service\s+account[:.\s]+([0-9\-]{4,20})/i,
    /customer\s+(?:number|id|account)[:.\s]+([0-9\-]{4,20})/i,
  ];
  for (const pat of patterns) {
    const m = text.match(pat);
    if (m) return m[1].trim();
  }
  return null;
}

// Extract billing period dates
function extractPeriod(text: string): { start: string | null; end: string | null } {
  // "Service period: MM/DD/YYYY – MM/DD/YYYY"
  const periodMatch = text.match(
    /(?:service|billing|bill)\s+period[:.\s]+([A-Za-z0-9\/,\s]+?)\s*(?:–|to|-|through)\s*([A-Za-z0-9\/,\s]+)/i,
  );
  if (periodMatch) {
    return {
      start: parseDate(periodMatch[1].trim()),
      end: parseDate(periodMatch[2].trim()),
    };
  }

  // "From MM/DD/YYYY to MM/DD/YYYY"
  const fromToMatch = text.match(
    /from\s+([A-Za-z0-9\/,\s]+?)\s+to\s+([A-Za-z0-9\/,\s]+)/i,
  );
  if (fromToMatch) {
    return {
      start: parseDate(fromToMatch[1].trim()),
      end: parseDate(fromToMatch[2].trim()),
    };
  }

  return { start: null, end: null };
}

// Extract amount due — handles positive, zero, negative, and accounting notation.
// Capture group includes optional leading minus and parentheses so parseDollars gets full context.
function extractAmount(text: string): number | null {
  // Positive/negative/zero amounts: $123.45, -$592.31, -592.31, ($592.31)
  const amountPattern = '(-?\\s*\\(\\s*)?\\$?(-?[\\d,]+\\.?\\d*)(\\s*\\))?';

  const labelledPatterns = [
    new RegExp(`(?:amount|total)\\s+due[:.\\s]+${amountPattern}`, 'i'),
    new RegExp(`(?:please\\s+pay|pay\\s+this\\s+amount)[:.\\s]+${amountPattern}`, 'i'),
    new RegExp(`(?:balance\\s+due|current\\s+charges)[:.\\s]+${amountPattern}`, 'i'),
    new RegExp(`total\\s+(?:amount|charges)[:.\\s]+${amountPattern}`, 'i'),
    // Zero / credit / refund cases
    new RegExp(`(?:no\\s+amount|amount\\s+due|total\\s+due)[:.\\s]+\\$?0+\\.?0*`, 'i'),
    new RegExp(`(?:credit|refund)[\\s:]+${amountPattern}`, 'i'),
  ];

  for (const pat of labelledPatterns) {
    const m = text.match(pat);
    if (!m) continue;
    // Zero pattern (no capture group)
    if (/no.amount|amount.due.*0+\.?0*$/i.test(m[0]) && !m[1] && !m[2]) {
      return 0;
    }
    // For credit/refund patterns, amount is positive in text but semantically negative
    const isCredit = /^(?:credit|refund)/i.test(m[0].trim());
    const raw = (m[1] ?? '') + (m[2] ?? '') + (m[3] ?? '');
    const value = parseDollars(raw.trim());
    if (value == null) continue;
    // Negate credit amounts — a credit balance is negative from the bill perspective
    return isCredit ? -Math.abs(value) : value;
  }
  return null;
}

export function parseBillEmail(subject: string, bodyText: string, from: string): ParsedBill {
  const combined = `${subject}\n${bodyText}`;
  const providerHint = detectProvider(from, subject);
  const accountNumber = extractAccountNumber(combined);
  const { start: periodStart, end: periodEnd } = extractPeriod(combined);
  const amountDueCents = extractAmount(combined); // dollar decimal

  // Parse is considered complete if we have provider, account, and period start
  const parseComplete = !!(providerHint && accountNumber && periodStart);

  return {
    providerHint,
    accountNumber,
    periodStart,
    periodEnd,
    amountDue: amountDueCents,
    parseComplete,
  };
}

// SHA256(provider_slug || account_number || period_start) — must match DB definition
export function computeBillHash(providerSlug: string, accountNumber: string, periodStart: string): string {
  return createHash('sha256')
    .update(`${providerSlug}${accountNumber}${periodStart}`)
    .digest('hex');
}

export function computePdfHash(pdfBuffer: Buffer): string {
  return createHash('sha256').update(pdfBuffer).digest('hex');
}

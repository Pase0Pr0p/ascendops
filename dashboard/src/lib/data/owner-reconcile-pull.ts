import {
  reconcileOwnerStatement,
  type OwnerReconResult,
  type OwnerStatementTotals,
} from './owner-reconcile';
import type { EntityRegistry } from './pulse';
import type { OwnerFinancialsSnapshot, GlClass } from './owner-aggregate';
import { ALL_SCOPE, resolveScope, type ResolvedScope } from './pulse-scope';

type StatementGlClass = GlClass | 'deposit';

export interface OwnerStatementLine {
  date: string;
  payer_payee?: string | null;
  type?: string | null;
  reference?: string | null;
  description: string | null;
  income: number | null;
  expense: number | null;
  balance?: number | null;
  gl_class: StatementGlClass | null;
}

export interface OwnerStatementProperty {
  property_name: string | null;
  beginning_balance: number;
  ending_balance: number;
  total_income: number;
  total_expense: number;
  bills_due_total?: number;
  required_reserves?: number | null;
  work_order_estimates?: number | null;
  lines: OwnerStatementLine[];
}

export interface OwnerStatementDocument {
  report?: 'owner_statement';
  owner_name?: string | null;
  owner_id?: string;
  entities_owner_id: string;
  appfolio_owner_id?: string;
  party_id?: string;
  period_from: string;
  period_to: string;
  properties: OwnerStatementProperty[];
}

export interface OwnerStatementFeed {
  lane: 'owner_statements';
  generated_at: string;
  period: { from: string; to: string };
  statements: OwnerStatementDocument[];
  errors?: { owner_name?: string | null; appfolio_owner_id?: string | null; error: string }[];
}

export interface ReconAdjustment {
  field: 'income' | 'expenses';
  category: string;
  amount: number;
  rule:
    | 'owner-draw-excluded'
    | 'deposit-liability-excluded'
    | 'non-noi-excluded'
    | 'unmatched-passthrough';
}

export interface KnownDelta {
  owner_id: string | '*';
  field: string;
  amount?: number;
  max_abs?: number;
  explanation: string;
  added: string;
  approved_by: string;
}

export interface ReconWithKnowns {
  result: OwnerReconResult;
  effective_status: 'green' | 'red';
  known_deltas: OwnerReconResult['deltas'];
  adjustments: ReconAdjustment[];
}

export interface OwnerReconRow extends ReconWithKnowns {
  owner_id: string;
  owner_name: string;
  attribution: 'ok' | 'blocked';
  attribution_reason?: string;
  unlocks?: string;
}

export interface OwnerReconRun {
  period: string;
  generated_at: string;
  company: ReconWithKnowns;
  owners: OwnerReconRow[];
}

const MONEY_CLASSES: ReadonlySet<GlClass> = new Set([
  'expense_operating',
  'passthrough_tax',
  'passthrough_insurance',
]);

const DEPOSIT_RE = /\b(security deposit|deposit receipt|mgmt held security deposits?)\b/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

function amount(line: OwnerStatementLine): number {
  return round2((line.income ?? 0) - (line.expense ?? 0));
}

function categoryOf(line: OwnerStatementLine): string {
  const desc = (line.description ?? 'Uncategorized').trim() || 'Uncategorized';
  const parts = desc.split(' - ').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2 && /^(unit|apt|apartment|suite|#|\d)/i.test(parts[0])) {
    return parts[1];
  }
  return parts[0] || desc;
}

function addSignedLine(line: OwnerStatementLine, target: 'income' | 'expenses'): number {
  if (target === 'income') return line.income ?? (line.expense != null ? -line.expense : amount(line));
  return line.expense ?? (line.income != null ? -line.income : -amount(line));
}

export function statementTotalsForOwner(stmt: OwnerStatementDocument): {
  totals: OwnerStatementTotals;
  adjustments: ReconAdjustment[];
} {
  let income = 0;
  let expenses = 0;
  const byCategory: Record<string, number> = {};
  const adjustments: ReconAdjustment[] = [];
  let includeByCategory = true;

  for (const prop of stmt.properties) {
    for (const line of prop.lines) {
      const value = amount(line);
      const category = categoryOf(line);
      if (DEPOSIT_RE.test(line.description ?? category) || line.gl_class === 'deposit') {
        includeByCategory = false;
        adjustments.push({
          field: 'income',
          category,
          amount: line.income ?? value,
          rule: 'deposit-liability-excluded',
        });
        continue;
      }
      if (line.gl_class == null) {
        includeByCategory = false;
        if (value !== 0) {
          const field = line.expense != null && line.income == null ? 'expenses' : 'income';
          adjustments.push({
            field,
            category,
            amount: field === 'expenses' ? addSignedLine(line, 'expenses') : addSignedLine(line, 'income'),
            rule: 'unmatched-passthrough',
          });
        }
        if (line.expense != null && line.income == null) expenses += addSignedLine(line, 'expenses');
        else income += addSignedLine(line, 'income');
        continue;
      }

      if (line.gl_class === 'owner_draw') {
        includeByCategory = false;
        adjustments.push({
          field: 'expenses',
          category,
          amount: addSignedLine(line, 'expenses'),
          rule: 'owner-draw-excluded',
        });
        continue;
      }
      if (line.gl_class === 'income') {
        const signed = addSignedLine(line, 'income');
        income += signed;
        byCategory[category] = round2((byCategory[category] ?? 0) + signed);
      } else if (MONEY_CLASSES.has(line.gl_class)) {
        const signed = addSignedLine(line, 'expenses');
        expenses += signed;
        byCategory[category] = round2((byCategory[category] ?? 0) + signed);
      } else {
        includeByCategory = false;
        adjustments.push({
          field: 'expenses',
          category,
          amount: addSignedLine(line, 'expenses'),
          rule: 'non-noi-excluded',
        });
      }
    }
  }

  const totals: OwnerStatementTotals = {
    owner_id: stmt.entities_owner_id,
    period: monthOf(stmt.period_from),
    from: monthOf(stmt.period_from),
    to: monthOf(stmt.period_to),
    income: round2(income),
    expenses: round2(expenses),
    net: round2(income - expenses),
  };
  if (includeByCategory) totals.by_category = byCategory;
  return { totals, adjustments };
}

function covers(delta: OwnerReconResult['deltas'][number], ownerId: string, known: KnownDelta): boolean {
  if (known.owner_id !== '*' && known.owner_id !== ownerId) return false;
  if (known.field !== delta.field) return false;
  const abs = Math.abs(delta.delta);
  if (known.max_abs != null) return abs <= known.max_abs;
  if (known.amount != null) return Math.abs(abs - Math.abs(known.amount)) <= 0.01;
  return false;
}

export function applyKnownDeltas(result: OwnerReconResult, known: KnownDelta[]): ReconWithKnowns {
  const covered: OwnerReconResult['deltas'] = [];
  const open = result.deltas.filter((delta) => {
    const match = known.find((k) => covers(delta, result.owner_id, k));
    if (match) covered.push(delta);
    return !match;
  });
  return {
    result,
    effective_status: open.length === 0 ? 'green' : 'red',
    known_deltas: covered,
    adjustments: [],
  };
}

function ownerScope(ownerId: string, entities: EntityRegistry): { scope: ResolvedScope; name: string } | null {
  const resolved = resolveScope({ kind: 'owner', id: ownerId }, entities);
  if (resolved.resolved.kind !== 'properties') return null;
  return { scope: resolved.resolved, name: resolved.resolved.label };
}

function attributionReason(snapshot: OwnerFinancialsSnapshot, scope: ResolvedScope): string | null {
  if (scope.kind !== 'properties' || snapshot.records.length === 0) return null;
  if (snapshot.records.every((record) => record.property_id == null)) {
    const nv = snapshot.needs_verification?.property_attribution as { why?: string } | undefined;
    return nv?.why ?? 'Owner financial records are not attributed to properties yet.';
  }
  return null;
}

function companyTotals(statements: OwnerStatementDocument[]): OwnerStatementTotals {
  let income = 0;
  let expenses = 0;
  const byCategory: Record<string, number> = {};
  let includeByCategory = true;
  let from = statements[0]?.period_from ?? '';
  let to = statements[0]?.period_to ?? '';
  for (const stmt of statements) {
    const { totals } = statementTotalsForOwner(stmt);
    income += totals.income;
    expenses += totals.expenses;
    from = from < stmt.period_from ? from : stmt.period_from;
    to = to > stmt.period_to ? to : stmt.period_to;
    if (!totals.by_category) includeByCategory = false;
    for (const [category, value] of Object.entries(totals.by_category ?? {})) {
      byCategory[category] = round2((byCategory[category] ?? 0) + value);
    }
  }
  const totals: OwnerStatementTotals = {
    owner_id: 'company',
    period: monthOf(from),
    from: monthOf(from),
    to: monthOf(to),
    income: round2(income),
    expenses: round2(expenses),
    net: round2(income - expenses),
  };
  if (includeByCategory && Object.keys(byCategory).length > 0) totals.by_category = byCategory;
  return totals;
}

export function runOwnerReconciliation(
  snapshot: OwnerFinancialsSnapshot,
  entities: EntityRegistry,
  feed: OwnerStatementFeed,
  known: { deltas?: KnownDelta[] } | KnownDelta[] = [],
): OwnerReconRun {
  const knownDeltas = Array.isArray(known) ? known : known.deltas ?? [];
  const owners: OwnerReconRow[] = [];
  for (const statement of feed.statements) {
    const resolved = ownerScope(statement.entities_owner_id, entities);
    if (!resolved) continue;
    const { totals, adjustments } = statementTotalsForOwner(statement);
    const result = reconcileOwnerStatement(snapshot, resolved.scope, totals);
    const wrapped = applyKnownDeltas(result, knownDeltas);
    const blocked = attributionReason(snapshot, resolved.scope);
    owners.push({
      ...wrapped,
      adjustments,
      owner_id: statement.entities_owner_id,
      owner_name: resolved.name,
      attribution: blocked ? 'blocked' : 'ok',
      attribution_reason: blocked ?? undefined,
      unlocks: 'per-property statement feed available',
    });
  }

  const companyResult = reconcileOwnerStatement(snapshot, ALL_SCOPE, companyTotals(feed.statements));
  const company = applyKnownDeltas(companyResult, knownDeltas);
  return {
    period: monthOf(feed.period.from),
    generated_at: feed.generated_at,
    company,
    owners,
  };
}

export function isOwnerPublishable(run: OwnerReconRun, ownerId: string): boolean {
  const row = run.owners.find((owner) => owner.owner_id === ownerId);
  return Boolean(row && row.attribution === 'ok' && row.effective_status === 'green');
}

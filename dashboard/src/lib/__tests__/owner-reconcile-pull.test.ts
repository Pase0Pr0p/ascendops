import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

import ownerFixtureJson from '@/lib/data/__fixtures__/pulse-slice/owner-financials.json';
import ownerStatementsJson from '@/lib/data/__fixtures__/pulse-slice/owner-statements.json';
import entitiesJson from '@/lib/data/__fixtures__/pulse-slice/entities.json';
import type { EntityRegistry } from '@/lib/data/pulse';
import type { OwnerFinancialsSnapshot } from '@/lib/data/owner-aggregate';
import {
  applyKnownDeltas,
  isOwnerPublishable,
  runOwnerReconciliation,
  statementTotalsForOwner,
  type OwnerStatementFeed,
  type OwnerStatementDocument,
} from '@/lib/data/owner-reconcile-pull';
import { reconcileTotals } from '@/lib/data/owner-reconcile';

const owner = ownerFixtureJson as unknown as OwnerFinancialsSnapshot;
const feed = ownerStatementsJson as unknown as OwnerStatementFeed;
const entities = entitiesJson as unknown as EntityRegistry;
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

const syntheticStmt: OwnerStatementDocument = {
  entities_owner_id: 'o_1',
  owner_name: 'Harbor Point LLC',
  period_from: '2026-06-01',
  period_to: '2026-06-30',
  properties: [
    {
      property_name: 'Moss Dr',
      beginning_balance: 100,
      ending_balance: 6300,
      total_income: 6750,
      total_expense: 550,
      bills_due_total: 0,
      lines: [
        {
          date: '2026-06-01',
          description: 'Rent Income - June',
          income: 3000,
          expense: null,
          gl_class: 'income',
        },
        {
          date: '2026-06-02',
          description: 'NSF Fees Collected - Reversal pair income',
          income: 35,
          expense: null,
          gl_class: 'income',
        },
        {
          date: '2026-06-03',
          description: 'NSF Fees Collected - Reversal pair expense',
          income: null,
          expense: 35,
          gl_class: 'income',
        },
        {
          date: '2026-06-04',
          description: 'Management Fees - June',
          income: null,
          expense: 300,
          gl_class: 'expense_operating',
        },
        {
          date: '2026-06-05',
          description: 'Owner Distribution - June',
          income: null,
          expense: 250,
          gl_class: 'owner_draw',
        },
        {
          date: '2026-06-06',
          description: 'Security Deposit Receipt',
          income: 500,
          expense: null,
          gl_class: 'income',
        },
        {
          date: '2026-06-07',
          description: 'Unmapped Statement Line',
          income: 3250,
          expense: null,
          gl_class: null,
        },
      ],
    },
  ],
};

describe('owner statement feed mapping', () => {
  it('reclassifies owner draw and deposits while recording unmatched passthrough', () => {
    const { totals, adjustments } = statementTotalsForOwner(syntheticStmt);
    expect(totals.income).toBe(6250);
    expect(totals.expenses).toBe(300);
    expect(totals.net).toBe(5950);
    expect(totals.by_category).toBeUndefined();
    expect(adjustments).toContainEqual({
      field: 'expenses',
      category: 'Owner Distribution',
      amount: 250,
      rule: 'owner-draw-excluded',
    });
    expect(adjustments).toContainEqual({
      field: 'income',
      category: 'Security Deposit Receipt',
      amount: 500,
      rule: 'deposit-liability-excluded',
    });
    expect(adjustments).toContainEqual({
      field: 'income',
      category: 'Unmapped Statement Line',
      amount: 3250,
      rule: 'unmatched-passthrough',
    });
  });

  it('includes by_category only when every line is classified and comparable', () => {
    const complete = clone(syntheticStmt);
    complete.properties[0].lines = [
      {
        date: '2026-06-01',
        description: 'Rent Income - June',
        income: 3000,
        expense: null,
        gl_class: 'income',
      },
      {
        date: '2026-06-04',
        description: 'Management Fees - June',
        income: null,
        expense: 300,
        gl_class: 'expense_operating',
      },
      {
        date: '2026-06-08',
        description: 'Management Fees - Credit',
        income: null,
        expense: -25,
        gl_class: 'expense_operating',
      },
    ];
    const { totals } = statementTotalsForOwner(complete);
    expect(totals.by_category).toMatchObject({
      'Rent Income': 3000,
      'Management Fees': 275,
    });
    const partial = clone(complete);
    partial.properties[0].lines[0].gl_class = null;
    expect(statementTotalsForOwner(partial).totals.by_category).toBeUndefined();
    const excluded = clone(complete);
    excluded.properties[0].lines.push({
      date: '2026-06-09',
      description: 'Owner Distribution - June',
      income: null,
      expense: 100,
      gl_class: 'owner_draw',
    });
    expect(statementTotalsForOwner(excluded).totals.by_category).toBeUndefined();
  });

  it('records debt service and capex exclusions instead of hiding them', () => {
    const stmt = clone(syntheticStmt);
    stmt.properties[0].lines = [
      {
        date: '2026-06-10',
        description: 'Mortgage Interest - June',
        income: null,
        expense: 800,
        gl_class: 'debt_service',
      },
      {
        date: '2026-06-11',
        description: 'Roof Replacement - June',
        income: null,
        expense: 5000,
        gl_class: 'expense_capex',
      },
    ];
    const { totals, adjustments } = statementTotalsForOwner(stmt);
    expect(totals.expenses).toBe(0);
    expect(totals.by_category).toBeUndefined();
    expect(adjustments).toContainEqual({
      field: 'expenses',
      category: 'Mortgage Interest',
      amount: 800,
      rule: 'non-noi-excluded',
    });
    expect(adjustments).toContainEqual({
      field: 'expenses',
      category: 'Roof Replacement',
      amount: 5000,
      rule: 'non-noi-excluded',
    });
  });
});

describe('known deltas and publish gate', () => {
  it('moves covered deltas to visible known_deltas without mutating the inner result', () => {
    const result = reconcileTotals(
      { income: 100, expenses: 20, net: 80, by_category: {} },
      { owner_id: 'o_1', period: '2026-06', income: 105, expenses: 20, net: 85 },
    );
    const wrapped = applyKnownDeltas(result, [
      {
        owner_id: 'o_1',
        field: 'income',
        amount: 5,
        explanation: 'Known timing delta',
        added: '2026-07-11',
        approved_by: 'David',
      },
      {
        owner_id: '*',
        field: 'net',
        max_abs: 5,
        explanation: 'Known timing delta',
        added: '2026-07-11',
        approved_by: 'David',
      },
    ]);
    expect(result.status).toBe('red');
    expect(result.deltas).toHaveLength(2);
    expect(wrapped.effective_status).toBe('green');
    expect(wrapped.known_deltas).toHaveLength(2);
  });

  it('leaves uncovered deltas red', () => {
    const result = reconcileTotals(
      { income: 100, expenses: 20, net: 80, by_category: {} },
      { owner_id: 'o_1', period: '2026-06', income: 107, expenses: 20, net: 87 },
    );
    const wrapped = applyKnownDeltas(result, [
      {
        owner_id: '*',
        field: 'income',
        max_abs: 5,
        explanation: 'Known small timing delta',
        added: '2026-07-11',
        approved_by: 'David',
      },
    ]);
    expect(wrapped.effective_status).toBe('red');
    expect(wrapped.known_deltas).toHaveLength(0);
  });

  it('fails closed for absent owners', () => {
    const run = runOwnerReconciliation(owner, entities, feed, []);
    expect(isOwnerPublishable(run, 'missing-owner')).toBe(false);
  });
});

describe('runOwnerReconciliation', () => {
  it('blocks owner publishability when all snapshot records lack property attribution', () => {
    const allNull = clone(owner);
    allNull.records = allNull.records.map((record) => ({ ...record, property_id: null }));
    allNull.needs_verification = {
      property_attribution: { why: 'per-property GL attribution is not available yet' },
    };
    const run = runOwnerReconciliation(allNull, entities, feed, []);
    expect(run.company.result.status).toBe('green');
    expect(run.owners[0].attribution).toBe('blocked');
    expect(run.owners[0].attribution_reason).toContain('per-property GL attribution');
    expect(isOwnerPublishable(run, 'o_1')).toBe(false);
  });

  it('is publishable for an attributed green owner and company roll-up is green on demo fixtures', () => {
    const run = runOwnerReconciliation(owner, entities, feed, []);
    expect(run.company.effective_status).toBe('green');
    expect(run.owners[0].attribution).toBe('ok');
    expect(run.owners[0].effective_status).toBe('green');
    expect(isOwnerPublishable(run, 'o_1')).toBe(true);
  });

  it('company roll-up turns red with itemized deltas when the statement drifts', () => {
    const drifted = clone(feed);
    drifted.statements[0].properties[0].lines[0].income = 3001;
    const run = runOwnerReconciliation(owner, entities, drifted, []);
    expect(run.company.effective_status).toBe('red');
    expect(run.company.result.deltas.some((delta) => delta.field === 'income')).toBe(true);
  });

  it.skipIf(!fs.existsSync(fileURLToPath(new URL('../../../.pulse-data/owner-statements.json', import.meta.url))))(
    'real owner-statement feed smoke validates run shape only',
    () => {
      const dir = fileURLToPath(new URL('../../../.pulse-data/', import.meta.url));
      const realFeed = JSON.parse(fs.readFileSync(`${dir}owner-statements.json`, 'utf-8')) as OwnerStatementFeed;
      const realOwner = JSON.parse(fs.readFileSync(`${dir}owner-financials.json`, 'utf-8')) as OwnerFinancialsSnapshot;
      const realEntities = JSON.parse(fs.readFileSync(`${dir}entities.json`, 'utf-8')) as EntityRegistry;
      const run = runOwnerReconciliation(realOwner, realEntities, realFeed, []);
      expect(run.period).toMatch(/^\d{4}-\d{2}$/);
      expect(run.company.result.status).toMatch(/^(green|red)$/);
      expect(Array.isArray(run.owners)).toBe(true);
    },
  );
});

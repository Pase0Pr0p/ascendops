import { LaneHeader, StatCard, ComingSoon } from './pulse-ui';
import { FinanceCharts } from './pulse-charts';
import { usd } from '@/lib/data/pulse-health';
import type { FinanceMetrics } from '@/lib/data/pulse';

// `live` comes from the aggregation module when records exist (§6.4), or the
// generator's live block in the records-less fallback.
export function FinanceLane({
  live,
  comingSoon,
}: {
  live: FinanceMetrics['live'];
  comingSoon: FinanceMetrics['coming_soon'];
}) {
  const dq = live.delinquency;
  const dep = live.deposits_held;
  // F-1: operating cash and the trust bank balance are DISTINCT from the
  // deposits-held liability and from each other, and are never summed.
  const op = live.cash_position?.operating;

  return (
    <section className="space-y-4">
      <LaneHeader label="Finance" sub="live · AppFolio financials" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <StatCard
          label="Operating cash"
          value={op && op.status === 'live' ? usd(op.balance) : '·'}
          sub={op && op.status === 'live' ? `as of ${op.as_of}` : 'pending a cash-flow read'}
          accent={!!(op && op.status === 'live')}
        />
        <StatCard label="Total receivable" value={usd(dq.total_receivable)} sub="delinquent balance" accent={dq.total_receivable > 0} />
        <StatCard label="Delinquent accounts" value={String(dq.delinquent_accounts)} sub="with a balance owing" />
        <StatCard label="30+ days past due" value={usd(dq.bucket_30_plus)} sub={`${usd(dq.bucket_0_30)} in 0-30`} accent={dq.bucket_30_plus > 0} />
        <StatCard
          label="Deposits held"
          value={dep && 'status' in dep && dep.status === 'live' ? usd(dep.total) : '·'}
          sub={dep && 'status' in dep && dep.status === 'live' ? `${dep.accounts} accounts, held in trust (liability)` : 'pending'}
        />
        <StatCard
          label="Trust bank balance"
          value="·"
          sub="pending a bank feed, not the deposits liability"
        />
      </div>

      <FinanceCharts
        delinquency={dq}
        deposits={dep && 'status' in dep && dep.status === 'live' ? { total: dep.total, accounts: dep.accounts } : null}
      />

      <ComingSoon slots={comingSoon} />
    </section>
  );
}

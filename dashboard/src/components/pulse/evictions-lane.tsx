import type { EvictionsMetrics } from '@/lib/data/pulse';
import { EVICTIONS_CEILINGS, healthLevel, type NaMap } from '@/lib/data/pulse-aggregate';
import { ComingSoon, LaneHeader, NACard, StatCard, UnmappedChip } from './pulse-ui';

// EVICTIONS — compact lane (master plan §4.3/§5.3, shard C-2 quick-wire),
// built from on-disk rent_roll.csv Status=Evict + delinquency.csv, zero new
// AppFolio access. `live` is ALWAYS the output of aggregateEvictions when
// records exist (global AND scoped — §6.4), or the generator's own live
// block in the records-less fallback. `move_outs_pending` is feed-level (a
// different population than the eviction records) and renders n/a with a
// reason under any scope narrower than ALL — never a stale portfolio number.
export function EvictionsLane({
  live,
  comingSoon,
  na,
  unmapped = 0,
}: {
  live: EvictionsMetrics['live'];
  comingSoon: EvictionsMetrics['coming_soon'];
  na: NaMap;
  unmapped?: number;
}) {
  return (
    <section className="space-y-4">
      <LaneHeader label="Evictions" sub="live · rent roll + delinquency" />

      <UnmappedChip count={unmapped} noun="evictions" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label="Units in eviction"
          value={String(live.units_in_eviction)}
          sub="rent roll Status=Evict"
          accent={live.units_in_eviction > EVICTIONS_CEILINGS.green}
          negative={healthLevel(live.units_in_eviction, EVICTIONS_CEILINGS) === 'red'}
        />
        <StatCard
          label="Balance at risk"
          value={`$${live.balance_at_risk.toLocaleString('en-US')}`}
          sub="delinquency join, rent roll fallback"
        />
        <StatCard
          label="Oldest eviction"
          value={live.oldest_eviction_age_days != null ? `${live.oldest_eviction_age_days}d` : 'n/a'}
          sub={live.oldest_eviction_age_days != null ? 'days since last payment' : 'no last-payment match on file'}
        />
        {na.move_outs_pending ? (
          <NACard label="Move-outs pending" reason={na.move_outs_pending} />
        ) : (
          <StatCard
            label="Move-outs pending"
            value={live.move_outs_pending != null ? String(live.move_outs_pending) : 'n/a'}
            sub="notice-rented + notice-unrented"
          />
        )}
      </div>

      <ComingSoon slots={comingSoon} />
    </section>
  );
}

import type { RenewalsMetrics } from '@/lib/data/pulse';
import { RENEWALS_NOT_STARTED_CEILINGS, type NaMap } from '@/lib/data/pulse-aggregate';
import { BarList, ComingSoon, LaneHeader, NAPanel, StatCard, UnmappedChip } from './pulse-ui';

// RENEWALS — its own lane, promoted out of the leasing widget (master plan
// §4.2/§5.2, shard C-1). `live` is ALWAYS the output of aggregateRenewals when
// records exist (global AND scoped — §6.4), or the generator's own live block
// in the records-less fallback. `na` is always {} today (every bucket here is
// resident-scopable, unlike the turns lane) but is threaded through for
// interface parity with the other lanes and to render honestly if a future
// scope type ever needs one. `unmapped` counts renewals excluded from a
// scoped view because the tracker carries no numeric property_id yet (see the
// generator docstring) — rendered as an explicit chip, never silently dropped.
export function RenewalsLane({
  live,
  comingSoon,
  na,
  unmapped = 0,
}: {
  live: RenewalsMetrics['live'];
  comingSoon: RenewalsMetrics['coming_soon'];
  na: NaMap;
  unmapped?: number;
}) {
  if (na.renewals) {
    return (
      <section className="space-y-4">
        <LaneHeader label="Renewals" sub="live · renewals tracker" />
        <NAPanel title="Renewals" reason={na.renewals} />
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <LaneHeader label="Renewals" sub="live · renewals tracker" />

      <UnmappedChip count={unmapped} noun="renewals" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="In intake window" value={String(live.in_window)} sub="~90-day renewal window" />
        <StatCard
          label="Not started"
          value={String(live.not_started)}
          sub="no offer out yet"
          accent={live.not_started > RENEWALS_NOT_STARTED_CEILINGS.amber}
        />
        <StatCard label="Out for signing" value={String(live.out_for_signing)} sub="offer sent, awaiting signature" />
        <StatCard
          label="Expiring ≤ 7d"
          value={String(live.offers_expiring_7d)}
          sub="lease end within a week"
          accent={live.offers_expiring_7d > 0}
        />
      </div>

      {Object.keys(live.by_status).length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">No renewals on the tracker right now.</p>
      ) : (
        <BarList
          title="Renewals by status"
          rows={Object.entries(live.by_status).map(([label, count]) => ({ label, count }))}
        />
      )}

      <ComingSoon slots={comingSoon} />
    </section>
  );
}

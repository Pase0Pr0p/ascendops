import { LaneHeader, StatCard, ComingSoon, UnmappedChip } from './pulse-ui';
import { MaintenanceCharts } from './pulse-charts';
import type { MaintenanceMetrics } from '@/lib/data/pulse';

// `live` comes from the aggregation module when records exist (§6.4), or the
// generator's live block in the records-less fallback. `unmappedOpen` counts
// open melds excluded from a scoped view because they have no property link
// yet (pre-D-2) — rendered as an explicit chip, never silently dropped (§6.5).
export function MaintenanceLane({
  live,
  comingSoon,
  unmappedOpen = 0,
}: {
  live: MaintenanceMetrics['live'];
  comingSoon: MaintenanceMetrics['coming_soon'];
  unmappedOpen?: number;
}) {
  const m = live;
  const urgent = m.emergency + m.high_priority;

  return (
    <section className="space-y-4">
      <LaneHeader label="Maintenance" sub="live · Property Meld" />

      <UnmappedChip count={unmappedOpen} noun="open melds" />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open work orders" value={String(m.open_work_orders)} sub={`oldest ${m.oldest_open_days ?? '·'}d open`} />
        <StatCard label="Genuinely unassigned" value={String(m.genuinely_unassigned)} sub="real signal · needs a tech" accent={m.genuinely_unassigned > 0} />
        <StatCard label="Emergency / high" value={String(urgent)} sub={`${m.emergency} emergency · ${m.high_priority} high`} accent={m.emergency > 0} />
        <StatCard label="Completed · 7d" value={m.completed_last_7d != null ? String(m.completed_last_7d) : '·'} sub="closed this week" />
      </div>

      <MaintenanceCharts
        aging={m.aging_buckets}
        priority={m.priority_breakdown}
        openTotal={m.open_work_orders}
      />

      <ComingSoon slots={comingSoon} />
    </section>
  );
}

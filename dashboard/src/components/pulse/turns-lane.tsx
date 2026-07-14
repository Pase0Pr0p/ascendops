import { Card, CardContent } from '@/components/ui/card';
import type { TurnsMetrics } from '@/lib/data/pulse';
import {
  healthLevel,
  PAST_TARGET_CEILINGS,
  STALLED_CEILINGS,
  type NaMap,
} from '@/lib/data/pulse-aggregate';
import { BarList, ComingSoon, HealthTile, LaneHeader, NACard, NAPanel, StatCard, UnmappedChip } from './pulse-ui';

// TURNOVERS + MAKE-READY — one lane section, two sub-rows (§2.2/§4.4/§4.5):
// they share one source (/api/unit_turns) and one mental model — the turn IS
// the container, make-ready is its pipeline.
//
// `live` is ALWAYS the output of aggregateTurns when records exist (global AND
// scoped — §6.4), or the generator's own live block in the records-less
// fallback. `na` marks blocks that cannot honestly be computed for the active
// scope (whole lane under a resident scope; avg/completed-30d under any
// slice); those slots render n/a + reason, never a number. `unmappedOpen`
// counts open turns excluded from a scoped view because they have no property
// link — rendered as an explicit chip, never silently dropped.

function SubRowLabel({ children }: { children: string }) {
  return (
    <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{children}</p>
  );
}

// The make-ready pipeline matrix: the configured categories (rows, AppFolio
// sort order) x the status strings OBSERVED on open turns (columns, verbatim
// — §4.5: the status enum is deliberately never hardcoded). Categories seen on
// records but missing from the configured list still render (defensive: a
// renamed category must not vanish).
function MakeReadyPipeline({
  categoriesInOrder,
  counts,
}: {
  categoriesInOrder: string[];
  counts: Record<string, Record<string, number>>;
}) {
  const statusTotals: Record<string, number> = {};
  for (const byStatus of Object.values(counts)) {
    for (const [status, n] of Object.entries(byStatus)) {
      statusTotals[status] = (statusTotals[status] ?? 0) + n;
    }
  }
  const statuses = Object.keys(statusTotals).sort(
    (a, b) => statusTotals[b] - statusTotals[a] || a.localeCompare(b)
  );
  const rows = [...categoriesInOrder, ...Object.keys(counts).filter((c) => !categoriesInOrder.includes(c))];

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold tracking-tight">Make-ready pipeline</p>
          <span className="text-[11px] text-muted-foreground">open turns per category · status verbatim</span>
        </div>
        {statuses.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            No make-ready category statuses observed for these turns (the AppFolio
            category-status field is empty), so the pipeline can&apos;t be shown. This
            is not an all-clear.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[480px] text-xs">
              <thead>
                <tr className="border-b border-border/60">
                  <th className="py-2 pr-3 text-left font-medium text-muted-foreground">Category</th>
                  {statuses.map((s) => (
                    <th key={s} className="px-2 py-2 text-right font-medium text-muted-foreground">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((cat) => {
                  const byStatus = counts[cat] ?? {};
                  return (
                    <tr key={cat} className="border-b border-border/40 last:border-0">
                      <td className="py-2 pr-3 text-muted-foreground">{cat}</td>
                      {statuses.map((s) => {
                        const n = byStatus[s] ?? 0;
                        return (
                          <td key={s} className="px-2 py-2 text-right tabular-nums">
                            {n > 0 ? (
                              <span className="inline-flex min-w-6 justify-center rounded-full bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                                {n}
                              </span>
                            ) : (
                              <span className="text-muted-foreground/50">·</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function TurnsLane({
  live,
  comingSoon,
  na,
  unmappedOpen = 0,
}: {
  live: TurnsMetrics['live'];
  comingSoon: TurnsMetrics['coming_soon'];
  na: NaMap;
  unmappedOpen?: number;
}) {
  const t = live.turnovers;
  const mk = live.make_ready;
  const laneNa = na.turnovers; // resident scope: the whole lane is n/a by design (§6)

  return (
    <section className="space-y-4">
      <LaneHeader label="Turnovers + Make-Ready" sub="live · AppFolio unit turns" />

      {/* Health tiles (§4.4/§4.5) — grey n/a under a resident scope, never a fake green. */}
      <div className="grid gap-3 sm:grid-cols-2">
        <HealthTile
          label="Turns past target"
          value={String(t.past_target)}
          level={healthLevel(t.past_target, PAST_TARGET_CEILINGS)}
          sub="green 0-5 · amber 6-15 · red >15"
          na={laneNa}
        />
        <HealthTile
          label="Stalled turns · zero WOs"
          value={mk.stalled_zero_wo != null ? String(mk.stalled_zero_wo) : undefined}
          level={mk.stalled_zero_wo != null ? healthLevel(mk.stalled_zero_wo, STALLED_CEILINGS) : undefined}
          sub="green 0-3 · amber 4-10 · red >10"
          na={laneNa ?? (mk.stalled_zero_wo == null ? 'work-order data did not resolve this run' : undefined)}
        />
      </div>

      <UnmappedChip count={unmappedOpen} noun="open turns" />

      {/* Sub-row 1 — TURNOVERS (§4.4) */}
      <SubRowLabel>Turnovers</SubRowLabel>
      {laneNa ? (
        <NAPanel title="Turnovers" reason={laneNa} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
            <StatCard label="Open turns" value={String(t.open_count)} sub="units in turnover" />
            {na.avg_turn_days ? (
              <NACard label="Avg turn days" reason={na.avg_turn_days} />
            ) : (
              <StatCard
                label="Avg turn days"
                value={t.avg_turn_days != null ? String(t.avg_turn_days) : '·'}
                sub="AppFolio portfolio stat"
              />
            )}
            <StatCard
              label="Past target"
              value={String(t.past_target)}
              sub="target date behind us"
              accent={t.past_target > 0}
            />
            {na.completed_30d ? (
              <NACard label="Completed · 30d" reason={na.completed_30d} />
            ) : (
              <StatCard
                label="Completed · 30d"
                value={t.completed_30d != null ? String(t.completed_30d) : '·'}
                sub="turns closed out"
              />
            )}
            <StatCard
              label="Oldest open"
              value={t.oldest_days != null ? `${t.oldest_days}d` : '·'}
              sub="since move-out"
              accent={t.oldest_days != null && t.oldest_days > 60}
            />
          </div>
          <BarList
            title="Open turns by age (days since move-out)"
            rows={Object.entries(t.age_buckets).map(([label, count]) => ({ label, count }))}
          />
        </>
      )}

      {/* Sub-row 2 — MAKE-READY (§4.5) */}
      <SubRowLabel>Make-Ready</SubRowLabel>
      {laneNa ? (
        <NAPanel title="Make-ready pipeline" reason={laneNa} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
            <StatCard
              label="Stalled · zero WOs"
              value={mk.stalled_zero_wo != null ? String(mk.stalled_zero_wo) : 'n/a'}
              sub={mk.stalled_zero_wo != null ? 'no work orders attached' : 'WO data unavailable this run'}
              accent={mk.stalled_zero_wo != null && mk.stalled_zero_wo > 0}
            />
            <StatCard label="Open WOs on turns" value={mk.open_wos_on_turns != null ? String(mk.open_wos_on_turns) : 'n/a'} sub="attached work orders" />
            <StatCard
              label="Rent-ready this week"
              value={String(mk.rent_ready_this_week)}
              sub="target within 7 days"
            />
          </div>
          <MakeReadyPipeline categoriesInOrder={mk.categories_in_order} counts={mk.category_status_counts} />
        </>
      )}

      <ComingSoon slots={comingSoon} />
    </section>
  );
}

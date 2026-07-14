import { Card, CardContent } from '@/components/ui/card';
import { humanizeKey, type LeasingMetrics } from '@/lib/data/pulse';
import type { NaMap } from '@/lib/data/pulse-aggregate';
import { IconClock } from '@tabler/icons-react';
import { InteractiveStat, LeasingFunnel, OccupancyDonut } from './pulse-charts';
import { NACard, NAPanel } from './pulse-ui';

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-1 py-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-3xl font-semibold tracking-tight text-foreground tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// `live` is ALWAYS the output of the aggregation module when records exist
// (global AND scoped — §6.4), or the generator's own live block in the
// records-less fallback. `na` marks blocks that cannot honestly be computed
// for the active scope; those slots render n/a + reason, never a number.
export function LeasingLane({
  live,
  comingSoon,
  na,
}: {
  live: LeasingMetrics['live'];
  comingSoon: LeasingMetrics['coming_soon'];
  na: NaMap;
}) {
  const a = live.applications;
  const r = live.renewal_retention;
  const occ = live.occupancy;

  return (
    <section className="space-y-4">
      <div className="space-y-1.5">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Leasing</p>
        <div className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
          <span className="text-xs text-muted-foreground">live · AppFolio + renewals</span>
        </div>
      </div>

      {/* Live stat cards */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {na.occupancy ? (
          <>
            <NACard label="Occupancy" reason={na.occupancy} />
            <NACard label="Vacant · available" reason={na.occupancy} />
          </>
        ) : occ.status === 'live' ? (
          <>
            <StatCard label="Occupancy" value={occ.occupancy_rate_pct != null ? `${occ.occupancy_rate_pct}%` : '·'} sub={`${occ.occupied_units} of ${occ.unit_basis} units`} />
            <StatCard label="Vacant · available" value={String(occ.vacant_available)} sub={`${occ.on_notice} on notice`} />
          </>
        ) : (
          <>
            <StatCard label="Occupancy" value="·" sub="pending" />
            <StatCard label="Vacant · available" value="·" sub="pending" />
          </>
        )}
        {na.applications ? (
          <>
            <NACard label="Applications · 30d" reason={na.applications} />
            <NACard label="Approval rate" reason={na.applications} />
          </>
        ) : (
          <>
            <InteractiveStat
              label="Applications · 30d"
              value={String(a.submitted_30d)}
              sub={`${a.total} all-time`}
              drill={{
                title: 'Applications · all-time status',
                sub: `${a.submitted_30d} in the last 30d · ${a.total} all-time`,
                rows: Object.entries(a.status_breakdown)
                  .sort((x, y) => y[1] - x[1])
                  .map(([k, v]) => ({ label: humanizeKey(k), value: String(v) })),
                note: `Approval rate ${a.approval_rate_pct ?? '·'}% · median ${a.median_days_to_decision ?? '·'}d to a decision.`,
              }}
            />
            <StatCard label="Approval rate" value={a.approval_rate_pct != null ? `${a.approval_rate_pct}%` : '·'} sub={`${a.median_days_to_decision ?? '·'}d median to decision`} />
          </>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {na.funnel ? (
          <NAPanel title="Application funnel" reason={na.funnel} />
        ) : (
          <LeasingFunnel stages={live.funnel} statusBreakdown={a.status_breakdown} />
        )}
        {na.occupancy ? (
          <NAPanel title="Occupancy mix" reason={na.occupancy} />
        ) : occ.status === 'live' ? (
          <OccupancyDonut occupancy={occ} />
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-sm text-muted-foreground">
              Occupancy snapshot pending.
            </CardContent>
          </Card>
        )}
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        {/* Renewal / retention */}
        <Card>
          <CardContent className="space-y-3 py-4">
            <p className="text-sm font-semibold tracking-tight">Renewals pipeline</p>
            {r.status === 'live' ? (
              <>
                <p className="text-3xl font-semibold tracking-tight tabular-nums">{r.intake_window_rows}</p>
                <p className="text-xs text-muted-foreground">tenants in the intake window</p>
                <div className="space-y-1.5 pt-1">
                  {Object.entries(r.by_status).map(([k, v]) => (
                    <div key={k} className="flex items-center justify-between text-xs">
                      <span className="text-muted-foreground">{humanizeKey(k)}</span>
                      <span className="font-medium tabular-nums">{v}</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-muted-foreground">Pending: {r.needs}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* Coming soon — labeled slots as outlined chips, pending a data source */}
      <div>
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
          Pending a data source
        </p>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          {Object.entries(comingSoon).map(([k, v]) => (
            <div key={k} className="space-y-2 rounded-xl border border-dashed border-border bg-secondary/30 px-3.5 py-3">
              <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
                <IconClock size={12} className="text-primary" />
                {humanizeKey(k)}
              </span>
              <p className="text-[11px] leading-snug text-muted-foreground">Needs: {v.needs}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

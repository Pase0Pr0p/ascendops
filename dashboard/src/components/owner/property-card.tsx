// PER-PROPERTY CARD (§3.2) — one card per property in the owner's portfolio.
// Data-backed columns (NOI from the OV aggregate; occupancy + delinquency from
// the scoped leasing/finance lanes) render live. Value + Rent vs Market flip to
// the RentCast estimate the moment the asset feed values the property (AL-4),
// each with an "est." pill + range + provider/as-of footer (§8.2). EQUITY stays
// n/a ("loan data needed") — it needs owner loan data we do not have (AL-1), and
// missing loan data is not zero debt. A property the feed could NOT value shows
// n/a with the feed's reason, never a guessed number (§8).
import { Card, CardContent } from '@/components/ui/card';
import { MiniStat, fmtUSD, fmtPct, providerLabel, fmtAsOf } from './owner-ui';
import type { ComplianceReadinessData } from '@/lib/data/compliance-readiness';

export interface OwnerPropertyView {
  propertyId: number;
  name: string;
  /** null => this property had no GL records in the trailing-12-mo window. */
  noiTtm: number | null;
  incomeTtm: number | null;
  expensesTtm: number | null;
  /** Coverage label for the *_Ttm figures (OV-1): 'TTM' when a true trailing-12
   *  source is verified, else the real coverage (e.g. 'YTD'). From
   *  financialsCoverage(snapshot).label. */
  coverageLabel: string;
  /** null => leasing feed pending (D-1). */
  occupancyPct: number | null;
  /** null => finance feed pending (D-1). */
  delinquency: number | null;
  /** Whether this property appeared in the OV records at all (drives the
   *  header "no GL activity" note vs a live NOI). */
  hasRecords: boolean;
  complianceReadiness?: ComplianceReadinessData;

  // -- AL-4 asset estimates (all provenance class `estimate`, §8.2) ----------
  /** AVM value; null => property is unvalued (see `unvaluedReason`). */
  value: number | null;
  valueRange: [number | null, number | null] | null;
  rentEstimate: number | null;
  rentRange: [number | null, number | null] | null;
  /** 'unit' (SFR: compare the unit's own rent) vs 'property' (multi-unit: the
   *  per-unit average, honest "property avg" label §4.3). null => no estimate. */
  assetGranularity: 'unit' | 'property' | null;
  assetProvider: string | null;
  assetAsOf: string | null;
  assetStale: boolean;
  /** Why the feed could not value this property (when `value` is null). */
  unvaluedReason: string | null;
  /** Current contract rent for the market comparison: the SUM of the property's
   *  occupied-unit rents (building total). For an SFR that is the one unit's
   *  rent. null => leasing feed pending or no occupied unit. */
  currentRentForCompare: number | null;
  /** True for a multi-unit property: RentCast's estimate basis (one unit vs
   *  whole building) is uncertain, so the comparison is labeled approximate
   *  instead of showing a confident precise gap (§8 owner-truth). */
  rentBasisApproximate: boolean;
}

// Semantic status colors for the readiness verdict — same emerald/amber/red
// trio as the Pulse health tiles (HEALTH_DOT in pulse-ui.tsx), never a new hue.
const READINESS_TONE = {
  green: { text: 'text-emerald-500', bar: 'bg-emerald-400' },
  amber: { text: 'text-amber-500', bar: 'bg-amber-500' },
  red: { text: 'text-red-500', bar: 'bg-red-500' },
} as const;

function IssuePill({
  count,
  noun,
  tone,
}: {
  count: number;
  noun: string;
  tone: 'red' | 'amber';
}) {
  if (count <= 0) return null;
  const cls =
    tone === 'red'
      ? 'border-red-500/40 bg-red-500/10 text-red-500'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return (
    <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium tabular-nums ${cls}`}>
      {count} {noun}{count === 1 ? '' : 's'}
    </span>
  );
}

function ComplianceReadinessStrip({ data }: { data?: ComplianceReadinessData }) {
  if (!data || data.state !== 'ready') {
    return (
      <div className="rounded-lg border border-dashed px-3 py-2.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Compliance readiness
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Pending{data ? `: ${data.reason}` : ''}
        </p>
      </div>
    );
  }

  const { report } = data;
  const tone: keyof typeof READINESS_TONE =
    report.blockers.length > 0 ? 'red' : report.warnings.length > 0 ? 'amber' : 'green';
  const topIssue = report.blockers[0] ?? report.warnings[0];

  return (
    <div
      className="space-y-2 rounded-lg border bg-secondary/20 px-3 py-2.5"
      title="Starts at 100; 25 deducted per blocker, 10 per warning."
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Compliance readiness
        </p>
        <div className="flex flex-wrap justify-end gap-1">
          <IssuePill count={report.blockers.length} noun="blocker" tone="red" />
          <IssuePill count={report.warnings.length} noun="warning" tone="amber" />
          {report.blockers.length === 0 && report.warnings.length === 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-500">
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              Clear
            </span>
          )}
        </div>
      </div>
      <div className="flex items-baseline gap-1">
        <span className={`text-2xl font-semibold tracking-tight tabular-nums ${READINESS_TONE[tone].text}`}>
          {report.score}
        </span>
        <span className="text-xs text-muted-foreground">/ 100</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-muted/40">
        <div
          className={`h-1.5 rounded-full transition-all ${READINESS_TONE[tone].bar}`}
          style={{ width: `${Math.min(Math.max(report.score, 2), 100)}%` }}
        />
      </div>
      {topIssue && (
        <p className="text-xs leading-snug text-muted-foreground">{topIssue.label}</p>
      )}
    </div>
  );
}

export function PropertyCard({ p }: { p: OwnerPropertyView }) {
  // Value: estimate + range note when valued; else honest n/a with the reason.
  const valueNote =
    p.value != null && p.valueRange && p.valueRange[0] != null && p.valueRange[1] != null
      ? `range ${fmtUSD(p.valueRange[0])} to ${fmtUSD(p.valueRange[1])}`
      : undefined;

  // Rent vs market: current rent = the building's total occupied-unit rent,
  // compared like-for-like against RentCast's building-level market estimate.
  // SFR -> exact gap. Multi-unit -> the estimate basis (one unit vs whole
  // building) is uncertain, so we show both numbers labeled "building est,
  // approximate" and NOT a confident precise gap (§8 owner-truth — an honest
  // approximate beats a wrong precise number). Market-only ("current n/a") when
  // the property has no occupied-unit rent yet.
  let rentValue: string | null = null;
  let rentNote: string | undefined;
  if (p.rentEstimate != null) {
    if (p.currentRentForCompare != null) {
      rentValue = fmtUSD(p.currentRentForCompare);
      if (p.rentBasisApproximate) {
        rentNote = `mkt ${fmtUSD(p.rentEstimate)} · building est, approximate`;
      } else {
        const gap = p.currentRentForCompare - p.rentEstimate;
        const gapStr =
          gap === 0 ? 'at market' : `${gap > 0 ? '+' : '-'}${fmtUSD(Math.abs(gap))} vs mkt`;
        rentNote = `mkt ${fmtUSD(p.rentEstimate)} · ${gapStr}`;
      }
    } else {
      rentValue = fmtUSD(p.rentEstimate);
      rentNote = `market est · current rent n/a`;
    }
  }

  const showAssetFooter = p.value != null && p.assetProvider != null && p.assetAsOf != null;

  return (
    <Card className="h-full">
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold tracking-tight">{p.name}</p>
          {!p.hasRecords && (
            <span className="shrink-0 rounded-full border border-dashed border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
              no GL activity this period
            </span>
          )}
        </div>
        <div className="grid grid-cols-3 gap-x-3 gap-y-3">
          <MiniStat
            label={`NOI (${p.coverageLabel})`}
            value={p.noiTtm != null ? fmtUSD(p.noiTtm) : null}
            reason="no financial records this period"
            accent
            derived
            negative={p.noiTtm != null && p.noiTtm < 0}
          />
          <MiniStat
            label="Occupancy"
            value={p.occupancyPct != null ? fmtPct(p.occupancyPct) : null}
            reason="leasing feed pending (D-1)"
            derived
          />
          <MiniStat
            label="Delinquency"
            value={p.delinquency != null ? fmtUSD(p.delinquency) : null}
            reason="finance feed pending (D-1)"
            derived
          />
          <MiniStat
            label="Value"
            value={p.value != null ? fmtUSD(p.value) : null}
            reason={p.unvaluedReason ?? 'pending valuation feed (AL)'}
            est
            stale={p.assetStale}
            note={valueNote}
          />
          <MiniStat label="Equity" value={null} reason="loan data needed" />
          <MiniStat label="Open Maint." value={null} reason="Meld join pending (D-2)" />
          <MiniStat
            label="Rent vs Market"
            value={rentValue}
            reason="market rent feed pending (AL)"
            est
            stale={p.assetStale}
            note={rentNote}
          />
        </div>
        <ComplianceReadinessStrip data={p.complianceReadiness} />
        {showAssetFooter && (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Valuation &amp; rent: {providerLabel(p.assetProvider)} · as of {fmtAsOf(p.assetAsOf)}
            {p.assetStale ? ' · stale estimate' : ''}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

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

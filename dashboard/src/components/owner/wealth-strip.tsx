// THE WEALTH STRIP (§3.1) — the owner-portfolio headline card row, in the
// master-plan order. Portfolio Value flips from a grey coming-soon card to a
// live estimate card the moment the RentCast asset feed carries ≥1 valued
// property in scope (AL-4). Total Equity + Net Cash Flow STAY coming-soon: both
// need owner-supplied loan data we do not have yet (AL-1) — missing loan data is
// not zero debt. The three data-backed cards (NOI, occupancy, total expenses)
// render live off the owner aggregate / leasing scope.
//
// Layout is fixed so a flip swaps a card in place with no rework (§3.1). Nothing
// here fabricates a number: a missing feed is a labeled coming-soon card or an
// honest NACard, never a zero (§8 owner-truth).
import { StatCard, NACard } from '@/components/pulse/pulse-ui';
import { ComingSoonCard, EstStatCard, fmtUSD, fmtPct } from './owner-ui';

export interface WealthStripProps {
  /** From aggregateOwnerFinancials — derived, always present when records exist. */
  noiTtm: number;
  expensesTtm: number;
  /** Portfolio occupancy under the owner scope. null => leasing records not
   *  emitted yet (D-1); occupancy renders as an honest NACard, never faked. */
  occupancy: { pct: number | null; occupied: number; basis: number } | null;
  /** True when the owner scope actually matched financial records. False when
   *  the GL feed is company-wide only (OV-1 property-attribution blocker) — in
   *  that case NOI/expenses are NOT zero, they are unknown, so render pending
   *  rather than a misleading $0 (§8 owner-truth). */
  financialsAttributable: boolean;
  /** AL-4: portfolio value (Σ of in-scope VALUED properties) + its estimate
   *  provenance, present only when ≥1 property is valued. null keeps the honest
   *  ComingSoon card. Equity stays pending regardless (needs loan data). */
  assetValue: {
    value: number;
    provider: string;
    asOf: string;
    stale: boolean;
    valuedCount: number;
    unvaluedCount: number;
  } | null;
  /** Coverage of the TTM figures, from financialsCoverage(snapshot). Drives the
   *  card label so a calendar-YTD figure is never shown to owners as 'TTM' (OV-1);
   *  auto-reverts to 'TTM' when a true trailing-12 source lands. */
  coverage: { label: string; caveat: string | null };
}

export function WealthStrip({
  noiTtm,
  expensesTtm,
  occupancy,
  financialsAttributable,
  assetValue,
  coverage,
}: WealthStripProps) {
  const valuedNoun = (n: number) => (n === 1 ? 'property' : 'properties');
  return (
    <>
    <section
      aria-label="Portfolio wealth strip"
      className="grid grid-cols-2 gap-3 md:grid-cols-3"
    >
      {/* EXT — Portfolio Value: live estimate card when the feed values ≥1 of
          the owner's properties (§8.2 provenance: estimate), else ComingSoon. */}
      {assetValue ? (
        <EstStatCard
          label="Portfolio Value"
          value={fmtUSD(assetValue.value)}
          provider={assetValue.provider}
          asOf={assetValue.asOf}
          stale={assetValue.stale}
          accent
          sub={
            assetValue.unvaluedCount > 0
              ? `sum of ${assetValue.valuedCount} valued ${valuedNoun(assetValue.valuedCount)} · ${assetValue.unvaluedCount} awaiting a value (see cards)`
              : `sum of ${assetValue.valuedCount} valued ${valuedNoun(assetValue.valuedCount)}`
          }
        />
      ) : (
        <ComingSoonCard label="Portfolio Value" reason="pending valuation feed" />
      )}
      {/* Total Equity STAYS pending — equity = value − loan balance, and owner
          loan data is not captured yet (AL-1). Missing loan data ≠ zero debt. */}
      <ComingSoonCard
        label="Total Equity"
        reason="loan data needed"
        sub="equity = value − loan balance; owner loan balances not captured yet (AL-1)"
      />
      <ComingSoonCard
        label={`Net Cash Flow (${coverage.label})`}
        reason="pending valuation feed"
        sub="true NCF needs loan + carry data (AL); never shown as the half-picture"
      />

      {/* Data-backed — live off the OV records (§8.2 provenance: derived).
          When financials are not attributable to this owner (company-wide GL
          only), NOI is unknown, not zero — render an honest NACard, never $0. */}
      {financialsAttributable ? (
        <StatCard
          label={`NOI (${coverage.label})`}
          value={fmtUSD(noiTtm)}
          accent
          derived
          negative={noiTtm < 0}
          sub={noiTtm < 0 ? 'operating loss: expenses exceeded income' : 'operating income − operating expenses'}
        />
      ) : (
        <NACard
          label={`NOI (${coverage.label})`}
          reason="per-property financials pending; AppFolio GL access needed to attribute income/expenses to this owner"
        />
      )}
      {occupancy && occupancy.pct != null ? (
        <StatCard
          label="Occupancy"
          value={fmtPct(occupancy.pct)}
          derived
          sub={`${occupancy.occupied}/${occupancy.basis} units`}
        />
      ) : (
        <NACard
          label="Occupancy"
          reason="leasing records pending (D-1); occupancy not yet scopable to this owner"
        />
      )}
      {financialsAttributable ? (
        <StatCard label={`Total Expenses (${coverage.label})`} value={fmtUSD(expensesTtm)} derived sub="operating expenses" />
      ) : (
        <NACard
          label={`Total Expenses (${coverage.label})`}
          reason="per-property financials pending; AppFolio GL access needed"
        />
      )}
    </section>
      {coverage.caveat && (
        <p className="mt-2 text-[11px] text-muted-foreground">
          {coverage.label} coverage: {coverage.caveat}
        </p>
      )}
    </>
  );
}

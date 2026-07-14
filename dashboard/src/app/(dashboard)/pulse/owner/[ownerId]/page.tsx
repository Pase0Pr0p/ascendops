// INTERNAL OWNER / ASSET VIEW (§5 OV-3) — the asset-first presentation of ONE
// owner's slice of the SAME records the /pulse ops board renders, through the
// SAME aggregation modules (owner-aggregate.ts + pulse-aggregate.ts), so the
// two surfaces cannot diverge (§8.1).
//
// Honesty posture (§8 owner-truth, this is owner-facing eventually):
//  - Unknown owner        -> an honest "owner not found" card, not an empty board.
//  - Registry / snapshot missing or record-less -> an honest "data pending —
//    foundation building" shell, never fabricated numbers.
//  - Every missing feed   -> a labeled coming-soon / n/a card with the reason.
import Link from 'next/link';
import {
  getOwnerFinancials,
  getEntities,
  getLeasingMetrics,
  getFinanceMetrics,
  getAssetMetrics,
  getMaintenanceMetrics,
  getRenewalsMetrics,
  getTurnsMetrics,
  getOwnerStatements,
} from '@/lib/data/pulse';
import type { EntityRegistry } from '@/lib/data/pulse';
import {
  aggregateOwnerFinancials,
  financialsCoverage,
  aggregateOwnerAssets,
  portfolioValueIsLive,
  currentRentBasis,
} from '@/lib/data/owner-aggregate';
import {
  aggregateLeasing,
  aggregateFinance,
  aggregateMaintenance,
  aggregateRenewals,
  aggregateTurns,
} from '@/lib/data/pulse-aggregate';
import { backfillPropertyIds } from '@/lib/data/lane-backfill';
import { StatCard } from '@/components/pulse/pulse-ui';
import { resolveScope, type ResolvedScope } from '@/lib/data/pulse-scope';
import {
  runOwnerReconciliation,
  isOwnerPublishable,
  type OwnerReconRun,
} from '@/lib/data/owner-reconcile-pull';
import { WealthStrip } from '@/components/owner/wealth-strip';
import { PropertyCard, type OwnerPropertyView } from '@/components/owner/property-card';
import { Card, CardContent } from '@/components/ui/card';
import knownDeltas from '../../../../../../config/owner-recon-known-deltas.json';

export const dynamic = 'force-dynamic';

// -- shared brand hero shell (two-tone headline, blue eyebrow) — theme-aware
//    via .pulse-hero, exactly like the /pulse board. Every state renders inside
//    it so even the honest empty states stay on-brand in both themes.
function OwnerShell({
  ownerName,
  subtitle,
  freshness,
  children,
}: {
  ownerName?: string | null;
  subtitle: string;
  freshness?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      <header className="pulse-hero relative overflow-hidden rounded-2xl border px-6 py-7 sm:px-8 sm:py-8">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Owner / Asset View
            </p>
            <h1 className="text-3xl font-extrabold leading-tight tracking-tight sm:text-4xl">
              Owner /<br />
              <span className="text-primary">Asset View</span>
            </h1>
            {ownerName && (
              <p className="text-lg font-semibold tracking-tight text-foreground">{ownerName}</p>
            )}
            <p className="max-w-xl text-sm text-muted-foreground">{subtitle}</p>
            {freshness && <div className="flex flex-wrap items-center gap-2 pt-1">{freshness}</div>}
          </div>
          <Link
            href="/pulse"
            className="shrink-0 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[12px] font-medium text-primary hover:bg-primary/20"
          >
            ← Ops board
          </Link>
        </div>
      </header>
      {children}
    </div>
  );
}

function FreshBadge({ label, tone }: { label: string; tone: 'green' | 'amber' }) {
  const cls =
    tone === 'green'
      ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-500'
      : 'border-amber-500/40 bg-amber-500/10 text-amber-500';
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] font-medium ${cls}`}>
      {label}
    </span>
  );
}

function fmtEt(iso: string): string {
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ReconciliationBadge({
  run,
  ownerId,
  hasFeed,
}: {
  run: OwnerReconRun | null;
  ownerId: string;
  hasFeed: boolean;
}) {
  if (!hasFeed) {
    return (
      <Card className="border-dashed">
        <CardContent className="space-y-1 py-4">
          <p className="text-sm font-semibold">Owner statement not yet reconciled</p>
          <p className="text-xs text-muted-foreground">
            Owner statement feed is not available for this period.
          </p>
        </CardContent>
      </Card>
    );
  }
  const row = run?.owners.find((item) => item.owner_id === ownerId);
  if (!run || !row) {
    return (
      <Card className="border-dashed">
        <CardContent className="space-y-1 py-4">
          <p className="text-sm font-semibold">Owner statement not yet reconciled</p>
          <p className="text-xs text-muted-foreground">
            This owner is absent from the current statement feed.
          </p>
        </CardContent>
      </Card>
    );
  }
  if (row.attribution === 'blocked') {
    return (
      <Card className="border-dashed">
        <CardContent className="space-y-1 py-4">
          <p className="text-sm font-semibold">Statement reconciliation pending per-property data</p>
          <p className="text-xs text-muted-foreground">{row.attribution_reason}</p>
        </CardContent>
      </Card>
    );
  }
  const publishable = isOwnerPublishable(run, ownerId);
  if (publishable) {
    return (
      <Card className="border-emerald-500/40 bg-emerald-500/5">
        <CardContent className="space-y-2 py-4">
          <p className="text-sm font-semibold text-emerald-600">
            Reconciled to owner statement {row.result.period}
          </p>
          {row.known_deltas.length > 0 && (
            <div className="space-y-1 text-xs text-muted-foreground">
              {row.known_deltas.map((delta) => (
                <p key={`${delta.field}-${delta.delta}`}>
                  Known delta {delta.field}: ours {delta.ours}, statement {delta.statement}, delta {delta.delta}
                </p>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  }
  return (
    <Card className="border-red-500/40 bg-red-500/5">
      <CardContent className="space-y-2 py-4">
        <p className="text-sm font-semibold text-red-600">Owner statement reconciliation mismatch</p>
        <div className="space-y-1 text-xs text-muted-foreground">
          {row.result.deltas.map((delta) => (
            <p key={`${delta.field}-${delta.delta}`}>
              {delta.field}: ours {delta.ours}, statement {delta.statement}, delta {delta.delta}
            </p>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// Portfolio occupancy under a resolved scope, live only when leasing records
// exist (D-1). Returns null otherwise so the strip renders an honest NACard.
function occupancyFor(scope: ResolvedScope): { pct: number | null; occupied: number; basis: number } | null {
  const leasing = getLeasingMetrics();
  if (!leasing?.records?.length) return null;
  const v = aggregateLeasing({ ...leasing, records: leasing.records }, scope);
  if (v.live.occupancy.status !== 'live') return null;
  return {
    pct: v.live.occupancy.occupancy_rate_pct,
    occupied: v.live.occupancy.occupied_units,
    basis: v.live.occupancy.unit_basis,
  };
}

// Per-property delinquency, live only when finance records exist (D-1).
function delinquencyFor(scope: ResolvedScope): number | null {
  const finance = getFinanceMetrics();
  if (!finance?.records?.length) return null;
  const v = aggregateFinance({ ...finance, records: finance.records }, scope);
  return v.live.delinquency.total_receivable;
}

// Owner-scoped operational lanes. maintenance / renewals / turns records carry a
// property_name but a null property_id (their sources drop the numeric id), so
// we backfill property_id via the SAFE unique-name join (backfillPropertyIds)
// before aggregating. Records that cannot join uniquely stay unscoped, never
// guessed (§8 owner-truth). Null when the lane has no records yet.
function maintenanceFor(scope: ResolvedScope, registry: EntityRegistry) {
  const m = getMaintenanceMetrics();
  if (!m?.records?.length) return null;
  const v = aggregateMaintenance({ ...m, records: backfillPropertyIds(m.records, registry) }, scope);
  return { open: v.live.open_work_orders, unassigned: v.live.genuinely_unassigned };
}
function renewalsFor(scope: ResolvedScope, registry: EntityRegistry) {
  const r = getRenewalsMetrics();
  if (!r?.records?.length) return null;
  const v = aggregateRenewals({ ...r, records: backfillPropertyIds(r.records, registry) }, scope);
  return { inWindow: v.live.in_window, notStarted: v.live.not_started };
}
function turnsFor(scope: ResolvedScope, registry: EntityRegistry) {
  const t = getTurnsMetrics();
  if (!t?.records?.length) return null;
  const v = aggregateTurns({ ...t, records: backfillPropertyIds(t.records, registry) }, scope);
  return { open: v.live.turnovers.open_count, pastTarget: v.live.turnovers.past_target };
}

export default async function OwnerAssetViewPage({
  params,
}: {
  params: Promise<{ ownerId: string }>;
}) {
  const { ownerId } = await params;
  const registry = getEntities();

  // --- foundation-pending: no entity registry yet (pre-D-1 real state).
  if (!registry) {
    return (
      <OwnerShell subtitle="Foundation building. The owner dashboard is not live yet.">
        <Card className="border-dashed">
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-lg font-semibold">Data pending: foundation building</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              The entity registry (<code>entities.json</code>) has not been generated yet, so
              owners cannot be resolved. This dashboard goes live once the Phase D records + registry
              land. No numbers are shown rather than guessed.
            </p>
          </CardContent>
        </Card>
      </OwnerShell>
    );
  }

  // --- resolve the owner. Unknown owner -> honest not-found card (§5 OV-3).
  const { resolved, warning } = resolveScope({ kind: 'owner', id: ownerId }, registry);
  if (resolved.kind !== 'properties') {
    return (
      <OwnerShell subtitle="This owner could not be found in the entity registry.">
        <Card className="border-dashed">
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-lg font-semibold">Owner not found</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              {warning ?? `No owner "${ownerId}" in the registry.`} Check the owner id, or open the{' '}
              <Link href="/pulse" className="text-primary underline-offset-2 hover:underline">
                ops board
              </Link>{' '}
              and pick an owner from the scope picker.
            </p>
          </CardContent>
        </Card>
      </OwnerShell>
    );
  }

  const ownerName = resolved.label;
  const propertyIds = resolved.ids;

  // --- owner exists but manages no properties: an honest empty state, never a
  //     $0 wealth strip (a zero here would read as a real portfolio number, §8).
  if (propertyIds.length === 0) {
    return (
      <OwnerShell ownerName={ownerName} subtitle="No properties under management for this owner.">
        <Card className="border-dashed">
          <CardContent className="space-y-2 py-10 text-center">
            <p className="text-lg font-semibold">No properties under management</p>
            <p className="mx-auto max-w-md text-sm text-muted-foreground">
              This owner is in the registry but has no properties linked to them, so there is
              nothing to aggregate. Numbers are withheld rather than shown as zero.
            </p>
          </CardContent>
        </Card>
      </OwnerShell>
    );
  }

  // --- financial spine (OV-1). OPTIONAL: when absent (the current pre-GL state,
  //     since AppFolio per-property GL is not granted) the page STILL renders the
  //     operational metrics sourced from the leasing / finance lanes (occupancy,
  //     delinquency) and the RentCast asset feed. ONLY the NOI / expense /
  //     cash-flow spine cards render honest-pending — driven by
  //     financialsAttributable=false, which shows an NACard with the reason, never
  //     a fabricated $0 (§8 owner-truth). This replaces the old whole-page
  //     data-pending gate so an owner is not blanket-pending when their real
  //     occupancy / delinquency / value numbers are available today.
  const snapshot = getOwnerFinancials();
  const statementFeed = getOwnerStatements();
  const reconRun =
    snapshot && statementFeed
      ? runOwnerReconciliation(snapshot, registry, statementFeed, knownDeltas)
      : null;
  const hasFinancials = Boolean(snapshot?.records?.length);
  const agg = snapshot && hasFinancials ? aggregateOwnerFinancials(snapshot, resolved) : null;
  // OV-1: the *_ttm figures are effectively calendar-YTD until a true trailing-12
  // source lands; drive the card label off the generator's needs_verification.window
  // so owners are never shown calendar-YTD as 'TTM' (and it auto-reverts to 'TTM').
  const coverage = financialsCoverage(snapshot);
  const isSynthetic = Boolean((snapshot as unknown as { _synthetic?: string })?._synthetic);

  // --- asset layer (AL-4): join the RentCast value/rent feed to this owner's
  //     properties through the SAME single owner-math module. Staleness is
  //     measured against real "now" so the amber stale badge is live. Absent
  //     feed -> null -> the value/rent cards stay honest ComingSoon (§8.2).
  const assetSnap = getAssetMetrics();
  const assets = assetSnap ? aggregateOwnerAssets(assetSnap, resolved, new Date().toISOString()) : null;
  const assetValue =
    assets && portfolioValueIsLive(assets) && assets.provenance
      ? {
          value: assets.portfolio_value,
          provider: assets.provenance.provider,
          asOf: assets.provenance.as_of,
          stale: assets.provenance.stale,
          valuedCount: assets.valued_count,
          unvaluedCount: assets.unvalued_count,
        }
      : null;

  // Portfolio occupancy (owner scope). Per-property occ/delinquency are wired
  // to flip live the moment leasing/finance records land (D-1); null today.
  const portfolioOccupancy = occupancyFor(resolved);
  const unitsLabel =
    portfolioOccupancy && portfolioOccupancy.basis > 0 ? `${portfolioOccupancy.basis} units` : 'units pending';

  // Owner-scoped operational lanes (maintenance / renewals / turns), unlocked by
  // the safe property_id backfill so they aggregate to this owner's properties.
  const ownerMaintenance = maintenanceFor(resolved, registry);
  const ownerRenewals = renewalsFor(resolved, registry);
  const ownerTurns = turnsFor(resolved, registry);

  const propViews: OwnerPropertyView[] = propertyIds.map((pid) => {
    const roll = agg?.by_property[String(pid)];
    const name = registry.properties.find((p) => p.id === pid)?.name ?? `Property ${pid}`;
    const propScope: ResolvedScope = { kind: 'properties', via: 'property', ids: [pid], label: name };

    // Asset estimate for this property (valued) or its unvalued reason.
    const av = assets?.by_property[String(pid)] ?? null;
    const unvaluedReason = assets?.unvalued.find((u) => u.property_id === pid)?.reason ?? null;
    const gran = av?.granularity ?? null;

    // Current rent for the market comparison: the SUM of occupied-unit rents
    // (the building's total current rent), compared like-for-like against
    // RentCast's building-level market estimate. SFR -> the one unit's rent
    // (exact gap); multi-unit -> total, labeled approximate (§4.3 / §8). Never a
    // per-unit average, which read every multi-unit far under market.
    const basis = currentRentBasis(getLeasingMetrics()?.records ?? null, pid, gran);
    const currentRentForCompare = basis.current;
    const rentBasisApproximate = basis.approximate;

    return {
      propertyId: pid,
      name: roll?.property_name ?? av?.property_name ?? name,
      noiTtm: roll ? roll.noi_ttm : null,
      incomeTtm: roll ? roll.income_ttm : null,
      expensesTtm: roll ? roll.expenses_ttm : null,
      coverageLabel: coverage.label,
      occupancyPct: occupancyFor(propScope)?.pct ?? null,
      delinquency: delinquencyFor(propScope),
      hasRecords: Boolean(roll),
      // AL-4 asset estimates (§8.2 provenance: estimate).
      value: av?.value ?? null,
      valueRange: av?.value_range ?? null,
      rentEstimate: av?.rent_estimate ?? null,
      rentRange: av?.rent_range ?? null,
      assetGranularity: gran,
      assetProvider: av?.provenance.provider ?? null,
      assetAsOf: av?.provenance.as_of ?? null,
      assetStale: av?.provenance.stale ?? false,
      unvaluedReason,
      currentRentForCompare,
      rentBasisApproximate,
    };
  });

  // Freshness: prefer the spine's timestamp; without a spine, fall back to the
  // operational lanes (finance/leasing) that actually source the live numbers,
  // so the badge reflects real data recency rather than reading "unknown".
  const opsAsOf = getFinanceMetrics()?.generated_at ?? getLeasingMetrics()?.generated_at ?? null;
  const freshFrom = snapshot?.generated_at ?? opsAsOf;
  const ageMs = freshFrom ? Date.now() - new Date(freshFrom).getTime() : Infinity;
  const fresh = ageMs < 26 * 60 * 60 * 1000;
  const spineNote = hasFinancials && snapshot ? `as of ${snapshot.today}` : 'operational metrics live · financial spine pending';

  return (
    <OwnerShell
      ownerName={ownerName}
      subtitle={`${propertyIds.length} ${propertyIds.length === 1 ? 'property' : 'properties'} · ${unitsLabel} · ${spineNote}`}
      freshness={
        <>
          <FreshBadge
            label={
              freshFrom
                ? `${fresh ? 'Updated' : 'Stale, last run'} ${fmtEt(freshFrom)} ET`
                : 'Freshness unknown'
            }
            tone={fresh ? 'green' : 'amber'}
          />
          {isSynthetic && (
            <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-500">
              Synthetic demo data, not live numbers
            </span>
          )}
        </>
      }
    >
      {/* Wealth strip (§3.1) */}
      <WealthStrip
        noiTtm={agg?.noi_ttm ?? 0}
        expensesTtm={agg?.expenses_ttm ?? 0}
        occupancy={portfolioOccupancy}
        financialsAttributable={Boolean(agg && Object.keys(agg.by_property).length > 0)}
        assetValue={assetValue}
        coverage={coverage}
      />

      <section aria-label="Owner statement reconciliation" className="space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
          Owner Statement Reconciliation
        </p>
        <ReconciliationBadge run={reconRun} ownerId={ownerId} hasFeed={Boolean(statementFeed)} />
      </section>

      {/* Operations (owner-scoped, unlocked by the safe property_id backfill) */}
      <section aria-label="Operations" className="space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
          Operations
        </p>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <StatCard
            label="Open work orders"
            value={ownerMaintenance ? String(ownerMaintenance.open) : '·'}
            derived
            sub={ownerMaintenance ? `${ownerMaintenance.unassigned} genuinely unassigned` : 'maintenance feed pending'}
          />
          <StatCard
            label="Renewals in window"
            value={ownerRenewals ? String(ownerRenewals.inWindow) : '·'}
            derived
            sub={ownerRenewals ? `${ownerRenewals.notStarted} not started` : 'renewals feed pending'}
          />
          <StatCard
            label="Open turns"
            value={ownerTurns ? String(ownerTurns.open) : '·'}
            derived
            sub={ownerTurns ? `${ownerTurns.pastTarget} past target` : 'turns feed pending'}
          />
        </div>
      </section>

      {/* Per-property cards (§3.2) */}
      <section aria-label="Properties" className="space-y-4">
        <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
          Properties
        </p>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          {propViews.map((p) => (
            <PropertyCard key={p.propertyId} p={p} />
          ))}
        </div>
      </section>

      {/* Drill-down hooks land in OV-4 (ledger) / OV-5 (ops accordion). */}
    </OwnerShell>
  );
}

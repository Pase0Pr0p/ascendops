import Link from 'next/link';
import {
  getLeasingMetrics,
  getMaintenanceMetrics,
  getFinanceMetrics,
  getTurnsMetrics,
  getRenewalsMetrics,
  getEvictionsMetrics,
  getEntities,
  isPulseDemo,
} from '@/lib/data/pulse';
import { getWorkflowCockpitData } from '@/lib/data/workflows';
import {
  aggregateLeasing,
  aggregateMaintenance,
  aggregateFinance,
  aggregateTurns,
  aggregateRenewals,
  aggregateEvictions,
} from '@/lib/data/pulse-aggregate';
import {
  parseScopeParam,
  resolveScope,
  scopeToParam,
  buildScopeOptions,
} from '@/lib/data/pulse-scope';
import { PulseHealthStrip, type StripLane } from '@/components/pulse/pulse-health-strip';
import { LeasingLane } from '@/components/pulse/leasing-lane';
import { TurnsLane } from '@/components/pulse/turns-lane';
import { RenewalsLane } from '@/components/pulse/renewals-lane';
import { EvictionsLane } from '@/components/pulse/evictions-lane';
import { MaintenanceLane } from '@/components/pulse/maintenance-lane';
import { FinanceLane } from '@/components/pulse/finance-lane';
import { WorkflowLane } from '@/components/pulse/workflow-lane';
import { ScopePicker } from '@/components/pulse/scope-picker';
import { LaneHeader, DataCaution } from '@/components/pulse/pulse-ui';
import { Card, CardContent } from '@/components/ui/card';

export const dynamic = 'force-dynamic';

function MissingSnapshot({ lane, generator }: { lane: string; generator: string }) {
  return (
    <Card>
      <CardContent className="py-8 text-center text-sm text-muted-foreground">
        {lane} snapshot not generated yet. Run <code>{generator}</code>.
      </CardContent>
    </Card>
  );
}

// Honesty rule: a lane whose snapshot has no per-entity records CANNOT be
// sliced — showing its global numbers under a scope pill would be a lie.
function UnscopableLane({ label, sub }: { label: string; sub: string }) {
  return (
    <section className="space-y-4">
      <LaneHeader label={label} sub={sub} />
      <Card className="border-dashed">
        <CardContent className="py-6 text-sm text-muted-foreground">
          This lane can&apos;t be scoped yet; its snapshot has no per-entity records (Phase D
          records emission pending). Numbers are hidden rather than shown unscoped under a scope
          filter.{' '}
          <Link href="/pulse" className="text-primary underline-offset-2 hover:underline">
            View unscoped
          </Link>
        </CardContent>
      </Card>
    </section>
  );
}

// Health-strip input per lane (§2.2 honesty): snapshot missing -> "not wired"
// grey; scope active on a records-less snapshot -> grey n/a (matches the
// UnscopableLane treatment below — never a stale portfolio number under a
// scope pill); otherwise the SAME view object the lane renders (§6.4 single
// source of truth — the strip never recomputes a lane's number its own way).
function stripLane<V>(
  snap: { records?: unknown[] } | null,
  scoped: boolean,
  view: V | null
): StripLane<V> {
  if (!snap || !view) return { state: 'missing' };
  if (scoped && !snap.records?.length) return { state: 'unscopable' };
  return { state: 'live', view };
}

export default async function PulsePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string | string[] }>;
}) {
  const sp = await searchParams;
  const leasing = getLeasingMetrics();
  const turns = getTurnsMetrics();
  const renewals = getRenewalsMetrics();
  const evictions = getEvictionsMetrics();
  const maintenance = getMaintenanceMetrics();
  const finance = getFinanceMetrics();
  const registry = getEntities();
  const workflowData = await getWorkflowCockpitData();

  // --- entity scope (§2.4): parsed from the URL, resolved against the registry.
  const requested = parseScopeParam(sp.scope);
  const { resolved, warning } = resolveScope(requested, registry);
  const scoped = resolved.kind !== 'all';
  const activeParam = scoped ? scopeToParam(requested) : null;
  const scopeLabel = scoped ? resolved.label : null;

  const anyRecords = Boolean(
    leasing?.records?.length ||
      turns?.records?.length ||
      renewals?.records?.length ||
      evictions?.records?.length ||
      maintenance?.records?.length ||
      finance?.records?.length
  );
  const pickerEnabled = registry != null && anyRecords;
  const scopeOptions = registry ? buildScopeOptions(registry) : [];

  // --- lane views. When a snapshot carries records, EVERY displayed number —
  // global and scoped — is recomputed through the aggregation module (§6.4
  // invariant; the ALL-scope equality with the generator's live block is
  // enforced in pulse-aggregate.test.ts). Records-less snapshots fall back to
  // the generator's aggregate display and cannot be scoped.
  const leasingView = leasing?.records?.length
    ? aggregateLeasing({ ...leasing, records: leasing.records }, resolved)
    : leasing
      ? { live: leasing.live, na: {} }
      : null;
  const turnsView = turns?.records?.length
    ? aggregateTurns({ ...turns, records: turns.records }, resolved)
    : turns
      ? { live: turns.live, na: {}, unmapped_open: 0 }
      : null;
  const renewalsView = renewals?.records?.length
    ? aggregateRenewals({ ...renewals, records: renewals.records }, resolved)
    : renewals
      ? { live: renewals.live, na: {}, unmapped: 0 }
      : null;
  const evictionsView = evictions?.records?.length
    ? aggregateEvictions({ ...evictions, records: evictions.records }, resolved)
    : evictions
      ? { live: evictions.live, na: {}, unmapped: 0 }
      : null;
  const maintenanceView = maintenance?.records?.length
    ? aggregateMaintenance({ ...maintenance, records: maintenance.records }, resolved)
    : maintenance
      ? { live: maintenance.live, na: {}, unmapped_open: 0 }
      : null;
  const financeView = finance?.records?.length
    ? aggregateFinance({ ...finance, records: finance.records }, resolved)
    : finance
      ? { live: finance.live, na: {} }
      : null;

  const generatedAt = leasing
    ? new Date(leasing.generated_at).toLocaleString('en-US', {
        timeZone: 'America/New_York',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })
    : null;

  return (
    <div className="mx-auto max-w-6xl space-y-8 pb-12">
      {/* Brand hero band — theme-aware gradient + radial glow (.pulse-hero in
          globals.css): navy in dark mode, white->pale-blue in light mode. */}
      <header className="pulse-hero relative overflow-hidden rounded-2xl border px-6 py-7 sm:px-8 sm:py-8">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">
              Daily Operating Board
            </p>
            <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl">
              Property <span className="text-primary">Pulse</span>
            </h1>
            <p className="max-w-xl text-sm text-muted-foreground">
              The live operating picture across Maintenance, Leasing, and Finance.
              {generatedAt && <span> · Updated {generatedAt} ET</span>}
            </p>
            {/* Scope pill row — dismissable pill next to the headline (§2.4). */}
            {(scoped || warning || isPulseDemo()) && (
              <div className="flex flex-wrap items-center gap-2 pt-1">
                {scoped && scopeLabel && (
                  <span className="inline-flex items-center gap-1.5 rounded-full border border-primary/40 bg-primary/10 px-3 py-1 text-[12px] font-medium text-primary">
                    Scoped: {scopeLabel}
                    <Link
                      href="/pulse"
                      aria-label="Clear scope"
                      className="rounded-full px-1 leading-none hover:bg-primary/20"
                    >
                      ✕
                    </Link>
                  </span>
                )}
                {warning && (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-500">
                    {warning}
                  </span>
                )}
                {isPulseDemo() && (
                  <span className="inline-flex items-center rounded-full border border-amber-500/40 bg-amber-500/10 px-3 py-1 text-[12px] font-medium text-amber-500">
                    Synthetic demo data (PULSE_DEMO=1), not live numbers
                  </span>
                )}
              </div>
            )}
          </div>
          <ScopePicker
            options={scopeOptions}
            currentParam={activeParam}
            currentLabel={scoped && scopeLabel ? `Scoped: ${scopeLabel}` : 'All properties'}
            enabled={pickerEnabled}
          />
        </div>
      </header>

      {/* HEALTH STRIP (§2.2, shard A-3) — 7 tiles, one per metric area. Each
          tile reads the SAME view object its lane renders below (§6.4);
          unwired areas (evictions; any missing snapshot) are grey "not wired";
          under a scope every tile is the scoped number or grey n/a. */}
      <PulseHealthStrip
        leasing={stripLane(leasing, scoped, leasingView)}
        renewals={stripLane(renewals, scoped, renewalsView)}
        evictions={stripLane(evictions, scoped, evictionsView)}
        turns={stripLane(turns, scoped, turnsView)}
        maintenance={stripLane(maintenance, scoped, maintenanceView)}
        finance={stripLane(finance, scoped, financeView)}
      />

      <div id="lane-leasing" className="scroll-mt-6">
        {!leasing ? (
          <MissingSnapshot lane="Leasing" generator="pulse_leasing_metrics.py" />
        ) : scoped && !leasing.records?.length ? (
          <UnscopableLane label="Leasing" sub="live · AppFolio + renewals" />
        ) : (
          leasingView && (
            <LeasingLane live={leasingView.live} comingSoon={leasing.coming_soon} na={leasingView.na} />
          )
        )}
        <DataCaution items={leasing?.needs_verification} />
      </div>

      <div id="lane-renewals" className="scroll-mt-6">
        {!renewals ? (
          <MissingSnapshot lane="Renewals" generator="pulse_renewals_metrics.py" />
        ) : scoped && !renewals.records?.length ? (
          <UnscopableLane label="Renewals" sub="live · renewals tracker" />
        ) : (
          renewalsView && (
            <RenewalsLane
              live={renewalsView.live}
              comingSoon={renewals.coming_soon}
              na={renewalsView.na}
              unmapped={renewalsView.unmapped}
            />
          )
        )}
        <DataCaution items={renewals?.needs_verification} />
      </div>

      <div id="lane-evictions" className="scroll-mt-6">
        {!evictions ? (
          <MissingSnapshot lane="Evictions" generator="pulse_evictions_metrics.py" />
        ) : scoped && !evictions.records?.length ? (
          <UnscopableLane label="Evictions" sub="live · rent roll + delinquency" />
        ) : (
          evictionsView && (
            <EvictionsLane
              live={evictionsView.live}
              comingSoon={evictions.coming_soon}
              na={evictionsView.na}
              unmapped={evictionsView.unmapped}
            />
          )
        )}
        <DataCaution items={evictions?.needs_verification} />
      </div>

      <div id="lane-turns" className="scroll-mt-6">
        {!turns ? (
          <MissingSnapshot lane="Turnovers + Make-Ready" generator="pulse_turns_metrics.py" />
        ) : scoped && !turns.records?.length ? (
          <UnscopableLane label="Turnovers + Make-Ready" sub="live · AppFolio unit turns" />
        ) : (
          turnsView && (
            <TurnsLane
              live={turnsView.live}
              comingSoon={turns.coming_soon}
              na={turnsView.na}
              unmappedOpen={turnsView.unmapped_open}
            />
          )
        )}
        <DataCaution items={turns?.needs_verification} />
      </div>

      <div id="lane-maintenance" className="scroll-mt-6">
        {!maintenance ? (
          <MissingSnapshot lane="Maintenance" generator="pulse_maintenance_metrics.py" />
        ) : scoped && !maintenance.records?.length ? (
          <UnscopableLane label="Maintenance" sub="live · Property Meld" />
        ) : (
          maintenanceView && (
            <MaintenanceLane
              live={maintenanceView.live}
              comingSoon={maintenance.coming_soon}
              unmappedOpen={maintenanceView.unmapped_open}
            />
          )
        )}
        <DataCaution items={maintenance?.needs_verification} />
      </div>

      <div id="lane-finance" className="scroll-mt-6">
        {!finance ? (
          <MissingSnapshot lane="Finance" generator="pulse_finance_metrics.py" />
        ) : scoped && !finance.records?.length ? (
          <UnscopableLane label="Finance" sub="live · AppFolio financials" />
        ) : (
          financeView && <FinanceLane live={financeView.live} comingSoon={finance.coming_soon} />
        )}
        <DataCaution items={finance?.needs_verification} />
      </div>

      <div id="lane-workflows" className="scroll-mt-6">
        <WorkflowLane data={workflowData} />
      </div>
    </div>
  );
}

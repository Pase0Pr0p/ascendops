// PM KPI dashboard page.
//
// FIDUCIARY REQUIREMENT: every data point shown here is SAMPLE/DEMO data
// from the mock AppFolio connector. Live data requires Rob's credentials +
// APPFOLIO_CONNECTOR_PATH=stack-api. The persistent banner + per-widget badge
// below make this unmistakable. Never remove these until the connector is live.

import { createAppFolioConnector } from '@/lib/appfolio';
import { computePmKpis, formatDollars } from '@/lib/appfolio/kpi';
import type { PmKpiSnapshot } from '@/lib/appfolio/kpi';

export const dynamic = 'force-dynamic';

export default async function PmKpiPage() {
  let kpis: PmKpiSnapshot | null = null;
  let error: string | null = null;

  try {
    const connector = createAppFolioConnector();
    kpis = await computePmKpis(connector);
  } catch (err) {
    error = err instanceof Error ? err.message : 'Unknown error';
  }

  const isDemo = !kpis || kpis.is_demo;

  return (
    <div className="space-y-6">
      {/* ------------------------------------------------------------------ */}
      {/* FIDUCIARY BANNER — persistent, unmissable. DO NOT REMOVE until live */}
      {/* ------------------------------------------------------------------ */}
      {isDemo && (
        <div className="rounded-lg border-2 border-amber-400 bg-amber-50 dark:bg-amber-950/30 px-4 py-3 flex items-center gap-3">
          <span className="text-amber-500 text-lg font-bold shrink-0">⚠</span>
          <div>
            <p className="text-sm font-semibold text-amber-800 dark:text-amber-300">
              SAMPLE DATA — NOT REAL PORTFOLIO DATA
            </p>
            <p className="text-xs text-amber-700 dark:text-amber-400">
              All numbers below are from mock fixtures. Connect AppFolio credentials to see live portfolio data.
            </p>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Portfolio KPIs</h1>
          <p className="text-sm text-muted-foreground">
            {kpis
              ? `Connector: ${kpis.connector} · Updated ${new Date(kpis.computed_at).toLocaleTimeString()}`
              : 'AppFolio property management metrics'}
          </p>
        </div>
        {isDemo && (
          <span className="text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300 border border-amber-300">
            DEMO
          </span>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-sm text-destructive">
          Error loading KPIs: {error}
        </div>
      )}

      {kpis && (
        <div className="space-y-6">
          {/* Maintenance */}
          <Section title="Maintenance" demo={isDemo}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard
                label="Open"
                value={kpis.maintenance.open}
                sublabel="work orders"
                highlight={kpis.maintenance.open > 0 ? 'warn' : 'ok'}
                demo={isDemo}
              />
              <KpiCard
                label="In Progress"
                value={kpis.maintenance.in_progress}
                sublabel="work orders"
                demo={isDemo}
              />
              <KpiCard
                label="Urgent Open"
                value={kpis.maintenance.urgent_open}
                sublabel="need immediate attention"
                highlight={kpis.maintenance.urgent_open > 0 ? 'danger' : 'ok'}
                demo={isDemo}
              />
              <KpiCard
                label="Oldest Open"
                value={kpis.maintenance.oldest_open_days !== null
                  ? `${kpis.maintenance.oldest_open_days}d`
                  : '—'}
                sublabel="days since created"
                highlight={
                  kpis.maintenance.oldest_open_days !== null && kpis.maintenance.oldest_open_days > 7
                    ? 'warn'
                    : 'ok'
                }
                demo={isDemo}
              />
            </div>
            {Object.keys(kpis.maintenance.by_category).length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {Object.entries(kpis.maintenance.by_category).map(([cat, count]) => (
                  <span key={cat} className="text-xs px-2 py-1 rounded-full bg-muted border text-muted-foreground">
                    {cat}: {count}
                  </span>
                ))}
              </div>
            )}
          </Section>

          {/* Occupancy */}
          <Section title="Occupancy" demo={isDemo}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <KpiCard
                label="Occupancy"
                value={`${kpis.occupancy.occupancy_rate_pct}%`}
                sublabel={`${kpis.occupancy.occupied} of ${kpis.occupancy.total_units} units`}
                highlight={kpis.occupancy.occupancy_rate_pct >= 90 ? 'ok' : 'warn'}
                demo={isDemo}
              />
              <KpiCard
                label="Notice Given"
                value={kpis.occupancy.notice_given}
                sublabel="moving out"
                highlight={kpis.occupancy.notice_given > 0 ? 'warn' : 'ok'}
                demo={isDemo}
              />
              <KpiCard
                label="Month-to-Month"
                value={kpis.occupancy.month_to_month}
                sublabel="no fixed term"
                demo={isDemo}
              />
              <KpiCard
                label="Expiring ≤60 Days"
                value={kpis.occupancy.expiring_60_days}
                sublabel="leases ending soon"
                highlight={kpis.occupancy.expiring_60_days > 0 ? 'warn' : 'ok'}
                demo={isDemo}
              />
            </div>
          </Section>

          {/* Accounts Receivable */}
          <Section title="Accounts Receivable" demo={isDemo}>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-2">
              <KpiCard
                label="Delinquent Units"
                value={kpis.ar.delinquent_units}
                sublabel="balance outstanding"
                highlight={kpis.ar.delinquent_units > 0 ? 'danger' : 'ok'}
                demo={isDemo}
              />
              <KpiCard
                label="Total AR"
                value={formatDollars(kpis.ar.total_ar_cents)}
                sublabel="outstanding balance"
                highlight={kpis.ar.total_ar_cents > 0 ? 'danger' : 'ok'}
                demo={isDemo}
              />
            </div>
            {kpis.ar.delinquent_details.length > 0 && (
              <div className="mt-3 space-y-1">
                {kpis.ar.delinquent_details.map((d, i) => (
                  <div key={i} className="flex items-center justify-between text-sm rounded-md bg-muted/50 px-3 py-2">
                    <span>{d.unit ? `Unit ${d.unit} — ` : ''}{d.tenantName}</span>
                    <span className="font-semibold text-destructive">{formatDollars(d.balance_cents)}</span>
                  </div>
                ))}
              </div>
            )}
          </Section>

          {/* Financials */}
          <Section title={`Financials — ${kpis.financials.period_start} to ${kpis.financials.period_end}`} demo={isDemo}>
            {kpis.financials.source === 'unavailable' ? (
              <p className="text-sm text-muted-foreground">Owner statement unavailable for this period.</p>
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <KpiCard
                  label="Gross Income"
                  value={formatDollars(kpis.financials.gross_income_cents)}
                  demo={isDemo}
                />
                <KpiCard
                  label="Total Expenses"
                  value={formatDollars(kpis.financials.total_expenses_cents)}
                  demo={isDemo}
                />
                <KpiCard
                  label="Management Fee"
                  value={formatDollars(kpis.financials.management_fee_cents)}
                  sublabel="10% of gross"
                  demo={isDemo}
                />
                <KpiCard
                  label="Net Distribution"
                  value={formatDollars(kpis.financials.net_distribution_cents)}
                  highlight="ok"
                  demo={isDemo}
                />
              </div>
            )}
          </Section>

          {/* Swap seam callout */}
          <div className="rounded-lg border border-dashed border-muted-foreground/30 p-4 text-xs text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">Mock → Live swap</p>
            <p>
              Set <code className="bg-muted px-1 rounded">APPFOLIO_CONNECTOR_PATH=stack-api</code> +{' '}
              <code className="bg-muted px-1 rounded">APPFOLIO_CLIENT_ID</code> /{' '}
              <code className="bg-muted px-1 rounded">APPFOLIO_CLIENT_SECRET</code> /{' '}
              <code className="bg-muted px-1 rounded">APPFOLIO_ACCOUNT_ID</code> in{' '}
              <code className="bg-muted px-1 rounded">orgs/paseo-pm/secrets.env</code>{' '}
              to connect to the live AppFolio Stack API. The <code className="bg-muted px-1 rounded">DEMO</code> banner disappears automatically.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function Section({
  title,
  demo,
  children,
}: {
  title: string;
  demo: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
        {demo && (
          <span className="text-[10px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200 dark:border-amber-700">
            SAMPLE
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function KpiCard({
  label,
  value,
  sublabel,
  highlight,
  demo,
}: {
  label: string;
  value: number | string;
  sublabel?: string;
  highlight?: 'ok' | 'warn' | 'danger';
  demo: boolean;
}) {
  const highlightClass =
    highlight === 'danger'
      ? 'border-destructive/40 bg-destructive/5'
      : highlight === 'warn'
      ? 'border-amber-300/60 bg-amber-50/50 dark:bg-amber-950/20'
      : '';

  return (
    <div className={`rounded-lg border bg-card p-4 relative ${highlightClass}`}>
      {demo && (
        <span className="absolute top-2 right-2 text-[9px] font-bold uppercase tracking-wider px-1 py-0.5 rounded bg-amber-100 text-amber-500 dark:bg-amber-900/30 dark:text-amber-400 border border-amber-200/60 dark:border-amber-700/40">
          DEMO
        </span>
      )}
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide pr-8">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${
        highlight === 'danger' ? 'text-destructive' : highlight === 'warn' ? 'text-amber-600 dark:text-amber-400' : ''
      }`}>
        {value}
      </p>
      {sublabel && <p className="mt-0.5 text-xs text-muted-foreground">{sublabel}</p>}
    </div>
  );
}

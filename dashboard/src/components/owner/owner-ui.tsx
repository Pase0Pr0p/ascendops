// Shared presentational atoms for the internal owner/asset view (§3.1/§3.2).
// Brand tokens only (text-foreground / text-muted-foreground / text-primary /
// bg-card via <Card>) so every atom renders correctly in BOTH light and dark
// themes with no per-theme code — same discipline as the /pulse components.
import { Card, CardContent } from '@/components/ui/card';

/** Whole-dollar USD (owner headline cards read cleaner without cents). */
export const fmtUSD = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** One-decimal percent. */
export const fmtPct = (n: number): string => `${n.toFixed(1)}%`;

// -- estimate provenance helpers (§8.2) -------------------------------------
/** Vendor id -> display label. Raw feed rows use 'rentcast'; owners see "RentCast". */
export function providerLabel(provider: string | null | undefined): string {
  const p = (provider || '').toLowerCase();
  if (p === 'rentcast') return 'RentCast';
  if (!provider) return 'estimate';
  return provider.charAt(0).toUpperCase() + provider.slice(1);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** 'YYYY-MM-DD' -> 'Jul 5, 2026' with no timezone drift (string-parsed, not Date). */
export function fmtAsOf(ymd: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd || '');
  if (!m) return ymd || 'unknown';
  const [, y, mo, d] = m;
  return `${MONTHS[Number(mo) - 1]} ${Number(d)}, ${y}`;
}

// Small "est." provenance pill — every estimate wears one (§8.2). Amber + "stale"
// when the estimate is past the freshness bar, so a stale number is never shown
// as if it were current.
export function EstPill({ stale }: { stale?: boolean }) {
  return (
    <span
      className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
        stale
          ? 'border-amber-500/40 bg-amber-500/10 text-amber-500'
          : 'border-border bg-secondary/40 text-muted-foreground'
      }`}
    >
      {stale ? 'est · stale' : 'est.'}
    </span>
  );
}

// Grey, dashed coming-soon card — sized to match <StatCard> so the asset
// layer (AL-4) can swap it for a live StatCard in the SAME grid cell with zero
// layout rework (§3.1). Honest label, never a fake/zero number (§8 owner-truth).
export function ComingSoonCard({
  label,
  reason,
  sub,
}: {
  label: string;
  reason: string;
  sub?: string;
}) {
  return (
    <Card className="h-full border-dashed">
      <CardContent className="space-y-2 py-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-dashed border-border bg-secondary/30 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
          {reason}
        </span>
        {sub && <p className="text-xs leading-snug text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// Live headline card for an ESTIMATE number (portfolio value): value + "est."
// pill + provider + as-of line, amber when stale (§8.2). Same footprint as
// <StatCard>/<ComingSoonCard> so it drops into the wealth-strip grid unchanged.
export function EstStatCard({
  label,
  value,
  provider,
  asOf,
  stale,
  sub,
  accent,
}: {
  label: string;
  value: string;
  provider: string;
  asOf: string;
  stale?: boolean;
  sub?: string;
  accent?: boolean;
}) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-1 py-4">
        <div className="flex items-center gap-2">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          <EstPill stale={stale} />
        </div>
        <p
          className={`text-3xl font-semibold tracking-tight tabular-nums ${
            accent ? 'text-primary' : 'text-foreground'
          }`}
        >
          {value}
        </p>
        <p className="text-xs text-muted-foreground">
          {providerLabel(provider)} · as of {fmtAsOf(asOf)}
          {stale ? ' · stale' : ''}
        </p>
        {sub && <p className="text-[11px] leading-snug text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// Compact labeled stat for the per-property grid. `value == null` renders an
// honest "n/a" with a one-line reason — never a zero or a guess (§8). A feed
// that lands later flips null -> a formatted string with no other change.
// `est` shows the provenance pill (estimate numbers only); `note` is a sub-line
// under a present value (e.g. an estimate range or a rent-vs-market gap).
export function MiniStat({
  label,
  value,
  reason,
  accent,
  negative,
  est,
  stale,
  note,
  derived,
}: {
  label: string;
  value?: string | null;
  reason?: string;
  accent?: boolean;
  /** Visually flag a loss/deficit (red, not just a minus sign). Presentation
   *  only: the caller decides when a value counts as negative. */
  negative?: boolean;
  est?: boolean;
  stale?: boolean;
  note?: string;
  /** Provenance tag (§8.2): value DERIVED from real records (not an estimate). */
  derived?: boolean;
}) {
  const na = value == null;
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-1.5">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        {est && !na && <EstPill stale={stale} />}
        {derived && !na && (
          <span className="inline-flex items-center rounded-full border border-border bg-secondary/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
            derived
          </span>
        )}
      </div>
      <p
        className={`text-lg font-semibold tabular-nums ${
          na ? 'text-muted-foreground' : negative ? 'text-red-500' : accent ? 'text-primary' : 'text-foreground'
        }`}
      >
        {na ? 'n/a' : value}
      </p>
      {na && reason && <p className="text-[10px] leading-snug text-muted-foreground">{reason}</p>}
      {!na && note && <p className="text-[10px] leading-snug text-muted-foreground">{note}</p>}
    </div>
  );
}

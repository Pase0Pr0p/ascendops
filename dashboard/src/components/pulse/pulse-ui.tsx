import { Card, CardContent } from '@/components/ui/card';

// Blue uppercase letter-spaced eyebrow + live subtitle — the classroom-card header look.
export function LaneHeader({ label, sub }: { label: string; sub: string }) {
  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{label}</p>
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse-dot" />
        <span className="text-xs text-muted-foreground">{sub}</span>
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  sub,
  accent,
  negative,
  derived,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  /** Visually flag a loss/deficit (red, not just a minus sign). Presentation
   *  only: the caller decides when a value counts as negative. Wins over accent. */
  negative?: boolean;
  /** Provenance tag (§8.2): mark a value that is DERIVED from real records
   *  (aggregated/computed), distinct from an ESTIMATE (est. pill) or a pending
   *  NACard. Off by default so non-owner surfaces are unchanged. */
  derived?: boolean;
}) {
  return (
    <Card className="h-full">
      <CardContent className="space-y-1 py-4">
        <div className="flex items-center gap-1.5">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
          {derived && (
            <span className="inline-flex items-center rounded-full border border-border bg-secondary/40 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              derived
            </span>
          )}
        </div>
        <p className={`text-3xl font-semibold tracking-tight tabular-nums ${negative ? 'text-red-500' : accent ? 'text-primary' : 'text-foreground'}`}>
          {value}
        </p>
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </CardContent>
    </Card>
  );
}

// Horizontal labeled bar list (funnel / aging distribution) in the brand blue.
// Pass `fmt` to format the displayed value (e.g. currency); bar width uses raw count.
export function BarList({
  title,
  rows,
  fmt,
}: {
  title: string;
  rows: { label: string; count: number }[];
  fmt?: (n: number) => string;
}) {
  const max = Math.max(...rows.map((r) => r.count), 1);
  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        <div className="space-y-2.5">
          {rows.map((r) => (
            <div key={r.label} className="space-y-1">
              <div className="flex items-center justify-between text-xs">
                <span className="text-muted-foreground">{r.label}</span>
                <span className="font-medium tabular-nums">{fmt ? fmt(r.count) : r.count}</span>
              </div>
              <div className="h-2.5 w-full rounded-full bg-muted/40">
                <div className="h-2.5 rounded-full bg-primary transition-all" style={{ width: `${Math.max((r.count / max) * 100, 3)}%` }} />
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

// n/a stat slot — a card that CANNOT be honestly computed for the active
// entity scope (e.g. occupancy % for a single resident). Hard honesty rule
// (§2.4/§6.4): render "n/a" with a one-line reason, never a misleading number.
export function NACard({ label, reason }: { label: string; reason: string }) {
  return (
    <Card className="h-full border-dashed">
      <CardContent className="space-y-1 py-4">
        <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <p className="text-3xl font-semibold tracking-tight text-muted-foreground">n/a</p>
        <p className="text-xs leading-snug text-muted-foreground">{reason}</p>
      </CardContent>
    </Card>
  );
}

// n/a chart/panel slot — same rule for a full-width chart region.
export function NAPanel({ title, reason }: { title: string; reason: string }) {
  return (
    <Card className="border-dashed">
      <CardContent className="space-y-2 py-4">
        <p className="text-sm font-semibold tracking-tight">{title}</p>
        <p className="text-2xl font-semibold text-muted-foreground">n/a</p>
        <p className="text-xs leading-snug text-muted-foreground">{reason}</p>
      </CardContent>
    </Card>
  );
}

// Amber honesty chip: records excluded from a scoped view because they cannot
// be attributed to any property (§6.5) — surfaced, never silently dropped.
export function UnmappedChip({ count, noun }: { count: number; noun: string }) {
  if (count <= 0) return null;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-500/10 px-2.5 py-0.5 text-[11px] font-medium text-amber-500">
      Unmapped: {count} {noun} excluded from this scope (no property link yet)
    </span>
  );
}

// Compact health tile — area name eyebrow, one headline number, one status
// dot (§2.2 health strip anatomy). Thresholds live in pulse-aggregate.ts
// (healthLevel + per-area ceilings); this only renders the verdict. `na`
// renders a grey n/a tile — never a fake green (§2.2 honesty rule).
const HEALTH_DOT: Record<'green' | 'amber' | 'red', string> = {
  green: 'bg-emerald-400',
  amber: 'bg-amber-500',
  red: 'bg-red-500',
};

export function HealthTile({
  label,
  value,
  level,
  sub,
  na,
  stacked,
}: {
  label: string;
  /** Headline number. Optional only because an `na` tile has none. */
  value?: string;
  /** Status verdict. Optional only because an `na` tile has none — a grey
   *  tile carries NO level, so it can never render a fake green. */
  level?: 'green' | 'amber' | 'red';
  sub?: string;
  na?: string;
  /** Compact vertical layout (label on top, number below) so the tile stays
   *  legible when many sit in one narrow row — used by the health strip. The
   *  default side-by-side layout is used by the wider lane health tiles. */
  stacked?: boolean;
}) {
  const dot = (
    <span
      className={`h-2.5 w-2.5 shrink-0 rounded-full ${na || !level ? 'bg-muted-foreground/40' : HEALTH_DOT[level]}`}
      aria-label={na || !level ? 'not available' : `status ${level}`}
    />
  );
  const number = (
    <span className="truncate text-2xl font-semibold tracking-tight tabular-nums">
      {na || !value ? 'n/a' : value}
    </span>
  );
  const subText = na ? (
    <p className="text-xs leading-snug text-muted-foreground">{na}</p>
  ) : (
    sub && <p className="text-xs leading-snug text-muted-foreground">{sub}</p>
  );

  if (stacked) {
    return (
      <Card className={`h-full ${na ? 'border-dashed' : ''}`}>
        <CardContent className="flex h-full flex-col gap-1 py-3">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{label}</p>
          <div className="flex items-center justify-between gap-2">
            {number}
            {dot}
          </div>
          {subText}
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={`h-full ${na ? 'border-dashed' : ''}`}>
      <CardContent className="flex h-full items-center justify-between gap-3 py-3">
        <div className="space-y-0.5">
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">{label}</p>
          {subText}
        </div>
        <div className="flex items-center gap-2.5">
          {number}
          {dot}
        </div>
      </CardContent>
    </Card>
  );
}

// Coming-soon outlined pill-chip slots, pending a data source.
export function ComingSoon({ slots }: { slots: Record<string, { needs: string }> }) {
  const human = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!slots || Object.keys(slots).length === 0) return null;
  return (
    <div>
      <p className="mb-3 text-[11px] font-semibold uppercase tracking-[0.2em] text-primary">Pending a data source</p>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        {Object.entries(slots).map(([k, v]) => (
          <div key={k} className="space-y-2 rounded-xl border border-dashed border-border bg-secondary/30 px-3.5 py-3">
            <span className="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] font-medium">
              {human(k)}
            </span>
            <p className="text-[11px] leading-snug text-muted-foreground">Needs: {v.needs}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

// Data-caution banner: renders a snapshot's `needs_verification` so a number
// that is partial/unverified (e.g. a 0-match join making "Out for signing: 0"
// look like a fact) is VISIBLY labeled, never shown as a clean real value.
// Amber to read as a caution distinct from the blue "pending a data source".
export function DataCaution({ items }: { items?: Record<string, { why: string }> }) {
  const human = (k: string) => k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!items || Object.keys(items).length === 0) return null;
  return (
    <div className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] px-3.5 py-3">
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.15em] text-amber-400/90">
        Some numbers may be incomplete
      </p>
      <ul className="space-y-1.5">
        {Object.entries(items).map(([k, v]) => (
          <li key={k} className="text-[11px] leading-snug text-muted-foreground">
            <span className="font-medium text-foreground/80">{human(k)}:</span> {v.why}
          </li>
        ))}
      </ul>
    </div>
  );
}

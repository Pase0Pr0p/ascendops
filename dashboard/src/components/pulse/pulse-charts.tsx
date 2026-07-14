'use client';

// Interactive, clickable drill-down charts for the Property Pulse board.
// Every chart segment (funnel stage, donut slice, aging bar) and the headline
// stat cards are clickable — a click opens a drill-down detail dialog with the
// deeper real breakdown behind that number. Built on the recharts already in the
// dashboard deps; brand blue accent per agentic-pm-brand-guide.md.
import { useState, type ReactNode } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Cell,
  PieChart,
  Pie,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { usd } from '@/lib/data/pulse-health';

// Brand blue (exact site accent) + a cool blue-family ramp for multi-slice
// charts. Mid-tone hues chosen to read on BOTH the navy (dark) and white (light)
// surfaces — the earlier -400 tints washed out on a white page.
const BRAND = 'lab(66.4277 -1.1116 -61.8456)';
const RAMP = ['lab(66.4277 -1.1116 -61.8456)', '#1d4ed8', '#3b82f6', '#0ea5e9', '#06b6d4', '#14b8a6'];

const TOOLTIP_STYLE = {
  contentStyle: {
    background: 'var(--popover)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontSize: 12,
    padding: '8px 12px',
    color: 'var(--foreground)',
  },
  labelStyle: { color: 'var(--foreground)', fontSize: 11, fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: 'var(--muted-foreground)' },
  cursor: { fill: 'rgba(147, 160, 189, 0.08)' },
} as const;

const humanize = (k: string) =>
  k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// ---------------------------------------------------------------------------
// Shared drill-down dialog
// ---------------------------------------------------------------------------
interface DrillRow {
  label: string;
  value: string;
  emphasis?: boolean;
}
interface Drill {
  title: string;
  sub?: string;
  rows: DrillRow[];
  note?: string;
}

function DrillDialog({ drill, onClose }: { drill: Drill | null; onClose: () => void }) {
  return (
    <Dialog open={!!drill} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-lg">{drill?.title}</DialogTitle>
          {drill?.sub && <DialogDescription>{drill.sub}</DialogDescription>}
        </DialogHeader>
        <div className="space-y-2">
          {drill?.rows.map((r) => (
            <div
              key={r.label}
              className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm ${
                r.emphasis
                  ? 'border-primary/40 bg-primary/10'
                  : 'border-border/60 bg-secondary/30'
              }`}
            >
              <span className="text-muted-foreground">{r.label}</span>
              <span className="font-semibold tabular-nums text-foreground">{r.value}</span>
            </div>
          ))}
        </div>
        {drill?.note && (
          <p className="pt-1 text-xs leading-snug text-muted-foreground">{drill.note}</p>
        )}
      </DialogContent>
    </Dialog>
  );
}

// A card wrapper that reads as clickable and opens a drill on click.
function ClickableCard({
  children,
  onClick,
  className = '',
}: {
  children: ReactNode;
  onClick: () => void;
  className?: string;
}) {
  return (
    <button type="button" onClick={onClick} className={`group block w-full text-left ${className}`}>
      {children}
    </button>
  );
}

const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : '·');

// ---------------------------------------------------------------------------
// Interactive stat card — click drills into a provided breakdown
// ---------------------------------------------------------------------------
export function InteractiveStat({
  label,
  value,
  sub,
  accent,
  drill,
}: {
  label: string;
  value: string;
  sub?: string;
  accent?: boolean;
  drill: Drill;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <ClickableCard onClick={() => setOpen(true)}>
        <Card className="h-full transition-transform group-hover:-translate-y-0.5">
          <CardContent className="space-y-1 py-4">
            <p className="flex items-center gap-1 text-[11px] uppercase tracking-wider text-muted-foreground">
              {label}
              <span className="text-primary opacity-0 transition-opacity group-hover:opacity-100">›</span>
            </p>
            <p
              className={`text-3xl font-semibold tracking-tight tabular-nums ${
                accent ? 'text-primary' : 'text-foreground'
              }`}
            >
              {value}
            </p>
            {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
          </CardContent>
        </Card>
      </ClickableCard>
      <DrillDialog drill={open ? drill : null} onClose={() => setOpen(false)} />
    </>
  );
}

// ---------------------------------------------------------------------------
// Leasing — application funnel (interactive horizontal bars)
// ---------------------------------------------------------------------------
export function LeasingFunnel({
  stages,
  statusBreakdown,
}: {
  stages: { stage: string; count: number }[];
  statusBreakdown: Record<string, number>;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const totalApps = Object.values(statusBreakdown).reduce((s, n) => s + n, 0);

  const onStage = (stage: string, count: number) =>
    setDrill({
      title: stage,
      // Funnel stages mix a 30d count with all-time status counts — they are not additive,
      // so no combined-denominator percentage here. The honest all-time split is in `rows` below.
      sub: `${count}`,
      rows: Object.entries(statusBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => ({
          label: humanize(k),
          value: `${v} · ${pct(v, totalApps)}`,
          emphasis: false,
        })),
      note: 'Standing application pipeline (not a strict flow). The breakdown above is the full all-time application status split behind the funnel.',
    });

  return (
    <Card>
      <CardContent className="space-y-3 py-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold tracking-tight">Application funnel</p>
          <span className="text-[11px] text-muted-foreground">click a stage to drill in</span>
        </div>
        <ResponsiveContainer width="100%" height={180}>
          <BarChart
            layout="vertical"
            data={stages}
            margin={{ top: 0, right: 40, bottom: 0, left: 8 }}
          >
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="stage"
              width={120}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
              tickLine={false}
              axisLine={false}
            />
            <Tooltip {...TOOLTIP_STYLE} />
            <Bar
              dataKey="count"
              radius={[4, 4, 4, 4]}
              maxBarSize={26}
              cursor="pointer"
              onClick={(d: { payload?: { stage: string; count: number } }) =>
                d.payload && onStage(d.payload.stage, d.payload.count)
              }
            >
              {stages.map((s, i) => (
                <Cell key={s.stage} fill={i === 0 ? BRAND : RAMP[(i + 1) % RAMP.length]} />
              ))}
              <LabelList
                dataKey="count"
                position="right"
                style={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 600 }}
              />
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </CardContent>
      <DrillDialog drill={drill} onClose={() => setDrill(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Leasing — occupancy donut (interactive slices)
// ---------------------------------------------------------------------------
export function OccupancyDonut({
  occupancy,
}: {
  occupancy: {
    occupied_units: number;
    vacant_available: number;
    on_notice: number;
    unit_basis: number;
    occupancy_rate_pct: number | null;
    basis_note?: string;
  };
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const data = [
    { key: 'Occupied', value: occupancy.occupied_units },
    { key: 'Vacant · available', value: occupancy.vacant_available },
    { key: 'On notice', value: occupancy.on_notice },
  ];

  const onSlice = (key: string, value: number) =>
    setDrill({
      title: key,
      sub: `${value} units · ${pct(value, occupancy.unit_basis)} of ${occupancy.unit_basis}`,
      rows: data.map((d) => ({
        label: d.key,
        value: `${d.value} · ${pct(d.value, occupancy.unit_basis)}`,
        emphasis: d.key === key,
      })),
      note: occupancy.basis_note,
    });

  return (
    <Card>
      <CardContent className="py-4">
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold tracking-tight">Occupancy mix</p>
          <span className="text-[11px] text-muted-foreground">click a segment</span>
        </div>
        <div className="flex items-center gap-4">
          <ResponsiveContainer width="55%" height={160}>
            <PieChart>
              <Pie
                data={data}
                dataKey="value"
                nameKey="key"
                innerRadius={44}
                outerRadius={68}
                paddingAngle={2}
                cursor="pointer"
                onClick={(d: { payload?: { key: string; value: number } }) =>
                  d.payload && onSlice(d.payload.key, d.payload.value)
                }
              >
                {data.map((d, i) => (
                  <Cell key={d.key} stroke="transparent" fill={i === 0 ? BRAND : RAMP[(i + 1) % RAMP.length]} />
                ))}
              </Pie>
              <Tooltip {...TOOLTIP_STYLE} />
            </PieChart>
          </ResponsiveContainer>
          <div className="flex-1 space-y-2">
            <p className="text-3xl font-semibold tabular-nums text-primary">
              {occupancy.occupancy_rate_pct != null ? `${occupancy.occupancy_rate_pct}%` : '·'}
            </p>
            <div className="space-y-1.5">
              {data.map((d, i) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onSlice(d.key, d.value)}
                  className="flex w-full items-center justify-between gap-2 text-left text-xs hover:opacity-80"
                >
                  <span className="flex items-center gap-1.5 text-muted-foreground">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: i === 0 ? BRAND : RAMP[(i + 1) % RAMP.length] }}
                    />
                    {d.key}
                  </span>
                  <span className="font-medium tabular-nums">{d.value}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </CardContent>
      <DrillDialog drill={drill} onClose={() => setDrill(null)} />
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Maintenance — aging bars + priority donut (both interactive)
// ---------------------------------------------------------------------------
export function MaintenanceCharts({
  aging,
  priority,
  openTotal,
}: {
  aging: Record<string, number>;
  priority: Record<string, number>;
  openTotal: number;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const agingData = Object.entries(aging).map(([bucket, count]) => ({ bucket, count }));
  const priorityData = Object.entries(priority).map(([key, count]) => ({ key, count }));
  const priorityTotal = priorityData.reduce((s, d) => s + d.count, 0);

  const onBucket = (bucket: string, count: number) =>
    setDrill({
      title: `Aging · ${bucket}`,
      sub: `${count} open work orders · ${pct(count, openTotal)} of ${openTotal} open`,
      rows: agingData.map((d) => ({
        label: d.bucket,
        value: `${d.count} · ${pct(d.count, openTotal)}`,
        emphasis: d.bucket === bucket,
      })),
      note: 'Days a work order has been open. Older buckets are the aging tail to clear first.',
    });

  const onPriority = (key: string, count: number) =>
    setDrill({
      title: `Priority · ${humanize(key)}`,
      sub: `${count} · ${pct(count, priorityTotal)} of the open board`,
      rows: priorityData
        .sort((a, b) => b.count - a.count)
        .map((d) => ({
          label: humanize(d.key),
          value: `${d.count} · ${pct(d.count, priorityTotal)}`,
          emphasis: d.key === key,
        })),
    });

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold tracking-tight">Aging (days open)</p>
            <span className="text-[11px] text-muted-foreground">click a bar</span>
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={agingData} margin={{ top: 8, right: 4, bottom: 0, left: -18 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
                allowDecimals={false}
              />
              <Tooltip {...TOOLTIP_STYLE} />
              <Bar
                dataKey="count"
                radius={[4, 4, 0, 0]}
                maxBarSize={40}
                cursor="pointer"
                onClick={(d: { payload?: { bucket: string; count: number } }) =>
                  d.payload && onBucket(d.payload.bucket, d.payload.count)
                }
              >
                {agingData.map((d, i) => (
                  <Cell
                    key={d.bucket}
                    fill={i >= agingData.length - 2 ? '#f59e0b' : BRAND}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
        <DrillDialog drill={drill} onClose={() => setDrill(null)} />
      </Card>

      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold tracking-tight">Priority mix</p>
            <span className="text-[11px] text-muted-foreground">click a segment</span>
          </div>
          <div className="flex items-center gap-4">
            <ResponsiveContainer width="52%" height={150}>
              <PieChart>
                <Pie
                  data={priorityData}
                  dataKey="count"
                  nameKey="key"
                  innerRadius={40}
                  outerRadius={62}
                  paddingAngle={2}
                  cursor="pointer"
                  onClick={(d: { payload?: { key: string; count: number } }) =>
                    d.payload && onPriority(d.payload.key, d.payload.count)
                  }
                >
                  {priorityData.map((d, i) => (
                    <Cell
                      key={d.key}
                      stroke="transparent"
                      fill={/emerg/i.test(d.key) ? '#ef4444' : /high/i.test(d.key) ? '#f59e0b' : RAMP[i % RAMP.length]}
                    />
                  ))}
                </Pie>
                <Tooltip {...TOOLTIP_STYLE} />
              </PieChart>
            </ResponsiveContainer>
            <div className="flex-1 space-y-1.5">
              {priorityData.map((d, i) => (
                <button
                  key={d.key}
                  type="button"
                  onClick={() => onPriority(d.key, d.count)}
                  className="flex w-full items-center justify-between gap-2 text-left text-xs hover:opacity-80"
                >
                  <span className="flex items-center gap-1.5 capitalize text-muted-foreground">
                    <span
                      className="h-2 w-2 rounded-full"
                      style={{ background: /emerg/i.test(d.key) ? '#ef4444' : /high/i.test(d.key) ? '#f59e0b' : RAMP[i % RAMP.length] }}
                    />
                    {d.key.toLowerCase()}
                  </span>
                  <span className="font-medium tabular-nums">{d.count}</span>
                </button>
              ))}
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Finance — delinquency aging + receivable vs deposits (interactive)
// ---------------------------------------------------------------------------
export function FinanceCharts({
  delinquency,
  deposits,
}: {
  delinquency: {
    total_receivable: number;
    delinquent_accounts: number;
    bucket_0_30: number;
    bucket_30_plus: number;
  };
  deposits: { total: number; accounts: number } | null;
}) {
  const [drill, setDrill] = useState<Drill | null>(null);
  const dq = delinquency;
  const agingData = [
    { bucket: '0-30 days', amount: dq.bucket_0_30 },
    { bucket: '30+ days', amount: dq.bucket_30_plus },
  ];

  const onBucket = (bucket: string, amount: number) =>
    setDrill({
      title: `Delinquency · ${bucket}`,
      sub: `${usd(amount)} · ${pct(amount, dq.total_receivable)} of total receivable`,
      rows: [
        { label: '0-30 days', value: `${usd(dq.bucket_0_30)} · ${pct(dq.bucket_0_30, dq.total_receivable)}`, emphasis: bucket.startsWith('0') },
        { label: '30+ days', value: `${usd(dq.bucket_30_plus)} · ${pct(dq.bucket_30_plus, dq.total_receivable)}`, emphasis: bucket.startsWith('30') },
        { label: 'Total receivable', value: usd(dq.total_receivable) },
        { label: 'Delinquent accounts', value: String(dq.delinquent_accounts) },
      ],
      note: '30+ days is the at-risk balance, the collection priority.',
    });

  const compareData = [
    { key: 'Receivable (owed)', amount: dq.total_receivable, color: '#f59e0b' },
    ...(deposits ? [{ key: 'Deposits held (trust)', amount: deposits.total, color: BRAND }] : []),
  ];
  const onCompare = (key: string, amount: number) =>
    setDrill({
      title: key,
      sub: usd(amount),
      rows: [
        { label: 'Receivable (owed)', value: usd(dq.total_receivable), emphasis: key.startsWith('Receivable') },
        ...(deposits
          ? [
              { label: 'Deposits held (trust)', value: usd(deposits.total), emphasis: key.startsWith('Deposits') },
              { label: 'Trust accounts', value: String(deposits.accounts) },
            ]
          : []),
      ],
      note: 'Receivable is money owed to owners; deposits held sit in trust and are a liability, not income.',
    });

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold tracking-tight">Delinquency aging</p>
            <span className="text-[11px] text-muted-foreground">click a bar</span>
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart data={agingData} margin={{ top: 8, right: 8, bottom: 0, left: 4 }}>
              <XAxis
                dataKey="bucket"
                tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis hide />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => usd(Number(v))} />
              <Bar
                dataKey="amount"
                radius={[4, 4, 0, 0]}
                maxBarSize={64}
                cursor="pointer"
                onClick={(d: { payload?: { bucket: string; amount: number } }) =>
                  d.payload && onBucket(d.payload.bucket, d.payload.amount)
                }
              >
                <Cell fill={BRAND} />
                <Cell fill="#f59e0b" />
                <LabelList
                  dataKey="amount"
                  position="top"
                  formatter={(v) => usd(Number(v))}
                  style={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
        <DrillDialog drill={drill} onClose={() => setDrill(null)} />
      </Card>

      <Card>
        <CardContent className="space-y-3 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold tracking-tight">Receivable vs deposits held</p>
            <span className="text-[11px] text-muted-foreground">click a bar</span>
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <BarChart
              layout="vertical"
              data={compareData}
              margin={{ top: 4, right: 48, bottom: 0, left: 8 }}
            >
              <XAxis type="number" hide />
              <YAxis
                type="category"
                dataKey="key"
                width={140}
                tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip {...TOOLTIP_STYLE} formatter={(v) => usd(Number(v))} />
              <Bar
                dataKey="amount"
                radius={[4, 4, 4, 4]}
                maxBarSize={30}
                cursor="pointer"
                onClick={(d: { payload?: { key: string; amount: number } }) =>
                  d.payload && onCompare(d.payload.key, d.payload.amount)
                }
              >
                {compareData.map((d) => (
                  <Cell key={d.key} fill={d.color} />
                ))}
                <LabelList
                  dataKey="amount"
                  position="right"
                  formatter={(v) => usd(Number(v))}
                  style={{ fill: 'var(--foreground)', fontSize: 12, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>
    </div>
  );
}

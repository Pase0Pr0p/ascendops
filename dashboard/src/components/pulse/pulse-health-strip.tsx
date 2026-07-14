// BUSINESS-HEALTH STRIP (§2.2, shard A-3) — one row of 7 compact tiles, one
// per metric area. Ten seconds after opening /pulse this row answers "is the
// business healthy today, and where is it not"; each tile clicks through to
// its lane. All tile derivation (and every honesty rule: §6.4 single source
// of truth, grey "not wired", scope n/a) is the pure buildStripTiles in
// @/lib/data/pulse-health — this component only renders its verdicts.
import {
  buildStripTiles,
  type PulseHealthStripProps,
} from '@/lib/data/pulse-health';
import { HealthTile } from './pulse-ui';

export type { PulseHealthStripProps, StripLane, StripTile } from '@/lib/data/pulse-health';

export function PulseHealthStrip(props: PulseHealthStripProps) {
  const tiles = buildStripTiles(props);
  return (
    <section
      aria-label="Business health"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-7"
    >
      {tiles.map((t) => {
        const tile = <HealthTile label={t.area} value={t.value} level={t.level} sub={t.sub} na={t.na} stacked />;
        return t.href ? (
          <a
            key={t.area}
            href={t.href}
            className="block h-full rounded-xl outline-primary/60 transition-transform hover:-translate-y-0.5 focus-visible:outline-2"
          >
            {tile}
          </a>
        ) : (
          <div key={t.area} className="h-full">
            {tile}
          </div>
        );
      })}
    </section>
  );
}

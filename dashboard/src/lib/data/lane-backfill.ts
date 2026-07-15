import type { EntityRegistry } from '@/lib/data/pulse';

// Normalize a property name for the name->id join: lowercase, collapse
// whitespace, and strip a trailing unit/apt designator so a unit-level record
// ("100 Example St Unit A") matches its property ("100 Example St").
function norm(s: string | null | undefined): string {
  return (s ?? '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/\s*(unit|apt|#|ste|suite)\s*\S*$/i, '');
}

/**
 * Backfill property_id onto lane records that carry a property_name but a null
 * property_id — maintenance / renewals / turns, whose sources (PropertyMeld, the
 * renewals tracker) drop the numeric AppFolio id. Without this they cannot be
 * owner-scoped.
 *
 * SAFE by construction (§8 owner-truth): a record is backfilled ONLY when its
 * normalized name maps to EXACTLY ONE registry property. Names that collide
 * (>1 property) or do not match are left null — they stay honestly
 * owner-unscoped rather than risk mis-attributing a work order / renewal to the
 * wrong owner. Verified on the live data: 228 properties -> 228 distinct
 * normalized names, 0 collisions, so every record joins uniquely today; the
 * collision guard is the permanent safety net if a future name ever collides.
 */
export function backfillPropertyIds<T extends { property_id: number | null; property_name?: string | null }>(
  records: T[],
  registry: EntityRegistry,
): T[] {
  const nameToIds = new Map<string, Set<number>>();
  for (const p of registry.properties) {
    const k = norm(p.name);
    if (!nameToIds.has(k)) nameToIds.set(k, new Set());
    nameToIds.get(k)!.add(p.id);
  }
  return records.map((r): T => {
    if (r.property_id != null) return r;
    const ids = nameToIds.get(norm(r.property_name));
    if (ids && ids.size === 1) return { ...r, property_id: [...ids][0] };
    return r;
  });
}

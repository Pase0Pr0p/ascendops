// Entity-scope parsing + resolution for the Property Pulse board (§2.4, §6.2).
//
// Scope is URL state: /pulse?scope=property:118 | owner:o_12 | group:smith-family
// | resident:<slug(name)>--<slug(unit)>. The server component parses the param,
// resolves it against the entity registry, and recomputes every lane through
// pulse-aggregate.ts. No client state machine.
//
// Pure module — no fs, safe to import from client components.

import type { EntityRegistry } from './pulse';

// URL-facing scope, straight from the param (unvalidated).
export type Scope =
  | { kind: 'all' }
  | { kind: 'property'; id: number }
  | { kind: 'owner'; id: string }
  | { kind: 'group'; slug: string }
  | { kind: 'resident'; key: string }
  | { kind: 'invalid'; raw: string };

// Registry-resolved scope, the only shape pulse-aggregate accepts.
// owner/group resolve to a property-id set — the union semantics of §6.2.
export type ResolvedScope =
  | { kind: 'all' }
  | { kind: 'properties'; via: 'property' | 'owner' | 'group'; ids: number[]; label: string }
  | { kind: 'resident'; key: string; name: string; unit: string; property_id: number; label: string };

export const ALL_SCOPE: ResolvedScope = { kind: 'all' };

/** Normalized entity key segment: lowercase, alnum runs joined by '-'. */
export function slug(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The resident scope key: names collide, so the unit disambiguates. */
export function residentKey(name: string, unit: string): string {
  return `${slug(name)}--${slug(unit)}`;
}

export function parseScopeParam(raw: string | string[] | undefined): Scope {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (!v || v === 'all') return { kind: 'all' };
  const sep = v.indexOf(':');
  if (sep <= 0) return { kind: 'invalid', raw: v };
  const type = v.slice(0, sep);
  const rest = v.slice(sep + 1);
  if (!rest) return { kind: 'invalid', raw: v };
  switch (type) {
    case 'property': {
      const id = Number(rest);
      return Number.isInteger(id) ? { kind: 'property', id } : { kind: 'invalid', raw: v };
    }
    case 'owner':
      return { kind: 'owner', id: rest };
    case 'group':
      return { kind: 'group', slug: rest };
    case 'resident':
      return { kind: 'resident', key: rest };
    default:
      return { kind: 'invalid', raw: v };
  }
}

export function scopeToParam(scope: Scope): string | null {
  switch (scope.kind) {
    case 'all':
      return null;
    case 'property':
      return `property:${scope.id}`;
    case 'owner':
      return `owner:${scope.id}`;
    case 'group':
      return `group:${scope.slug}`;
    case 'resident':
      return `resident:${scope.key}`;
    case 'invalid':
      return null;
  }
}

export interface ScopeResolution {
  resolved: ResolvedScope;
  /** Set when the requested scope could not be honored — the board falls back
   *  to ALL and MUST surface this to the user (never a silent wrong slice). */
  warning: string | null;
}

export function resolveScope(scope: Scope, registry: EntityRegistry | null): ScopeResolution {
  if (scope.kind === 'all') return { resolved: ALL_SCOPE, warning: null };
  if (scope.kind === 'invalid') {
    return { resolved: ALL_SCOPE, warning: `Unrecognized scope "${scope.raw}"; showing all properties.` };
  }
  if (!registry) {
    return {
      resolved: ALL_SCOPE,
      warning: 'Entity registry not generated yet (entities.json missing); showing all properties.',
    };
  }
  switch (scope.kind) {
    case 'property': {
      const p = registry.properties.find((x) => x.id === scope.id);
      if (!p) return { resolved: ALL_SCOPE, warning: `Unknown property id ${scope.id}; showing all properties.` };
      return { resolved: { kind: 'properties', via: 'property', ids: [p.id], label: p.name }, warning: null };
    }
    case 'owner': {
      const o = registry.owners.find((x) => x.id === scope.id);
      if (!o) return { resolved: ALL_SCOPE, warning: `Unknown owner "${scope.id}"; showing all properties.` };
      const ids = registry.properties.filter((p) => p.owner_id === o.id).map((p) => p.id);
      return { resolved: { kind: 'properties', via: 'owner', ids, label: o.name }, warning: null };
    }
    case 'group': {
      const g = registry.owner_groups[scope.slug];
      if (!g) return { resolved: ALL_SCOPE, warning: `Unknown owner group "${scope.slug}"; showing all properties.` };
      const ownerIds = new Set(g.owners);
      const ids = registry.properties.filter((p) => p.owner_id != null && ownerIds.has(p.owner_id)).map((p) => p.id);
      return { resolved: { kind: 'properties', via: 'group', ids, label: g.label }, warning: null };
    }
    case 'resident': {
      const r = registry.residents.find((x) => x.key === scope.key);
      if (!r) return { resolved: ALL_SCOPE, warning: 'Unknown resident scope; showing all properties.' };
      return {
        resolved: { kind: 'resident', key: r.key, name: r.name, unit: r.unit, property_id: r.property_id, label: r.name },
        warning: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Scope-picker options (built server-side from the registry, serialized to the
// client combobox — the client never sees the full registry).
// ---------------------------------------------------------------------------
export interface ScopeOption {
  param: string;
  label: string;
  group: 'Properties' | 'Owners' | 'Owner groups' | 'Residents';
  /** Secondary line shown in the picker (owner name, unit, …). */
  hint?: string;
}

export function buildScopeOptions(registry: EntityRegistry): ScopeOption[] {
  const ownerById = new Map(registry.owners.map((o) => [o.id, o]));
  const opts: ScopeOption[] = [];
  for (const p of registry.properties) {
    const owner = p.owner_id != null ? ownerById.get(p.owner_id) : undefined;
    opts.push({ param: `property:${p.id}`, label: p.name, group: 'Properties', hint: owner?.name });
  }
  for (const o of registry.owners) {
    const g = o.group != null ? registry.owner_groups[o.group] : undefined;
    opts.push({ param: `owner:${o.id}`, label: o.name, group: 'Owners', hint: g?.label });
  }
  for (const [gslug, g] of Object.entries(registry.owner_groups)) {
    opts.push({ param: `group:${gslug}`, label: g.label, group: 'Owner groups', hint: `${g.owners.length} owners` });
  }
  for (const r of registry.residents) {
    opts.push({ param: `resident:${r.key}`, label: r.name, group: 'Residents', hint: r.unit });
  }
  return opts;
}

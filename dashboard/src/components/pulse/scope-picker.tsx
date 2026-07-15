'use client';

// Entity scope picker (§2.4): searchable grouped combobox in the pulse header.
// All (default) · Properties · Owners · Owner groups · Residents. Selecting an
// entity pushes URL state (/pulse?scope=property:118) — the server component
// re-renders every lane through the aggregation module. No client state machine
// beyond the open/closed dropdown.

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { ScopeOption } from '@/lib/data/pulse-scope';

const GROUP_ORDER: ScopeOption['group'][] = ['Properties', 'Owners', 'Owner groups', 'Residents'];

export function ScopePicker({
  options,
  currentParam,
  currentLabel,
  enabled,
}: {
  options: ScopeOption[];
  /** Active scope param (e.g. "property:118") or null for All. */
  currentParam: string | null;
  currentLabel: string;
  /** False until records emission + entities.json are live (Phase D). */
  enabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const router = useRouter();
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const select = (param: string | null, group?: ScopeOption['group']) => {
    setOpen(false);
    // Owner selection opens the per-property OWNER ASSET VIEW ("see all their
    // properties"), not just an ops-board scope — that is the board a user
    // searching an owner name is looking for. Everything else scopes the ops
    // board in place. Owner GROUPS resolve to a property union via the same
    // asset view once David curates owner-groups membership.
    if (param && group === 'Owners' && param.startsWith('owner:')) {
      router.push(`/pulse/owner/${encodeURIComponent(param.slice('owner:'.length))}`);
      return;
    }
    router.push(param ? `/pulse?scope=${encodeURIComponent(param)}` : '/pulse');
  };

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] text-muted-foreground backdrop-blur transition-colors hover:border-primary/50 hover:text-foreground"
      >
        <span className={currentParam ? 'font-medium text-primary' : undefined}>{currentLabel}</span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-80 overflow-hidden rounded-xl border bg-popover shadow-xl">
          {enabled ? (
            <Command>
              <CommandInput placeholder="Property, owner, group, or resident…" autoFocus />
              <CommandList>
                <CommandEmpty>No matching entity.</CommandEmpty>
                <CommandGroup heading="View">
                  <CommandItem value="all all-properties everything" onSelect={() => select(null)}>
                    <span className={!currentParam ? 'font-medium text-primary' : undefined}>All properties</span>
                  </CommandItem>
                </CommandGroup>
                {GROUP_ORDER.map((group) => {
                  const items = options.filter((o) => o.group === group);
                  if (items.length === 0) return null;
                  return (
                    <CommandGroup key={group} heading={group}>
                      {items.map((o) => (
                        <CommandItem
                          key={o.param}
                          // cmdk filters on `value`; include label + hint + group
                          // so typing "moss" or an owner name surfaces matches.
                          value={`${o.label} ${o.hint ?? ''} ${o.group}`}
                          onSelect={() => select(o.param, o.group)}
                        >
                          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-2">
                            <span
                              className={`truncate ${o.param === currentParam ? 'font-medium text-primary' : ''}`}
                            >
                              {o.label}
                            </span>
                            {o.hint && (
                              <span className="shrink-0 text-[11px] text-muted-foreground">{o.hint}</span>
                            )}
                          </span>
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  );
                })}
              </CommandList>
            </Command>
          ) : (
            <p className="px-4 py-5 text-xs leading-relaxed text-muted-foreground">
              Scoping available once records emission is live; the lane generators do not emit
              per-entity records yet (Phase D of the command-center plan).
            </p>
          )}
        </div>
      )}
    </div>
  );
}

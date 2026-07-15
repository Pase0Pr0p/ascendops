'use client';

import { useEffect, useState } from 'react';
import { useOrg } from './use-org';

interface Brand {
  /** Full brand name for titles, headers, metadata. */
  name: string;
  /** Short name for compact slots (favicons, mobile nav, PWA title). */
  shortName: string;
  /** 1–3 letter monogram for compact logo slots (sidebar, splash, login). */
  initials: string;
  /** True when the brand resolved from an org (not the framework default). */
  isOrgBrand: boolean;
}

const DEFAULT_BRAND: Brand = {
  name: 'Agentic PM',
  shortName: 'Agentic PM',
  initials: 'AP',
  isOrgBrand: false,
};

/**
 * Resolves the active brand from the currently selected org.
 *
 * Resolution order per org:
 *   1. `brand_name` / `brand_short_name` explicitly set in context.json
 *   2. Fallback: smart-cased `name` (e.g. "ascendops" → "AscendOps")
 *   3. Fallback: "Agentic PM" product-brand default
 *
 * When no org is selected (currentOrg === 'all') or org context lookup
 * fails, falls back to the Agentic PM product default so the cockpit's
 * brand identity is preserved in cross-org views.
 */
export function useBrand(): Brand {
  const { currentOrg } = useOrg();
  const [brand, setBrand] = useState<Brand>(DEFAULT_BRAND);

  useEffect(() => {
    if (!currentOrg || currentOrg === 'all') {
      setBrand(DEFAULT_BRAND);
      return;
    }

    let cancelled = false;
    fetch(`/api/brand?org=${encodeURIComponent(currentOrg)}`)
      .then(r => (r.ok ? r.json() : null))
      .then(data => {
        if (cancelled || !data) return;
        // Server computes name, shortName, initials — just pass through.
        setBrand({
          name: data.name ?? DEFAULT_BRAND.name,
          shortName: data.shortName ?? DEFAULT_BRAND.shortName,
          initials: data.initials ?? DEFAULT_BRAND.initials,
          isOrgBrand: Boolean(data.isOrgBrand),
        });
      })
      .catch(() => {
        // Silent fallback — never crash UI on brand lookup failure
        if (!cancelled) setBrand(DEFAULT_BRAND);
      });

    return () => {
      cancelled = true;
    };
  }, [currentOrg]);

  return brand;
}


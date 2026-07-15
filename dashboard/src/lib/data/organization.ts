// cortextOS Dashboard - Organization metadata reader
// Reads context.json and brand-voice.md from the framework root org directory.

import fs from 'fs';
import path from 'path';
import { getOrgContextPath, getOrgBrandVoicePath, CTX_FRAMEWORK_ROOT } from '@/lib/config';

export interface OrgContext {
  name: string;
  description: string;
  industry: string;
  icp: string;
  value_prop: string;
  brand_name: string;
  brand_short_name: string;
}

export interface Brand {
  name: string;
  shortName: string;
  /** 1–3 letter monogram for compact logo slots (sidebar, splash, login).
   *  Derived from the name — e.g. "AscendOps" → "AO", "Acme Corp" → "AC". */
  initials: string;
  isOrgBrand: boolean;
}

const DEFAULT_CONTEXT: OrgContext = {
  name: '',
  description: '',
  industry: '',
  icp: '',
  value_prop: '',
  brand_name: '',
  brand_short_name: '',
};

const FRAMEWORK_BRAND: Brand = {
  name: 'Agentic PM',
  shortName: 'Agentic PM',
  initials: 'AP',
  isOrgBrand: false,
};

/**
 * Read context.json for an org. Returns defaults if file missing.
 */
export function getOrganizationContext(org: string): OrgContext {
  const filePath = getOrgContextPath(org);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_CONTEXT };
  }
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw);
    return {
      name: data.name ?? '',
      description: data.description ?? '',
      industry: data.industry ?? '',
      icp: data.icp ?? '',
      value_prop: data.value_prop ?? '',
      brand_name: data.brand_name ?? '',
      brand_short_name: data.brand_short_name ?? '',
    };
  } catch {
    return { ...DEFAULT_CONTEXT };
  }
}

/**
 * Read brand-voice.md for an org. Returns empty string if missing.
 */
export function getBrandVoice(org: string): string {
  const filePath = getOrgBrandVoicePath(org);
  if (!fs.existsSync(filePath)) {
    return '';
  }
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

/** List all org directory names under the framework root. */
export function listOrgs(): string[] {
  const orgsDir = path.join(CTX_FRAMEWORK_ROOT, 'orgs');
  if (!fs.existsSync(orgsDir)) return [];
  try {
    return fs
      .readdirSync(orgsDir, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** Convert "ascendops" → "AscendOps", "acme-corp" → "Acme Corp". */
function smartCase(raw: string): string {
  if (!raw) return '';
  return raw
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Derive a 1-3 letter monogram from a brand name.
 *
 * Multi-word names take first letter of each word (up to 3):
 *   "AscendOps"  → "AO"   (CamelCase treated as two words via regex below)
 *   "Acme Corp"  → "AC"
 *   "Joe's PM Co" → "JPC"
 *
 * Single lowercase-word names take first 2 chars uppercased:
 *   "acme"       → "AC"
 *
 * Empty input → empty string; caller should fall back to framework default.
 */
export function deriveInitials(name: string): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  // Split on whitespace / hyphens / underscores first
  const words = trimmed.split(/[\s_-]+/).filter(Boolean);

  // If we got multiple words, use first letter of each (up to 3)
  if (words.length > 1) {
    return words
      .slice(0, 3)
      .map(w => w.charAt(0).toUpperCase())
      .join('');
  }

  // Single word — try CamelCase split (e.g. "AscendOps" → ["Ascend", "Ops"])
  const camelParts = trimmed.match(/[A-Z][a-z]*|[a-z]+/g) || [];
  if (camelParts.length > 1) {
    return camelParts
      .slice(0, 3)
      .map(p => p.charAt(0).toUpperCase())
      .join('');
  }

  // True single word — first 2 chars uppercased
  return trimmed.slice(0, 2).toUpperCase();
}

/**
 * Resolve the brand for a specific org.
 *
 * Priority: explicit `brand_name` → smart-cased `name` → framework default.
 */
export function getOrgBrand(org: string): Brand {
  const ctx = getOrganizationContext(org);
  const name =
    (ctx.brand_name && ctx.brand_name.trim()) ||
    smartCase(ctx.name || org) ||
    FRAMEWORK_BRAND.name;
  const shortName =
    (ctx.brand_short_name && ctx.brand_short_name.trim()) || name;
  const initials = deriveInitials(shortName) || FRAMEWORK_BRAND.initials;
  return { name, shortName, initials, isOrgBrand: true };
}

/**
 * Resolve the brand used for server-rendered metadata (page title, etc).
 *
 * Selection:
 *   1. If `CTX_DEFAULT_ORG` env var is set and that org exists, use its brand
 *   2. If exactly one org exists, use its brand
 *   3. Otherwise return the product-brand default (Agentic PM)
 *
 * This runs at request time server-side, so it picks up org changes without
 * a dashboard rebuild.
 */
export function getDefaultBrand(): Brand {
  const envOrg = process.env.CTX_DEFAULT_ORG?.trim();
  const orgs = listOrgs();

  if (envOrg && orgs.includes(envOrg)) {
    return getOrgBrand(envOrg);
  }
  if (orgs.length === 1) {
    return getOrgBrand(orgs[0]);
  }
  return { ...FRAMEWORK_BRAND };
}

/**
 * DAD Addons Catalog - the typed, minimal listing layer.
 *
 * HTTP addons are unsigned by design, and require no manifest file at all.
 * There is no downloadable artifact to protect - the addon is a live HTTPS
 * server the author controls, so signing it would add no security (it can
 * change behavior server-side at any time). The catalog entry itself holds
 * `baseUrl` (+ optional `apiKey` install gate) and that is everything -
 * there is no deeper truth: what the catalog says is what you install.
 */

import { isValidVersion } from './version.js';
import type { DadApiKey } from './manifest.js';
import { isHttpsUrl, isBareHttpsUrl, validateApiKeyShape } from './validation.js';

export type DadCatalogAddonType = 'http';

/** One row in the catalog - display + server pointer, nothing more. */
export interface DadCatalogEntry {
  /** Must match the addon's manifest `id` exactly (case-sensitive). */
  id: string;

  /** Human-readable display name. */
  name: string;

  /** Strict `major.minor.patch` - drives the "update available" badge. */
  version: string;

  /** Always 'http' - the only addon type DAD currently supports. */
  type: DadCatalogAddonType;

  /**
   * Base URL of the addon's data server (HTTPS, no query/fragment).
   * REQUIRED; this is the entire install payload - there is no deeper
   * manifest to fetch and nothing to sign.
   */
  baseUrl: string;

  /** One-line marketing blurb for the listing shelf. */
  description?: string;

  /** Publisher display name. */
  publisher?: string;

  /**
   * HTTPS URL of the addon's logo for the listing shelf.
   * Absent (or unset) => the client falls back to the shared default at
   * `https://delulu-addons.pages.dev/default_addon_logo.png` - a publisher
   * only overrides this field when they ship their own logo.
   */
  logo?: string;

  /**
   * Install-gate. `required: true` => install is blocked until the user
   * provides an API key, with `pageUrl` the signup/buy page opened in the
   * OS browser. There is no signed manifest for http addons, so this gate
   * lives here, in the catalog.
   */
  apiKey?: DadApiKey;
}

/** The catalog document itself. */
export interface DadCatalog {
  /** Canonical URL of this catalog file (self-pointer). Optional. */
  sourceUrl?: string;
  addons: DadCatalogEntry[];
}

/**
 * Validates a catalog document. Structural and unambiguous:
 * - every entry needs id/name/version/type ('http' only)
 * - version must be strict major.minor.patch
 * - `baseUrl` required (bare HTTPS, no query/fragment)
 * - apiKey gate's pageUrl must be HTTPS
 * - ids are unique within the catalog
 */
export function validateCatalog(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Catalog must be an object'] };
  }

  const cat = raw as Record<string, any>;
  if (!Array.isArray(cat.addons)) {
    return { valid: false, errors: ["Catalog requires an 'addons' array"] };
  }

  const seenIds = new Set<string>();
  cat.addons.forEach((entry, i) => {
    const at = `addons[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const e = entry as Record<string, any>;

    if (typeof e.id !== 'string' || e.id.trim() === '') {
      errors.push(`${at}.id must be a non-empty string`);
    } else {
      if (seenIds.has(e.id)) errors.push(`${at}.id '${e.id}' is duplicated in the catalog`);
      seenIds.add(e.id);
    }
    if (typeof e.name !== 'string' || e.name.trim() === '') {
      errors.push(`${at}.name must be a non-empty string`);
    }
    if (typeof e.version !== 'string' || !isValidVersion(e.version)) {
      errors.push(`${at}.version must be 'major.minor.patch' (e.g. '2.1.0')`);
    }
    if (e.type !== 'http') {
      errors.push(`${at}.type must be 'http' (DAD only supports HTTP addons)`);
    }

    if (!isBareHttpsUrl(e.baseUrl)) {
      errors.push(`${at}.baseUrl is REQUIRED - an HTTPS URL without query/fragment`);
    }

    for (const optionalStr of ['description', 'publisher'] as const) {
      if (e[optionalStr] !== undefined && (typeof e[optionalStr] !== 'string' || e[optionalStr].trim() === '')) {
        errors.push(`${at}.${optionalStr} must be a non-empty string`);
      }
    }
    // logo has its own dedicated HTTPS check below (isHttpsUrl already
    // implies "non-empty string" - an empty string fails `new URL('')`) -
    // handled separately, rather than through the generic string-field loop
    // above, so a bad logo value produces ONE clear error, not two.
    if (e.logo !== undefined && !isHttpsUrl(e.logo)) {
      errors.push(`${at}.logo must be an HTTPS URL`);
    }

    if (e.apiKey !== undefined) {
      errors.push(...validateApiKeyShape(e.apiKey, `${at}.apiKey`));
    }
  });

  return { valid: errors.length === 0, errors };
}

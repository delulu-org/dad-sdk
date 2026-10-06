/**
 * DAD Addons Catalog - the typed, minimal listing layer.
 *
 * A catalog is a SHELF, not a source of truth. Each row is display data plus
 * ONE pointer: `manifestUrl`, the URL where the addon serves its own
 * `manifest.json`. Everything that matters at runtime - `baseUrl`,
 * `capabilities`, the `apiKey` gate, the real `version` - lives in that
 * manifest, which the client fetches, validates, and caches at install time.
 * The catalog's `version` is only there so a client can show "2.1.0
 * available" without fetching every manifest.
 *
 * Two catalogs are expected, both with this exact shape:
 *   - the OFFICIAL one, hand-reviewed and hand-maintained by the team
 *   - community/unofficial ones, self-published by third parties
 * There is no `official` flag anywhere: official status is derived from the
 * addon's reverse-DNS `id` starting with `org.delulu.` (case-insensitive),
 * which is a namespace reservation, not a field a publisher can set.
 *
 * HTTP addons are unsigned by design, and that is fine: the addon is a live
 * HTTPS server the author controls, so there is no downloadable artifact to
 * protect and no offline trust boundary.
 */

import { isValidVersion } from './version.js';
import { isHttpsUrl } from './validation.js';

export type DadCatalogAddonType = 'http';

/** The `org.delulu.` namespace the official catalog owns. */
export const OFFICIAL_ID_PREFIX = 'org.delulu.';

/**
 * True when an addon id belongs to the reserved official namespace.
 * Case-insensitive, because DNS is - a publisher must not be able to slip
 * `Org.Delulu.x` past a prefix check.
 */
export function isOfficialId(id: string): boolean {
  return id.toLowerCase().startsWith(OFFICIAL_ID_PREFIX);
}

/**
 * One row in the catalog - display data plus a pointer to the addon's own
 * manifest, never a copy of it.
 */
export interface DadCatalogEntry {
  /** Must match the addon's manifest `id` exactly (case-sensitive). */
  id: string;

  /** Human-readable display name. */
  name: string;

  /**
   * Discovery copy of the addon's version (strict `major.minor.patch`) - drives
   * the "update available" badge. The manifest fetched at install time is the
   * authority; keep this in step with it.
   */
  version: string;

  /** Always 'http' - the only addon type DAD currently supports. */
  type: DadCatalogAddonType;

  /**
   * HTTPS URL of the addon's `manifest.json` (e.g.
   * `https://addon.example.com/manifest.json`). REQUIRED. This is the install
   * payload: the client fetches it, validates it, and takes `baseUrl`,
   * `capabilities`, `apiKey`, and the real `version` from it.
   */
  manifestUrl: string;

  /** One-line marketing blurb for the listing shelf. */
  description?: string;

  /** Publisher display name. */
  publisher?: string;

  /**
   * HTTPS URL of the addon's logo for the listing shelf. Purely cosmetic, so it
   * may be omitted even when the manifest has one; a client with no logo for an
   * entry falls back to the shared DAD default logo.
   */
  logo?: string;
}

/** The catalog document itself. */
export interface DadCatalog {
  addons: DadCatalogEntry[];
}

/**
 * Manifest fields rejected on a catalog entry. Left in place they create two
 * sources of truth that can disagree, so they fail loudly instead of being
 * silently ignored.
 */
const MIGRATED_TO_MANIFEST_FIELDS = ['baseUrl', 'apiKey'] as const;

/**
 * Validates a catalog document. Structural and unambiguous:
 * - every entry needs id/name/version/type ('http' only)
 * - version must be strict major.minor.patch
 * - `manifestUrl` required (HTTPS) - the row's only pointer
 * - `baseUrl`/`apiKey` rejected: they belong to the manifest
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

  cat.addons.forEach((entry, i) => {
    const at = `addons[${i}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      errors.push(`${at} must be an object`);
      return;
    }
    const e = entry as Record<string, any>;

    if (typeof e.id !== 'string' || e.id.trim() === '') {
      errors.push(`${at}.id must be a non-empty string`);
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

    for (const moved of MIGRATED_TO_MANIFEST_FIELDS) {
      if (e[moved] !== undefined) {
        errors.push(
          `${at}.${moved} is not a catalog field anymore - it belongs to the addon's manifest.json, which the client ` +
            `fetches from '${at}.manifestUrl'. Remove it from the entry.`
        );
      }
    }

    if (!isHttpsUrl(e.manifestUrl)) {
      errors.push(
        `${at}.manifestUrl is REQUIRED - the HTTPS URL of the addon's manifest.json, e.g. ` +
          `'https://addon.example.com/manifest.json'`
      );
    }

    for (const optionalStr of ['description', 'publisher'] as const) {
      if (e[optionalStr] !== undefined && (typeof e[optionalStr] !== 'string' || e[optionalStr].trim() === '')) {
        errors.push(`${at}.${optionalStr} must be a non-empty string`);
      }
    }
    // Kept out of the generic string loop so a bad logo yields ONE clear error.
    if (e.logo !== undefined && !isHttpsUrl(e.logo)) {
      errors.push(`${at}.logo must be an HTTPS URL`);
    }
  });

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 2b. Namespace seal
// ============================================================================

/**
 * Publisher name reserved for the team. Claiming it REQUIRES holding the
 * `org.delulu.` namespace, but holding the namespace does not require using
 * this exact string (an official addon may publish under a personal or org
 * name).
 */
export const TEAM_PUBLISHER = 'delulu';

export interface CatalogSealResult {
  valid: boolean;
  errors: string[];
}

/**
 * Checks that an entry's claim to team identity is self-consistent.
 *
 * `org.delulu.*` and `publisher: 'delulu'` are equivalent claims, so requiring
 * one without the other is an error in BOTH directions:
 *
 * - `org.delulu.*` with no/foreign publisher - something outside the team is
 *   sitting in the team's reserved id space.
 * - `publisher: 'delulu'` on a non-team id - team branding on an addon the team
 *   does not own.
 *
 * Per-entry only: no baseline and no comparison against what is already
 * published. The id is the stable identity; the host is not.
 *
 * A namespace reservation, not a security boundary - what it protects is the
 * integrity of the hand-reviewed official catalog file.
 */
export function sealCatalog(raw: unknown): CatalogSealResult {
  const structural = validateCatalog(raw);
  if (!structural.valid) {
    return { valid: false, errors: structural.errors };
  }

  const errors: string[] = [];
  const cat = raw as DadCatalog;

  cat.addons.forEach((e, i) => {
    const at = `addons[${i}] ('${e.id}')`;
    const publisher = e.publisher?.trim().toLowerCase();
    const claimsNamespace = isOfficialId(e.id);

    if (claimsNamespace && publisher !== TEAM_PUBLISHER) {
      errors.push(
        `${at} uses the reserved '${OFFICIAL_ID_PREFIX}' namespace, so its publisher must be '${TEAM_PUBLISHER}' ` +
          `(found: ${e.publisher === undefined ? 'none' : `'${e.publisher}'`}). An addon may not hold the team id space ` +
          `without being published by the team.`
      );
    }
    if (!claimsNamespace && publisher === TEAM_PUBLISHER) {
      errors.push(
        `${at} claims publisher '${TEAM_PUBLISHER}' but its id '${e.id}' is outside the reserved ` +
          `'${OFFICIAL_ID_PREFIX}' namespace. Team branding must not appear on a non-team addon.`
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

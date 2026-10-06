/**
 * Supported DAD capability identifiers.
 * Clear, generic, and strictly typed.
 */
export type DadCapability = 'meta' | 'direct_stream' | 'torrent' | 'subtitle';

/** The three URL-route names DAD's HTTP contract defines. */
export type DadRoute = 'streams' | 'meta' | 'subtitles';

/**
 * Every valid capability identifier, in the order `dad init` prints them.
 * Single source of truth shared by validation (validateManifest) and the
 * scaffold's field guide, so the two can never drift.
 */
export const DAD_CAPABILITIES: readonly DadCapability[] = ['meta', 'direct_stream', 'torrent', 'subtitle'];

/**
 * Maps each capability to the one route that serves it - 'direct_stream'
 * and 'torrent' both live under '/streams', everything else is 1:1. Single
 * source of truth for both directions of this mapping: `createHttpAddonHandler`
 * (define.ts) dispatches an incoming route name to a handler, and `dad test`
 * (cli/probe.ts) builds probe URLs from an addon's declared capabilities -
 * both read this instead of hardcoding the mapping separately.
 */
export const CAPABILITY_ROUTES: Record<DadCapability, DadRoute> = {
  meta: 'meta',
  direct_stream: 'streams',
  torrent: 'streams',
  subtitle: 'subtitles',
};

import { isValidVersion } from './version.js';
import { isHttpsUrl, isBareHttpsUrl, validateApiKeyShape } from './validation.js';

/**
 * Fallback logo URL injected into any addon manifest that does not ship its
 * own. Guarantees `logo` is ALWAYS present and non-null once a manifest has
 * gone through the SDK (define layer).
 *
 * Override it with the `DAD_DEFAULT_LOGO_URL` environment variable - a fork,
 * self-hosted deployment, or an air-gapped install can point the SDK at its own
 * asset instead of reaching out to delulu's CDN on every request.
 */
export const DAD_DEFAULT_LOGO_URL: string =
  (typeof process !== 'undefined' && process.env && process.env.DAD_DEFAULT_LOGO_URL) ||
  'https://delulu-addons.pages.dev/default_addon_logo.png';

/**
 * Returns the manifest with `logo` guaranteed non-null: uses the given logo if
 * the developer set a real one, otherwise injects the DAD default. A `null` or
 * empty value counts as "not set". The source manifest files stay untouched -
 * injection happens at define time only.
 */
export function withDefaultLogo<T extends BaseDadManifest>(
  manifest: T,
  defaultLogoUrl: string = DAD_DEFAULT_LOGO_URL
): T {
  if (manifest.logo === undefined || manifest.logo === null || manifest.logo.trim() === '') {
    return { ...manifest, logo: defaultLogoUrl };
  }
  return manifest;
}

/**
 * Base properties shared by all DAD addon manifests.
 */
export interface BaseDadManifest {
  /** Unique reverse-DNS identifier (e.g. "org.delulu.vandal", "org.delulu.embegator") */
  id: string;

  /** Human-readable display name */
  name: string;

  /** SemVer version of the addon (e.g. "1.0.0") */
  version: string;

  /** Publisher or author name */
  publisher?: string;

  /** Short description of what this addon provides */
  description?: string;

  /** Public icon / logo URL */
  logo?: string;

  /** Array of capabilities this addon provides */
  capabilities: DadCapability[];
}

/**
 * Configures a single API key that the client sends on EVERY request as
 * `Authorization: Bearer <key>` - the "OpenAI" model. The addon's author
 * controls what a key unlocks (free tier, paid access, per-key limits) on
 * their own backend; the SDK only delivers the key, securely and typed.
 */
export interface DadApiKey {
  /** Hard gate: if `true`, the addon cannot be installed until a key is provided. */
  required: boolean;

  /**
   * HTTPS URL where users sign up / buy / generate a key. Opened in the OS
   * default browser. Locked to HTTPS by validation, so it cannot be swapped
   * for a phishing page.
   */
  pageUrl: string;
}

/**
 * HTTP DAD Addon Manifest (`type: "http"`) - the only addon type DAD
 * currently supports.
 *
 * This file IS the contract. Each addon serves it at `{baseUrl}/manifest.json`,
 * and a catalog only points at it (`manifestUrl`) for discovery - the addon
 * itself is fetched, re-validated, and cached from that URL at install time,
 * so the manifest - not the catalog copy - is what Delulu Core acts on.
 *
 * Hosted remotely as a web microservice (Cloudflare Workers, Go, Python, Node, etc.).
 * HTTP addons are NOT SIGNED - there is no downloadable artifact to protect and
 * no offline trust boundary: the addon is a live HTTPS server the author
 * controls, so a signature would add no security (its behavior can change
 * server-side at any time).
 */
export interface HttpDadManifest extends BaseDadManifest {
  type: 'http';

  /**
   * Base URL of the addon's data server. A bare HTTPS origin - no path, no
   * query string, no fragment (routes live directly under it: `{baseUrl}/streams/{media_type}/{tmdb_id}[/{season}[/{episode}]]`,
   * `{baseUrl}/meta/...`, `{baseUrl}/subtitles/...` - all JSON).
   */
  baseUrl: string;

  /** Optional single API key delivery (Bearer on every request). */
  apiKey?: DadApiKey;
}

/**
 * DAD addon manifest. Currently always an HTTP manifest - kept as an alias
 * (rather than collapsing straight to `HttpDadManifest`) so a future addon
 * type can be added back as a union member without breaking callers that
 * already write `DadManifest`.
 */
export type DadManifest = HttpDadManifest;

/**
 * Validates the structure and required fields of a DAD manifest.
 *
 * Used for BOTH sides of the wire and nothing in between: an author's
 * `manifest.json` on disk, the copy an addon serves over HTTP, and the copy a
 * client fetched from a catalog. There is no build or signing step that can
 * add fields later, so there is only ONE validator.
 */
export function validateManifest(raw: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object') {
    return { valid: false, errors: ['Manifest must be an object'] };
  }

  const m = raw as Record<string, any>;

  const ID_PATTERN = /^[a-z0-9]+(\.[a-z0-9-]+)+$/;
  if (!m.id || typeof m.id !== 'string') {
    errors.push("Missing or invalid 'id' string");
  } else if (!ID_PATTERN.test(m.id)) {
    errors.push(
      `'id' must be reverse-DNS (e.g. 'org.yourname.addon-name') - got '${m.id}'. Same format 'dad init' enforces at scaffold time.`
    );
  }
  if (!m.name || typeof m.name !== 'string') errors.push("Missing or invalid 'name' string");
  if (!m.version || typeof m.version !== 'string' || !isValidVersion(m.version)) {
    errors.push("Invalid or missing 'version' - must be semantic 'major.minor.patch' (e.g. '2.1.0')");
  }
  // `logo` follows one rule everywhere (see withDefaultLogo): absent, null, or
  // an empty/whitespace-only string all mean "the developer set none".
  const logoUnset =
    m.logo === undefined || m.logo === null || (typeof m.logo === 'string' && m.logo.trim() === '');
  if (!logoUnset && !isHttpsUrl(m.logo)) {
    errors.push(
      "'logo' must be a non-empty HTTPS URL when set - omit it (or use null/'') to fall back to the DAD default logo"
    );
  }

  const validCaps = DAD_CAPABILITIES;
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    errors.push("Missing or empty 'capabilities' array");
  } else {
    const seenCaps = new Set<string>();
    for (const cap of m.capabilities) {
      if (!validCaps.includes(cap)) {
        errors.push(`Invalid capability '${cap}'. Must be one of: ${validCaps.join(', ')}`);
      } else if (seenCaps.has(cap)) {
        errors.push(`Duplicate capability '${cap}' - declare each capability once`);
      } else {
        seenCaps.add(cap);
      }
    }
  }

  if (m.type !== 'http') {
    errors.push("Invalid 'type'. Must be 'http' - DAD only supports HTTP addons.");
  } else {
    if (!m.baseUrl || typeof m.baseUrl !== 'string') {
      errors.push("HTTP addon requires 'baseUrl' string URL");
    } else if (!isBareHttpsUrl(m.baseUrl)) {
      errors.push(
        "HTTP addon 'baseUrl' must be a bare HTTPS origin URL - no path, no query string, no fragment (e.g. 'https://addon.example.com'). " +
          "The addon's routes live directly under it: {baseUrl}/streams/... and its manifest at {baseUrl}/manifest.json."
      );
    }
    if (m.apiKey !== undefined) {
      errors.push(...validateApiKeyShape(m.apiKey, 'apiKey'));
    }
    if (m.signature !== undefined || m.publicKeyId !== undefined) {
      // v1 fields; naming them turns a puzzling error into an obvious fix.
      errors.push(
        "HTTP addons are NOT signed - remove 'signature' and 'publicKeyId'. They were v1 fields and carry no meaning in v2."
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Supported DAD capability identifiers.
 * Clear, generic, and strictly typed.
 */
export type DadCapability = 'meta' | 'direct_stream' | 'torrent' | 'subtitle';

/** The three URL-route names DAD's HTTP contract defines. */
export type DadRoute = 'streams' | 'meta' | 'subtitles';

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
 */
export const DAD_DEFAULT_LOGO_URL = 'https://delulu-addons.pages.dev/default_addon_logo.png';

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
 * Hosted remotely as a web microservice (Cloudflare Workers, Go, Python, Node, etc.).
 * HTTP addons are NOT SIGNED - there is no downloadable artifact to protect and
 * no offline trust boundary: the addon is a live HTTPS server the author
 * controls, so a signature would add no security (its behavior can change
 * server-side at any time). The catalog entry (baseUrl + optional apiKey gate)
 * IS the authority - there is no separate manifest file for http addons.
 */
export interface HttpDadManifest extends BaseDadManifest {
  type: 'http';

  /**
   * Base URL of the addon's data server. HTTPS, no query string or fragment.
   * Data calls are extensionless path segments: `{baseUrl}/streams/{media_type}/{tmdb_id}[/{season}[/{episode}]]`,
   * `{baseUrl}/meta/...`, `{baseUrl}/subtitles/...` - all JSON.
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
 * Type guard to check if a manifest is for an HTTP DAD addon. Currently
 * always true for any valid `DadManifest` - kept for forward compatibility.
 */
export function isHttpManifest(manifest: DadManifest): manifest is HttpDadManifest {
  return manifest.type === 'http';
}

/**
 * Validates the structure and required fields of a DAD manifest.
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
  if (m.logo !== undefined && m.logo !== null) {
    if (!isHttpsUrl(m.logo)) {
      errors.push("'logo' must be an HTTPS URL if present - matches the catalog's own logo requirement");
    }
  }

  const validCaps: DadCapability[] = ['meta', 'direct_stream', 'torrent', 'subtitle'];
  if (!Array.isArray(m.capabilities) || m.capabilities.length === 0) {
    errors.push("Missing or empty 'capabilities' array");
  } else {
    for (const cap of m.capabilities) {
      if (!validCaps.includes(cap)) {
        errors.push(`Invalid capability '${cap}'. Must be one of: ${validCaps.join(', ')}`);
      }
    }
  }

  if (m.type !== 'http') {
    errors.push("Invalid 'type'. Must be 'http' - DAD only supports HTTP addons.");
  } else {
    if (!m.baseUrl || typeof m.baseUrl !== 'string') {
      errors.push("HTTP addon requires 'baseUrl' string URL");
    } else if (!isBareHttpsUrl(m.baseUrl)) {
      errors.push("HTTP addon 'baseUrl' must be a bare HTTPS URL (no query string or fragment)");
    }
    if (m.apiKey !== undefined) {
      errors.push(...validateApiKeyShape(m.apiKey, 'apiKey'));
    }
    if (m.signature !== undefined || m.publicKeyId !== undefined) {
      errors.push("HTTP addons are NOT signed - remove 'signature' and 'publicKeyId'.");
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a developer's source manifest. Kept as a separate export (rather
 * than folding call sites onto `validateManifest` directly) since some
 * callers historically distinguished "source, pre-build" validation from
 * production validation; for HTTP-only manifests the two are identical -
 * there is no build/signing step that adds fields later.
 */
export function validateSourceManifest(raw: unknown): { valid: boolean; errors: string[] } {
  return validateManifest(raw);
}

import { HttpDadManifest, DadCapability, validateSourceManifest, withDefaultLogo } from './manifest.js';
import { DadError, DadErrorCode, DAD_ERROR_STATUS, isErrorResponse, validateErrorResponse } from './errors.js';
import {
  DadMetaRequest,
  DadMetaResponse,
  DadStreamRequest,
  DadStreamItem,
  DadSubtitleRequest,
  DadSubtitleItem,
  DadMediaType,
  validateMetaResponse,
  validateStreamItems,
  validateSubtitleItems,
  allowedStreamTypesForCapabilities,
} from './responses.js';

export interface DadAddonHandlers {
  /** Handler called when Delulu Core requests metadata (if 'meta' capability declared) */
  getMeta?: (req: DadMetaRequest) => Promise<DadMetaResponse | null>;

  /** Handler called when Delulu Core requests streams (if 'direct_stream' or 'torrent' capability declared) */
  getStreams?: (req: DadStreamRequest) => Promise<DadStreamItem[]>;

  /** Handler called when Delulu Core requests subtitles (if 'subtitle' capability declared) */
  getSubtitles?: (req: DadSubtitleRequest) => Promise<DadSubtitleItem[]>;
}

export interface HttpAddonDefinition extends DadAddonHandlers {
  manifest: HttpDadManifest;
}

/**
 * Every declared DAD capability has exactly one handler it maps to.
 * Used to enforce capability <-> handler consistency at definition time.
 */
const CAPABILITY_HANDLERS: Record<DadCapability, keyof DadAddonHandlers> = {
  meta: 'getMeta',
  direct_stream: 'getStreams',
  torrent: 'getStreams',
  subtitle: 'getSubtitles',
};

/**
 * Hard validation at definition/load time (throws on violation):
 *  1. The manifest itself must be structurally valid.
 *  2. Every DECLARED capability must have its matching handler implemented.
 *  3. Every implemented handler must be covered by a declared capability.
 * Catches misconfigured addons before they ever reach Delulu Core.
 */
function assertAddonDefinition(def: HttpAddonDefinition): void {
  const manifestCheck = validateSourceManifest(def.manifest);
  if (!manifestCheck.valid) {
    throw new TypeError(
      `DAD addon '${def.manifest.id}' has an invalid manifest: ${manifestCheck.errors.join('; ')}`
    );
  }

  const caps: DadCapability[] = def.manifest.capabilities ?? [];
  const capabilitiesByHandler = new Map<keyof DadAddonHandlers, DadCapability>();

  for (const cap of caps) {
    const handler = CAPABILITY_HANDLERS[cap];
    capabilitiesByHandler.set(handler, cap);
    if (!def[handler]) {
      throw new TypeError(
        `DAD addon '${def.manifest.id}' declares capability '${cap}' but does not implement handler '${handler}'.`
      );
    }
  }

  const allHandlers = Object.values(CAPABILITY_HANDLERS) as (keyof DadAddonHandlers)[];
  const implementedHandlers = (Object.keys(def) as (keyof DadAddonHandlers)[]).filter(
    (k) => allHandlers.includes(k) && Boolean(def[k])
  );
  for (const h of implementedHandlers) {
    if (!capabilitiesByHandler.has(h)) {
      const cap = Object.keys(CAPABILITY_HANDLERS).find((c) => CAPABILITY_HANDLERS[c as DadCapability] === h);
      throw new TypeError(
        `DAD addon '${def.manifest.id}' implements handler '${h}' but does not declare the matching capability '${cap}'.`
      );
    }
  }
}

/**
 * Define a type-safe HTTP DAD Addon.
 * `logo` is guaranteed non-null: the developer's own logo when provided,
 * otherwise the DAD default (`withDefaultLogo`).
 */
export function defineHttpAddon(def: HttpAddonDefinition): HttpAddonDefinition {
  const normalized = { ...def, manifest: withDefaultLogo(def.manifest) };
  assertAddonDefinition(normalized);
  return normalized;
}

/**
 * Alias of `defineHttpAddon`. DAD currently supports only HTTP addons -
 * kept as a separate export so call sites that prefer the generic name
 * don't need to change if a second addon type is ever added back.
 */
export function defineAddon(def: HttpAddonDefinition): HttpAddonDefinition {
  return defineHttpAddon(def);
}

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}

function errorResponse(code: DadErrorCode, error_message: string): Response {
  return jsonResponse({ error: code, error_message }, DAD_ERROR_STATUS[code]);
}

function toErrorResponse(e: unknown): Response {
  if (e instanceof DadError) {
    return errorResponse(e.code, e.message);
  }
  if (typeof e === 'string') {
    return errorResponse('internal_error', e);
  }
  const message = e instanceof Error ? e.message : String(e);
  return errorResponse('internal_error', message);
}

/**
 * Standard HTTP Request Router for HTTP DAD Addons.
 * Compatible with Cloudflare Workers, Node.js (via native fetch / Web Standard Request), Bun, Deno, Fastify, and Next.js.
 *
 * The addon's catalog entry is the source of truth: the entry itself holds
 * `baseUrl` (+ optional `apiKey` gate) and that is everything - HTTP addons
 * are UNSIGNED by design (no artifact to protect); this server only serves data.
 * HARDENED extensionless, path-segment routes (Strictly GET):
 * - GET /streams/{media_type}/{tmdb_id}[/{season}[/{episode}]]  -> Resolves streams
 * - GET /meta/{media_type}/{tmdb_id}[/{season}[/{episode}]]    -> Resolves meta (per-season trailers!)
 * - GET /subtitles/{media_type}/{tmdb_id}[/{season}[/{episode}]] -> Resolves subtitles (per-episode)
 * - OPTIONS *                                                   -> CORS preflight
 *
 * Path URLs are the ONLY accepted shape. The old Stremio-style `.../meta/movie/tt0137523.json`
 * suffix and query-string routes (`?tmdb_id=`/`?media_type=`) are rejected with a 400 so
 * clients can never regress to them.
 *
 * API keys arrive as `Authorization: Bearer <key>` on every request and are
 * injected into the request as `auth`. If present, missing/invalid and - after
 * the addon's backend decides what the key unlocks - a 401 is returned as-is.
 */
export function createHttpAddonHandler(addon: HttpAddonDefinition): (request: Request) => Promise<Response> {
  return async function handleRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // 1. CORS Preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Strictly enforce GET method
    if (request.method !== 'GET') {
      return errorResponse('method_not_allowed', 'DAD HTTP addons strictly use GET requests.');
    }

    const pathname = url.pathname.replace(/\/+$/, '');
    const segments = pathname.split('/').filter(Boolean);
    const route = segments[0] as string | undefined;

    // HARDENED: DAD HTTP routes are extensionless path-segment URLs. ANY `.` in
    // the path is rejected loudly (400) - the old Stremio-style
    // `.../meta/movie/tt0137523.json` suffix (or any file extension) must never
    // sneak back into clients.
    if (pathname.includes('.')) {
      return errorResponse(
        'bad_request',
        `DAD routes are extensionless by design - no '.json' or any file extension. ` +
          `Request '/${route ?? 'streams'}/{media_type}/{tmdb_id}' instead.`
      );
    }

    if (route !== 'meta' && route !== 'streams' && route !== 'subtitles') {
      return errorResponse('not_found', `Not found: ${pathname}`);
    }
    if (segments.length < 3) {
      return errorResponse(
        'bad_request',
        `Malformed DAD request '${pathname}' - expected ` +
          `'/${route}/{media_type}/{tmdb_id}[/{season}[/{episode}]]'`
      );
    }

    // Parse + strictly validate the path segments into a DadRequest.
    // Returns an error message string on invalid input (handled as a 400).
    function parsePathRequest(): DadMetaRequest | string {
      const mediaTypeSegment = segments[1];
      if (mediaTypeSegment !== 'movie' && mediaTypeSegment !== 'tv') {
        return `Invalid 'media_type' - must be 'movie' or 'tv' (got '${mediaTypeSegment}')`;
      }

      const idSegment = segments[2];
      if (!/^\d+$/.test(idSegment)) {
        return `Invalid 'tmdb_id' - must be digits only (e.g. '/${route}/movie/550'), got '${idSegment}'`;
      }

      // Movies have no seasons or episodes - reject extra segments outright
      // rather than silently parsing and forwarding s/e to the handler.
      if (mediaTypeSegment === 'movie' && segments.length > 3) {
        return `'season'/'episode' segments are TV-only - got '/${route}/movie/${idSegment}/${segments.slice(3).join('/')}'. Use '/${route}/movie/${idSegment}' instead.`;
      }

      let s: number | undefined;
      let e: number | undefined;

      // Season/episode segments are OPTIONAL on every route - TV shows have
      // per-season trailers (meta) and per-episode subtitles, so the same
      // hierarchical shape applies to streams, meta, and subtitles alike:
      //   3 segments -> movie / season-agnostic TV show
      //   4 segments -> season only   (e.g. /meta/tv/{tmdb_id}/{season})
      //   5 segments -> season+episode (e.g. /subtitles/tv/{tmdb_id}/{season}/{episode})
      if (segments.length > 5) {
        return `Malformed DAD request - too many segments. Max is '/${route}/{media_type}/{tmdb_id}/{season}/{episode}'`;
      }
      if (segments.length >= 4) {
        if (!/^\d+$/.test(segments[3])) {
          return "Invalid 's' (season) - must be an integer";
        }
        s = parseInt(segments[3], 10);
      }
      if (segments.length === 5) {
        if (!/^\d+$/.test(segments[4])) {
          return "Invalid 'e' (episode) - must be an integer";
        }
        e = parseInt(segments[4], 10);
      }

      // Single API key delivery (OpenAI-style): `Authorization: Bearer <key>`.
      // Present on every request the client makes when it holds a key for this addon.
      const authHeader = request.headers.get('authorization');
      let auth: string | undefined;
      if (authHeader) {
        const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
        if (!match) {
          return "Invalid 'Authorization' header - must be 'Bearer <apiKey>'";
        }
        auth = match[1];
      }

      return {
        tmdb_id: parseInt(idSegment, 10),
        media_type: mediaTypeSegment as DadMediaType,
        s,
        e,
        auth,
      };
    }

    const req = parsePathRequest();
    if (typeof req === 'string') {
      return errorResponse('bad_request', req);
    }

    // 3. Streams Endpoint (/streams/{media_type}/{tmdb_id}[/{season}[/{episode}]])
    if (route === 'streams') {
      if (!addon.getStreams) {
        return errorResponse('not_found', 'Addon does not declare the streams capability');
      }
      let raw: unknown;
      try {
        raw = (await addon.getStreams(req)) ?? [];
      } catch (e: unknown) {
        return toErrorResponse(e);
      }
      if (isErrorResponse(raw) && validateErrorResponse(raw).valid) {
        return jsonResponse(raw, DAD_ERROR_STATUS[raw.error]);
      }
      const streamCheck = validateStreamItems(raw, {
        allowedTypes: allowedStreamTypesForCapabilities(addon.manifest.capabilities),
      });
      if (!streamCheck.valid) {
        return errorResponse('invalid_response', `Invalid stream response: ${streamCheck.errors.join(' ')}`);
      }
      return jsonResponse(raw);
    }

    // 4. Meta Endpoint (/meta/{media_type}/{tmdb_id})
    if (route === 'meta') {
      if (!addon.getMeta) {
        return errorResponse('not_found', 'Addon does not declare the meta capability');
      }
      let raw: unknown;
      try {
        raw = (await addon.getMeta(req)) ?? null;
      } catch (e: unknown) {
        return toErrorResponse(e);
      }
      if (isErrorResponse(raw) && validateErrorResponse(raw).valid) {
        return jsonResponse(raw, DAD_ERROR_STATUS[raw.error]);
      }
      const metaCheck = validateMetaResponse(raw);
      if (!metaCheck.valid) {
        return errorResponse('invalid_response', `Invalid meta response: ${metaCheck.errors.join(' ')}`);
      }
      return jsonResponse(raw);
    }

    // 5. Subtitles Endpoint (/subtitles/{media_type}/{tmdb_id}[/{season}[/{episode}]])
    if (route === 'subtitles') {
      if (!addon.getSubtitles) {
        return errorResponse('not_found', 'Addon does not declare the subtitles capability');
      }
      let raw: unknown;
      try {
        raw = (await addon.getSubtitles(req)) ?? [];
      } catch (e: unknown) {
        return toErrorResponse(e);
      }
      if (isErrorResponse(raw) && validateErrorResponse(raw).valid) {
        return jsonResponse(raw, DAD_ERROR_STATUS[raw.error]);
      }
      const subtitleCheck = validateSubtitleItems(raw);
      if (!subtitleCheck.valid) {
        return errorResponse('invalid_response', `Invalid subtitle response: ${subtitleCheck.errors.join(' ')}`);
      }
      return jsonResponse(raw);
    }

    return errorResponse('not_found', `Not found: ${pathname}`);
  };
}

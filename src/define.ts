import { HttpDadManifest, DadCapability, validateManifest, withDefaultLogo } from './manifest.js';
import { DadError, DadErrorCode, DAD_ERROR_STATUS, isErrorResponse, looksLikeErrorPayload, validateErrorResponse } from './errors.js';
import {
  DadRequest,
  DadMetaResponse,
  DadStreamItem,
  DadSubtitleItem,
  validateMetaResponse,
  validateStreamItems,
  validateSubtitleItems,
  allowedStreamTypesForCapabilities,
} from './responses.js';

export interface DadAddonHandlers {
  /** Handler called when Delulu Core requests metadata (if 'meta' capability declared) */
  getMeta?: (req: DadRequest) => Promise<DadMetaResponse | null>;

  /** Handler called when Delulu Core requests streams (if 'direct_stream' or 'torrent' capability declared) */
  getStreams?: (req: DadRequest) => Promise<DadStreamItem[]>;

  /** Handler called when Delulu Core requests subtitles (if 'subtitle' capability declared) */
  getSubtitles?: (req: DadRequest) => Promise<DadSubtitleItem[]>;
}

export interface HttpAddonDefinition extends DadAddonHandlers {
  manifest: HttpDadManifest;
}

/**
 * Optional operational hooks for the HTTP adapter. The default deliberately
 * logs no exception details: upstream errors regularly contain credentials,
 * tokens, or internal URLs. Applications that have a redacting, access-
 * controlled logger can opt in to receiving the original error here.
 */
export interface HttpAddonHandlerOptions {
  onUnexpectedError?: (error: unknown) => void;
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
  const manifestCheck = validateManifest(def.manifest);
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
      const candidates = (Object.keys(CAPABILITY_HANDLERS) as DadCapability[]).filter(
        (c) => CAPABILITY_HANDLERS[c] === h
      );
      throw new TypeError(
        `DAD addon '${def.manifest.id}' implements handler '${h}' but does not declare the matching capability. ` +
          `Declare one of: ${candidates.map((c) => `'${c}'`).join(', ')}.`
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

function toErrorResponse(e: unknown, onUnexpectedError?: (error: unknown) => void): Response {
  if (e instanceof DadError) {
    return errorResponse(e.code, e.message);
  }
  // Anything that is not an explicit DadError is an unexpected bug. Do not
  // write its message to the default log: connection strings, API tokens, and
  // internal URLs often appear there. Hosts with a redacting logger can opt in
  // through onUnexpectedError.
  try {
    onUnexpectedError?.(e);
  } catch {
    // Observability must never turn an already-failed request into a crash.
  }
  return errorResponse('internal_error', 'Internal addon error.');
}

/** Serialize an addon-controlled value without allowing a cyclic/BigInt/etc.
 * value to escape the adapter as an unhandled exception. */
function handlerJsonResponse(data: unknown, status = 200): Response {
  try {
    return jsonResponse(data, status);
  } catch {
    return errorResponse('invalid_response', 'Handler returned a response that cannot be serialized as JSON.');
  }
}

/**
 * If a handler returned something shaped like a DAD error, answer it as one.
 *
 * A valid `{ error, error_message }` object passes through with its own status;
 * a malformed one is reported as `invalid_response` naming what went wrong
 * instead of falling through to the success validator.
 *
 * Returns null when the payload isn't error-shaped at all (the normal case).
 */
function errorOrMalformedError(raw: unknown): Response | null {
  if (isErrorResponse(raw)) {
    return handlerJsonResponse(raw, DAD_ERROR_STATUS[raw.error]);
  }
  if (!looksLikeErrorPayload(raw)) return null;
  const check = validateErrorResponse(raw);
  return errorResponse(
    'invalid_response',
    `Handler returned an object with an 'error' field that is not a valid DAD error response: ${check.errors.join(
      ' '
    )}. Return a well-formed { error, error_message } pair, or throw DadError instead.`
  );
}

/**
 * Standard HTTP Request Router for HTTP DAD Addons.
 * Compatible with Cloudflare Workers, Node.js (via native fetch / Web Standard Request), Bun, Deno, Fastify, and Next.js.
 *
 * The addon's OWN `manifest.json` is the contract: it declares `baseUrl`,
 * `capabilities`, and the optional `apiKey` gate. HTTP addons are UNSIGNED by
 * design (no artifact to protect); this server only serves data.
 * HARDENED extensionless, path-segment routes (Strictly GET):
 * - GET /streams/{media_type}/{tmdb_id}[/{season}[/{episode}]]  -> Resolves streams
 * - GET /meta/{media_type}/{tmdb_id}[/{season}[/{episode}]]    -> Resolves meta (per-season trailers!)
 * - GET /subtitles/{media_type}/{tmdb_id}[/{season}[/{episode}]] -> Resolves subtitles (per-episode)
 * - OPTIONS *                                                   -> CORS preflight
 *
 * Path URLs are the only accepted shape: extensionless path segments, no
 * `.../meta/movie/tt0137523.json` suffix, no query-string routes.
 *
 * API keys arrive as `Authorization: Bearer <key>` on every request and are
 * injected into the request as `auth`. If the manifest sets `apiKey.required`,
 * a request WITHOUT a key is rejected 401 before any handler runs; otherwise
 * the key is optional and a bad key is a 401 the backend decides to raise.
 */
export function createHttpAddonHandler(
  addon: HttpAddonDefinition,
  options: HttpAddonHandlerOptions = {}
): (request: Request) => Promise<Response> {
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

    // The addon's OWN manifest is part of its HTTP contract: install/discovery
    // and `dad test` fetch it at `{baseUrl}/manifest.json`. Serve the validated,
    // logo-injected manifest here so every deployment (Workers, Node, Deno, ...)
    // exposes it with zero extra code - matching what `dad dev` already served.
    if (pathname === '/manifest.json' || pathname === '/manifest') {
      return handlerJsonResponse(addon.manifest);
    }

    const segments = pathname.split('/').filter(Boolean);
    const route = segments[0] as string | undefined;

    // DAD data routes are extensionless - any file extension is a 400. The
    // one exception is the addon's own `/manifest.json`, served above.
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

    // Result object rather than a `DadRequest | string` union: both branches
    // hold strings, so a message can never be mistaken for a parsed request.
    type ParseOutcome = { ok: true; request: DadRequest } | { ok: false; error: string };

    function parsePathRequest(): ParseOutcome {
      const fail = (error: string): ParseOutcome => ({ ok: false, error });

      const mediaTypeSegment = segments[1];
      if (mediaTypeSegment !== 'movie' && mediaTypeSegment !== 'tv') {
        return fail(`Invalid 'media_type' - must be 'movie' or 'tv' (got '${mediaTypeSegment}')`);
      }

      const idSegment = segments[2];
      const numericId = Number(idSegment);
      if (!/^[1-9]\d*$/.test(idSegment) || !Number.isSafeInteger(numericId)) {
        return fail(`Invalid 'tmdb_id' - must be a positive integer (e.g. '/${route}/movie/550'), got '${idSegment}'`);
      }

      // Movies have no seasons or episodes - reject extra segments outright
      // rather than silently parsing and forwarding s/e to the handler.
      if (mediaTypeSegment === 'movie' && segments.length > 3) {
        return fail(
          `'season'/'episode' segments are TV-only - got '/${route}/movie/${idSegment}/${segments
            .slice(3)
            .join('/')}'. Use '/${route}/movie/${idSegment}' instead.`
        );
      }

      let s: number | undefined;
      let e: number | undefined;

      // Season/episode segments are optional on every route:
      //   3 segments -> movie / season-agnostic TV show
      //   4 segments -> season only   (e.g. /meta/tv/{tmdb_id}/{season})
      //   5 segments -> season+episode (e.g. /subtitles/tv/{tmdb_id}/{season}/{episode})
      if (segments.length > 5) {
        return fail(`Malformed DAD request - too many segments. Max is '/${route}/{media_type}/{tmdb_id}/{season}/{episode}'`);
      }
      if (segments.length >= 4) {
        if (!/^\d+$/.test(segments[3])) {
          return fail("Invalid 's' (season) - must be an integer");
        }
        s = parseInt(segments[3], 10);
      }
      if (segments.length === 5) {
        if (!/^\d+$/.test(segments[4])) {
          return fail("Invalid 'e' (episode) - must be an integer");
        }
        e = parseInt(segments[4], 10);
      }

      const authHeader = request.headers.get('authorization');
      let auth: string | undefined;
      if (authHeader) {
        const match = /^Bearer\s+(\S+)$/i.exec(authHeader);
        if (!match) {
          return fail("Invalid 'Authorization' header - must be 'Bearer <apiKey>'");
        }
        auth = match[1];
      }

      return {
        ok: true,
        request: {
          tmdb_id: numericId,
          media_type: mediaTypeSegment as DadRequest['media_type'],
          s,
          e,
          auth,
        },
      };
    }

    const parsed = parsePathRequest();
    if (!parsed.ok) {
      return errorResponse('bad_request', parsed.error);
    }
    const req = parsed.request;

    // Enforce a declared `apiKey.required` gate before any handler runs.
    if (addon.manifest.apiKey?.required === true && req.auth === undefined) {
      return errorResponse(
        'unauthorized',
        `This addon requires an API key${
          addon.manifest.apiKey.pageUrl ? ` - get one at ${addon.manifest.apiKey.pageUrl}` : ''
        }.`
      );
    }

    // 3. Streams Endpoint (/streams/{media_type}/{tmdb_id}[/{season}[/{episode}]])
    if (route === 'streams') {
      if (!addon.getStreams) {
        return errorResponse(
          'not_found',
          `Addon '${addon.manifest.id}' does not declare 'direct_stream' or 'torrent' - no streams capability to serve.`
        );
      }
      let raw: unknown;
      try {
        raw = (await addon.getStreams(req)) ?? [];
      } catch (e: unknown) {
        return toErrorResponse(e, options.onUnexpectedError);
      }
      const errored = errorOrMalformedError(raw);
      if (errored) return errored;
      const streamCheck = validateStreamItems(raw, {
        allowedTypes: allowedStreamTypesForCapabilities(addon.manifest.capabilities),
      });
      if (!streamCheck.valid) {
        return errorResponse('invalid_response', `Invalid stream response: ${streamCheck.errors.join(' ')}`);
      }
      return handlerJsonResponse(raw);
    }

    // 4. Meta Endpoint (/meta/{media_type}/{tmdb_id})
    if (route === 'meta') {
      if (!addon.getMeta) {
        return errorResponse('not_found', `Addon '${addon.manifest.id}' does not declare the 'meta' capability.`);
      }
      let raw: unknown;
      try {
        raw = (await addon.getMeta(req)) ?? null;
      } catch (e: unknown) {
        return toErrorResponse(e, options.onUnexpectedError);
      }
      const errored = errorOrMalformedError(raw);
      if (errored) return errored;
      const metaCheck = validateMetaResponse(raw);
      if (!metaCheck.valid) {
        return errorResponse('invalid_response', `Invalid meta response: ${metaCheck.errors.join(' ')}`);
      }
      return handlerJsonResponse(raw);
    }

    // 5. Subtitles Endpoint (/subtitles/{media_type}/{tmdb_id}[/{season}[/{episode}]])
    if (route === 'subtitles') {
      if (!addon.getSubtitles) {
        return errorResponse(
          'not_found',
          `Addon '${addon.manifest.id}' does not declare the 'subtitle' capability.`
        );
      }
      let raw: unknown;
      try {
        raw = (await addon.getSubtitles(req)) ?? [];
      } catch (e: unknown) {
        return toErrorResponse(e, options.onUnexpectedError);
      }
      const errored = errorOrMalformedError(raw);
      if (errored) return errored;
      const subtitleCheck = validateSubtitleItems(raw);
      if (!subtitleCheck.valid) {
        return errorResponse('invalid_response', `Invalid subtitle response: ${subtitleCheck.errors.join(' ')}`);
      }
      return handlerJsonResponse(raw);
    }

    return errorResponse('not_found', `Not found: ${pathname}`);
  };
}

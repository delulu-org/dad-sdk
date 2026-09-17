/**
 * Media type identifier.
 */
export type DadMediaType = 'movie' | 'tv';

import { isHttpsUrl } from './validation.js';

// ============================================================================
// 1. Universal Request
// ============================================================================

/**
 * Universal DAD Request
 * Every addon call receives exactly these parameters:
 * - tmdb_id: TMDB ID (e.g. 550)
 * - media_type: "movie" | "tv"
 * - s: Season number (e.g. 1, optional/null for movies)
 * - e: Episode number (e.g. 1, optional/null for movies)
 * - auth: API key delivered as `Authorization: Bearer`, present only when the
 *   client holds one for this addon. The addon's author decides what it unlocks.
 */
export interface DadRequest {
  tmdb_id: number;
  media_type: DadMediaType;
  s?: number | null;
  e?: number | null;
  auth?: string;
}

export type DadMetaRequest = DadRequest;
export type DadStreamRequest = DadRequest;
export type DadSubtitleRequest = DadRequest;

// ============================================================================
/**
 * Trailer quality keys understood by Delulu Core's player. Free-form strings
 * are NOT accepted - a trailer_sources map keyed by anything else is invalid.
 */
export type DadTrailerQualityKey = '2160p' | '1440p' | '1080p' | '720p' | '480p' | '360p' | 'hls';

/** Quality-keyed trailer source map. e.g. { "1080p": "https://...", "hls": "https://..." } */
export type DadTrailerSources = Partial<Record<DadTrailerQualityKey, string>>;

/**
 * Meta Addon Response.
 * Core app already gets poster, backdrop, overview, title, and cast from TMDB.
 * Meta addons are called strictly to enrich missing media signals:
 * transparent logo, official trailer(s), IMDb ID mapping, and IMDb rating.
 *
 * ALL fields are completely optional and nullable. If an addon only finds a logo,
 * it simply returns { logo_url: "..." }, and nothing is dropped.
 */
export interface DadMetaResponse {
  /** Canonical IMDb ID (e.g. "tt0137523") */
  imdb_id?: string | null;

  /**
   * Canonical IMDb community rating as a NUMBER (e.g. 8.8).
   * UNIFIED FORM: an addon MUST normalize before returning - parseFloat any
   * string rating it receives from an upstream source. Returning a string is
   * a type violation. `null` when unknown.
   */
  imdb_rating?: number | null;

  /** Transparent title logo URL (PNG) */
  logo_url?: string | null;

  /** Primary trailer URL */
  trailer_url?: string | null;

  /** Quality-keyed trailer sources map (keys constrained to DadTrailerQualityKey) */
  trailer_sources?: DadTrailerSources | null;
}

/**
 * Validates a meta response against the enforced meta contract.
 * A `null`/`undefined` result (addon found nothing) is valid.
 */
export function validateMetaResponse(raw: unknown): { valid: boolean; errors: string[] } {
  if (raw == null) return { valid: true, errors: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Meta response must be an object or null'] };
  }

  const m = raw as Record<string, any>;
  const errors: string[] = [];

  if (m.imdb_id !== undefined && m.imdb_id !== null && typeof m.imdb_id !== 'string') {
    errors.push(`'imdb_id' must be a string`);
  }
  if (m.imdb_rating !== undefined && m.imdb_rating !== null) {
    if (typeof m.imdb_rating !== 'number' || isNaN(m.imdb_rating)) {
      errors.push(`'imdb_rating' must be a number - normalize string ratings (e.g. parseFloat) before returning`);
    }
  }
  for (const field of ['logo_url', 'trailer_url'] as const) {
    if (m[field] !== undefined && m[field] !== null && typeof m[field] !== 'string') {
      errors.push(`'${field}' must be a string`);
    }
  }
  if (m.trailer_sources !== undefined && m.trailer_sources !== null) {
    if (typeof m.trailer_sources !== 'object' || Array.isArray(m.trailer_sources)) {
      errors.push(`'trailer_sources' must be an object map`);
    } else {
      const allowedKeys: DadTrailerQualityKey[] = ['2160p', '1440p', '1080p', '720p', '480p', '360p', 'hls'];
      for (const [k, v] of Object.entries(m.trailer_sources)) {
        if (!allowedKeys.includes(k as DadTrailerQualityKey)) {
          errors.push(
            `trailer_sources key '${k}' is not a recognized quality - must be one of: ${allowedKeys.join(', ')}`
          );
        }
        if (typeof v !== 'string') {
          errors.push(`trailer_sources['${k}'] must be a string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 3. Stream Types
// ============================================================================

export type DadStreamType = 'direct' | 'torrent';

/**
 * Derives the set of stream `type` values an addon is allowed to emit,
 * strictly from its declared capabilities ('direct_stream' => 'direct',
 * 'torrent' => 'torrent'). The single source of truth for this mapping -
 * both `createHttpAddonHandler` (define.ts, enforcing production responses)
 * and `dad test` (cli/probe.ts, testing a live deployed addon) call this
 * rather than each re-deriving it, so the two can never drift out of sync.
 */
export function allowedStreamTypesForCapabilities(capabilities: readonly string[]): DadStreamType[] {
  const allowed: DadStreamType[] = [];
  if (capabilities.includes('direct_stream')) allowed.push('direct');
  if (capabilities.includes('torrent')) allowed.push('torrent');
  return allowed;
}

/**
 * The playback contract is strict and deterministic:
 *
 * - If a stream is directly playable by the player, the addon returns it with
 *   NO `headers` and NO `needs_proxy`. Delulu Core passes the URL straight to
 *   the player - zero proxying.
 * - If a stream CANNOT be played directly (CORS/HLS rewriting, datacenter-
 *   blocked CDN, third-party mirror, etc.), the addon MUST set
 *   `needs_proxy: true` AND provide a NON-EMPTY `headers` map (typically
 *   `{ Referer, User-Agent, Origin, Cookie, ... }`). Delulu Core will only
 *   route it through the proxy if these headers exist.
 * - `headers` are PER-STREAM, so an addon aggregating many providers attaches
 *   each stream's own headers to that stream item (Provider A's Referer never
 *   leaks onto Provider B's URL).
 *
 * An addon that omits `headers` is declaring the URL directly playable - no
 * proxy, no header injection, period.
 */

/**
 * Fields shared by every stream candidate.
 *
 * ONLY `type`, `title`, and `stream_url` are strictly required.
 * ALL quality/codec/size signals are optional and nullable - an addon that
 * doesn't know them is never penalized or dropped over them.
 */
export interface DadStreamItemBase {
  type: DadStreamType;

  /** Display title / release name (e.g. "Server 1 - 1080p" or "Movie.1080p.x265") */
  title: string;

  /** Playable video stream URL (MP4 / HLS .m3u8) OR magnet link / torrent URI */
  stream_url: string;

  /**
   * Container format so the player can pick the right engine WITHOUT sniffing
   * the URL: "hls", "mp4", "mpd" (DASH), "mkv", "webm", or "other".
   * Optional but strongly recommended.
   */
  media_format?: 'hls' | 'mp4' | 'mpd' | 'mkv' | 'webm' | 'other' | null;

  /** Optional resolution (e.g. "2160p", "1080p", "720p", "480p") */
  resolution?: string | null;

  /** Optional video codec (e.g. "HEVC", "AVC", "AV1") */
  codec?: string | null;

  /** Optional HDR format (e.g. "Dolby Vision", "HDR10+", "HDR", "SDR") */
  hdr_format?: string | null;

  /** Optional audio format (e.g. "Dolby Atmos", "DTS-HD", "DD+", "AAC") */
  audio_format?: string | null;

  /** Optional audio languages (e.g. ["English", "Hindi"]) */
  audio_languages?: string[] | null;

  /** Optional file size in gigabytes (e.g. 2.4) */
  size_gb?: number | null;

  /** Optional subtitles bundled with this stream */
  subtitles?: DadSubtitleItem[] | null;
}

/**
 * Directly-playable stream. `needs_proxy` defaults to `false` and `headers`
 * are FORBIDDEN (`never`) - a header-bearing URL is not directly playable by
 * definition, so a non-proxied stream can never carry headers.
 */
export interface DadDirectStreamItem extends DadStreamItemBase {
  type: 'direct';

  /** Directly playable without any proxy. Defaults to `false`. */
  needs_proxy?: false;

  /** Forbidden on directly-playable streams - no headers means no proxy. */
  headers?: never;
}

/**
 * Proxied stream. `needs_proxy` MUST be `true` and `headers` MUST be a
 * NON-EMPTY map of the exact headers the proxy must inject to fetch this URL
 * (Referer, User-Agent, Origin, Cookie, ...). Per-stream: each URL carries
 * its own headers.
 */
export interface DadProxiedStreamItem extends DadStreamItemBase {
  type: 'direct';

  needs_proxy: true;

  /** REQUIRED. e.g. `{ Referer: "https://provider-a.com/", "User-Agent": "..." }` */
  headers: Record<string, string>;
}

/**
 * Torrent stream candidate. Header/proxy semantics do not apply - the URL is
 * handed to the torrent engine, not the player. Either a `magnet:` URI or a
 * torrent HTTP(S) link; `info_hash` is the structured handoff key.
 */
export interface DadTorrentStreamItem extends DadStreamItemBase {
  type: 'torrent';

  /** Magnet URI (e.g. `magnet:?xt=urn:btih:...`) or .torrent HTTP(S) URL */
  stream_url: string;

  /** Not applicable to torrents */
  needs_proxy?: never;

  /** Not applicable to torrents */
  headers?: never;

  /** BTIH info hash (40-hex v1 / 64-hex v2) for the torrent engine */
  info_hash?: string | null;

  /** Preferred file index inside a multi-file torrent */
  file_idx?: number | null;

  /** Reported seeders for ranking */
  seeders?: number | null;

  /**
   * Optional tracker announce URLs alongside the magnet. Keep the magnet
   * minimal (xt + dn); trackers travel here so the engine can decide whether
   * to use them or fall back to its own list.
   */
  trackers?: string[] | null;
}

export type DadStreamItem = DadDirectStreamItem | DadProxiedStreamItem | DadTorrentStreamItem;

/** Truncates a suspicious value for safe inclusion in an error message. */
function truncateForError(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}.` : value;
}

/**
 * Validates a stream candidate against the playback contract:
 * - structural fields (`type`, `title`, `stream_url`)
 * - direct + headers => error (directly playable streams never carry headers)
 * - `needs_proxy: true` without non-empty `headers` => error
 * - torrent items must not carry `headers`/`needs_proxy`
 */
export function validateStreamItem(item: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!item || typeof item !== 'object') {
    return { valid: false, errors: ['Stream item must be an object'] };
  }

  const s = item as Record<string, any>;

  if (s.type !== 'direct' && s.type !== 'torrent') {
    return { valid: false, errors: [`Invalid stream 'type'. Must be 'direct' or 'torrent'`] };
  }

  if (!s.title || typeof s.title !== 'string' || s.title.trim() === '') {
    errors.push(`Missing or invalid non-empty 'title' string`);
  }
  if (!s.stream_url || typeof s.stream_url !== 'string' || s.stream_url.trim() === '') {
    errors.push(`Missing or invalid non-empty 'stream_url' string`);
  } else if (s.type === 'direct' && !isHttpsUrl(s.stream_url)) {
    errors.push(
      `Direct stream 'stream_url' must be an HTTPS URL - got '${truncateForError(s.stream_url)}'. ` +
        `(javascript:, file:, and similar schemes are never valid stream URLs.)`
    );
  }

  if (s.type === 'direct') {
    if (s.needs_proxy === true) {
      if (!s.headers || typeof s.headers !== 'object' || Array.isArray(s.headers)) {
        errors.push(`'needs_proxy: true' requires a non-empty 'headers' object (e.g. { Referer, User-Agent })`);
      } else {
        const keys = Object.keys(s.headers);
        if (keys.length === 0) {
          errors.push(`'needs_proxy: true' requires a non-empty 'headers' object - empty headers are meaningless`);
        } else {
          for (const k of keys) {
            if (typeof s.headers[k] !== 'string') {
              errors.push(`Header '${k}' must be a string value`);
            }
          }
        }
      }
    } else if (s.headers !== undefined && s.headers !== null) {
      errors.push(`Directly-playable stream cannot carry 'headers'. Either drop them entirely (plays direct) or set 'needs_proxy: true'.`);
    }
  } else if (s.type === 'torrent') {
    if (s.headers !== undefined && s.headers !== null) {
      errors.push(`Torrent items must not carry 'headers' - torrents go to the torrent engine, not the proxy`);
    }
    if (s.needs_proxy !== undefined && s.needs_proxy !== null && s.needs_proxy !== false) {
      errors.push(`Torrent items must not set 'needs_proxy' - torrents go to the torrent engine, not the proxy`);
    }
    const isMagnet = typeof s.stream_url === 'string' && s.stream_url.startsWith('magnet:');
    if (!isMagnet && !(typeof s.info_hash === 'string' && s.info_hash.length >= 40)) {
      errors.push(`Torrent items need a 'magnet:' stream_url or a valid 'info_hash'`);
    }
    if (s.trackers !== undefined && s.trackers !== null) {
      if (!Array.isArray(s.trackers)) {
        errors.push(`'trackers' must be an array of tracker announce URLs`);
      } else {
        for (const t of s.trackers) {
          if (typeof t !== 'string' || t.trim() === '') {
            errors.push(`'trackers' must contain only non-empty strings`);
            break;
          }
        }
      }
    }
  }

  // Embedded per-stream subtitles - the "video + subs in one request" path.
  // Every embedded track goes through the same subtitle contract
  // (validateSubtitleItems) as a standalone /subtitles response.
  if (s.subtitles !== undefined && s.subtitles !== null) {
    const subsCheck = validateSubtitleItems(s.subtitles);
    if (!subsCheck.valid) {
      errors.push(`Embedded 'subtitles' on stream: ${subsCheck.errors.join('; ')}`);
    }
  }

  // media_format/resolution are informational hints for Delulu Core's player,
  // not an SDK-enforced whitelist - deciding which formats are playable is
  // the CLIENT's job, not the SDK's. A value the player doesn't recognize
  // (e.g. 'flv') is a normal, harmless outcome: the client just drops that
  // stream. What the SDK DOES enforce is that the field is well-formed at
  // all - a non-string here isn't "an unsupported format", it's a type
  // violation that would force every consumer to defensively type-check.
  for (const field of ['media_format', 'resolution'] as const) {
    if (s[field] !== undefined && s[field] !== null && typeof s[field] !== 'string') {
      errors.push(`'${field}' must be a string if present (got ${typeof s[field]})`);
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validates a whole stream list. Returns `{ valid: false, errors }` (rather
 * than throwing) so callers can decide how to surface violations.
 *
 * Pass `{ allowedTypes: ['direct'] }` to additionally enforce that every item
 * matches the addon's DECLARED capabilities - e.g. a `direct_stream`-only
 * addon returning a torrent item is a contract violation.
 */
export function validateStreamItems(
  items: unknown,
  options: { allowedTypes?: DadStreamType[] } = {}
): { valid: boolean; errors: string[] } {
  if (!Array.isArray(items)) {
    return { valid: false, errors: ['Stream result must be an array of stream items'] };
  }
  const errors: string[] = [];
  items.forEach((item, i) => {
    const res = validateStreamItem(item);
    if (!res.valid) {
      errors.push(`Stream item #${i + 1}: ${res.errors.join('; ')}`);
      return;
    }
    const allowed = options.allowedTypes;
    if (allowed && allowed.length > 0) {
      const t = (item as { type?: unknown }).type;
      if (typeof t === 'string' && !allowed.includes(t as DadStreamType)) {
        errors.push(
          `Stream item #${i + 1}: type '${t}' is not allowed by this addon's declared capabilities (allowed: ${allowed.join(', ')})`
        );
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 4. Subtitle Types
// ============================================================================

export interface DadSubtitleItem {
  id: string;
  url: string;
  lang_code: string; // e.g. "en", "es", "bn", "hi"
  language: string;  // e.g. "English", "Spanish", "Bengali"
  title: string;     // e.g. "English [SDH]"
  format: 'vtt' | 'srt';
  provider?: string | null;
}

/** Validates a subtitle list (structural checks on each item). */
export function validateSubtitleItems(items: unknown): { valid: boolean; errors: string[] } {
  if (!Array.isArray(items)) {
    return { valid: false, errors: ['Subtitle result must be an array'] };
  }
  const errors: string[] = [];
  items.forEach((item, i) => {
    const s = item as Record<string, any> | null;
    if (!s || typeof s !== 'object') {
      errors.push(`Subtitle item #${i + 1}: must be an object`);
      return;
    }
    for (const field of ['id', 'url', 'lang_code', 'language', 'title'] as const) {
      if (!s[field] || typeof s[field] !== 'string') {
        errors.push(`Subtitle item #${i + 1}: missing or invalid '${field}' string`);
      }
    }
    if (s.format !== 'vtt' && s.format !== 'srt') {
      errors.push(`Subtitle item #${i + 1}: 'format' must be 'vtt' or 'srt'`);
    }
  });
  return { valid: errors.length === 0, errors };
}

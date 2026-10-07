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

// ============================================================================
/**
 * Meta Addon Response.
 * Core app already gets poster, backdrop, overview, title, cast, and the title
 * logo straight from TMDB. Meta addons are called strictly to enrich the
 * signals TMDB does not carry: IMDb ID mapping, IMDb rating, and official
 * trailer URL(s).
 *
 * Every field is optional; `null` and absent both mean "unknown / not found".
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

  /**
   * Official trailer URLs, ordered by preference - the FIRST entry is the
   * default. HTTPS only. `[]` / absent / `null` = no trailer. Deliver the most
   * adaptive single URL you have (the client's player handles quality
   * selection); do NOT supply per-quality or per-format variants.
   */
  trailers?: string[];
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
  if (m.trailers !== undefined && m.trailers !== null) {
    if (!Array.isArray(m.trailers)) {
      errors.push(`'trailers' must be an array of HTTPS URL strings`);
    } else {
      for (let i = 0; i < m.trailers.length; i++) {
        const t = m.trailers[i];
        if (typeof t !== 'string') {
          errors.push(`trailers[${i}] must be a string`);
        } else if (!isHttpsUrl(t)) {
          errors.push(`trailers[${i}] must be an HTTPS URL`);
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
 * ONLY `type`, `title`, and the type's own identity field are strictly
 * required: a `direct` item must have `stream_url`, a `torrent` item must have
 * `info_hash`. ALL quality/codec/size signals are optional and nullable - an
 * addon that doesn't know them is never penalized or dropped over them.
 *
 * `stream_url` lives on the direct variants rather than here: it means nothing
 * to a torrent, whose identity is `info_hash`.
 */
export interface DadStreamItemBase {
  type: DadStreamType;

  /** Display title / release name (e.g. "Server 1 - 1080p" or "Movie.1080p.x265") */
  title: string;

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

  /**
   * Optional audio format for the WHOLE file (e.g. "Dolby Atmos", "DTS-HD",
   * "DD+", "AAC"). Display-only: what the selection screen shows before you pick.
   */
  audio_format?: string | null;

  /**
   * REQUIRED. Audio languages in this file - display-only, so the shelf can say
   * "2 audio tracks" before the user picks. Always an array; use `[]` when the
   * languages are unknown.
   *
   * A muxed file with both English and Hindi is ONE item listing both. Never
   * emit the same `stream_url` twice as separate items.
   *
   * Shape is validated (array of non-empty strings); content is not - whether
   * the file really has Hindi is the addon's data to own.
   */
  audio_languages: string[];

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

  /** Playable video stream URL (MP4 / HLS .m3u8), HTTPS only. */
  stream_url: string;

  /** Directly playable without any proxy. Defaults to `false`. */
  needs_proxy?: false;

  /** Forbidden on directly-playable streams - no headers means no proxy. */
  headers?: never;

  /**
   * Forbidden. `info_hash` is a torrent-engine field; on a direct stream it can
   * only mislead whoever reads the item (or an addon that answers to both
   * stream kinds and fills in both halves by habit).
   */
  info_hash?: never;

  /** Forbidden - meaningless without `info_hash`, so always an authoring slip. */
  file_idx?: never;

  /** Forbidden - direct streams have their own `headers`; trackers are torrent-only. */
  trackers?: never;

  /** Not applicable - seeders describe a torrent's swarm. */
  seeders?: never;
}

/**
 * Proxied stream. `needs_proxy` MUST be `true` and `headers` MUST be a
 * NON-EMPTY map of the exact headers the proxy must inject to fetch this URL
 * (Referer, User-Agent, Origin, Cookie, ...). Per-stream: each URL carries
 * its own headers.
 */
export interface DadProxiedStreamItem extends DadStreamItemBase {
  type: 'direct';

  /** URL the proxy fetches on the player's behalf. HTTPS only. */
  stream_url: string;

  needs_proxy: true;

  /** REQUIRED. e.g. `{ Referer: "https://provider-a.com/", "User-Agent": "..." }` */
  headers: Record<string, string>;

  /** Forbidden - torrent-engine field, see `DadDirectStreamItem`. */
  info_hash?: never;

  /** Forbidden - torrent-engine field, see `DadDirectStreamItem`. */
  file_idx?: never;

  /** Forbidden - trackers are torrent-only. */
  trackers?: never;

  /** Not applicable - seeders describe a torrent's swarm. */
  seeders?: never;
}

/**
 * Torrent stream candidate. Goes to the torrent engine, not the player, so
 * header/proxy semantics do not apply.
 *
 * No `stream_url` - the torrent's identity is `info_hash`. Emit the hash; Core
 * builds whatever magnet/`.torrent` URL the engine wants, using `trackers` for
 * the announce list.
 *
 * `file_idx` is REQUIRED (`0` for a single-file torrent, the real index for a
 * pack) so an episode inside a season pack can never be guessed at.
 */
export interface DadTorrentStreamItem extends DadStreamItemBase {
  type: 'torrent';

  /** Forbidden - a torrent has no playable URL; the peer swarm is the source. */
  stream_url?: never;

  /** Not applicable to torrents */
  needs_proxy?: never;

  /** Not applicable to torrents */
  headers?: never;

  /** REQUIRED. BTIH info hash: 40 hex chars (v1) or 64 hex chars (v2). */
  info_hash: string;

  /** REQUIRED. Zero-based file index. `0` for a single-file torrent. */
  file_idx: number;

  /** Reported seeders for ranking */
  seeders?: number | null;

  /**
   * Optional tracker announce URLs. Keep them as plain announce URLs
   * (`udp://`, `https://`, `wss://`); the Core decides whether to use them or
   * fall back to its own list.
   */
  trackers?: string[] | null;
}

export type DadStreamItem = DadDirectStreamItem | DadProxiedStreamItem | DadTorrentStreamItem;

/** Truncates a suspicious value for safe inclusion in an error message. */
function truncateForError(value: string, max = 60): string {
  return value.length > max ? `${value.slice(0, max)}.` : value;
}

/**
 * BTIH info hash: 40 hex chars (v1) or 64 hex chars (v2). Anchored and
 * case-insensitive, so no padding, no separators, no truncation, and no
 * "40 characters that happen to not be hex".
 */
const INFO_HASH_RE = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * Tracker announce URLs. `udp`/`tcp` are the BitTorrent norms; `wss`/`ws`/`https`
 * are the WebTorrent transports. Anything else (`not a url`, a magnet, a
 * `javascript:` URI) is a typo the engine would silently ignore.
 */
const TRACKER_RE = /^(?:udp|tcp|wss|ws|https):\/\/[^\s]+$/i;

/**
 * Fields that only exist for the torrent engine. Declared `never` on both
 * direct variants; checked by presence so `null`/`false`/`{}` cannot slip past.
 */
const TORRENT_ONLY_FIELDS = ['info_hash', 'file_idx', 'trackers', 'seeders'] as const;

/**
 * Validates a stream candidate against the playback contract:
 * - structural fields (`type`, `title`) plus the type's own identity field:
 *   `stream_url` (HTTPS) for `direct`, `info_hash` + `file_idx` for `torrent`
 * - `stream_url` is required on direct and FORBIDDEN on torrent; torrent-only
 *   fields (`info_hash`, `file_idx`, `trackers`, `seeders`) are FORBIDDEN on direct
 * - every `never` field is checked by PRESENCE, so `null`, `false` and `{}` are
 *   errors too - not silently treated as "unset"
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

  // Presence test is `!== undefined`, not truthiness - `null` on a field the
  // contract declares inapplicable is still an error, not "unset".
  if (s.type === 'direct') {
    if (!s.stream_url || typeof s.stream_url !== 'string' || s.stream_url.trim() === '') {
      errors.push(`Missing or invalid non-empty 'stream_url' string`);
    } else if (!isHttpsUrl(s.stream_url)) {
      errors.push(
        `Direct stream 'stream_url' must be an HTTPS URL - got '${truncateForError(s.stream_url)}'. ` +
          `(javascript:, file:, and similar schemes are never valid stream URLs.)`
      );
    }

    for (const field of TORRENT_ONLY_FIELDS) {
      if (s[field] !== undefined) {
        errors.push(
          `Direct stream items must NOT carry '${field}' - it is a torrent-engine field and a direct URL has no ` +
            `torrent to identify.`
        );
      }
    }
  } else if (s.type === 'torrent') {
    if (s.stream_url !== undefined) {
      errors.push(
        `Torrent items must NOT carry 'stream_url' - a torrent has no playable URL; the peer swarm is the source. ` +
          `Send 'info_hash' (+ 'file_idx') instead.`
      );
    }
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
    if (s.headers !== undefined) {
      errors.push(`Torrent items must not carry 'headers' - torrents go to the torrent engine, not the proxy`);
    }
    if (s.needs_proxy !== undefined) {
      errors.push(
        `Torrent items must not set 'needs_proxy' (not even false) - torrents go to the torrent engine, not the proxy`
      );
    }

    if (typeof s.info_hash !== 'string' || s.info_hash.trim() === '') {
      errors.push(
        `Torrent items require an 'info_hash' - a torrent has no URL, so the BTIH hash is its identity ` +
          `(40-hex v1 or 64-hex v2)`
      );
    } else if (!INFO_HASH_RE.test(s.info_hash)) {
      errors.push(
        `Torrent 'info_hash' must be 40 hex chars (v1) or 64 hex chars (v2), nothing else - got ` +
          `'${truncateForError(s.info_hash)}'`
      );
    }

    if (s.file_idx === undefined || s.file_idx === null) {
      errors.push(
        `Torrent items require 'file_idx' - the zero-based index of the file you mean. ` +
          `Use 0 for a single-file torrent; for a season/episode pack it must be the exact episode requested.`
      );
    } else if (typeof s.file_idx !== 'number' || !Number.isInteger(s.file_idx) || s.file_idx < 0) {
      errors.push(
        `Torrent 'file_idx' must be a non-negative integer (use 0 for a single-file torrent) - got ` +
          `${JSON.stringify(truncateForError(String(s.file_idx)))}`
      );
    }

    if (s.seeders !== undefined && s.seeders !== null) {
      if (typeof s.seeders !== 'number' || !Number.isInteger(s.seeders) || s.seeders < 0) {
        errors.push(`Torrent 'seeders' must be a non-negative integer when present (e.g. 42)`);
      }
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
          if (!TRACKER_RE.test(t.trim())) {
            errors.push(
              `Tracker '${truncateForError(t)}' is not a usable announce URL - expected udp://, https://, ` +
                `wss://, or ws://`
            );
            break;
          }
        }
      }
    }
  }

  // Shape is validated, content is not - see the field's doc comment.
  if (s.audio_languages === undefined || s.audio_languages === null) {
    errors.push(
      `Missing 'audio_languages' - it is required because every stream has audio. Use [] if you cannot tell.`
    );
  } else if (!Array.isArray(s.audio_languages)) {
    errors.push(
      `'audio_languages' must be an array of language names (e.g. ["English", "Hindi"]) - got ` +
        `${JSON.stringify(truncateForError(String(s.audio_languages)))}`
    );
  } else if (s.audio_languages.length > 0) {
    const bad = s.audio_languages.find((l) => typeof l !== 'string' || l.trim() === '');
    if (bad !== undefined) {
      errors.push(
        `'audio_languages' must contain only non-empty language names - got ` +
          `${JSON.stringify(truncateForError(String(bad)))}`
      );
    }
  }

  if (s.audio_format !== undefined && s.audio_format !== null) {
    if (typeof s.audio_format !== 'string' || s.audio_format.trim() === '') {
      errors.push(`'audio_format' must be a non-empty string when present (e.g. "Dolby Atmos")`);
    }
  }

  // Embedded per-stream subtitles go through the same contract as /subtitles.
  if (s.subtitles !== undefined && s.subtitles !== null) {
    const subsCheck = validateSubtitleItems(s.subtitles);
    if (!subsCheck.valid) {
      errors.push(`Embedded 'subtitles' on stream: ${subsCheck.errors.join('; ')}`);
    }
  }

  // Type-checked only: deciding which formats are playable is the client's job.
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
 * Pass `{ allowedTypes: [...] }` to additionally enforce that every item
 * matches the addon's DECLARED capabilities - e.g. a `direct_stream`-only
 * addon returning a torrent item is a contract violation.
 *
 * Omitting `allowedTypes` skips the capability check entirely. Passing an EMPTY
 * array enforces "no stream type is permitted" - what a `subtitle`-only or
 * `meta`-only addon resolves to, so any item at all is an error.
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
    if (options.allowedTypes) {
      const allowed = options.allowedTypes;
      const t = (item as { type?: unknown }).type;
      if (typeof t !== 'string') {
        errors.push(`Stream item #${i + 1}: missing a string 'type' field`);
      } else if (!allowed.includes(t as DadStreamType)) {
        const permitted = allowed.length === 0 ? 'no stream types' : `allowed: ${allowed.join(', ')}`;
        errors.push(
          `Stream item #${i + 1}: type '${t}' is not allowed by this addon's declared capabilities (${permitted})`
        );
      }
    }
  });
  return { valid: errors.length === 0, errors };
}

// ============================================================================
// 4. Subtitle Types
// ============================================================================

/**
 * Subtitle container formats DAD accepts. `vtt`/`srt` are the web baseline,
 * `ass`/`ssa` are the styled fan-sub formats, and `ttml`/`dfxp` are the
 * XML caption-exchange formats. The SDK is not a transcoder - it only checks
 * that an author advertises one of these; the player does the rendering.
 */
export type DadSubtitleFormat = 'vtt' | 'srt' | 'ass' | 'ssa' | 'ttml' | 'dfxp';

export const DAD_SUBTITLE_FORMATS: readonly DadSubtitleFormat[] = ['vtt', 'srt', 'ass', 'ssa', 'ttml', 'dfxp'];

export interface DadSubtitleItem {
  id: string;
  url: string;
  lang_code: string; // e.g. "en", "es", "bn", "hi"
  language: string;  // e.g. "English", "Spanish", "Bengali"
  title: string;     // e.g. "English [SDH]"
  format: DadSubtitleFormat;
  provider?: string | null;
}

/**
 * Validates a subtitle list. Every string field must be non-empty (trimmed,
 * so whitespace-only values are rejected), and `url` must be a valid HTTPS URL
 * - subtitle URLs are handed to a client/player, so javascript:, file:, and
 * arbitrary schemes are never acceptable.
 */
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
    for (const field of ['id', 'lang_code', 'language', 'title'] as const) {
      if (typeof s[field] !== 'string' || s[field].trim() === '') {
        errors.push(`Subtitle item #${i + 1}: missing or invalid non-empty '${field}' string`);
      }
    }
    if (typeof s.url !== 'string' || s.url.trim() === '') {
      errors.push(`Subtitle item #${i + 1}: missing or invalid non-empty 'url' string`);
    } else if (!isHttpsUrl(s.url)) {
      errors.push(
        `Subtitle item #${i + 1}: 'url' must be an HTTPS URL - got '${truncateForError(s.url)}'. ` +
          `(javascript:, file:, and similar schemes are never valid subtitle URLs.)`
      );
    }
    if (!DAD_SUBTITLE_FORMATS.includes(s.format)) {
      errors.push(`Subtitle item #${i + 1}: 'format' must be one of ${DAD_SUBTITLE_FORMATS.join(', ')}`);
    }
  });
  return { valid: errors.length === 0, errors };
}

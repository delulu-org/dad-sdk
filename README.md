# @delulu-addon/dad-sdk

The **Delulu Addon Development (DAD) SDK** - build, test, and ship HTTP
addons for Delulu.

```bash
npm install @delulu-addon/dad-sdk
```

> **Only HTTP addons are publicly supported.** DAD addons run as a live
> HTTPS server you host and control.

---

## Quick start

```bash
npx @delulu-addon/dad-sdk init my-addon --name "My Addon"
cd my-addon
npm install
npm run build
npx dad dev
```

`dad dev` starts a **real local server** and prints ready-to-run `curl`
commands for every route your addon declares, so you're testing against the
exact request shapes Delulu Core sends in production - not a mock.

```
------------------------------------------------------------
 DAD dev server - My Addon (org.example.my-addon)
------------------------------------------------------------
 Listening on http://localhost:7890
 Capabilities: direct_stream

 Try it:
   curl http://localhost:7890/streams/movie/10378     # Big Buck Bunny (movie)
   curl http://localhost:7890/streams/tv/1930/1/1     # The Beverly Hillbillies (tv)

 Press Ctrl+C to stop.
```

---

## The contract

Every addon implements up to three handlers, gated by the capabilities it
declares in its manifest:

| Capability | Handler | Called when |
|---|---|---|
| `meta` | `getMeta(req)` | Client wants a logo, trailer, IMDb id/rating - things TMDB doesn't already give it |
| `direct_stream` | `getStreams(req)` | Client wants playable stream URLs |
| `torrent` | `getStreams(req)` | Same handler, torrent-shaped items |
| `subtitle` | `getSubtitles(req)` | Client wants subtitle tracks |

Declaring a capability without implementing its handler (or vice versa)
throws at definition time - the SDK won't let you ship a manifest and code
that disagree with each other.

### The request

```ts
interface DadRequest {
  tmdb_id: number;
  media_type: 'movie' | 'tv';
  s?: number | null;   // season, TV only
  e?: number | null;   // episode, TV only
  auth?: string;        // the Bearer key, if the client is holding one for this addon
}
```

Same shape for `getMeta`, `getStreams`, and `getSubtitles`.

### The stream contract (the part worth understanding well)

A stream is either **directly playable** or **needs proxying** - never
ambiguous:

```ts
// Directly playable - the player hits this URL with no help from Delulu Core.
// headers is FORBIDDEN here at the type level: a URL that needs headers
// injected is, by definition, not directly playable.
{
  type: 'direct',
  title: 'Server 1 1080p',
  stream_url: 'https://cdn.example.com/movie.m3u8',
  media_format: 'hls',
  resolution: '1080p',
}

// Needs proxying - set needs_proxy: true AND provide non-empty headers.
// Delulu Core only routes through its proxy when both are present.
{
  type: 'direct',
  title: 'Provider A 1080p',
  stream_url: 'https://provider-a.example.com/stream.m3u8',
  needs_proxy: true,
  headers: { Referer: 'https://provider-a.example.com/', 'User-Agent': 'Mozilla/5.0' },
}

// Torrent - handed to the torrent engine, not the player. No headers/proxy.
{
  type: 'torrent',
  title: 'Movie.2160p.Remux',
  stream_url: 'magnet:?xt=urn:btih:...',
  info_hash: '...',
  seeders: 142,
}
```

Headers are **per-stream** - if you're aggregating multiple providers, each
stream item carries its own headers. Provider A's `Referer` never leaks onto
Provider B's URL.

Subtitles that belong to a **specific stream** (DVD subs baked into an mkv,
a provider-only track) are embedded directly on the stream item:

```ts
{
  type: 'direct',
  title: 'BluRay - 1080p',
  stream_url: 'https://cdn.example.com/movie.mkv',
  media_format: 'mkv',
  subtitles: [
    { id: 'en-sdh', url: 'https://cdn.example.com/en-sdh.vtt', lang_code: 'en', language: 'English', title: 'English [SDH]', format: 'vtt' },
  ],
}
```

`subtitles` follows the exact same contract as a standalone `/subtitles`
response - every embedded track is validated with the same rules. Universal
tracks (apply to any stream of a title) still belong in `/subtitles`; anything
riding on a specific stream belongs here. One `/streams` request answers
"video + subs" when the addon embeds them.

`dad dev` and `createHttpAddonHandler` both run every response through the
same validator (`validateStreamItems`), so a malformed item - headers on a
direct stream, `needs_proxy: true` with empty headers, an unsupported
`type`, a broken embedded subtitle - is caught immediately with a specific
error message, not a runtime crash somewhere downstream.

### Meta responses

```ts
interface DadMetaResponse {
  imdb_id?: string | null;       // 'tt0137523'
  imdb_rating?: number | null;   // 8.8 - MUST be a number, not "8.8"
  logo_url?: string | null;
  trailer_url?: string | null;
  trailer_sources?: Partial<Record<'2160p'|'1440p'|'1080p'|'720p'|'480p'|'360p'|'hls', string>> | null;
}
```

Every field is optional and nullable - Delulu Core already has poster,
backdrop, overview, title, and cast from TMDB. Meta addons only fill in what
TMDB doesn't have. Return `{ logo_url: '...' }` and everything else is fine
left unset.

### Errors (the DAD error model)

Every failure any addon can hit is one **closed-set machine-readable code** in
a single shape - so Delulu Core and `dad test` can always tell *why* a request
failed without parsing prose:

```json
{ "error": "content_unavailable", "error_message": "No streams for this title" }
```

Addon authors throw `DadError` and the SDK serializes it into that contract.
The same codes cover the SDK's own validation failures:

```ts
import { DadError } from '@delulu-addon/dad-sdk';

throw new DadError('unauthorized', 'Missing or invalid API key');
throw new DadError('upstream_unreachable', 'Provider scraper timed out');
throw new DadError('content_unavailable', 'No streams for this title');
```

| Code | HTTP | What it means |
|---|---|---|
| `bad_request` | 400 | Malformed route/params (extension, bad media_type/id/season) |
| `method_not_allowed` | 405 | Non-GET request |
| `unauthorized` | 401 | Missing/invalid API key |
| `not_found` | 404 | Unknown route or undeclared capability |
| `content_unavailable` | 404 | Title known, but addon has no content for it |
| `invalid_response` | 422 | The addon's response failed SDK validation (malformed stream/meta/subtitle item) |
| `upstream_unreachable` | 502 | The addon's upstream source couldn't be reached |
| `rate_limited` | 429 | Backend asking the client to slow down |
| `internal_error` | 500 | Unexpected addon crash / catch-all |

`dad test` treats any of these as a **graceful, valid answer** - a well-formed
DAD error proves the addon speaks the contract. An unmodeled error body fails
the probe. `validateErrorResponse` exposes the same check directly.

One exception: `unauthorized` is only graceful when no `--key` was supplied -
see [**Testing a live addon**](#testing-a-live-addon) below.

---

## Writing an addon

```ts
import { defineHttpAddon, createHttpAddonHandler } from '@delulu-addon/dad-sdk';
import manifest from '../manifest.json' with { type: 'json' };

export const addon = defineHttpAddon({
  manifest,
  async getStreams(req) {
    // req.auth is the raw Bearer key, if the client is holding one.
    return [
      {
        type: 'direct',
        title: 'Example 1080p',
        stream_url: 'https://example.com/stream.mp4',
        media_format: 'mp4',
        resolution: '1080p',
      },
    ];
  },
});

export const handler = createHttpAddonHandler(addon);
```

`handler` is a plain `(Request) => Promise<Response>` - deploy it wherever
you like: Cloudflare Workers, Deno Deploy, Next.js route handlers, or plain
Node (the scaffold includes a `src/server.ts` for that last case). Routes
are strict, extensionless path segments, GET only:

```
GET {baseUrl}/streams/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
GET {baseUrl}/meta/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
GET {baseUrl}/subtitles/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
```

No `.json` suffixes, no query strings - both are rejected with a `400` so a
client can never regress into the old Stremio-style route shape.

### API keys (the "LLM key" model)

```json
{
  "apiKey": { "required": true, "pageUrl": "https://your-addon.com/get-a-key" }
}
```

The client sends `Authorization: Bearer <key>` on every request once the
user has one. It arrives in your handler as `req.auth`. What it unlocks -
free tier, paid tier, per-key rate limits - is entirely up to your backend.
A single opaque key, author-defined scope: the same shape as an OpenAI/
Anthropic API key, and the right amount of mechanism for "one author, one
backend, one key gating access to their own service."

---

## Shipping an addon

Deploy your server, then update `manifest.json`'s `baseUrl` to your deployed
domain. That's the entire install payload - the addon is just a live HTTPS
server you control.

```bash
npx dad validate   # checks manifest.json against the DAD schema
```

HTTP addons are **not signed**: there's no downloadable artifact to protect,
and a live server's behavior can change at any time, so a signature would
add process without adding real security.

---

## CLI reference

```
dad init <dir> [--id <reverse.dns.id>] [--name "Name"]
                        Scaffold a new HTTP addon

dad dev [dir] [--port <n>]
                        Start a real local server and print ready-to-run curl commands

dad test <manifest-url> [--key <api-key>]
                        Validate a DEPLOYED addon from its public manifest:
                        fetches {baseUrl}/manifest.json and probes every declared
                        capability using public-domain fixtures (Big Buck Bunny,
                        Sintel, The Beverly Hillbillies, ...) - no copyrighted
                        titles are ever requested. --key sends
                        Authorization: Bearer <key> to test the AUTHENTICATED
                        path (or set DAD_TEST_API_KEY instead of passing --key
                        on the command line - safer for shell history/CI logs).

dad validate [dir]      Validate manifest.json schema
dad help                 Show all of the above
```

`dad test` runs the exact validators `createHttpAddonHandler` uses in
production against every capability an addon declares, so a
`dad test`-clean addon is at minimum a live server speaking the DAD contract:

```
------------------------------------------------------------
 DAD test - My Addon (org.example.my-addon)
------------------------------------------------------------
 Capabilities: direct_stream, subtitle
 [OK] Big Buck Bunny (2008) - streams/movie/10378 (direct_stream)
      valid stream items
 [OK] Big Buck Bunny (2008) - subtitles/movie/10378 (subtitle)
      valid subtitle items
 [OK] The Beverly Hillbillies (1962) - streams/tv/1930/1/1 (direct_stream)
      valid stream items
   ... (one result line per fixture per declared route, elided here)

 PASS - 12 probes, all clean.
```

### Testing a live addon

Without `--key`, `dad test` probes your addon with no `Authorization` header
at all - this checks the **graceful-rejection path**: an
`apiKey.required: true` addon should answer `401 { error: 'unauthorized' }`
in a well-formed way, not crash or return malformed JSON. That's a genuine
pass; nobody expects to get real content without a key.

With `--key <api-key>` (or `DAD_TEST_API_KEY` in the environment), `dad test`
sends that key on every probe instead - testing the **authenticated path**:
does a real, valid key actually unlock real content? This flips the meaning
of an `unauthorized` response: if you supplied a key and still got rejected,
that's now a **failure** - your key gate is rejecting a key that should work
(either the key is wrong, or the gate itself is broken; `dad test` can't tell
those apart from the outside, but either way it's worth a second look).

```bash
dad test https://your-addon.example.com/manifest.json               # graceful-rejection path
dad test https://your-addon.example.com/manifest.json --key sk_live_abc123  # authenticated path
```

---

## Package layout

```
src/
  manifest.ts    Manifest types + validation
  errors.ts      DAD error model (DadError, DadErrorCode, validateErrorResponse)
  validation.ts  Shared primitives (isHttpsUrl, isBareHttpsUrl, validateApiKeyShape)
  responses.ts   Request/response types + validators (meta, streams, subtitles)
  define.ts      defineHttpAddon / createHttpAddonHandler
  version.ts     Strict semver helpers + monotonic version-bump checks
  catalog.ts     Catalog-side helpers
  fixtures.ts    Public-domain TMDB fixtures (Big Buck Bunny, Sintel, ...)
  cli.ts         `dad` CLI entrypoint
  cli/
    init.ts      dad init
    dev.ts       dad dev
    probe.ts     dad test
    templates.ts Scaffolding templates
```

Everything is exported from the package root:

```ts
import {
  defineHttpAddon, createHttpAddonHandler,
  DadError,
  validateManifest, validateStreamItems, validateMetaResponse, validateSubtitleItems,
  isValidVersion, compareVersions, isVersionBump,
  DAD_TEST_FIXTURES,
} from '@delulu-addon/dad-sdk';
```


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
  audio_languages: [],
  media_format: 'hls',
  resolution: '1080p',
}

// Needs proxying - set needs_proxy: true AND provide non-empty headers.
// Delulu Core only routes through its proxy when both are present.
{
  type: 'direct',
  title: 'Provider A 1080p',
  stream_url: 'https://provider-a.example.com/stream.m3u8',
  audio_languages: [],
  needs_proxy: true,
  headers: { Referer: 'https://provider-a.example.com/', 'User-Agent': 'Mozilla/5.0' },
}

// Torrent - handed to the torrent engine, not the player. No URL, no
// headers/proxy: the peer swarm is the source, so a torrent has nothing to play.
{
  type: 'torrent',
  title: 'Movie.2160p.Remux',
  info_hash: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678', // 40-hex v1 (or 64-hex v2)
  audio_languages: [],
  file_idx: 0,                                        // REQUIRED - 0 for single-file
  seeders: 142,
  trackers: ['udp://tracker.example.org:1337/announce'],
}
```

A torrent item is identified by `info_hash` + `file_idx`, never `stream_url` -
emit the hash and Core builds whatever magnet/`.torrent` URL the engine wants.
`file_idx` is required so an episode inside a season pack is never guessed at;
`0` means single-file.

Headers are **per-stream** - if you're aggregating multiple providers, each
stream item carries its own headers. Provider A's `Referer` never leaks onto
Provider B's URL.

### Multiple audio tracks

One stream item = one link. A file muxed with both English and Hindi audio is
**one** item whose `audio_languages` lists both:

```ts
{
  type: 'direct',
  title: 'BluRay - 1080p',
  stream_url: 'https://cdn.example.com/movie.mkv',
  media_format: 'mkv',
  audio_format: 'Dolby Atmos',
  audio_languages: ['English', 'Hindi'],
}
```

Do **not** emit the same `stream_url` twice as two items - they play the
identical file and just show up twice on the shelf. Separate items are only for
genuinely different URLs: a dubbed file, a separate audio server.

`audio_languages` is a **display label**, not player input - the player reads
the real track list off the file once it demuxes.

It is also **required**. If you cannot tell what languages a source has, say so
with an empty array:

```ts
audio_languages: []   // "I can't tell"
```

`null` and omitting the field are both rejected, so client code writes
`item.audio_languages.map(...)` directly instead of threading `?? [] ?? null`
through every view.

The SDK checks the **shape** (an array of non-empty strings) but never the
**content** - if you write `["Hindi"]` and the file has no Hindi, that's your
data quality, the same boundary that applies to torrent `file_idx` ranges.

Subtitles that belong to a **specific stream** (DVD subs baked into an mkv,
a provider-only track) are embedded directly on the stream item:

```ts
{
  type: 'direct',
  title: 'BluRay - 1080p',
  stream_url: 'https://cdn.example.com/movie.mkv',
  audio_languages: [],
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
  imdb_id?: string | null;    // 'tt0137523'
  imdb_rating?: number | null; // 8.8 - MUST be a number, not "8.8"
  trailers?: string[];         // HTTPS URLs, ordered - FIRST is the default
}
```

Every field is optional and nullable - Delulu Core already has poster,
backdrop, overview, title, cast, and the title logo from TMDB. Meta addons only
fill in what TMDB doesn't carry: IMDb ID, IMDb rating, and official trailers.

`trailers` is an ordered array: the first entry is the default the client
plays. `[]`/absent/`null` all mean "no trailer". Deliver the most adaptive
single URL you have - quality selection is the client player's job, so never
ship per-resolution or per-format variants. Older fields (`logo_url`,
`trailer_url`, `trailer_sources`) from pre-2.0 addons are tolerated and
ignored.

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

`dad test` splits the model into **graceful** and **server/contract** errors:

- **Graceful** (`content_unavailable`, `rate_limited`, and `unauthorized` when the
  gate works): the addon is functioning - it spoke the contract, it just had
  nothing or asked to slow down. These **pass** the probe.
- **Server/contract** (`bad_request`, `method_not_allowed`, `not_found`,
  `invalid_response`, `upstream_unreachable`, `internal_error`): the addon
  itself is broken. `dad test` only requests routes it *declared*, with
  well-formed valid input, so any of these is an addon bug, not an empty
  answer - they **fail** the probe.

`validateErrorResponse` exposes the same shape check directly; an unmodeled
error body fails the probe too.

One exception: `unauthorized` is only graceful when no `--key` was supplied -
see [**Testing a live addon**](#testing-a-live-addon) below. When the manifest
declares no `apiKey` gate, `unauthorized` is a FAIL.

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
        audio_languages: [],
        media_format: 'mp4',
        resolution: '1080p',
      },
    ];
  },
});

export const handler = createHttpAddonHandler(addon);
```

For production hosts that use a redacting, access-controlled logger, pass an
optional hook for unexpected programming/upstream errors. The SDK never writes
their raw messages to the default console, because they can contain secrets:

```ts
export const handler = createHttpAddonHandler(addon, {
  onUnexpectedError(error) {
    logger.error({ err: error }, 'DAD addon handler failed'); // redact as appropriate
  },
});
```

`handler` is a plain `(Request) => Promise<Response>` - deploy it wherever
you like: Cloudflare Workers, Deno Deploy, Next.js route handlers, or plain
Node (the scaffold includes a `src/server.ts` for that last case). Routes
are strict, extensionless path segments, GET only:

```
GET {baseUrl}/streams/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
GET {baseUrl}/meta/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
GET {baseUrl}/subtitles/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
GET {baseUrl}/manifest.json   # served by the handler itself (see below)
```

No `.json` suffixes (except the handler's own `/manifest.json`), no query
strings - both are otherwise rejected with a `400`.

The handler also answers `/manifest.json` and `/manifest` with the addon's own
(built, logo-injected) manifest, so every deployment site - Workers, Deno,
Node, Next.js - exposes install endpoint `{baseUrl}/manifest.json` with zero
extra code, matching what `dad dev` serves locally.

### `manifest.json`

`dad init` prints this same field list at scaffold time, so you see it before
you write a line of code:

| Field | Required | What it does |
| --- | --- | --- |
| `id` | yes | Reverse-DNS id, matched case-sensitively against the catalog. Don't rename after publishing. |
| `name` | yes | Display name in the client. |
| `version` | yes | Strict `major.minor.patch`. The client's source of truth - the catalog's copy is only a discovery hint. |
| `type` | yes | Always `"http"` - the only type DAD supports. |
| `baseUrl` | yes | A bare HTTPS origin - **no path, no query string, no fragment** (`https://your-addon.example.com`). Routes live directly under it. |
| `capabilities` | yes | Any of `meta`, `direct_stream`, `torrent`, `subtitle`. Every declared capability needs its matching handler, or `defineHttpAddon` throws. |
| `apiKey` | no | `{ required, pageUrl }` - the install gate. See below. |
| `description` | no | One line for the listing shelf. |
| `publisher` | no | Your name or org. |
| `logo` | no | HTTPS URL. **Leave it out and the SDK injects the shared default** - `https://delulu-addons.pages.dev/default_addon_logo.png` - at the define layer, so the client always has a logo to render. Set your own only if you have one; nothing is fetched or validated at build time. Override the default host-wide with `DAD_DEFAULT_LOGO_URL`. |

This file is the contract: serve it at `{baseUrl}/manifest.json`, and a
catalog lists it by URL (see [The catalog](#the-catalog)). `null`, `""`, and
`"   "` all mean "no logo of my own" everywhere - validator and injector agree.

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

`required: true` is **enforced, not advisory**: `createHttpAddonHandler`
rejects any request without a key with `401 { error: 'unauthorized' }` before
your handler ever runs. `required: false` means the key is a bonus, and
anonymous requests still work.

---

## The catalog

A catalog is a **shelf, not a source of truth**. Each row is display data plus
one pointer:

```json
{
  "addons": [
    {
      "id": "org.example.my-addon",
      "name": "My Addon",
      "version": "1.0.0",
      "type": "http",
      "manifestUrl": "https://your-addon.example.com/manifest.json",
      "description": "One line for the shelf.",
      "publisher": "Your name",
      "logo": "https://your-addon.example.com/logo.png"
    }
  ]
}
```

At install time the client fetches `manifestUrl`, validates it with the same
`validateManifest` you ran locally, caches it, and drives every request from
`baseUrl` / `capabilities` / `apiKey` **as declared in the manifest**. So:

- A catalog row must NOT carry `baseUrl` or `apiKey`. Those live in the
  manifest now; a leftover copy is rejected with a migration error.
- `version` in a row is a discovery copy so a client can show "1.0.0 available"
  without fetching every manifest. Keep it in step with the manifest.
- `logo` in a row is cosmetic only and may be omitted even if the manifest has
  one.

There are two catalogs with this identical shape: an **official** one the team
hand-curates, and community/unofficial ones third parties self-publish. There
is no `official: true` field to set - official status is derived from the
addon's id starting with `org.delulu.` (case-insensitive), which is a namespace
reservation rather than something a publisher can declare.

---

## Shipping an addon

1. Deploy your server.
2. Point `manifest.json`'s `baseUrl` at the deployed domain, and serve that same
   file at `{baseUrl}/manifest.json`.
3. `npx dad validate` - checks the manifest against the DAD schema.
4. `npx dad test https://your-addon.example.com/manifest.json` - probes the
   deployed host.
5. Add a row pointing at your `manifestUrl` to the official catalog (open a PR)
   or your own community catalog.

HTTP addons are **not signed**: there's no downloadable artifact to protect,
and the manifest is fetched live and re-validated at install time.

---

## CLI reference

```
dad init <dir> [--id <reverse.dns.id>] [--name "Name"]
                        Scaffold a new HTTP addon

dad dev [dir] [--port <n>]
                        Start a real local server and print ready-to-run curl commands

dad test <manifest-url> [--key <api-key>]
                        Validate a DEPLOYED addon from its public manifest:
                        fetches the manifest, checks it declares the same host
                        it is served from, then probes every declared
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

`dad test` fails loudly rather than waving things through - a lenient probe
certifies a broken addon:

| What it sees | Verdict |
| --- | --- |
| `200` + a payload that passes the production validators | pass (and it's the only way to produce "real data") |
| A graceful DAD error (`content_unavailable`, `rate_limited`) | pass - the addon answered, it just had nothing or asked to slow down |
| A server/contract DAD error (`internal_error`, `upstream_unreachable`, `invalid_response`, `not_found`, `bad_request`, `method_not_allowed`) | **fail** - the probe only requests declared routes with valid input, so these mean the addon itself is broken |
| `401 unauthorized`, manifest declares an `apiKey` gate, no `--key` sent | pass - the gate is working |
| `401 unauthorized`, **no** declared gate | **fail** - nobody could ever use this addon |
| `401 unauthorized` after you passed `--key` | **fail** - your gate is rejecting a key that should work |
| Bare `404`/`400` that isn't a DAD error (hosting 404 page, stale deploy, wrong route shape) | **fail** - something other than your addon is answering |
| Every probe valid but **nothing ever returns data** | **fail** - contract-correct and useless |
| A manifest declaring a `baseUrl` on a different host than the one serving it | **fail** when remote; a loud **warning** for `dad dev` on localhost |

Without `--key`, `dad test` probes with no `Authorization` header at all -
checking the **graceful-rejection path**. An `apiKey.required: true` addon
should answer a well-formed `401`, not crash. That's a genuine pass, but a
narrow one: the run says the data path went untested and tells you to re-run
with `--key`.

With `--key <api-key>` (or `DAD_TEST_API_KEY` in the environment), `dad test`
sends that key on every probe instead - testing the **authenticated path**.
This flips the meaning of an `unauthorized` response: supplied a key and still
rejected is now a **failure**.

```bash
dad test https://your-addon.example.com/manifest.json               # graceful-rejection path
dad test https://your-addon.example.com/manifest.json --key sk_live_abc123  # authenticated path
```

---

## Package layout

```
src/
  manifest.ts    Manifest types + validation (the contract)
  errors.ts      DAD error model (DadError, DadErrorCode, DAD_ERROR_STATUS)
  validation.ts  Shared primitives (isHttpsUrl, isBareHttpsUrl, validateApiKeyShape)
  responses.ts   Request/response types + validators (meta, streams, subtitles)
  define.ts      defineHttpAddon / createHttpAddonHandler
  version.ts     Strict semver format check
  catalog.ts     Catalog schema (pointer + display rows) + validateCatalog
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
  DadError, DAD_ERROR_STATUS,
  validateManifest, validateCatalog, isOfficialId,
  validateStreamItems, validateMetaResponse, validateSubtitleItems,
  isValidVersion,
  DAD_TEST_FIXTURES,
} from '@delulu-addon/dad-sdk';
```


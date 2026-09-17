import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineHttpAddon,
  createHttpAddonHandler,
  DadError,
  validateErrorResponse,
  dadErrorStatus,
} from '../dist/index.js';

test('HTTP Addon Handler routes movie streams, series streams, and CORS', async () => {
  let lastStreamReq = null;

  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.test-addon',
      name: 'Test HTTP Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams(req) {
      lastStreamReq = req;
      return [
        {
          type: 'direct',
          title: '1080p Web-DL',
          stream_url: 'https://video.example.com/stream.mp4',
        },
      ];
    },
  });

  const handler = createHttpAddonHandler(addon);

  // 1. The static catalog manifest is the source of truth - this server does NOT serve one
const manifestRes = await handler(new Request('https://addon.example.com/manifest.json'));
  assert.equal(manifestRes.status, 400);
  const manifestErr = await manifestRes.json();
  assert.equal(manifestErr.error, 'bad_request');
  assert.ok(manifestErr.error_message.includes('extensionless'), 'the .json route style is hardened away');

  // 2. GET /streams/movie/10378
  const movieRes = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(movieRes.status, 200);
  const movieStreams = await movieRes.json();
  assert.equal(movieStreams.length, 1);
  assert.equal(movieStreams[0].title, '1080p Web-DL');
  assert.deepEqual(lastStreamReq, {
    tmdb_id: 10378,
    media_type: 'movie',
    s: undefined,
    e: undefined,
    auth: undefined,
  });

// 3. GET /streams/tv/10378/3/2 (Season 3, Episode 2)
  const tvRes = await handler(new Request('https://addon.example.com/streams/tv/10378/3/2'));
  assert.equal(tvRes.status, 200);
  assert.deepEqual(lastStreamReq, {
    tmdb_id: 10378,
    media_type: 'tv',
    s: 3,
    e: 2,
    auth: undefined,
  });

  // 4. CORS preflight (OPTIONS)
  const optionsRes = await handler(new Request('https://addon.example.com/streams/movie/10378', { method: 'OPTIONS' }));
  assert.equal(optionsRes.headers.get('Access-Control-Allow-Origin'), '*');

  // 5. Rejects POST with 405 Method Not Allowed
  const postRes = await handler(new Request('https://addon.example.com/streams/movie/10378', { method: 'POST' }));
  assert.equal(postRes.status, 405);
});

test('path-segment routes are HARDENED: .json suffix and query-string routes are rejected with 400', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.test-addon',
      name: 'Test HTTP Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return [];
    },
  });
  const handler = createHttpAddonHandler(addon);

  // Old Stremio-style `.json` suffix - the exact thing we hardened away
  const jsonRoute = await handler(new Request('https://addon.example.com/meta/movie/10378.json'));
  assert.equal(jsonRoute.status, 400);

  // Old query-string request format - no longer a valid route
  const queryRoute = await handler(new Request('https://addon.example.com/streams?tmdb_id=10378&media_type=movie'));
  assert.equal(queryRoute.status, 400);

  // Bare route with no segments is malformed, not silently 404'd
  const bareRoute = await handler(new Request('https://addon.example.com/streams'));
  assert.equal(bareRoute.status, 400);

  // Wrong media_type segment is invalid
  const badType = await handler(new Request('https://addon.example.com/meta/banana/10378'));
  assert.equal(badType.status, 400);

  // More than season+episode is malformed
  const tooMany = await handler(new Request('https://addon.example.com/streams/tv/10378/3/2/5'));
  assert.equal(tooMany.status, 400);

  // Non-integer season/episode is malformed
  const badEpisode = await handler(new Request('https://addon.example.com/streams/tv/10378/3/abc'));
  assert.equal(badEpisode.status, 400);
});

test('meta and subtitle routes accept season/episode - per-season trailers, per-episode subtitles', async () => {
  let lastMetaReq = null;
  let lastSubtitleReq = null;

  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.test-addon',
      name: 'Test HTTP Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['meta', 'subtitle'],
    },
    async getMeta(req) {
      lastMetaReq = req;
      return null;
    },
    async getSubtitles(req) {
      lastSubtitleReq = req;
      return [];
    },
  });
  const handler = createHttpAddonHandler(addon);

  // Per-season trailer lookup: /meta/tv/{tmdb_id}/{season}
  const seasonMeta = await handler(new Request('https://addon.example.com/meta/tv/10378/3'));
  assert.equal(seasonMeta.status, 200);
  assert.deepEqual(lastMetaReq, { tmdb_id: 10378, media_type: 'tv', s: 3, e: undefined, auth: undefined });

  // Per-episode subtitles: /subtitles/tv/{tmdb_id}/{season}/{episode}
  const episodeSubs = await handler(new Request('https://addon.example.com/subtitles/tv/10378/3/2'));
  assert.equal(episodeSubs.status, 200);
  assert.deepEqual(lastSubtitleReq, { tmdb_id: 10378, media_type: 'tv', s: 3, e: 2, auth: undefined });

  // Whole-show meta and subtitles still work without season/episode
  await handler(new Request('https://addon.example.com/meta/tv/10378'));
  assert.equal(lastMetaReq.s, undefined);
});

test('api key is injected as req.auth from Authorization: Bearer', async () => {
  let receivedAuth = 'none';
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.paid-addon',
      name: 'Paid Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://paid.example.com',
      capabilities: ['meta'],
      apiKey: { required: true, pageUrl: 'https://paid.example.com/signup' },
    },
    async getMeta(req) {
      receivedAuth = req.auth ?? 'missing';
      return null;
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(
    new Request('https://paid.example.com/meta/movie/10378', {
      headers: { Authorization: 'Bearer sk-1234567890' },
    })
  );
  assert.equal(res.status, 200);
  assert.equal(receivedAuth, 'sk-1234567890');
});

test('malformed Authorization header is rejected with 400', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.paid-addon',
      name: 'Paid Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://paid.example.com',
      capabilities: ['meta'],
    },
    async getMeta() {
      return null;
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(
    new Request('https://paid.example.com/meta/movie/10378', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    })
  );
assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'bad_request');
  assert.ok(data.error_message.includes('Bearer'));
});

test('error model: status map pairs codes to HTTP statuses', () => {
  assert.equal(dadErrorStatus('bad_request'), 400);
  assert.equal(dadErrorStatus('method_not_allowed'), 405);
  assert.equal(dadErrorStatus('unauthorized'), 401);
  assert.equal(dadErrorStatus('not_found'), 404);
  assert.equal(dadErrorStatus('content_unavailable'), 404);
  assert.equal(dadErrorStatus('invalid_response'), 422);
  assert.equal(dadErrorStatus('upstream_unreachable'), 502);
  assert.equal(dadErrorStatus('rate_limited'), 429);
  assert.equal(dadErrorStatus('internal_error'), 500);
});

test('error model: validateErrorResponse accepts a valid contract body', () => {
  const ok = validateErrorResponse({ error: 'content_unavailable', error_message: 'nothing here' });
  assert.equal(ok.valid, true);
  assert.deepEqual(ok.errors, []);
});

test('error model: validateErrorResponse rejects an unknown code', () => {
  const bad = validateErrorResponse({ error: 'magic_failure', error_message: 'oop' });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors[0].includes('magic_failure'));
});

test('error model: validateErrorResponse rejects a missing/non-string message', () => {
  const noMsg = validateErrorResponse({ error: 'not_found' });
  assert.equal(noMsg.valid, false);
  assert.ok(noMsg.errors.some((e) => e.includes("'error_message'")));
});

test('http handler: a thrown DadError becomes a contract-conformant response', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.throws-key',
      name: 'Throws Key Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      throw new DadError('unauthorized', 'Missing or invalid API key');
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 401);
  const data = await res.json();
  assert.deepEqual(data, { error: 'unauthorized', error_message: 'Missing or invalid API key' });
});

test('http handler: a returned DadErrorResponse object serializes as-is', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.returns-err',
      name: 'Returns Error Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return { error: 'upstream_unreachable', error_message: 'Provider scraper timed out' };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 502);
  const data = await res.json();
  assert.deepEqual(data, { error: 'upstream_unreachable', error_message: 'Provider scraper timed out' });
});

test('http handler: an unknown addon throw becomes internal_error 500', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.crashes',
      name: 'Crashing Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      throw new Error('kaboom at scraper');
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 500);
  const data = await res.json();
  assert.equal(data.error, 'internal_error');
  assert.ok(data.error_message.includes('kaboom at scraper'));
  assert.equal(validateErrorResponse(data).valid, true);
});

test('http handler: movies reject season/episode path segments (TV-only)', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.movie-strict',
      name: 'Movie Strict',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return [{ type: 'direct', title: 'x', stream_url: 'https://cdn.example.com/a.mp4' }];
    },
  });
  const handler = createHttpAddonHandler(addon);

  const withSeasonEpisode = await handler(new Request('https://addon.example.com/streams/movie/550/1/2'));
  assert.equal(withSeasonEpisode.status, 400);
  const data = await withSeasonEpisode.json();
  assert.equal(data.error, 'bad_request');
  assert.ok(data.error_message.includes('TV-only'));

  const withSeasonOnly = await handler(new Request('https://addon.example.com/streams/movie/550/1'));
  assert.equal(withSeasonOnly.status, 400);

  // Same route with no s/e still works fine.
  const plain = await handler(new Request('https://addon.example.com/streams/movie/550'));
  assert.equal(plain.status, 200);
});

test('http handler: CORS only advertises the methods it actually accepts (GET, OPTIONS - not POST)', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.cors-check',
      name: 'CORS Check',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return [];
    },
  });
  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/550', { method: 'OPTIONS' }));
  const allowed = res.headers.get('Access-Control-Allow-Methods');
  assert.ok(allowed.includes('GET'));
  assert.ok(!allowed.includes('POST'), `Access-Control-Allow-Methods should not advertise POST, got '${allowed}'`);
});


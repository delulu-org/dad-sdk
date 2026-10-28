import test from 'node:test';
import assert from 'node:assert/strict';
import { defineHttpAddon, createHttpAddonHandler, validateMetaResponse } from '../dist/index.js';

test('meta: null or undefined result is valid (addon found nothing)', () => {
  assert.equal(validateMetaResponse(null).valid, true);
  assert.equal(validateMetaResponse(undefined).valid, true);
});

test('meta: accepts valid overall_imdb_rating and trailers', () => {
  const res = validateMetaResponse({ overall_imdb_rating: 8.8, imdb_id: 'tt0137523', trailers: ['https://x/y.mp4'] });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: accepts overall_imdb_rating boundary values 0.0 and 10.0', () => {
  assert.equal(validateMetaResponse({ overall_imdb_rating: 0.0 }).valid, true);
  assert.equal(validateMetaResponse({ overall_imdb_rating: 10.0 }).valid, true);
  assert.equal(validateMetaResponse({ overall_imdb_rating: 7.5 }).valid, true);
});

test('meta: rejects overall_imdb_rating out of [0.0, 10.0] range', () => {
  const under = validateMetaResponse({ overall_imdb_rating: -0.1 });
  assert.equal(under.valid, false);
  assert.ok(under.errors.some((e) => e.includes('between 0.0 and 10.0 inclusive')));

  const over = validateMetaResponse({ overall_imdb_rating: 10.1 });
  assert.equal(over.valid, false);
  assert.ok(over.errors.some((e) => e.includes('between 0.0 and 10.0 inclusive')));
});

test('meta: rejects a string overall_imdb_rating (must be normalized to number)', () => {
  const res = validateMetaResponse({ overall_imdb_rating: '8.8' });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("'overall_imdb_rating' must be a number"));
});

test('meta: rejects NaN, Infinity, or -Infinity overall_imdb_rating', () => {
  const nanRes = validateMetaResponse({ overall_imdb_rating: NaN });
  assert.equal(nanRes.valid, false);
  assert.ok(nanRes.errors[0].includes("'overall_imdb_rating' must be a number"));

  const infRes = validateMetaResponse({ overall_imdb_rating: Infinity });
  assert.equal(infRes.valid, false);
  assert.ok(infRes.errors[0].includes("'overall_imdb_rating' must be a number"));

  const negInfRes = validateMetaResponse({ overall_imdb_rating: -Infinity });
  assert.equal(negInfRes.valid, false);
  assert.ok(negInfRes.errors[0].includes("'overall_imdb_rating' must be a number"));
});

test('meta: rejects deprecated imdb_rating field with migration message', () => {
  const res = validateMetaResponse({ imdb_rating: 8.8 });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("'imdb_rating' has been renamed to 'overall_imdb_rating'")));
});

test('meta: accepts valid episode_imdb_ratings object map', () => {
  const res = validateMetaResponse({
    overall_imdb_rating: 9.2,
    episode_imdb_ratings: {
      1: 8.5,
      2: 9.0,
      10: 10.0,
      15: 0.0,
    },
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: accepts episode_imdb_ratings as null or undefined', () => {
  assert.equal(validateMetaResponse({ episode_imdb_ratings: null }).valid, true);
  assert.equal(validateMetaResponse({}).valid, true);
});

test('meta: rejects episode_imdb_ratings that is an array or non-object', () => {
  const resArr = validateMetaResponse({ episode_imdb_ratings: [8.5, 9.0] });
  assert.equal(resArr.valid, false);
  assert.ok(resArr.errors.some((e) => e.includes("'episode_imdb_ratings' must be an object map")));

  const resStr = validateMetaResponse({ episode_imdb_ratings: '8.5' });
  assert.equal(resStr.valid, false);
  assert.ok(resStr.errors.some((e) => e.includes("'episode_imdb_ratings' must be an object map")));
});

test('meta: rejects episode_imdb_ratings with non-positive-integer episode keys', () => {
  const zeroEp = validateMetaResponse({ episode_imdb_ratings: { 0: 8.5 } });
  assert.equal(zeroEp.valid, false);
  assert.ok(zeroEp.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));

  const negEp = validateMetaResponse({ episode_imdb_ratings: { '-1': 8.5 } });
  assert.equal(negEp.valid, false);
  assert.ok(negEp.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));

  const strEp = validateMetaResponse({ episode_imdb_ratings: { 'ep1': 8.5 } });
  assert.equal(strEp.valid, false);
  assert.ok(strEp.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));

  const leadingZero = validateMetaResponse({ episode_imdb_ratings: { '01': 8.5 } });
  assert.equal(leadingZero.valid, false);
  assert.ok(leadingZero.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));

  const paddedEp = validateMetaResponse({ episode_imdb_ratings: { ' 1 ': 8.5 } });
  assert.equal(paddedEp.valid, false);
  assert.ok(paddedEp.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));

  const floatEp = validateMetaResponse({ episode_imdb_ratings: { '1.5': 8.5 } });
  assert.equal(floatEp.valid, false);
  assert.ok(floatEp.errors.some((e) => e.includes("episode numbers must be positive integers >= 1")));
});

test('meta: rejects episode_imdb_ratings with invalid rating values', () => {
  const strRating = validateMetaResponse({ episode_imdb_ratings: { 1: '8.5' } });
  assert.equal(strRating.valid, false);
  assert.ok(strRating.errors.some((e) => e.includes("must be a number")));

  const overRating = validateMetaResponse({ episode_imdb_ratings: { 1: 10.5 } });
  assert.equal(overRating.valid, false);
  assert.ok(overRating.errors.some((e) => e.includes("between 0.0 and 10.0 inclusive")));

  const underRating = validateMetaResponse({ episode_imdb_ratings: { 1: -0.5 } });
  assert.equal(underRating.valid, false);
  assert.ok(underRating.errors.some((e) => e.includes("between 0.0 and 10.0 inclusive")));
});

test('meta: accepts trailers as an array of HTTPS URLs (first = default)', () => {
  const res = validateMetaResponse({ trailers: ['https://x/a.mp4', 'https://x/b.m3u8'] });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: accepts empty or absent trailers as "no trailer"', () => {
  assert.equal(validateMetaResponse({ trailers: [] }).valid, true);
  assert.equal(validateMetaResponse({ trailers: null }).valid, true);
  assert.equal(validateMetaResponse({}).valid, true);
});

test('meta: rejects trailers with a non-HTTPS URL', () => {
  const res = validateMetaResponse({ trailers: ['http://x/a.mp4'] });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("trailers[0] must be an HTTPS URL")));
});

test('meta: rejects trailers with a non-string item', () => {
  const res = validateMetaResponse({ trailers: ['https://x/a.mp4', 42] });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("trailers[1] must be a string")));
});

test('meta: rejects a non-array trailers value', () => {
  const res = validateMetaResponse({ trailers: 'https://x/a.mp4' });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("'trailers' must be an array")));
});

test('meta: tolerates legacy fields from older addons (forward compat)', () => {
  const res = validateMetaResponse({ logo_url: 'https://x/logo.png', trailer_url: 'https://x/y.mp4' });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: http handler returns 422 when getMeta emits invalid rating', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.bad-meta',
      name: 'Bad Meta',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['meta'],
    },
    async getMeta() {
      return { overall_imdb_rating: 12.0 };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/meta/movie/10378'));
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, 'invalid_response');
  assert.ok(data.error_message.includes('Invalid meta response'));
});

test('meta: http handler returns 422 when getMeta emits deprecated imdb_rating', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.deprecated-meta',
      name: 'Deprecated Meta',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['meta'],
    },
    async getMeta() {
      return { imdb_rating: 8.8 };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/meta/movie/10378'));
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, 'invalid_response');
  assert.ok(data.error_message.includes('imdb_rating'));
});

test('meta: http handler rejects episode segment on /meta with 400 Bad Request', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.tv-meta',
      name: 'TV Meta',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['meta'],
    },
    async getMeta() {
      return { overall_imdb_rating: 9.0 };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/meta/tv/10378/1/5'));
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.equal(data.error, 'bad_request');
  assert.ok(data.error_message.includes('Episode-level requests are forbidden on /meta'));
});

test('meta: http handler accepts season query on /meta with 200 OK', async () => {
  let receivedReq = null;
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.tv-meta-season',
      name: 'TV Meta Season',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['meta'],
    },
    async getMeta(req) {
      receivedReq = req;
      return {
        overall_imdb_rating: 9.0,
        episode_imdb_ratings: { 1: 8.9, 2: 9.4 },
      };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/meta/tv/10378/2'));
  assert.equal(res.status, 200);
  assert.equal(receivedReq.tmdb_id, 10378);
  assert.equal(receivedReq.media_type, 'tv');
  assert.equal(receivedReq.s, 2);
  assert.equal(receivedReq.e, undefined);
  const data = await res.json();
  assert.equal(data.overall_imdb_rating, 9.0);
  assert.equal(data.episode_imdb_ratings[1], 8.9);
  assert.equal(data.episode_imdb_ratings[2], 9.4);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineHttpAddon, createHttpAddonHandler, validateMetaResponse } from '../dist/index.js';

test('meta: null result is valid (addon found nothing)', () => {
  assert.equal(validateMetaResponse(null).valid, true);
  assert.equal(validateMetaResponse(undefined).valid, true);
});

test('meta: accepts normalized numeric rating with trailers', () => {
  const res = validateMetaResponse({ imdb_rating: 8.8, imdb_id: 'tt0137523', trailers: ['https://x/y.mp4'] });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: rejects a string rating (must be normalized to number)', () => {
  const res = validateMetaResponse({ imdb_rating: '8.8' });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("'imdb_rating' must be a number"));
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

test('meta: http handler returns 422 when getMeta emits a string rating', async () => {
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
      return { imdb_rating: '8.8' };
    },
  });

const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/meta/movie/10378'));
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, 'invalid_response');
  assert.ok(data.error_message.includes('Invalid meta response'));
});

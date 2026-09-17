import test from 'node:test';
import assert from 'node:assert/strict';
import { defineHttpAddon, createHttpAddonHandler, validateMetaResponse } from '../dist/index.js';

test('meta: null result is valid (addon found nothing)', () => {
  assert.equal(validateMetaResponse(null).valid, true);
  assert.equal(validateMetaResponse(undefined).valid, true);
});

test('meta: accepts normalized numeric rating', () => {
  const res = validateMetaResponse({ imdb_rating: 8.8, imdb_id: 'tt0137523', trailer_url: 'https://x/y.mp4' });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: rejects a string rating (must be normalized to number)', () => {
  const res = validateMetaResponse({ imdb_rating: '8.8' });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("'imdb_rating' must be a number"));
});

test('meta: accepts trailer_sources keyed by known quality keys', () => {
  const res = validateMetaResponse({ trailer_sources: { '1080p': 'https://x/1080.mp4', hls: 'https://x/master.m3u8' } });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('meta: rejects trailer_sources keyed by an unrecognized quality string', () => {
  const res = validateMetaResponse({ trailer_sources: { garbage: 'https://x/y.mp4' } });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("trailer_sources key 'garbage' is not a recognized quality")));
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

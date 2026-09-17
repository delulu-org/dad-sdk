import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineHttpAddon,
  createHttpAddonHandler,
  validateStreamItems,
} from '../dist/index.js';

const baseManifest = {
  id: 'com.example.test',
  name: 'Test',
  version: '1.0.0',
  type: 'http',
  baseUrl: 'https://addon.example.com',
};

test('throws at definition time: capability declared but handler missing', () => {
  assert.throws(
    () =>
      defineHttpAddon({
        manifest: { ...baseManifest, capabilities: ['direct_stream'] },
        // no getStreams
      }),
    /declares capability 'direct_stream' but does not implement handler 'getStreams'/
  );
});

test('throws at definition time: handler implemented but capability not declared', () => {
  assert.throws(
    () =>
      defineHttpAddon({
        manifest: { ...baseManifest, capabilities: ['meta'] },
        async getMeta() {
          return null;
        },
        async getStreams() {
          return [];
        },
      }),
    /implements handler 'getStreams' but does not declare the matching capability/
  );
});

test('throws at definition time: manifest invalid', () => {
  assert.throws(
    () =>
      defineHttpAddon({
        manifest: { ...baseManifest, capabilities: [] },
        async getStreams() {
          return [];
        },
      }),
    /invalid manifest/
  );
});

test('validateStreamItems enforces allowedTypes from declared capabilities', () => {
  const torrentItem = { type: 'torrent', title: 'x', stream_url: 'magnet:?xt=urn:btih:aaaa' };
  // direct_stream-only addon returns a torrent item -> violation
  const res = validateStreamItems([torrentItem], { allowedTypes: ['direct'] });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("type 'torrent' is not allowed"));
  // torrent-capable addon accepts it
  const ok = validateStreamItems([torrentItem], { allowedTypes: ['direct', 'torrent'] });
  assert.equal(ok.valid, true);
});

test('http handler rejects non-numeric tmdb_id / invalid media_type / bad season with 400', async () => {
  const addon = defineHttpAddon({
    manifest: { ...baseManifest, capabilities: ['direct_stream'] },
    async getStreams() {
      return [];
    },
  });
  const handler = createHttpAddonHandler(addon);

  const badTmdb = await handler(new Request('https://addon.example.com/streams/movie/abc'));
  assert.equal(badTmdb.status, 400);

  const badType = await handler(new Request('https://addon.example.com/streams/banana/10378'));
  assert.equal(badType.status, 400);

  const badSeason = await handler(new Request('https://addon.example.com/streams/tv/10378/abc'));
  assert.equal(badSeason.status, 400);
});

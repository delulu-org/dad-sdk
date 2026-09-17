import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineHttpAddon,
  createHttpAddonHandler,
  validateStreamItem,
  validateStreamItems,
} from '../dist/index.js';

test('accepts a directly-playable stream with no headers', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Server 1 - 1080p',
    stream_url: 'https://cdn.example.com/movie.mp4',
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('accepts a proxied stream with needs_proxy true and non-empty headers', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Server 2 - 1080p',
    stream_url: 'https://provider.example.com/movie.m3u8',
    needs_proxy: true,
    headers: { Referer: 'https://provider.example.com/', 'User-Agent': 'Mozilla/5.0' },
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('rejects needs_proxy true without any headers', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Broken Proxy Stream',
    stream_url: 'https://provider.example.com/movie.m3u8',
    needs_proxy: true,
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes('non-empty \'headers\''));
});

test('rejects a directly-playable stream that carries headers without needs_proxy', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Ambiguous Stream',
    stream_url: 'https://cdn.example.com/movie.mp4',
    headers: { Referer: 'https://cdn.example.com/' },
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes('needs_proxy: true'));
});

test('rejects a proxied stream with an empty headers object', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Empty Headers',
    stream_url: 'https://provider.example.com/movie.m3u8',
    needs_proxy: true,
    headers: {},
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes('empty \'headers\''));
});

test('rejects a directly-playable stream (no needs_proxy) carrying an EMPTY headers object', () => {
  // Regression test: the symmetric case above already rejects
  // needs_proxy:true + headers:{} ("empty headers are meaningless"). This
  // case - headers:{} with NO needs_proxy at all - used to silently PASS,
  // because {} is truthy in JS and the old check only fired for headers
  // objects with at least one key. A direct stream carrying an empty
  // headers object should be rejected the same way a populated one is.
  const res = validateStreamItem({
    type: 'direct',
    title: 'Empty Headers, No Proxy Flag',
    stream_url: 'https://cdn.example.com/movie.mp4',
    headers: {},
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("cannot carry 'headers'"));
});

test('accepts a directly-playable stream with headers explicitly set to null', () => {
  // null/undefined both mean "field not meaningfully present" and must stay
  // valid - only a truthy headers value (including {}) should be rejected
  // when needs_proxy is not set.
  const res = validateStreamItem({
    type: 'direct',
    title: 'Null Headers',
    stream_url: 'https://cdn.example.com/movie.mp4',
    headers: null,
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('accepts a torrent stream with magnet url and rejects one with headers', () => {
  const magnet = { type: 'torrent', title: 'Movie.1080p.x265', stream_url: 'magnet:?xt=urn:btih:aaaa' };
  const ok = validateStreamItem(magnet);
  assert.equal(ok.valid, true);

  const bad = validateStreamItem({
    ...magnet,
    headers: { Referer: 'https://tracker.example.com/' },
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors[0].includes('must not carry \'headers\''));
});

test('accepts a stream item with a valid embedded subtitles array', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'BluRay 1080p',
    stream_url: 'https://cdn.example.com/movie.mkv',
    media_format: 'mkv',
    subtitles: [
      {
        id: 'en-sdh',
        url: 'https://cdn.example.com/en-sdh.vtt',
        lang_code: 'en',
        language: 'English',
        title: 'English [SDH]',
        format: 'vtt',
      },
    ],
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('rejects a stream item whose embedded subtitles are malformed', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Broken Embedded Subs',
    stream_url: 'https://cdn.example.com/movie.mkv',
    subtitles: [{ id: 'en', url: 'https://cdn.example.com/en.vtt' }],
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.join('').includes('Embedded'));
});

test('http handler returns 422 when an addon embeds malformed subtitles on a stream', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.bad-embedded-subs',
      name: 'Bad Embedded Subs',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return [
        {
          type: 'direct',
          title: 'Broken Subs',
          stream_url: 'https://cdn.example.com/movie.mp4',
          subtitles: [{ url: 'https://cdn.example.com/en.vtt' }],
        },
      ];
    },
  });

const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, 'invalid_response');
  assert.ok(data.error_message.includes('Invalid stream response'));
});

test('http handler returns 422 when an addon returns a proxy stream without headers', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.bad-stream',
      name: 'Bad Stream Addon',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return [
        {
          type: 'direct',
          title: 'Broken Proxy Stream',
          stream_url: 'https://provider.example.com/movie.m3u8',
          needs_proxy: true,
        },
      ];
    },
  });

const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 422);
  const data = await res.json();
  assert.equal(data.error, 'invalid_response');
  assert.ok(data.error_message.includes('Invalid stream response'));
});

test('http handler returns 422 when getStreams returns a non-array', async () => {
  const addon = defineHttpAddon({
    manifest: {
      id: 'com.example.not-array',
      name: 'Not Array',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://addon.example.com',
      capabilities: ['direct_stream'],
    },
    async getStreams() {
      return { not: 'an array' };
    },
  });

  const handler = createHttpAddonHandler(addon);
  const res = await handler(new Request('https://addon.example.com/streams/movie/10378'));
  assert.equal(res.status, 422);
});

test('rejects a direct stream whose stream_url uses a non-HTTPS scheme (javascript:, file:)', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://cdn.example.com/movie.mp4']) {
    const res = validateStreamItem({ type: 'direct', title: 'x', stream_url: url });
    assert.equal(res.valid, false, `expected '${url}' to be rejected`);
  }
});

test('accepts any well-formed string for media_format/resolution - the SDK is not a format whitelist', () => {
  // The SDK's job is "is this field the right TYPE", never "is this specific
  // value a format Delulu Core recognizes". An unrecognized-but-valid string
  // (e.g. a niche container the client doesn't support) is the CLIENT's call
  // to drop, not something the SDK should reject at the addon boundary.
  const res = validateStreamItem({
    type: 'direct',
    title: 'x',
    stream_url: 'https://cdn.example.com/a.flv',
    media_format: 'flv',
    resolution: 'potato-vision',
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('rejects media_format/resolution that are not strings at all', () => {
  for (const field of ['media_format', 'resolution']) {
    const res = validateStreamItem({
      type: 'direct',
      title: 'x',
      stream_url: 'https://cdn.example.com/a.mp4',
      [field]: 12345,
    });
    assert.equal(res.valid, false, `expected non-string '${field}' to be rejected`);
    assert.ok(res.errors.some((e) => e.includes(`'${field}' must be a string`)));
  }
});

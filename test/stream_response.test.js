import test from 'node:test';
import assert from 'node:assert/strict';
import {
  defineHttpAddon,
  createHttpAddonHandler,
validateStreamItem,
  validateStreamItems,
  validateSubtitleItems,
  DAD_SUBTITLE_FORMATS,
  allowedStreamTypesForCapabilities,
} from '../dist/index.js';

test('accepts a directly-playable stream with no headers', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Server 1 - 1080p',
    stream_url: 'https://cdn.example.com/movie.mp4',
    audio_languages: [],
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('accepts a proxied stream with needs_proxy true and non-empty headers', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Server 2 - 1080p',
    stream_url: 'https://provider.example.com/movie.m3u8',
    audio_languages: [],
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
    audio_languages: [],
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
    audio_languages: [],
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
    audio_languages: [],
    needs_proxy: true,
    headers: {},
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes('empty \'headers\''));
});

test('rejects a directly-playable stream (no needs_proxy) carrying an EMPTY headers object', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Empty Headers, No Proxy Flag',
    stream_url: 'https://cdn.example.com/movie.mp4',
    audio_languages: [],
    headers: {},
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors[0].includes("cannot carry 'headers'"));
});

test('accepts a directly-playable stream with headers explicitly set to null', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'Null Headers',
    stream_url: 'https://cdn.example.com/movie.mp4',
    audio_languages: [],
    headers: null,
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('accepts a torrent identified by info_hash + file_idx, and rejects one with headers', () => {
  const torrent = {
    type: 'torrent',
    title: 'Movie.1080p.x265',
    info_hash: 'a'.repeat(40),
    audio_languages: [],
    file_idx: 0,
  };
  const ok = validateStreamItem(torrent);
  assert.equal(ok.valid, true, ok.errors.join(', '));

  const bad = validateStreamItem({
    ...torrent,
    headers: { Referer: 'https://tracker.example.com/' },
  });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors[0].includes('must not carry \'headers\''));
});

test('a torrent item must NOT carry stream_url - the hash is its identity', () => {
  for (const bad of [
    'magnet:?xt=urn:btih:' + 'a'.repeat(40),
    'https://cdn.example.com/x.torrent',
    'javascript:alert(1)',
    'hello world',
  ]) {
    const res = validateStreamItem({ type: 'torrent', title: 'x', info_hash: 'b'.repeat(40), file_idx: 0, stream_url: bad, audio_languages: [] });
    assert.equal(res.valid, false, `stream_url ${JSON.stringify(bad)} must be rejected on a torrent`);
    assert.ok(
      res.errors.some((e) => e.includes('must NOT carry \'stream_url\'')),
      `expected a stream_url-specific error, got: ${res.errors.join(' | ')}`
    );
  }
});

test('torrent info_hash is required and strictly hex-validated', () => {
  const base = { type: 'torrent', title: 'x', file_idx: 0, audio_languages: [] };

  const missing = validateStreamItem(base);
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes("require an 'info_hash'")));

  const rejected = [
    'x'.repeat(40), // right length, not hex
    'a'.repeat(39), // v1 one short
    'a'.repeat(41), // v1 one long
    `${'a'.repeat(39)}z`,
    ` ${'a'.repeat(40)}`, // padded - a magnet-parsed hash never has whitespace
    'magnet:?xt=urn:btih:' + 'a'.repeat(40), // the whole magnet, not the hash
    '',
    null,
  ];
  for (const info_hash of rejected) {
    const res = validateStreamItem({ ...base, info_hash });
    assert.equal(res.valid, false, `expected rejection for ${JSON.stringify(info_hash)}`);
  }

  for (const info_hash of ['a'.repeat(40), 'F'.repeat(40), '0123456789abcdef'.repeat(4), 'A'.repeat(64)]) {
    const res = validateStreamItem({ ...base, info_hash });
    assert.equal(res.valid, true, `expected ${info_hash.slice(0, 12)}... to be accepted: ${res.errors.join(', ')}`);
  }
});

test('torrent file_idx is REQUIRED - the wrong file means the wrong episode', () => {
  const base = { type: 'torrent', title: 'x', info_hash: 'c'.repeat(40), audio_languages: [] };

  for (const file_idx of [undefined, null]) {
    const res = validateStreamItem({ ...base, file_idx });
    assert.equal(res.valid, false, `file_idx ${JSON.stringify(file_idx)} must be rejected`);
    assert.ok(res.errors.some((e) => e.includes("require 'file_idx'")), res.errors.join(' | '));
  }

  for (const file_idx of ['2', -1, 1.5, true, {}]) {
    const res = validateStreamItem({ ...base, file_idx });
    assert.equal(res.valid, false, `file_idx ${JSON.stringify(file_idx)} must be rejected`);
    assert.ok(
      res.errors.some((e) => e.includes("'file_idx' must be a non-negative integer")),
      res.errors.join(' | ')
    );
  }

  const single = validateStreamItem({ ...base, file_idx: 0 });
  assert.equal(single.valid, true, single.errors.join(', '));
  const pack = validateStreamItem({ ...base, file_idx: 7 });
  assert.equal(pack.valid, true, pack.errors.join(', '));
});

test('torrent seeders and trackers are shape-checked when present', () => {
  const base = { type: 'torrent', title: 'x', info_hash: 'd'.repeat(40), file_idx: 0, audio_languages: [] };

  const badTracker = validateStreamItem({ ...base, trackers: ['not a url'] });
  assert.equal(badTracker.valid, false);
  assert.ok(badTracker.errors.some((e) => e.includes('not a usable announce URL')), badTracker.errors.join(' | '));

  const goodTrackers = validateStreamItem({
    ...base,
    trackers: ['udp://tracker.example.org:1337/announce', 'wss://tracker.example.org/announce', 'https://t.example.org/a'],
  });
  assert.equal(goodTrackers.valid, true, goodTrackers.errors.join(', '));

  const badSeeders = validateStreamItem({ ...base, seeders: 'many' });
  assert.equal(badSeeders.valid, false);
  assert.ok(badSeeders.errors.some((e) => e.includes("'seeders' must be a non-negative integer")));

  const okSeeders = validateStreamItem({ ...base, seeders: 0 });
  assert.equal(okSeeders.valid, true, okSeeders.errors.join(', '));
});

test('an addon may only return the stream types it declared', () => {
  const cases = [
    [['direct_stream'], 'direct', true],
    [['direct_stream'], 'torrent', false],
    [['torrent'], 'torrent', true],
    [['torrent'], 'direct', false],
    [['direct_stream', 'torrent'], 'direct', true],
    [['direct_stream', 'torrent'], 'torrent', true],
  ];
  for (const [caps, itemType, expected] of cases) {
    const allowed = allowedStreamTypesForCapabilities(caps);
    const item = itemType === 'torrent'
      ? { type: 'torrent', title: 'x', info_hash: 'b'.repeat(40), file_idx: 0, audio_languages: [] }
      : { type: 'direct', title: 'x', stream_url: 'https://a.example.com/s.m3u8', audio_languages: [] };
    const res = validateStreamItems([item], { allowedTypes: allowed });
    assert.equal(res.valid, expected, `caps=${JSON.stringify(caps)} item=${itemType}: ${res.errors.join(' | ')}`);
  }
});

test('an addon with NO stream capability may not return streams at all', () => {
  for (const caps of [['subtitle'], ['meta'], ['meta', 'subtitle']]) {
    assert.deepEqual(allowedStreamTypesForCapabilities(caps), [], `${JSON.stringify(caps)} should map to no stream types`);

    for (const itemType of ['torrent', 'direct']) {
      const item = itemType === 'torrent'
        ? { type: 'torrent', title: 'x', info_hash: 'b'.repeat(40), file_idx: 0, audio_languages: [] }
        : { type: 'direct', title: 'x', stream_url: 'https://a.example.com/s.m3u8', audio_languages: [] };
      const res = validateStreamItems([item], { allowedTypes: allowedStreamTypesForCapabilities(caps) });
      assert.equal(res.valid, false, `caps=${JSON.stringify(caps)} must not be able to return ${itemType}`);
      assert.ok(res.errors[0].includes('no stream types'), res.errors.join(' | '));
    }
  }

  const empty = validateStreamItems([], { allowedTypes: [] });
  assert.equal(empty.valid, true);

  const unchecked = validateStreamItems([{ type: 'torrent', title: 'x', info_hash: 'b'.repeat(40), file_idx: 0, audio_languages: [] }]);
  assert.equal(unchecked.valid, true);
});

test('every never-field is checked by PRESENCE, not truthiness', () => {
  const torrentBase = { type: 'torrent', title: 'x', info_hash: 'c'.repeat(40), file_idx: 0, audio_languages: [] };
  const falsePositives = [
    ['stream_url: null', { ...torrentBase, stream_url: null, audio_languages: [] }],
    ['needs_proxy: false', { ...torrentBase, needs_proxy: false }],
    ['headers: null', { ...torrentBase, headers: null }],
    ['headers: {}', { ...torrentBase, headers: {} }],
  ];
  for (const [label, item] of falsePositives) {
    const res = validateStreamItem(item);
    assert.equal(res.valid, false, `torrent + ${label} must be rejected`);
  }

  const clean = validateStreamItem(torrentBase);
  assert.equal(clean.valid, true, clean.errors.join(', '));
});

test('a direct stream must NOT carry torrent-engine fields', () => {
  const directBase = { type: 'direct', title: 'x', stream_url: 'https://cdn.example.com/a.m3u8', audio_languages: [] };

  for (const field of ['info_hash', 'file_idx', 'trackers', 'seeders']) {
    for (const value of ['realValue', null, 0, {}, []]) {
      const res = validateStreamItem({ ...directBase, [field]: value });
      assert.equal(res.valid, false, `direct + ${field}: ${JSON.stringify(value)} must be rejected`);
      assert.ok(
        res.errors.some((e) => e.includes(`must NOT carry '${field}'`)),
        `expected a '${field}'-specific error, got: ${res.errors.join(' | ')}`
      );
    }
  }

  const clean = validateStreamItem(directBase);
  assert.equal(clean.valid, true, clean.errors.join(', '));

  const proxied = validateStreamItem({
    type: 'direct',
    title: 'x',
    stream_url: 'https://p.example.com/s.m3u8',
    audio_languages: [],
    needs_proxy: true,
    headers: { Referer: 'https://p.example.com/' },
    info_hash: 'd'.repeat(40),
    audio_languages: [],
  });
  assert.equal(proxied.valid, false);
  assert.ok(proxied.errors.some((e) => e.includes("must NOT carry 'info_hash'")));
});

test('audio_languages: required, always an array, shape checked', () => {
  const base = { type: 'direct', title: 'BluRay', stream_url: 'https://cdn.example.com/movie.mkv', audio_languages: [] };

  for (const audio_languages of [
    ['English'],           // single language
    ['English', 'Hindi'],  // the multi-audio case
    [],                    // empty = "I cannot tell" - the ONLY way to say it
  ]) {
    const res = validateStreamItem({ ...base, audio_languages });
    assert.equal(res.valid, true, `expected valid for ${JSON.stringify(audio_languages)}: ${res.errors.join(' | ')}`);
  }

  for (const missing of [undefined, null]) {
    const res = validateStreamItem({ ...base, audio_languages: missing });
    assert.equal(res.valid, false, `must reject ${JSON.stringify(missing)}`);
    assert.ok(res.errors.some((e) => e.includes("Missing 'audio_languages'")), res.errors.join(' | '));
  }
  const absent = validateStreamItem({ type: 'direct', title: 'x', stream_url: 'https://cdn.example.com/movie.mkv' });
  assert.equal(absent.valid, false, `must reject an omitted field: ${absent.errors.join(' | ')}`);
  assert.ok(absent.errors.some((e) => e.includes("Missing 'audio_languages'")), absent.errors.join(' | '));

  for (const bad of ['English', 42, {}, true]) {
    const res = validateStreamItem({ ...base, audio_languages: bad });
    assert.equal(res.valid, false, `must reject ${JSON.stringify(bad)}`);
    assert.ok(res.errors.some((e) => e.includes("'audio_languages' must be an array")), res.errors.join(' | '));
  }

  for (const bad of [['English', ''], ['English', 3]]) {
    const res = validateStreamItem({ ...base, audio_languages: bad });
    assert.equal(res.valid, false, `must reject ${JSON.stringify(bad)}`);
    assert.ok(res.errors.some((e) => e.includes('only non-empty language names')), res.errors.join(' | '));
  }

  const lying = validateStreamItem({ ...base, audio_languages: ['Klingon'] });
  assert.equal(lying.valid, true, lying.errors.join(' | '));
});

test('audio_format is an optional non-empty display string', () => {
  const base = { type: 'direct', title: 'x', stream_url: 'https://cdn.example.com/movie.mkv', audio_languages: [] };

  for (const audio_format of ['Dolby Atmos', 'DTS-HD', 'DD+', 'AAC', undefined, null]) {
    const res = validateStreamItem({ ...base, audio_format });
    assert.equal(res.valid, true, `expected valid for ${JSON.stringify(audio_format)}: ${res.errors.join(' | ')}`);
  }
  for (const bad of ['', '   ', 42, {}]) {
    const res = validateStreamItem({ ...base, audio_format: bad });
    assert.equal(res.valid, false, `must reject ${JSON.stringify(bad)}`);
  }
});

test('accepts a stream item with a valid embedded subtitles array', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'BluRay 1080p',
    stream_url: 'https://cdn.example.com/movie.mkv',
    audio_languages: [],
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
    audio_languages: [],
    subtitles: [{ id: 'en', url: 'https://cdn.example.com/en.vtt' }],
  });
  assert.equal(res.valid, false);
  assert.ok(res.errors.join('').includes('Embedded'));
});

test('rejects embedded subtitle URLs that are NOT valid HTTPS (javascript:, file:, http:)', () => {
  const base = {
    type: 'direct',
    title: 'Subs URL Guard',
    stream_url: 'https://cdn.example.com/movie.mkv',
    audio_languages: [],
  };
  const baseSub = { id: 'en', lang_code: 'en', language: 'English', title: 'English', format: 'vtt' };
  for (const badUrl of ['javascript:alert(1)', 'file:///etc/passwd', 'http://cdn.example.com/en.vtt']) {
    const res = validateStreamItem({ ...base, subtitles: [{ ...baseSub, url: badUrl }] });
    assert.equal(res.valid, false, `expected rejection for url '${badUrl}'`);
    assert.ok(
      res.errors.join('').includes('HTTPS'),
      `expected an HTTPS rule message for '${badUrl}', got: ${res.errors.join('; ')}`
    );
  }
});

test('rejects embedded subtitle string fields that are empty or whitespace-only', () => {
  const base = {
    type: 'direct',
    title: 'Subs Field Guard',
    stream_url: 'https://cdn.example.com/movie.mkv',
    audio_languages: [],
  };
  const baseSub = { id: 'en', lang_code: 'en', language: 'English', title: 'English', format: 'vtt', url: 'https://cdn.example.com/en.vtt' };
  const res = validateStreamItem({ ...base, subtitles: [{ ...baseSub, id: '   ', language: '' }] });
  assert.equal(res.valid, false);
  const joined = res.errors.join('');
  assert.ok(joined.includes('non-empty'), `expected non-empty field errors, got: ${joined}`);
});

test('DAD_SUBTITLE_FORMATS is exactly the approved set', () => {
  assert.deepEqual([...DAD_SUBTITLE_FORMATS], ['vtt', 'srt', 'ass', 'ssa', 'ttml', 'dfxp']);
});

test('accepts every declared subtitle format (vtt, srt, ass, ssa, ttml, dfxp)', () => {
  for (const format of DAD_SUBTITLE_FORMATS) {
    const res = validateSubtitleItems([
      { id: `x-${format}`, url: `https://cdn.example.com/a.${format}`, lang_code: 'en', language: 'English', title: 'English', format },
    ]);
    assert.equal(res.valid, true, `expected '${format}' to be accepted: ${res.errors.join('; ')}`);
  }
});

test('rejects an unknown subtitle format and lists the allowed ones', () => {
  const res = validateSubtitleItems([
    { id: 'x', url: 'https://cdn.example.com/a.pdf', lang_code: 'en', language: 'English', title: 'English', format: 'pdf' },
  ]);
  assert.equal(res.valid, false);
  const joined = res.errors.join('');
  assert.ok(joined.includes('ass') && joined.includes('dfxp'), `expected the allowed formats listed, got: ${joined}`);
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
          audio_languages: [],
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
          audio_languages: [],
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
    const res = validateStreamItem({ type: 'direct', title: 'x', stream_url: url, audio_languages: [] });
    assert.equal(res.valid, false, `expected '${url}' to be rejected`);
  }
});

test('accepts any well-formed string for media_format/resolution - the SDK is not a format whitelist', () => {
  const res = validateStreamItem({
    type: 'direct',
    title: 'x',
    stream_url: 'https://cdn.example.com/a.flv',
    audio_languages: [],
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
      audio_languages: [],
      [field]: 12345,
    });
    assert.equal(res.valid, false, `expected non-string '${field}' to be rejected`);
    assert.ok(res.errors.some((e) => e.includes(`'${field}' must be a string`)));
  }
});

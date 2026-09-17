import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { DAD_TEST_FIXTURES } from '../dist/index.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const run = promisify(execFile);
const runCLI = (args, opts = {}) => run('node', [CLI, ...args], { timeout: 120000, ...opts });

const VALID_MANIFEST = {
  id: 'org.example.test-addon',
  name: 'Test Addon',
  version: '1.0.0',
  type: 'http',
  baseUrl: 'https://addon.example.com',
  capabilities: ['direct_stream', 'meta', 'subtitle'],
};

/**
 * Spins a REAL local HTTP server serving a manifest at /manifest.json + the
 * DAD routes, so `dad test` probes a real contract endpoint. The manifest's
 * declared baseUrl stays HTTPS (validator enforces HTTPS on the manifest
 * string), but since `dad test` probes the ORIGIN the manifest came from,
 * requests land on this localhost server.
 */
function startAddonServer(manifest = VALID_MANIFEST) {
  const routes = {
    '/streams/movie/10378': [{ type: 'direct', title: '1080p', stream_url: 'https://cdn.example.com/movie.mp4' }],
    '/streams/movie/45745': [{ type: 'direct', title: '720p', stream_url: 'https://cdn.example.com/movie2.mp4' }],
    '/meta/movie/10378': { imdb_id: 'tt1254207', imdb_rating: 6.4 },
    '/meta/movie/45745': { imdb_id: 'tt1727587' },
    '/subtitles/movie/10378': [
      {
        id: 'en',
        url: 'https://cdn.example.com/en.vtt',
        lang_code: 'en',
        language: 'English',
        title: 'English',
        format: 'vtt',
      },
    ],
    '/subtitles/movie/45745': [],
  };

  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(manifest));
      return;
    }
    const body = routes[req.url];
    if (body === undefined) {
      res.statusCode = 404;
res.end(JSON.stringify({ error: 'not_found', error_message: 'No content for this title' }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify(body));
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.manifestUrl = `http://127.0.0.1:${port}/manifest.json`;
      server.closeAsync = () => new Promise((r) => server.close(r));
      resolve(server);
    });
  });
}

test('fixtures are public-domain / free-licensed movies with real TMDB ids', () => {
  const titles = DAD_TEST_FIXTURES.map((f) => f.title);
  assert.ok(DAD_TEST_FIXTURES.length >= 5);
  for (const f of DAD_TEST_FIXTURES) {
    assert.ok(Number.isInteger(f.tmdb_id));
    assert.ok(f.media_type === 'movie' || f.media_type === 'tv');
    assert.ok(f.title);
  }
  // Ensure no copyrighted fixtures slipped in
  assert.ok(!titles.some((t) => /fight club|breaking bad/i.test(t)));
});

test('dad test against a live addon server reports PASS', async () => {
  const server = await startAddonServer();
  try {
    const { stdout } = await runCLI(['test', server.manifestUrl]);
    assert.match(stdout, /DAD test/);
    assert.match(stdout, /PASS/);
    assert.doesNotMatch(stdout, /FAIL/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test fails loudly on an invalid manifest URL shape (non-200)', async () => {
  const server = await startAddonServer();
  try {
    await assert.rejects(
      runCLI(['test', `http://127.0.0.1:${server.address().port}/nope.json`]),
      /DAD test FAILED/
    );
  } finally {
    await server.closeAsync();
  }
});

test('dad test surfaces invalid streams as FAIL and exits non-zero', async () => {
  const badManifest = { ...VALID_MANIFEST, capabilities: ['direct_stream'] };
  const server = await startAddonServer(badManifest);
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(badManifest));
      return;
    }
    if (req.url === '/streams/movie/10378') {
      res.statusCode = 200;
      res.end(JSON.stringify([{ type: 'banana', title: 'Bad', stream_url: 'x' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', error_message: 'No content for this title' }));
  });
  try {
    const e = await runCLI(['test', server.manifestUrl]).then(
      () => null,
      (err) => err
    );
    assert.ok(e, 'should exit non-zero when a stream probe fails validation');
    assert.match(String(e.stdout ?? '') + String(e.stderr ?? ''), /FAIL/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test PASSES a stream probe that answers with a valid contract error (graceful)', async () => {
  const server = await startAddonServer();
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(VALID_MANIFEST));
      return;
    }
    if (req.url === '/streams/movie/10378') {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: 'unauthorized', error_message: 'Missing or invalid API key' }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', error_message: 'No content for this title' }));
  });
  try {
    const { stdout } = await runCLI(['test', server.manifestUrl]);
    assert.match(stdout, /PASS/);
    assert.match(stdout, /graceful error: unauthorized/);
    assert.doesNotMatch(stdout, /FAIL/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test FAILS a direct_stream-only addon that returns a torrent item - matches production 422 behavior', async () => {
  // Regression test: dad test used to call validateStreamItems(data, { allowedTypes: [] }),
  // which SKIPS the capability<->type check entirely (empty array = "no restriction"),
  // so this exact scenario would silently PASS even though createHttpAddonHandler
  // would 422 it in production. dad test must derive allowedTypes from the
  // addon's declared capabilities, same as production.
  const directOnlyManifest = { ...VALID_MANIFEST, capabilities: ['direct_stream'] };
  const server = await startAddonServer(directOnlyManifest);
  server.removeAllListeners('request');
  server.on('request', (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(directOnlyManifest));
      return;
    }
    if (req.url === '/streams/movie/10378') {
      res.statusCode = 200;
      res.end(
        JSON.stringify([
          { type: 'torrent', title: 'Sneaky Torrent', stream_url: 'magnet:?xt=urn:btih:' + 'a'.repeat(40) },
        ])
      );
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', error_message: 'No content for this title' }));
  });
  try {
    const e = await runCLI(['test', server.manifestUrl]).then(
      () => null,
      (err) => err
    );
    assert.ok(e, 'dad test should exit non-zero - a direct_stream-only addon returned a torrent item');
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    assert.match(out, /FAIL/);
    assert.match(out, /not allowed by this addon's declared capabilities/);
  } finally {
    await server.closeAsync();
  }
});

/** Starts a key-gated server: 200 with real content only for the exact expected key. */
function startKeyGatedServer(expectedKey = 'real-valid-key') {
  const manifest = {
    ...VALID_MANIFEST,
    capabilities: ['direct_stream'],
    apiKey: { required: true, pageUrl: 'https://addon.example.com/signup' },
  };
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(manifest));
      return;
    }
    if (req.headers['authorization'] === `Bearer ${expectedKey}`) {
      res.statusCode = 200;
      res.end(JSON.stringify([{ type: 'direct', title: '1080p', stream_url: 'https://cdn.example.com/movie.mp4' }]));
      return;
    }
    res.statusCode = 401;
    res.end(JSON.stringify({ error: 'unauthorized', error_message: 'Missing or invalid API key' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.manifestUrl = `http://127.0.0.1:${port}/manifest.json`;
      server.closeAsync = () => new Promise((r) => server.close(r));
      resolve(server);
    });
  });
}

test('dad test with NO --key: an unauthorized response is graceful and PASSES', async () => {
  const server = await startKeyGatedServer();
  try {
    const { stdout } = await runCLI(['test', server.manifestUrl]);
    assert.match(stdout, /PASS/);
    assert.match(stdout, /graceful error: unauthorized/);
    assert.match(stdout, /Auth: none/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test --key with the WRONG key: unauthorized now FAILS (key gate looks broken)', async () => {
  const server = await startKeyGatedServer('real-valid-key');
  try {
    const e = await runCLI(['test', server.manifestUrl, '--key', 'totally-wrong-key']).then(
      () => null,
      (err) => err
    );
    assert.ok(e, 'expected dad test to exit non-zero when a supplied key is rejected');
    const out = String(e.stdout ?? '') + String(e.stderr ?? '');
    assert.match(out, /FAIL/);
    assert.match(out, /key rejected: unauthorized/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test --key with the CORRECT key: gets real content back and PASSES', async () => {
  const server = await startKeyGatedServer('real-valid-key');
  try {
    const { stdout } = await runCLI(['test', server.manifestUrl, '--key', 'real-valid-key']);
    assert.match(stdout, /PASS/);
    assert.match(stdout, /Auth: sending Authorization: Bearer/);
    assert.doesNotMatch(stdout, /FAIL/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test reads DAD_TEST_API_KEY from the environment when --key is not passed', async () => {
  const server = await startKeyGatedServer('env-supplied-key');
  try {
    const { stdout } = await runCLI(['test', server.manifestUrl], {
      env: { ...process.env, DAD_TEST_API_KEY: 'env-supplied-key' },
    });
    assert.match(stdout, /PASS/);
    assert.match(stdout, /Auth: sending Authorization: Bearer/);
  } finally {
    await server.closeAsync();
  }
});

test('dad test probes the /streams route ONCE for an addon declaring BOTH direct_stream and torrent', async () => {
  // Regression test: direct_stream and torrent both resolve to '/streams'
  // (see CAPABILITY_ROUTES). The probe loop used to iterate CAPABILITIES
  // instead of routes, so an addon declaring both got '/streams' hit twice
  // per fixture with an identical request - doubling real load against a
  // live server and double-reporting the same result under two labels.
  const bothManifest = { ...VALID_MANIFEST, capabilities: ['direct_stream', 'torrent'] };
  let streamsHitCount = 0;
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(bothManifest));
      return;
    }
    if (req.url.startsWith('/streams/')) {
      streamsHitCount++;
      res.end(JSON.stringify([{ type: 'direct', title: '1080p', stream_url: 'https://cdn.example.com/movie.mp4' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not_found', error_message: 'No content for this title' }));
  });
  const listening = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve(`http://127.0.0.1:${port}/manifest.json`);
    });
  });

  try {
    const { stdout } = await runCLI(['test', listening]);
    assert.match(stdout, /PASS/);
    // One /streams request per fixture (6 fixtures) - NOT two per fixture
    // (which is what the bug produced: one for 'direct_stream', one for
    // 'torrent', both hitting the identical '/streams' URL).
    assert.equal(
      streamsHitCount,
      DAD_TEST_FIXTURES.length,
      `expected exactly 1 request to /streams per fixture (${DAD_TEST_FIXTURES.length} fixtures), got ${streamsHitCount} total hits`
    );
    // Exactly one probe result line should mention the movie fixture's
    // streams route, not two (one for each capability). Label format is
    // "{title} - streams/movie/{id} (...)" - no leading slash.
    const streamsLines = stdout.split('\n').filter((l) => l.includes('streams/movie/10378'));
    assert.equal(streamsLines.length, 1, `expected exactly 1 result line for streams/movie/10378, got ${streamsLines.length}`);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { checkAddonId, identifySealedNamespace } from '../dist/cli/registry.js';

const run = promisify(execFile);
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function startRegistry(doc) {
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(doc));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const registryUrl = `http://127.0.0.1:${server.address().port}/registry.json`;
      server.registryUrl = registryUrl;
      server.closeAsync = () => new Promise((r) => server.close(r));
      resolve(server);
    });
  });
}

function startAddonServer(manifest) {
  const server = createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/manifest.json') {
      res.end(JSON.stringify(manifest));
      return;
    }
    const route = `/streams/movie/10378`;
    if (req.url === route) {
      res.end(JSON.stringify([{ type: 'direct', title: '1080p', stream_url: 'https://cdn.example.com/movie.mp4' }]));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'content_unavailable', error_message: 'nothing here' }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      server.manifestUrl = `http://127.0.0.1:${server.address().port}/manifest.json`;
      server.closeAsync = () => new Promise((r) => server.close(r));
      resolve(server);
    });
  });
}

const ADDON_URL = 'https://addon.example.com/manifest.json';

test('registry guard: free id is ok', async () => {
  const reg = await startRegistry({ official: [], addons: [] });
  try {
    const r = await checkAddonId({ id: 'com.example.fresh', manifestUrl: ADDON_URL, registryUrl: reg.registryUrl });
    assert.equal(r.status, 'ok');
  } finally {
    await reg.closeAsync();
  }
});

test('registry guard: id registered to the SAME url is self (allowed)', async () => {
  const reg = await startRegistry({
    official: [],
    addons: [{ id: 'com.example.mine', manifestUrl: ADDON_URL }],
  });
  try {
    const r = await checkAddonId({ id: 'com.example.mine', manifestUrl: ADDON_URL, registryUrl: reg.registryUrl });
    assert.equal(r.status, 'self');
  } finally {
    await reg.closeAsync();
  }
});

test('registry guard: id registered to a DIFFERENT url is a conflict', async () => {
  const reg = await startRegistry({
    official: [],
    addons: [{ id: 'com.example.taken', manifestUrl: 'https://other.example.com/manifest.json' }],
  });
  try {
    const r = await checkAddonId({ id: 'com.example.taken', manifestUrl: ADDON_URL, registryUrl: reg.registryUrl });
    assert.equal(r.status, 'conflict');
    assert.match(r.detail, /other\.example\.com/);
  } finally {
    await reg.closeAsync();
  }
});

test('registry guard: org.delulu.* not in the official list is SEALED (blocked)', async () => {
  const reg = await startRegistry({ official: [], addons: [] });
  try {
    const r = await checkAddonId({ id: 'org.delulu.vandal', manifestUrl: ADDON_URL, registryUrl: reg.registryUrl });
    assert.equal(r.status, 'sealed');
    assert.match(r.detail, /reserved namespace/);
  } finally {
    await reg.closeAsync();
  }
});

test('registry guard: org.delulu.* IS allowed when in the official list', async () => {
  const reg = await startRegistry({
    official: [{ id: 'org.delulu.vandal', manifestUrl: ADDON_URL }],
    addons: [],
  });
  try {
    const r = await checkAddonId({ id: 'org.delulu.vandal', manifestUrl: ADDON_URL, registryUrl: reg.registryUrl });
    assert.equal(r.status, 'self');
  } finally {
    await reg.closeAsync();
  }
});

test('registry guard: unreachable registry degrades to non-blocking warning', async () => {
  const r = await checkAddonId({ id: 'com.example.x', manifestUrl: ADDON_URL, registryUrl: 'http://127.0.0.1:1/registry.json' });
  assert.equal(r.status, 'unreachable');
});

test('identifySealedNamespace detects the reserved prefix case-insensitively', () => {
  assert.equal(identifySealedNamespace('org.delulu.trailers'), 'org.delulu.');
  assert.equal(identifySealedNamespace('ORG.DELULU.X'), 'org.delulu.');
  assert.equal(identifySealedNamespace('com.example.x'), undefined);
  assert.equal(identifySealedNamespace('org.deluluxe'), undefined);
});

test('dad test FAILS a sealed id before probing', async () => {
  const reg = await startRegistry({ official: [], addons: [] });
  const addon = await startAddonServer({ id: 'org.delulu.vandal', name: 'Squatter', version: '1.0.0', type: 'http', baseUrl: 'https://addon.example.com', capabilities: ['direct_stream'] });
  try {
    const e = await run('node', [CLI, 'test', addon.manifestUrl], {
      timeout: 120000,
      env: { ...process.env, DAD_REGISTRY_URL: reg.registryUrl },
    }).then(
      () => null,
      (err) => err
    );
    assert.ok(e, 'expected non-zero exit');
    assert.match(e.stderr, /reserved namespace 'org\.delulu\.'/);
  } finally {
    await reg.closeAsync();
    await addon.closeAsync();
  }
});

test('dad test PASSES an official org.delulu.* id', async () => {
  const addon = await startAddonServer({ id: 'org.delulu.official-addon', name: 'Official', version: '1.0.0', type: 'http', baseUrl: 'https://addon.example.com', capabilities: ['direct_stream'] });
  const reg = await startRegistry({ official: [{ id: 'org.delulu.official-addon', manifestUrl: addon.manifestUrl }], addons: [] });
  try {
    const { stdout } = await run('node', [CLI, 'test', addon.manifestUrl], {
      timeout: 120000,
      env: { ...process.env, DAD_REGISTRY_URL: reg.registryUrl },
    });
    assert.match(stdout, /PASS/);
  } finally {
    await reg.closeAsync();
    await addon.closeAsync();
  }
});

test('dad test FAILS a colliding id (different URL)', async () => {
  const reg = await startRegistry({ official: [], addons: [{ id: 'com.example.collide', manifestUrl: 'https://different.example.com/manifest.json' }] });
  const addon = await startAddonServer({ id: 'com.example.collide', name: 'Collide', version: '1.0.0', type: 'http', baseUrl: 'https://addon.example.com', capabilities: ['direct_stream'] });
  try {
    const e = await run('node', [CLI, 'test', addon.manifestUrl], {
      timeout: 120000,
      env: { ...process.env, DAD_REGISTRY_URL: reg.registryUrl },
    }).then(
      () => null,
      (err) => err
    );
    assert.ok(e);
    assert.match(e.stderr, /already registered/);
  } finally {
    await reg.closeAsync();
    await addon.closeAsync();
  }
});

test('dad test degrades to a warning when the registry is unreachable', async () => {
  const addon = await startAddonServer({ id: 'com.example.solo', name: 'Solo', version: '1.0.0', type: 'http', baseUrl: 'https://addon.example.com', capabilities: ['direct_stream'] });
  try {
    const { stdout } = await run('node', [CLI, 'test', addon.manifestUrl], {
      timeout: 120000,
      env: { ...process.env, DAD_REGISTRY_URL: 'http://127.0.0.1:1/registry.json' },
    });
    assert.match(stdout, /PASS/);
    assert.match(stdout, /Registry: \[warn\]/);
  } finally {
    await addon.closeAsync();
  }
});

test('dad dev refuses to serve a sealed id and exits non-zero', async () => {
  const reg = await startRegistry({ official: [], addons: [] });
  const tmpDir = await import('node:fs/promises').then((fs) =>
    fs.mkdtemp(fileURLToPath(new URL('../tmp-reg-dev-', import.meta.url)))
  );
  await import('node:fs/promises').then((fs) =>
    fs.writeFile(
      `${tmpDir}/manifest.json`,
      JSON.stringify({ id: 'org.delulu.squatter', name: 'X', version: '1.0.0', type: 'http', baseUrl: 'https://x.example.com', capabilities: ['direct_stream'] })
    )
  );
  try {
    const e = await run('node', [CLI, 'dev', tmpDir], {
      timeout: 120000,
      env: { ...process.env, DAD_REGISTRY_URL: reg.registryUrl },
    }).then(
      () => null,
      (err) => err
    );
    assert.ok(e, 'expected non-zero exit');
    assert.match(e.stderr, /reserved namespace/);
  } finally {
    await reg.closeAsync();
    await import('node:fs/promises').then((fs) => fs.rm(tmpDir, { recursive: true, force: true }));
  }
});
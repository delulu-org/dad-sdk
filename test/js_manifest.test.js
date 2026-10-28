import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest } from '../dist/index.js';

test('validates a compliant JS DAD Manifest', () => {
  const validJsManifest = {
    id: 'com.example.js-scraper',
    name: 'JS Scraper',
    version: '1.0.0',
    type: 'js',
    capabilities: ['direct_stream'],
    bundle: {
      url: 'https://cdn.example.com/addons/scraper/bundle.js',
      sha256: 'a'.repeat(64),
    },
  };

  const res = validateManifest(validJsManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('validates a JS manifest with apiKey gate', () => {
  const gatedJsManifest = {
    id: 'com.example.gated-scraper',
    name: 'Gated Scraper',
    version: '1.2.3',
    type: 'js',
    capabilities: ['direct_stream', 'torrent'],
    bundle: {
      url: 'https://cdn.example.com/addons/gated/bundle.js',
      sha256: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    },
    apiKey: {
      required: true,
      pageUrl: 'https://example.com/api-keys',
    },
  };

  const res = validateManifest(gatedJsManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('rejects JS manifest missing bundle object', () => {
  const invalid = {
    id: 'com.example.bad-js',
    name: 'Bad JS',
    version: '1.0.0',
    type: 'js',
    capabilities: ['direct_stream'],
  };

  const res = validateManifest(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("requires 'bundle' object")));
});

test('rejects JS manifest with non-HTTPS bundle url', () => {
  const invalid = {
    id: 'com.example.bad-js',
    name: 'Bad JS',
    version: '1.0.0',
    type: 'js',
    capabilities: ['direct_stream'],
    bundle: {
      url: 'http://insecure.example.com/bundle.js',
      sha256: 'a'.repeat(64),
    },
  };

  const res = validateManifest(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("'bundle.url' must be a valid HTTPS URL")));
});

test('rejects JS manifest with invalid sha256 (uppercase, wrong length, bad chars)', () => {
  const cases = [
    'A'.repeat(64), // uppercase
    'a'.repeat(63), // too short
    'a'.repeat(65), // too long
    'g'.repeat(64), // non-hex character
    'not-a-hash',
  ];

  for (const sha of cases) {
    const invalid = {
      id: 'com.example.bad-js',
      name: 'Bad JS',
      version: '1.0.0',
      type: 'js',
      capabilities: ['direct_stream'],
      bundle: {
        url: 'https://cdn.example.com/bundle.js',
        sha256: sha,
      },
    };

    const res = validateManifest(invalid);
    assert.equal(res.valid, false, `Expected failure for sha: ${sha}`);
    assert.ok(res.errors.some((e) => e.includes("'bundle.sha256' must be exactly 64 lowercase hexadecimal characters")));
  }
});

test('rejects JS manifest carrying baseUrl', () => {
  const invalid = {
    id: 'com.example.bad-js',
    name: 'Bad JS',
    version: '1.0.0',
    type: 'js',
    baseUrl: 'https://example.com',
    capabilities: ['direct_stream'],
    bundle: {
      url: 'https://cdn.example.com/bundle.js',
      sha256: 'a'.repeat(64),
    },
  };

  const res = validateManifest(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("JS addons do not use 'baseUrl'")));
});

test('rejects JS manifest carrying signing fields', () => {
  const invalid = {
    id: 'com.example.bad-js',
    name: 'Bad JS',
    version: '1.0.0',
    type: 'js',
    capabilities: ['direct_stream'],
    bundle: {
      url: 'https://cdn.example.com/bundle.js',
      sha256: 'a'.repeat(64),
    },
    signature: 'bad-sig',
    publicKeyId: 'delulu-key-1',
  };

  const res = validateManifest(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("JavaScript addons are sandboxed and NOT signed")));
});


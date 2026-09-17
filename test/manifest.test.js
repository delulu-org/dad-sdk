import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, isHttpManifest } from '../dist/index.js';

test('validates a compliant HTTP DAD Manifest (e.g. Cinemeta)', () => {
  const cinemetaHttpManifest = {
    id: 'com.stremio.cinemeta',
    name: 'Cinemeta',
    version: '1.0.0',
    type: 'http',
    capabilities: ['meta'],
    baseUrl: 'https://v3-cinemeta.strem.io/dad',
  };

  const res = validateManifest(cinemetaHttpManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
  assert.equal(isHttpManifest(cinemetaHttpManifest), true);
});

test('rejects manifest with invalid capability string', () => {
  const invalid = {
    id: 'bad-cap',
    name: 'Bad Cap',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://example.com',
    capabilities: ['invalid_cap'],
  };

  const res = validateManifest(invalid);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("Invalid capability 'invalid_cap'")));
});

test("rejects an unknown manifest type - DAD only supports HTTP addons", () => {
  const wrongType = {
    id: 'org.delulu.something',
    name: 'Something',
    version: '1.0.0',
    type: 'native',
    capabilities: ['meta'],
  };
  const res = validateManifest(wrongType);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("Must be 'http'")));
});

test('rejects a manifest with no type at all', () => {
  const noType = { id: 'x', name: 'X', version: '1.0.0', capabilities: ['meta'] };
  const res = validateManifest(noType);
  assert.equal(res.valid, false);
});

test('validates an http addon with an apiKey (OpenAI-style single key)', () => {
  const paidManifest = {
    id: 'com.delulu.premium',
    name: 'Premium Streams',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://premium.example.com/dad',
    capabilities: ['direct_stream'],
    apiKey: { required: true, pageUrl: 'https://premium.example.com/signup' },
  };
  const res = validateManifest(paidManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('rejects an http manifest whose baseUrl is not HTTPS or carries a query string', () => {
  const tooWeakUrl = {
    id: 'bad-url',
    name: 'Bad URL',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'http://addon.example.com',
    capabilities: ['meta'],
  };
  assert.equal(validateManifest(tooWeakUrl).valid, false);

  const queryCarried = {
    id: 'bad-url',
    name: 'Bad URL',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://addon.example.com?token=x',
    capabilities: ['meta'],
  };
  assert.equal(validateManifest(queryCarried).valid, false);
});

test('rejects http manifest with invalid apiKey (non-https pageUrl, bad types)', () => {
  const cases = [
    { apiKey: { required: true, pageUrl: 'http://premium.example.com/signup' } },   // not https
    { apiKey: { required: 'yes', pageUrl: 'https://premium.example.com/signup' } }, // required not boolean
    { apiKey: { required: true } },                                                  // missing pageUrl
  ];
  for (const apiKey of cases) {
    const m = {
      id: 'com.delulu.premium',
      name: 'Premium',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://premium.example.com/dad',
      capabilities: ['direct_stream'],
      apiKey,
    };
    assert.equal(validateManifest(m).valid, false, `expected rejection for ${JSON.stringify(apiKey)}`);
  }
});

test('rejects an HTTP addon carrying signature/publicKeyId - http addons are NOT signed', () => {
  const http = {
    id: 'com.example.http',
    name: 'HTTP Addon',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://addon.example.com',
    capabilities: ['meta'],
    publicKeyId: 'delulu-official-v1',
    signature: 'fake-signature',
  };
  const res = validateManifest(http);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('NOT signed')));
});

test('removed decoration fields (protocolVersion, minAppVersion) are no longer required', () => {
  const minimal = {
    id: 'com.example.minimal',
    name: 'Minimal',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://minimal.example.com',
    capabilities: ['meta'],
  };
  const res = validateManifest(minimal);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
  assert.ok(!minimal.protocolVersion, 'protocolVersion removed from the model');
});

test('rejects a manifest with a non-semver version (must be major.minor.patch)', () => {
  for (const version of ['2', '2.1', '2.1.0-beta', 'v2.1.0']) {
    const m = {
      id: 'com.example.bad-version',
      name: 'Bad Version',
      version,
      type: 'http',
      baseUrl: 'https://bad-version.example.com',
      capabilities: ['meta'],
    };
    const res = validateManifest(m);
    assert.equal(res.valid, false, `expected rejection for version '${version}'`);
    assert.ok(res.errors.some((e) => e.toLowerCase().includes('version')));
  }
});

test('rejects a manifest id that is not reverse-DNS - matches the format dad init enforces', () => {
  for (const id of ['not-reverse-dns', 'x', 'has spaces here', 'UPPER.CASE.ID']) {
    const m = {
      id,
      name: 'Bad Id',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://bad-id.example.com',
      capabilities: ['meta'],
    };
    const res = validateManifest(m);
    assert.equal(res.valid, false, `expected rejection for id '${id}'`);
    assert.ok(res.errors.some((e) => e.includes('reverse-DNS')));
  }
});

test('accepts well-formed reverse-DNS ids', () => {
  for (const id of ['org.delulu.meta-resolver', 'com.example.some-addon', 'io.github.user-name.my-addon']) {
    const m = {
      id,
      name: 'Good Id',
      version: '1.0.0',
      type: 'http',
      baseUrl: 'https://good-id.example.com',
      capabilities: ['meta'],
    };
    const res = validateManifest(m);
    assert.equal(res.valid, true, `expected '${id}' to be accepted: ${res.errors.join(', ')}`);
  }
});

test('manifest logo must be HTTPS if present - matches the catalog logo requirement', () => {
  const base = {
    id: 'org.example.logo-check',
    name: 'Logo Check',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://logo-check.example.com',
    capabilities: ['meta'],
  };
  assert.equal(validateManifest({ ...base, logo: 'http://example.com/logo.png' }).valid, false);
  assert.equal(validateManifest({ ...base, logo: 'not-a-url' }).valid, false);
  assert.equal(validateManifest({ ...base, logo: 'https://example.com/logo.png' }).valid, true);
  assert.equal(validateManifest(base).valid, true, 'logo is optional - omitting it is fine');
});

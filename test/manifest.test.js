import test from 'node:test';
import assert from 'node:assert/strict';
import { validateManifest, withDefaultLogo, DAD_DEFAULT_LOGO_URL } from '../dist/index.js';

test('validates a compliant HTTP DAD Manifest (e.g. Cinemeta)', () => {
  const cinemetaHttpManifest = {
    id: 'com.stremio.cinemeta',
    name: 'Cinemeta',
    version: '1.0.0',
    type: 'http',
    capabilities: ['meta'],
    baseUrl: 'https://v3-cinemeta.strem.io',
  };

  const res = validateManifest(cinemetaHttpManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('rejects manifest with invalid capability string', () => {
  const invalid = {
    id: 'com.example.bad-cap',
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

test('rejects a manifest listing the same capability twice', () => {
  const dup = {
    id: 'com.example.dup-caps',
    name: 'Dup Caps',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://example.com',
    capabilities: ['direct_stream', 'direct_stream'],
  };

  const res = validateManifest(dup);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("Duplicate capability 'direct_stream'")));
});

test("rejects an unknown manifest type - DAD only supports HTTP addons", () => {
  const wrongType = {
    id: 'com.example.something',
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
    baseUrl: 'https://premium.example.com',
    capabilities: ['direct_stream'],
    apiKey: { required: true, pageUrl: 'https://premium.example.com/signup' },
  };
  const res = validateManifest(paidManifest);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('rejects an http manifest whose baseUrl is not HTTPS, carries a query string, or has a path', () => {
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
  const queryRes = validateManifest(queryCarried);
  assert.equal(queryRes.valid, false);

  const pathCarried = {
    id: 'bad-url',
    name: 'Bad URL',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://addon.example.com/dad',
    capabilities: ['meta'],
  };
  const pathRes = validateManifest(pathCarried);
  assert.equal(pathRes.valid, false);
  assert.ok(pathRes.errors.some((e) => e.includes('no path')), 'error message mentions the path rule');
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
      baseUrl: 'https://premium.example.com',
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
  for (const id of ['com.example.meta-resolver', 'com.example.some-addon', 'io.github.user-name.my-addon']) {
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

test('manifest logo must be HTTPS if present', () => {
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

test('"no logo" means the same thing to validateManifest and withDefaultLogo', () => {
  // The two used to disagree: withDefaultLogo treated null / '' / whitespace as
  // "unset" and injected the DAD default, while validateManifest REJECTED '' and
  // whitespace - so a developer who wrote "logo": "" got a hard validation error
  // for the exact value the SDK would have happily defaulted.
  const base = {
    id: 'org.example.logo-unset',
    name: 'Logo Unset',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://logo-unset.example.com',
    capabilities: ['meta'],
  };
  const unsetForms = [undefined, null, '', '   '];

  for (const logo of unsetForms) {
    const manifest = { ...base, logo };
    const res = validateManifest(manifest);
    assert.equal(res.valid, true, `logo ${JSON.stringify(logo)} must be treated as unset: ${res.errors.join(', ')}`);
    assert.equal(
      withDefaultLogo(manifest).logo,
      DAD_DEFAULT_LOGO_URL,
      `logo ${JSON.stringify(logo)} must fall back to the DAD default`
    );
  }

  // A real value is left completely alone.
  assert.equal(withDefaultLogo({ ...base, logo: 'https://example.com/logo.png' }).logo, 'https://example.com/logo.png');
});

test('a non-string logo is rejected with exactly ONE clear error', () => {
  const base = {
    id: 'org.example.logo-type',
    name: 'Logo Type',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://logo-type.example.com',
    capabilities: ['meta'],
  };
  const res = validateManifest({ ...base, logo: 12345 });
  assert.equal(res.valid, false);
  assert.equal(res.errors.length, 1, `expected exactly 1 error, got: ${JSON.stringify(res.errors)}`);
});

test('seals the reserved names: org.delulu.* ids and the delulu publisher are rejected', () => {
  const base = {
    name: 'Imposter',
    version: '1.0.0',
    type: 'http',
    baseUrl: 'https://imposter.example.com',
    capabilities: ['meta'],
  };

  // Any id in the reserved namespace is rejected - the bare root, deeper names,
  // and case variants.
  for (const id of ['org.delulu.pd', 'org.delulu.a.b.c', 'org.delulu', 'ORG.DELULU.pd']) {
    const res = validateManifest({ ...base, id });
    assert.equal(res.valid, false, `expected reserved id '${id}' to be rejected`);
    assert.ok(
      res.errors.some((e) => e.includes('org.delulu') && e.includes('reserved')),
      `expected a reserved-namespace error for '${id}': ${res.errors.join(', ')}`
    );
  }

  // The reserved publisher is rejected on ANY id, case/whitespace-insensitive.
  for (const publisher of ['delulu', 'DELULU', '  delulu  ']) {
    const res = validateManifest({ ...base, id: 'com.example.ok', publisher });
    assert.equal(res.valid, false, `expected reserved publisher '${publisher}' to be rejected`);
    assert.ok(
      res.errors.some((e) => e.includes('reserved')),
      `expected a reserved-publisher error for '${publisher}': ${res.errors.join(', ')}`
    );
  }

  // A normal id and publisher is fine; so is a normal id with no publisher.
  const ok = validateManifest({ ...base, id: 'com.example.ok', publisher: 'Example Co.' });
  assert.equal(ok.valid, true, ok.errors.join(', '));
  assert.equal(validateManifest({ ...base, id: 'com.example.ok' }).valid, true);
});

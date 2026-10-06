import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCatalog, isOfficialId, OFFICIAL_ID_PREFIX, sealCatalog, TEAM_PUBLISHER } from '../dist/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const validEntry = {
  id: 'org.delulu.meta-resolver',
  name: 'MetaResolver',
  version: '2.1.0',
  type: 'http',
  manifestUrl: 'https://meta-resolver.example.com/manifest.json',
  description: 'Unified metadata resolver.',
};

test('validates a compliant catalog', () => {
  const catalog = {
    addons: [
      validEntry,
      {
        id: 'com.example.paid',
        name: 'Paid Addon',
        version: '1.0.0',
        type: 'http',
        manifestUrl: 'https://paid.example.com/dad/manifest.json',
        publisher: 'Example Co.',
        logo: 'https://example.com/logo.png',
      },
    ],
  };
  const res = validateCatalog(catalog);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('entries require manifestUrl - the row is a pointer, not a copy of the manifest', () => {
  const missing = validateCatalog({ addons: [{ ...validEntry, manifestUrl: undefined }] });
  assert.equal(missing.valid, false);
  assert.ok(missing.errors.some((e) => e.includes('manifestUrl')), missing.errors.join(', '));

  const insecure = validateCatalog({ addons: [{ ...validEntry, manifestUrl: 'http://x.example.com/manifest.json' }] });
  assert.equal(insecure.valid, false);

  const notAUrl = validateCatalog({ addons: [{ ...validEntry, manifestUrl: 'manifest.json' }] });
  assert.equal(notAUrl.valid, false);
});

test('manifestUrl may carry a query string (e.g. a CDN cache-buster)', () => {
  const res = validateCatalog({
    addons: [{ ...validEntry, manifestUrl: 'https://cdn.example.com/manifest.json?v=2' }],
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('baseUrl and apiKey are REJECTED - they live in the manifest, not the catalog', () => {
  const withBaseUrl = validateCatalog({
    addons: [{ ...validEntry, baseUrl: 'https://stale.example.com' }],
  });
  assert.equal(withBaseUrl.valid, false);
  const baseUrlError = withBaseUrl.errors.find((e) => e.includes('baseUrl'));
  assert.ok(baseUrlError, withBaseUrl.errors.join(', '));
  assert.ok(baseUrlError.includes('manifest.json'), `error should say where it moved: ${baseUrlError}`);

  const withApiKey = validateCatalog({
    addons: [{ ...validEntry, apiKey: { required: true, pageUrl: 'https://example.com/signup' } }],
  });
  assert.equal(withApiKey.valid, false);
  assert.ok(
    withApiKey.errors.some((e) => e.includes('apiKey') && e.includes('manifest.json')),
    withApiKey.errors.join(', ')
  );
});

test("rejects a type other than 'http'", () => {
  const native = validateCatalog({ addons: [{ ...validEntry, type: 'native' }] });
  assert.equal(native.valid, false);
  assert.ok(native.errors.some((e) => e.includes("must be 'http'")));

  const banana = validateCatalog({ addons: [{ ...validEntry, type: 'banana' }] });
  assert.equal(banana.valid, false);
});

test('rejects entries missing required fields or with an invalid version', () => {
  const bad = [
    { ...validEntry, name: '' },
    { ...validEntry, version: '2.1' },
    { ...validEntry, version: 'v2.1.0' },
  ];
  for (const entry of bad) {
    const res = validateCatalog({ addons: [entry] });
    assert.equal(res.valid, false, `expected rejection for ${JSON.stringify(entry)}`);
  }
});

test('requires the addons array', () => {
  assert.equal(validateCatalog({}).valid, false);
  assert.equal(validateCatalog({ addons: [] }).valid, true, 'an empty catalog is valid - no addons shipped yet');
  assert.equal(validateCatalog(null).valid, false);
});

test('an invalid logo produces exactly ONE clear error, not two', () => {
  const nonString = validateCatalog({ addons: [{ ...validEntry, logo: 12345 }] });
  assert.equal(nonString.valid, false);
  assert.equal(nonString.errors.length, 1, `expected exactly 1 error, got: ${JSON.stringify(nonString.errors)}`);
  assert.ok(nonString.errors[0].includes('logo must be an HTTPS URL'));

  const emptyString = validateCatalog({ addons: [{ ...validEntry, logo: '' }] });
  assert.equal(emptyString.valid, false);
  assert.equal(emptyString.errors.length, 1, `expected exactly 1 error, got: ${JSON.stringify(emptyString.errors)}`);
});

test('a logo URL may carry a query string (e.g. a CDN cache-buster)', () => {
  const res = validateCatalog({
    addons: [{ ...validEntry, logo: 'https://cdn.example.com/logo.png?v=2' }],
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

test('official status comes from the reserved id namespace, never a flag', () => {
  assert.equal(OFFICIAL_ID_PREFIX, 'org.delulu.');
  assert.equal(isOfficialId('org.delulu.meta-resolver'), true);
  assert.equal(isOfficialId('Org.Delulu.MetaResolver'), true);
  assert.equal(isOfficialId('ORG.DELULU.x'), true);
  assert.equal(isOfficialId('com.example.delulu'), false);
  assert.equal(isOfficialId('notorg.delulu.x'), false);
  assert.equal(isOfficialId('org.delulu'), false, 'the prefix includes the trailing dot');
});

test('the official catalog does not smuggle in an "official" flag', () => {
  const res = validateCatalog({ addons: [{ ...validEntry, official: true }] });
  assert.equal(res.valid, true, 'unknown display-only keys must not be validated as if they were contract');
  assert.equal(isOfficialId('org.delulu.meta-resolver'), true, 'the prefix, not the flag, is what counts');
});

// ---------------------------------------------------------------------------
// Namespace seal (sealCatalog)
// ---------------------------------------------------------------------------

const teamEntry = {
  id: 'org.delulu.pd',
  name: 'Public Domain',
  version: '1.0.0',
  type: 'http',
  publisher: 'delulu',
  manifestUrl: 'https://pd.example.com/manifest.json',
};

test('the reserved namespace and the team publisher must agree, in both directions', () => {
  const cases = [
    [{ ...teamEntry }, true, 'namespace + team publisher agree'],
    [{ ...teamEntry, id: 'ORG.DELULU.pd', publisher: 'DELULU' }, true, 'case-insensitive on both sides'],
    [{ ...teamEntry, publisher: undefined }, false, 'reserved id with no publisher'],
    [{ ...teamEntry, publisher: 'someone-else' }, false, 'reserved id, foreign publisher'],
    [{ ...teamEntry, id: 'com.evil.pd' }, false, 'team publisher on a non-team id'],
    [{ ...teamEntry, id: 'com.evil.pd', publisher: 'Example Co.' }, true, 'foreign id + foreign publisher'],
  ];
  for (const [entry, expected, label] of cases) {
    const res = sealCatalog({ addons: [entry] });
    assert.equal(res.valid, expected, `${label}: ${res.errors.join(' | ')}`);
  }

  assert.equal(TEAM_PUBLISHER, 'delulu');
});

test('changing an addon host is never blocked - Cloudflare Workers move constantly', () => {
  const moves = [
    'https://pd-addon.org-delulu.workers.dev/manifest.json', // worker renamed
    'https://pd.delulu.org/manifest.json', // custom domain attached
    'https://pd-v2.org-delulu.workers.dev/manifest.json', // moved back
    'https://pd.delulu-addons.dev/manifest.json', // different zone
    'https://pd.example.com/dad/v2/manifest.json', // new path, same host
  ];
  for (const manifestUrl of moves) {
    const res = sealCatalog({ addons: [{ ...teamEntry, manifestUrl }] });
    assert.equal(res.valid, true, `${manifestUrl} must be allowed: ${res.errors.join(' | ')}`);
  }
});

test('structural errors short-circuit the seal', () => {
  const broken = sealCatalog({ addons: [{ id: 'org.delulu.x' }] });
  assert.equal(broken.valid, false);
  assert.ok(broken.errors[0].includes('name'), broken.errors.join(' | '));
});

test('the published file itself passes its own seal', () => {
  const real = JSON.parse(
    readFileSync(path.resolve(__dirname, '..', '..', 'http_addon_catalog.json'), 'utf-8')
  );
  const res = sealCatalog(real);
  assert.equal(res.valid, true, res.errors.join(' | '));
});


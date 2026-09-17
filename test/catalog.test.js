import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog } from '../dist/index.js';

const validEntry = {
  id: 'org.delulu.meta-resolver',
  name: 'MetaResolver',
  version: '2.1.0',
  type: 'http',
  baseUrl: 'https://meta-resolver.example.com/dad',
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
        baseUrl: 'https://paid.example.com/dad',
        publisher: 'Example Co.',
        logo: 'https://example.com/logo.png',
        apiKey: { required: true, pageUrl: 'https://example.com/signup' },
      },
    ],
  };
  const res = validateCatalog(catalog);
  assert.equal(res.valid, true, `Validation failed: ${res.errors.join(', ')}`);
});

test('http entries require baseUrl', () => {
  const noBaseUrl = validateCatalog({ addons: [{ ...validEntry, baseUrl: undefined }] });
  assert.equal(noBaseUrl.valid, false);

  const insecureBaseUrl = validateCatalog({ addons: [{ ...validEntry, baseUrl: 'http://x.example.com' }] });
  assert.equal(insecureBaseUrl.valid, false);

  const queryCarried = validateCatalog({ addons: [{ ...validEntry, baseUrl: 'https://x.example.com?token=abc' }] });
  assert.equal(queryCarried.valid, false);
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

test('rejects duplicated addon ids', () => {
  const res = validateCatalog({ addons: [validEntry, { ...validEntry, id: 'org.delulu.meta-resolver' }] });
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('duplicated')));
});

test('apiKey gate: pageUrl must be HTTPS, required must be boolean', () => {
  const httpWithHttpPage = validateCatalog({
    addons: [{ ...validEntry, apiKey: { required: true, pageUrl: 'http://example.com/signup' } }],
  });
  assert.equal(httpWithHttpPage.valid, false);

  const malformedApiKey = validateCatalog({
    addons: [{ ...validEntry, apiKey: { required: 'yes', pageUrl: 'https://example.com/signup' } }],
  });
  assert.equal(malformedApiKey.valid, false);
});

test('requires the addons array', () => {
  assert.equal(validateCatalog({}).valid, false);
  assert.equal(validateCatalog({ addons: [] }).valid, true, 'an empty catalog is valid - no addons shipped yet');
  assert.equal(validateCatalog(null).valid, false);
});

test('an invalid logo produces exactly ONE clear error, not two', () => {
  // Regression test: logo used to be checked both by the generic
  // "is this a non-empty string" loop AND the dedicated isHttpsUrl check,
  // so a non-string logo (e.g. a number) failed BOTH checks and produced
  // two confusing, overlapping error messages for one bad field.
  const nonString = validateCatalog({ addons: [{ ...validEntry, logo: 12345 }] });
  assert.equal(nonString.valid, false);
  assert.equal(nonString.errors.length, 1, `expected exactly 1 error, got: ${JSON.stringify(nonString.errors)}`);
  assert.ok(nonString.errors[0].includes('logo must be an HTTPS URL'));

  const emptyString = validateCatalog({ addons: [{ ...validEntry, logo: '' }] });
  assert.equal(emptyString.valid, false);
  assert.equal(emptyString.errors.length, 1, `expected exactly 1 error, got: ${JSON.stringify(emptyString.errors)}`);
});

test('a logo URL may carry a query string (e.g. a CDN cache-buster) - only baseUrl is bare', () => {
  const res = validateCatalog({
    addons: [{ ...validEntry, logo: 'https://cdn.example.com/logo.png?v=2' }],
  });
  assert.equal(res.valid, true, res.errors.join(', '));
});

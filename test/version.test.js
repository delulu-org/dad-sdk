import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVersion, VERSION_RE } from '../dist/index.js';

test('isValidVersion accepts strict major.minor.patch only', () => {
  assert.equal(isValidVersion('1.0.0'), true);
  assert.equal(isValidVersion('2.1.0'), true);
  assert.equal(isValidVersion('0.0.1'), true);
  assert.equal(isValidVersion('2'), false);
  assert.equal(isValidVersion('2.1'), false);
  assert.equal(isValidVersion('2.1.0-beta'), false);
  assert.equal(isValidVersion('v2.1.0'), false);
  assert.equal(isValidVersion('2.a.0'), false);
  assert.equal(isValidVersion(''), false);
});

test('isValidVersion rejects leading zeros on any segment - strict semver forbids them', () => {
  // Strict semver forbids leading zeros on every segment.
  for (const version of ['01.2.0', '1.02.0', '1.2.00', '00.0.0']) {
    assert.equal(isValidVersion(version), false, `expected '${version}' to be rejected (leading zero)`);
  }
});

test('isValidVersion still accepts a bare 0 segment and multi-digit segments', () => {
  for (const version of ['0.0.0', '1.0.0', '10.20.30', '999.999.999']) {
    assert.equal(isValidVersion(version), true, `expected '${version}' to be accepted`);
  }
});

test('VERSION_RE is anchored - a valid version cannot hide inside a longer string', () => {
  // Without ^...$ anchoring, '1.0.0-beta' or 'x1.0.0' could match a substring
  // and be reported as a valid version.
  assert.equal(VERSION_RE.test('1.0.0-beta'), false);
  assert.equal(VERSION_RE.test('prefix-1.0.0'), false);
  assert.equal(VERSION_RE.test('1.0.0-suffix'), false);
  assert.equal(VERSION_RE.test('\n1.0.0'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidVersion, compareVersions, isVersionBump } from '../dist/index.js';

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

test('compareVersions is a strict numeric semver comparison', () => {
  assert.equal(compareVersions('2.1.0', '2.1.0'), 0);
  assert.equal(compareVersions('2.1.0', '2.0.0'), 1);
  assert.equal(compareVersions('2.1.0', '2.1.1'), -1);
  assert.equal(compareVersions('2.10.0', '2.9.0'), 1, 'build numbers compare numerically, not lexically');
  assert.equal(compareVersions('3.0.0', '2.99.99'), 1, 'major wins over counting minor patches');
});

test('isVersionBump: first publish is always allowed (nothing to bump against)', () => {
  assert.equal(isVersionBump('1.0.0', null), true);
  assert.equal(isVersionBump('1.0.0', undefined), true);
});

test('isVersionBump: an update REQUIRES a strict version increase', () => {
  assert.equal(isVersionBump('2.1.1', '2.1.0'), true);
  assert.equal(isVersionBump('3.0.0', '2.1.0'), true);
  // Equal or lower must be rejected - a forgotten bump fails the publish
  assert.equal(isVersionBump('2.1.0', '2.1.0'), false);
  assert.equal(isVersionBump('2.0.0', '2.1.0'), false);
  assert.equal(isVersionBump('1.9.9', '2.1.0'), false);
});

test('isVersionBump throws on malformed versions instead of passing silently', () => {
  assert.throws(() => isVersionBump('2', '2.1.0'), /must be 'major\.minor\.patch'/);
  assert.throws(() => isVersionBump('2.1.0', '2'), /Invalid previous published version/);
});

test('isValidVersion rejects leading zeros on any segment - strict semver forbids them', () => {
  // Regression test: the doc comment on VERSION_RE explicitly claims "STRICT
  // semantic major.minor.patch", but the original regex (\d+\.\d+\.\d+) had
  // no leading-zero guard, so '01.2.0' passed when real semver forbids it.
  for (const version of ['01.2.0', '1.02.0', '1.2.00', '00.0.0']) {
    assert.equal(isValidVersion(version), false, `expected '${version}' to be rejected (leading zero)`);
  }
});

test('isValidVersion still accepts a bare 0 segment and multi-digit segments', () => {
  for (const version of ['0.0.0', '1.0.0', '10.20.30', '999.999.999']) {
    assert.equal(isValidVersion(version), true, `expected '${version}' to be accepted`);
  }
});

test('compareVersions compares segments NUMERICALLY, not lexicographically (1.10.0 > 1.9.0)', () => {
  // A hand-rolled string-split comparator is a classic place to accidentally
  // compare "10" < "9" lexicographically. Confirms this one doesn't.
  assert.equal(compareVersions('1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('2.0.0', '10.0.0'), -1);
});
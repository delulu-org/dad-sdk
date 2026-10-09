import test from 'node:test';
import assert from 'node:assert/strict';
import { validateHealthPong } from '../dist/index.js';

test('health: accepts contract-valid 4-field pong payload', () => {
  const good = {
    ok: true,
    addon_id: 'dev.fearless.rosseta',
    name: 'Rosseta',
    version: '0.1.0',
  };
  const result = validateHealthPong(good);
  assert.equal(result.valid, true, result.errors.join(', '));
});

test('health: rejects non-object or null payloads', () => {
  assert.equal(validateHealthPong(null).valid, false);
  assert.equal(validateHealthPong(undefined).valid, false);
  assert.equal(validateHealthPong('ok').valid, false);
  assert.equal(validateHealthPong([]).valid, false);
});

test('health: rejects unknown fields (strict 4 fields contract)', () => {
  const withProtocol = {
    ok: true,
    addon_id: 'dev.fearless.rosseta',
    name: 'Rosseta',
    version: '0.1.0',
    protocol_version: '2.0',
  };
  const res = validateHealthPong(withProtocol);
  assert.equal(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes("Unknown field in health pong: 'protocol_version'")));
});

test('health: rejects ok: false or non-boolean ok', () => {
  assert.equal(
    validateHealthPong({ ok: false, addon_id: 'a.b', name: 'N', version: '1.0.0' }).valid,
    false
  );
  assert.equal(
    validateHealthPong({ ok: 'true', addon_id: 'a.b', name: 'N', version: '1.0.0' }).valid,
    false
  );
});

test('health: rejects empty or missing required fields', () => {
  const missingId = { ok: true, name: 'N', version: '1.0.0' };
  assert.equal(validateHealthPong(missingId).valid, false);

  const emptyId = { ok: true, addon_id: '   ', name: 'N', version: '1.0.0' };
  assert.equal(validateHealthPong(emptyId).valid, false);

  const missingName = { ok: true, addon_id: 'a.b', version: '1.0.0' };
  assert.equal(validateHealthPong(missingName).valid, false);

  const missingVersion = { ok: true, addon_id: 'a.b', name: 'N' };
  assert.equal(validateHealthPong(missingVersion).valid, false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runInit } from '../dist/cli/init.js';
import { runBundle } from '../dist/cli/bundle.js';
import { testJsAddon } from '../dist/cli/probe_js.js';
import { DAD_TEST_FIXTURES } from '../dist/index.js';

test('dad init --type js scaffolds a valid JS addon and builds with dad bundle', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-init-js-test-'));
  try {
    const targetDir = path.join(tmpDir, 'my-js-scraper');

    // 1. Scaffold JS addon
    await runInit(targetDir, {
      id: 'com.example.my-scraper',
      name: 'My Scraper',
      type: 'js',
    });

    assert.ok(fs.existsSync(path.join(targetDir, 'manifest.json')));
    assert.ok(fs.existsSync(path.join(targetDir, 'src', 'index.ts')));

    const manifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf-8'));
    assert.equal(manifest.type, 'js');
    assert.equal(manifest.id, 'com.example.my-scraper');
    assert.ok(manifest.bundle, 'manifest must have bundle object');

    // 2. Bundle the scaffolded addon
    // Note: To compile against our local SDK build in tests, we adjust the import
    const indexPath = path.join(targetDir, 'src', 'index.ts');
    let code = fs.readFileSync(indexPath, 'utf-8');
    code = code.replace('@delulu-addon/dad-sdk', path.resolve('dist/index.js').replace(/\\/g, '/'));
    fs.writeFileSync(indexPath, code, 'utf-8');

    const outBundle = path.join(targetDir, 'dist', 'bundle.js');
    const bundleRes = await runBundle(indexPath, {
      out: outBundle,
      manifest: path.join(targetDir, 'manifest.json'),
    });

    assert.ok(fs.existsSync(outBundle), 'Compiled bundle.js must exist');
    assert.ok(bundleRes.sha256.length === 64, 'Computed SHA-256 must be 64 characters');

    // Check that manifest was updated with sha256
    const updatedManifest = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf-8'));
    assert.equal(updatedManifest.bundle.sha256, bundleRes.sha256);

    // 3. Run testJsAddon against the compiled bundle
    const bundleContent = fs.readFileSync(outBundle, 'utf-8');
    const outcome = await testJsAddon(updatedManifest, bundleContent, DAD_TEST_FIXTURES);

    assert.equal(outcome.producedData, true, 'Scaffolded addon must return stream data');
    const failedProbes = outcome.results.filter((r) => r.status === 'fail');
    assert.equal(failedProbes.length, 0, `All probes must pass, failed: ${failedProbes.map(p => p.detail).join('; ')}`);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

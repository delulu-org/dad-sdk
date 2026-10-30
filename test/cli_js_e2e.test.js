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

test('testJsAddon provides .details(), next(), prev() and CryptoJS in sandbox environment', async () => {
  const manifest = {
    id: 'com.example.sandbox-test',
    name: 'Sandbox Test',
    version: '1.0.0',
    type: 'js',
    bundle: { url: 'https://example.com/bundle.js', sha256: '0'.repeat(64) },
    capabilities: ['direct_stream'],
  };

  const bundleCode = `
    exports.getStreams = async function(req) {
      const html = '<div class="items"><p class="p1">Item 1</p><p class="p2">Item 2</p></div>';
      const $ = cheerio.load(html);
      
      // Test .details() bulk extraction
      const details = $('p').details();
      if (!Array.isArray(details) || details.length !== 2) {
        throw new Error("details() must return 2 items, got " + JSON.stringify(details));
      }
      if (details[0].text !== 'Item 1' || details[0].attrs.class !== 'p1') {
        throw new Error("Invalid details[0]: " + JSON.stringify(details[0]));
      }

      // Test $.details static
      const staticDetails = $.details('p');
      if (staticDetails.length !== 2) {
        throw new Error("$.details() failed");
      }

      // Test next() and prev()
      const p1 = $('p.p1');
      const p2 = p1.next();
      if (p2.text() !== 'Item 2') {
        throw new Error("next() failed: " + p2.text());
      }
      if (p2.prev().text() !== 'Item 1') {
        throw new Error("prev() failed");
      }

      // Test CryptoJS
      const sha256 = CryptoJS.SHA256('hello').toString(CryptoJS.enc.Hex);
      const sha512 = CryptoJS.SHA512('hello').toString(CryptoJS.enc.Hex);
      const hmac = CryptoJS.HmacMD5('hello', 'key').toString(CryptoJS.enc.Hex);

      if (!sha256 || !sha512 || !hmac) {
        throw new Error("CryptoJS hash operations failed");
      }

      return [
        {
          type: 'direct',
          title: 'Validated Stream',
          stream_url: 'https://example.com/video.mp4',
          audio_languages: ['eng'],
        }
      ];
    };
  `;

  const outcome = await testJsAddon(manifest, bundleCode, [DAD_TEST_FIXTURES[0]]);
  assert.equal(outcome.producedData, true, 'Addon with details() and CryptoJS must return stream data');
  const failedProbes = outcome.results.filter((r) => r.status === 'fail');
  assert.equal(failedProbes.length, 0, `All probes must pass, failed: ${failedProbes.map(p => p.detail).join('; ')}`);
});


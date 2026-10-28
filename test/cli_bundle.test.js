import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { runBundle } from '../dist/cli/bundle.js';

test('dad bundle compiles TypeScript addon, externalizes cheerio, and calculates sha256', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dad-bundle-test-'));
  try {
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    // 1. Create manifest.json
    const manifestPath = path.join(tmpDir, 'manifest.json');
    const initialManifest = {
      id: 'com.example.test-bundle',
      name: 'Test Bundle',
      version: '1.0.0',
      type: 'js',
      capabilities: ['direct_stream'],
      bundle: {
        url: 'https://cdn.example.com/bundle.js',
        sha256: '0'.repeat(64),
      },
    };
    fs.writeFileSync(manifestPath, JSON.stringify(initialManifest, null, 2), 'utf-8');

    // 2. Create helper module to verify multi-file inlining
    fs.writeFileSync(
      path.join(srcDir, 'helper.ts'),
      `export function getTestUrl(): string { return 'https://example.com/stream.mp4'; }`,
      'utf-8'
    );

    // 3. Create entry TypeScript file importing helper and cheerio
    const entryPath = path.join(srcDir, 'index.ts');
    fs.writeFileSync(
      entryPath,
      `import { defineJsAddon } from '${path.resolve('dist/index.js').replace(/\\/g, '/')}';
       import { getTestUrl } from './helper.js';

       export default defineJsAddon({
         manifest: {
           id: 'com.example.test-bundle',
           name: 'Test Bundle',
           version: '1.0.0',
           type: 'js',
           capabilities: ['direct_stream'],
           bundle: {
             url: 'https://cdn.example.com/bundle.js',
             sha256: '${'0'.repeat(64)}',
           },
         },
         getStreams: async (req) => {
           // Verify cheerio syntax works
           const $ = cheerio.load('<html><body><a href="test">Stream</a></body></html>');
           const text = $('a').text();
           return [{
             type: 'direct',
             title: text,
             stream_url: getTestUrl(),
             audio_languages: ['eng'],
           }];
         },
       });`,
      'utf-8'
    );

    const outPath = path.join(tmpDir, 'dist', 'bundle.js');
    const result = await runBundle(entryPath, {
      out: outPath,
      manifest: manifestPath,
    });

    // Check bundle exists
    assert.ok(fs.existsSync(outPath), 'Output bundle.js must exist');
    const content = fs.readFileSync(outPath, 'utf-8');

    // Inlined helper must be present
    assert.ok(content.includes('https://example.com/stream.mp4'), 'Helper code must be inlined');

    // Cheerio must NOT be bundled as a massive tree (it is external)
    assert.ok(result.sizeBytes < 50 * 1024, `Bundle size must be < 50KB, was ${result.sizeBytes} bytes`);

    // SHA-256 calculation must be bit-exact
    const expectedSha = crypto.createHash('sha256').update(fs.readFileSync(outPath)).digest('hex');
    assert.equal(result.sha256, expectedSha);

    // manifest.json must be updated with the computed sha256
    const updatedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    assert.equal(updatedManifest.bundle.sha256, expectedSha);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { defineJsAddon, defineAddon } from '../dist/index.js';

test('defineJsAddon: defines a valid direct_stream JS addon', () => {
  const def = defineJsAddon({
    manifest: {
      id: 'com.example.stream-addon',
      name: 'Stream Addon',
      version: '1.0.0',
      type: 'js',
      capabilities: ['direct_stream'],
      bundle: {
        url: 'https://cdn.example.com/bundle.js',
        sha256: '0'.repeat(64),
      },
    },
    getStreams: async () => [],
  });

  assert.equal(def.manifest.id, 'com.example.stream-addon');
  assert.equal(typeof def.getStreams, 'function');
  assert.ok(def.manifest.logo, 'default logo injected when omitted');
});

test('defineJsAddon: throws when capability declared but handler missing', () => {
  assert.throws(
    () => {
      defineJsAddon({
        manifest: {
          id: 'com.example.missing-handler',
          name: 'Missing Handler',
          version: '1.0.0',
          type: 'js',
          capabilities: ['direct_stream'],
          bundle: {
            url: 'https://cdn.example.com/bundle.js',
            sha256: '0'.repeat(64),
          },
        },
      });
    },
    {
      name: 'TypeError',
      message: /declares capability 'direct_stream' but does not implement handler 'getStreams'/,
    }
  );
});

test('defineJsAddon: throws when handler implemented but capability omitted', () => {
  assert.throws(
    () => {
      defineJsAddon({
        manifest: {
          id: 'com.example.unmapped-handler',
          name: 'Unmapped Handler',
          version: '1.0.0',
          type: 'js',
          capabilities: ['meta'],
          bundle: {
            url: 'https://cdn.example.com/bundle.js',
            sha256: '0'.repeat(64),
          },
        },
        getMeta: async () => null,
        getStreams: async () => [],
      });
    },
    {
      name: 'TypeError',
      message: /implements handler 'getStreams' but does not declare the matching capability/,
    }
  );
});

test('defineAddon: correctly delegates to defineJsAddon for type: "js"', () => {
  const def = defineAddon({
    manifest: {
      id: 'com.example.unified-js',
      name: 'Unified JS',
      version: '1.0.0',
      type: 'js',
      capabilities: ['torrent'],
      bundle: {
        url: 'https://cdn.example.com/bundle.js',
        sha256: '1'.repeat(64),
      },
    },
    getStreams: async () => [],
  });

  assert.equal(def.manifest.type, 'js');
  assert.equal(typeof def.getStreams, 'function');
});

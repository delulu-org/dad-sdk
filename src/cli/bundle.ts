import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Plugin } from 'esbuild';
import { validateManifest } from '../manifest.js';

export interface BundleOptions {
  out?: string;
  manifest?: string;
  minify?: boolean;
}

export interface BundleResult {
  entryFile: string;
  outFile: string;
  sha256: string;
  sizeBytes: number;
}

async function loadEsbuild(): Promise<any> {
  try {
    const mod = await import('esbuild');
    return mod.default || mod;
  } catch {
    console.error(`\n✖ 'esbuild' is required to bundle JavaScript addons.`);
    console.error(`  Please install it as a devDependency in your addon project:`);
    console.error(`    npm install -D esbuild\n`);
    process.exit(1);
    throw new Error('esbuild is not installed');
  }
}

const FORBIDDEN_MODULES = new Set([
  'fs',
  'node:fs',
  'net',
  'node:net',
  'tls',
  'node:tls',
  'child_process',
  'node:child_process',
  'worker_threads',
  'node:worker_threads',
  'cluster',
  'node:cluster',
  'os',
  'node:os',
  'dgram',
  'node:dgram',
  'dns',
  'node:dns',
  'http',
  'node:http',
  'https',
  'node:https',
]);

/**
 * Esbuild plugin that intercepts forbidden Node.js modules and throws a helpful
 * error explaining the sandbox constraints.
 */
function createSandboxShieldPlugin(): Plugin {
  return {
    name: 'dad-sandbox-shield',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        if (FORBIDDEN_MODULES.has(args.path)) {
          return {
            errors: [
              {
                text:
                  `Cannot import Node native module '${args.path}'. Delulu JS addons execute inside an isolated ` +
                  `QuickJS sandbox with zero OS/network access. Use global 'fetch()' for network requests ` +
                  `and 'cheerio' / 'CryptoJS' for parsing and cryptography.`,
              },
            ],
          };
        }
        return undefined;
      });
    },
  };
}

/**
 * Bundles a JavaScript/TypeScript addon into a single monolithic bundle.js file,
 * verifies sandbox safety, calculates the SHA-256 checksum, and syncs manifest.json.
 */
export async function runBundle(entryArg?: string, options: BundleOptions = {}): Promise<BundleResult> {
  const cwd = process.cwd();

  // 1. Resolve entry file
  let entryFile = entryArg ? path.resolve(cwd, entryArg) : undefined;
  if (!entryFile) {
    const candidates = [
      path.join(cwd, 'src', 'index.ts'),
      path.join(cwd, 'src', 'index.js'),
      path.join(cwd, 'index.ts'),
      path.join(cwd, 'index.js'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) {
        entryFile = c;
        break;
      }
    }
  }

  if (!entryFile || !fs.existsSync(entryFile)) {
    console.error(` Error: Entry file not found. Looked for: src/index.ts, src/index.js, index.ts, index.js`);
    console.error(` Usage: dad bundle [entry-file] [--out <output-path>] [--manifest <manifest-path>] [--minify]`);
    process.exit(1);
    throw new Error('Entry file not found');
  }

  // 2. Resolve output file
  const outFile = options.out ? path.resolve(cwd, options.out) : path.join(cwd, 'dist', 'bundle.js');
  const outDir = path.dirname(outFile);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 3. Resolve manifest file
  const manifestPath = options.manifest
    ? path.resolve(cwd, options.manifest)
    : path.join(path.dirname(entryFile), 'manifest.json');
  const fallbackManifestPath = path.join(cwd, 'manifest.json');
  const actualManifestPath = fs.existsSync(manifestPath)
    ? manifestPath
    : fs.existsSync(fallbackManifestPath)
      ? fallbackManifestPath
      : null;

  console.log(`\n Bundling ${path.relative(cwd, entryFile)} -> ${path.relative(cwd, outFile)}...`);

  // 4. Execute esbuild
  const esbuild = await loadEsbuild();
  try {
    await esbuild.build({
      entryPoints: [entryFile],
      bundle: true,
      outfile: outFile,
      format: 'cjs',
      target: 'es2020',
      minify: Boolean(options.minify),
      platform: 'neutral',
      external: [
        'cheerio',
        'cheerio-without-node-native',
        'react-native-cheerio',
        'crypto-js',
      ],
      plugins: [createSandboxShieldPlugin()],
      banner: {
        js:
          `// DAD Sandboxed JavaScript Addon Bundle - Compiled by @delulu-addon/dad-sdk\n` +
          `var module = (typeof module !== 'undefined') ? module : { exports: {} };\n` +
          `var exports = (typeof exports !== 'undefined') ? exports : module.exports;\n`,
      },
    });
  } catch (err: any) {
    console.error(`\n✖ Bundling failed:\n${err.message || err}`);
    process.exit(1);
  }

  // 5. Read output bundle and compute SHA-256
  const bundleBytes = fs.readFileSync(outFile);
  const sha256 = crypto.createHash('sha256').update(bundleBytes).digest('hex');
  const sizeKb = (bundleBytes.length / 1024).toFixed(2);

  console.log(`✔ Bundle compiled successfully!`);
  console.log(`  Artifact: ${path.relative(cwd, outFile)} (${sizeKb} KB)`);
  console.log(`  SHA-256:  ${sha256}`);

  // 6. Sync SHA-256 with manifest.json
  if (actualManifestPath && fs.existsSync(actualManifestPath)) {
    try {
      const rawText = fs.readFileSync(actualManifestPath, 'utf-8');
      const manifest = JSON.parse(rawText);
      if (manifest.type === 'js') {
        if (!manifest.bundle || typeof manifest.bundle !== 'object') {
          manifest.bundle = { url: '', sha256: '' };
        }
        manifest.bundle.sha256 = sha256;
        fs.writeFileSync(actualManifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
        console.log(`✔ Synced SHA-256 with ${path.relative(cwd, actualManifestPath)}`);

        // Validate manifest
        const check = validateManifest(manifest);
        if (!check.valid) {
          console.warn(`  Warning: Manifest has pending validation items:`);
          for (const e of check.errors) {
            console.warn(`    - ${e}`);
          }
        }
      }
    } catch (err: any) {
      console.warn(`  Warning: Failed to update manifest.json: ${err.message}`);
    }
  } else {
    console.log(`ℹ No manifest.json found in project to auto-update bundle.sha256.`);
  }

  return {
    entryFile,
    outFile,
    sha256,
    sizeBytes: bundleBytes.length,
  };
}


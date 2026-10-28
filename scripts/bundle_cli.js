import esbuild from 'esbuild';
import { builtinModules } from 'node:module';

console.log('Bundling standalone probe_js (inlining cheerio & crypto-js)...');

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`),
];

await esbuild.build({
  entryPoints: ['./src/cli/probe_js.ts'],
  outfile: './dist/cli/probe_js.js',
  bundle: true,
  minify: true,
  format: 'esm',
  platform: 'node',
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  external: [
    ...nodeBuiltins,
    '../manifest.js',
    '../responses.js',
    '../fixtures.js',
    '../errors.js',
    '../validation.js',
    '../version.js',
  ],
});

console.log('✔ Standalone probe_js.js bundled successfully.');

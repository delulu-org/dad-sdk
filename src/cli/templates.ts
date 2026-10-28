/**
 * Scaffolding templates used by `dad init`. Kept as in-code strings (rather
 * than loose files on disk) so they always ship correctly inside the
 * published npm package regardless of install location.
 *
 * This public SDK only scaffolds HTTP addons.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * The SDK's own package version, read from the published package.json (npm
 * always ships it at the package root next to dist/). Injected into every
 * scaffold so generated addons pin the major line they were generated from,
 * instead of a hardcoded version that drifts from the SDK itself.
 */
const SDK_VERSION: string = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf-8')
).version;

export interface TemplateFile {
  path: string; // relative to the new addon dir
  content: string;
}

function pkgJson(addonName: string): string {
  return `{
  "name": "${addonName}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "dad dev",
    "validate": "dad validate"
  },
  "dependencies": {
    "@delulu-addon/dad-sdk": "^${SDK_VERSION}"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
`;
}

const tsconfigJson = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
`;

const gitignore = `node_modules/
dist/
.env
.env.*
*.enc.zip
*.manifest.json
`;

/**
 * HTTP addon starter - a remote-server addon, run with \`dad dev\` (real HTTP
 * server on localhost) and deployed anywhere that runs Node/Bun/Deno/Workers.
 */
export function httpAddonTemplate(id: string, name: string): TemplateFile[] {
  return [
    {
      path: 'package.json',
      content: pkgJson(name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')),
    },
    { path: 'tsconfig.json', content: tsconfigJson },
    { path: '.gitignore', content: gitignore },
    {
      path: 'manifest.json',
      content: `{
  "id": "${id}",
  "name": "${name}",
  "version": "1.0.0",
  "type": "http",
  "description": "TODO: one-line description of what this addon provides",
  "publisher": "TODO: your name or org",
  "baseUrl": "https://your-addon-domain.example.com",
  "capabilities": ["direct_stream"]
}
`,
    },
    {
      path: 'src/index.ts',
      content: `import { defineHttpAddon, createHttpAddonHandler, DadError } from '@delulu-addon/dad-sdk';
import manifest from '../manifest.json' with { type: 'json' };

/**
 * ${name}
 *
 * This addon runs as a live HTTPS server you deploy and control - Cloudflare
 * Workers, Node, Bun, Deno, Fastify, Next.js route handlers, anything that
 * speaks the Web-standard Request/Response.
 *
 * Run it locally against real request shapes with:
 *   npx dad dev
 */
export const addon = defineHttpAddon({
  manifest: manifest as any,

  // Called for GET /streams/{movie|tv}/{tmdb_id}[/{season}[/{episode}]]
  async getStreams(req) {
    // req: { tmdb_id, media_type, s?, e?, auth? }
    //
    // 'auth' is the raw API key from 'Authorization: Bearer <key>' when the
    // client is holding one for this addon (see manifest.json 'apiKey').
    // Decide what that key unlocks yourself - free tier, paid tier, rate
    // limits, whatever your backend wants.

    // Report failures in the shared DAD error model - the SDK serializes a
    // thrown DadError into the exact { error, error_message } contract:
    //
    //   if (req.auth !== 'my-key') {
    //     throw new DadError('unauthorized', 'Missing or invalid API key');
    //   }
    //   if (upstreamIsDown) {
    //     throw new DadError('upstream_unreachable', 'Scraper timed out');
    //   }
    //   if (weHaveNothing) {
    //     throw new DadError('content_unavailable', 'No streams for this title');
    //   }

    return [
      {
        type: 'direct',
        title: 'Example 1080p Stream',
        stream_url: 'https://example.com/sample-1080p.mp4',
        audio_languages: [],
        media_format: 'mp4',
        resolution: '1080p',
      },
      // A stream that needs header injection to play (CORS-blocked CDN,
      // signed mirror, etc.) MUST set needs_proxy + non-empty headers:
      // {
      //   type: 'direct',
      //   title: 'Proxied Example',
      //   stream_url: 'https://provider-a.example.com/stream.m3u8',
      //   needs_proxy: true,
      //   headers: { Referer: 'https://provider-a.example.com/', 'User-Agent': 'Mozilla/5.0' },
      // },
    ];
  },

  // Uncomment + declare 'meta' in manifest.json capabilities to enrich
  // metadata the core app doesn't already have from TMDB (IMDb id,
  // overall IMDb rating, season episode ratings, official trailers).
  // First trailer URL is the default; the client's player handles quality.
  //
  // async getMeta(req) {
  //   return {
  //     imdb_id: 'tt0903747',
  //     overall_imdb_rating: 9.5,
  //     episode_imdb_ratings: req.s === 1 ? { 1: 9.0, 2: 8.7 } : undefined,
  //     trailers: ['https://.../trailer.mp4'],
  //   };
  // },

  // Uncomment + declare 'subtitle' in manifest.json capabilities.
  // async getSubtitles(req) {
  //   return [];
  // },
});

export const handler = createHttpAddonHandler(addon);
`,
    },
    {
      path: 'src/server.ts',
      content: `import { createServer } from 'node:http';
import { handler } from './index.js';

/**
 * Minimal production entrypoint for plain Node hosting. If you're deploying
 * to Cloudflare Workers / Deno Deploy / Next.js route handlers, you likely
 * don't need this file - export \`handler\` from src/index.ts directly into
 * that platform's fetch-handler convention instead. This file is here so
 * \`node dist/server.js\` just works out of the box.
 */
const port = Number(process.env.PORT) || 8787;

createServer(async (nodeReq, nodeRes) => {
  const url = \`http://\${nodeReq.headers.host ?? 'localhost'}\${nodeReq.url}\`;
  const request = new Request(url, {
    method: nodeReq.method,
    headers: nodeReq.headers as Record<string, string>,
  });
  const response = await handler(request);
  nodeRes.statusCode = response.status;
  response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
  nodeRes.end(await response.text());
}).listen(port, () => {
  console.log(\`Addon server listening on http://localhost:\${port}\`);
});
`,
    },
    {
      path: 'README.md',
      content: `# ${name}

A Delulu HTTP addon, built with \`@delulu-addon/dad-sdk\`.

## Develop

\`\`\`bash
npm install
npx dad dev
\`\`\`

This starts a real local HTTP server and prints example curl commands for
every route your addon declares, so you can hit it with the exact request
shapes Delulu Core sends in production.

## Deploy

Deploy \`src/index.ts\`'s \`handler\` export anywhere that speaks Web-standard
\`Request\`/\`Response\` (Cloudflare Workers, Deno Deploy, Next.js route
handlers), or run \`node dist/server.js\` for plain Node hosting. Then update
\`manifest.json\`'s \`baseUrl\` to your deployed domain.

## Validate

\`\`\`bash
npx dad validate
\`\`\`
`,
    },
  ];
}

/**
 * JavaScript addon starter - a sandboxed client-side scraper that executes
 * inside Delulu Core's embedded QuickJS runtime.
 */
export function jsAddonTemplate(id: string, name: string): TemplateFile[] {
  return [
    {
      path: 'package.json',
      content: `{
  "name": "${name.toLowerCase().replace(/[^a-z0-9-]+/g, '-')}",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "dad bundle",
    "bundle": "dad bundle",
    "test": "dad test",
    "validate": "dad validate"
  },
  "dependencies": {
    "@delulu-addon/dad-sdk": "^${SDK_VERSION}"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
`,
    },
    { path: 'tsconfig.json', content: tsconfigJson },
    { path: '.gitignore', content: gitignore },
    {
      path: 'manifest.json',
      content: `{
  "id": "${id}",
  "name": "${name}",
  "version": "1.0.0",
  "type": "js",
  "description": "TODO: one-line description of what this addon provides",
  "publisher": "TODO: your name or org",
  "bundle": {
    "url": "https://your-addon-cdn.example.com/bundle.js",
    "sha256": ""
  },
  "capabilities": ["direct_stream"]
}
`,
    },
    {
      path: 'src/index.ts',
      content: `import { defineJsAddon } from '@delulu-addon/dad-sdk';

export default defineJsAddon({
  manifest: {
    id: '${id}',
    name: '${name}',
    version: '1.0.0',
    type: 'js',
    description: 'TODO: one-line description of what this addon provides',
    publisher: 'TODO: your name or org',
    bundle: {
      url: 'https://your-addon-cdn.example.com/bundle.js',
      sha256: '',
    },
    capabilities: ['direct_stream'],
  },

  /**
   * Scrapes and returns playable streams for a given movie or TV episode.
   * Runs in Delulu Core's isolated QuickJS sandbox.
   */
  getStreams: async (req) => {
    console.log(\`[${name}] Scraping streams for TMDB \${req.tmdbId} (\${req.mediaType})\`);

    // In QuickJS, Web standard fetch() and native Servo-backed cheerio ($)
    // are available globally with bare-metal speed:
    // const res = await fetch('https://example.com/page');
    // const html = await res.text();
    // const $ = cheerio.load(html);
    // const link = $('a.download-link').attr('href');

    return [
      {
        type: 'direct',
        title: 'Big Buck Bunny (Demo Stream)',
        stream_url: 'https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4',
        audio_languages: ['eng'],
        resolution: '1080p',
        media_format: 'mp4',
      },
    ];
  },
});
`,
    },
    {
      path: 'README.md',
      content: `# ${name}

A sandboxed JavaScript Delulu addon, built with \`@delulu-addon/dad-sdk\`.

## Building the Bundle

\`\`\`bash
npm install
npx dad bundle
\`\`\`

Compiles \`src/index.ts\` into a single monolithic \`dist/bundle.js\`, computes its
SHA-256 hash, and automatically updates \`manifest.json\`.

## Testing Locally

\`\`\`bash
npx dad test
\`\`\`

Tests your scraper against public-domain test fixtures (*Big Buck Bunny*, *The Beverly Hillbillies*)
inside an isolated sandbox environment.

## Publishing

Upload \`dist/bundle.js\` to any HTTPS CDN (GitHub Releases, Cloudflare R2, AWS S3, etc.).
Update the \`bundle.url\` in \`manifest.json\` to your CDN URL, and distribute your \`manifest.json\`.
`,
    },
  ];
}

import path from 'node:path';
import fs from 'node:fs';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createHttpAddonHandler, type HttpAddonDefinition } from '../define.js';
import { CAPABILITY_ROUTES } from '../manifest.js';
import { DAD_TEST_FIXTURES } from '../fixtures.js';

const DEFAULT_PORT = 7890;

/**
 * Loads an addon's built `dist/index.js` and finds its `defineHttpAddon`-
 * produced export (conventionally named `addon`, but falls back to scanning
 * all named exports for one that looks right - so `dad dev` doesn't force an
 * export naming convention on the developer).
 */
async function loadAddon(targetDir: string): Promise<HttpAddonDefinition> {
  const distEntry = path.join(targetDir, 'dist', 'index.js');
  if (!fs.existsSync(distEntry)) {
    throw new Error(
      `No build output found at ${path.relative(targetDir, distEntry)}. Run 'npm run build' (or 'tsc') first, ` +
        `then 'dad dev' again. dad dev runs your compiled addon, not the raw TypeScript.`
    );
  }
  const mod = (await import(pathToFileURL(distEntry).href)) as Record<string, unknown>;
  const candidate = (mod.addon ?? mod.default ?? Object.values(mod).find((v) => isAddonDefinition(v))) as
    | HttpAddonDefinition
    | undefined;
  if (!candidate) {
    throw new Error(
      `Couldn't find an addon export in ${distEntry}. Export your defineHttpAddon() ` +
        `result as 'export const addon = ...' (or as the default export).`
    );
  }
  return candidate;
}

function isAddonDefinition(v: unknown): v is HttpAddonDefinition {
  return Boolean(v && typeof v === 'object' && 'manifest' in (v as Record<string, unknown>));
}

const SAMPLE_REQUESTS = DAD_TEST_FIXTURES.map((f) => ({
  media_type: f.media_type as 'movie' | 'tv',
  tmdb_id: f.tmdb_id,
  s: f.s,
  e: f.e,
  label: f.s !== undefined ? `${f.title} S${f.s}E${f.e ?? '?'}` : f.title,
}));

function printBanner(text: string) {
  console.log(`\n${'-'.repeat(60)}\n ${text}\n${'-'.repeat(60)}`);
}

/**
 * `dad dev`: starts a REAL local HTTP server wrapping
 * `createHttpAddonHandler`, so the developer can `curl` it (or point the
 * Delulu client's dev-install flow at it) with the exact route shapes and
 * validation production uses. Prints ready-to-run example requests.
 */
async function devHttpAddon(addon: HttpAddonDefinition, port: number) {
  const handler = createHttpAddonHandler(addon);

  const server = createServer(async (nodeReq, nodeRes) => {
    // Dev-only: serve the addon's manifest from the root so `dad test`
    // can validate a local dev server (see probe.ts comment).
    if (nodeReq.method === 'GET' && (nodeReq.url === '/manifest.json' || nodeReq.url === '/manifest')) {
      nodeRes.statusCode = 200;
      nodeRes.setHeader('Content-Type', 'application/json');
      nodeRes.end(JSON.stringify(addon.manifest));
      return;
    }

    const url = `http://localhost:${port}${nodeReq.url}`;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(nodeReq.headers)) {
      if (typeof v === 'string') headers[k] = v;
    }
    const request = new Request(url, { method: nodeReq.method, headers });
    const start = Date.now();
    const response = await handler(request);
    const ms = Date.now() - start;
    const status = response.status;
    const statusLabel = status >= 400 ? `\x1b[31m${status}\x1b[0m` : `\x1b[32m${status}\x1b[0m`;
    console.log(`${nodeReq.method} ${nodeReq.url}  ${statusLabel}  ${ms}ms`);
    nodeRes.statusCode = status;
    response.headers.forEach((value, key) => nodeRes.setHeader(key, value));
    nodeRes.end(Buffer.from(await response.arrayBuffer()));
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));

  printBanner(`DAD dev server - ${addon.manifest.name} (${addon.manifest.id})`);
  console.log(` Listening on http://localhost:${port}`);
  console.log(` Capabilities: ${addon.manifest.capabilities.join(', ')}`);
  if (addon.manifest.apiKey?.required) {
    console.log(` API key REQUIRED - pass one with: curl -H "Authorization: Bearer <key>" ...`);
  }
  console.log(`\n Try it:`);
  // Dedupe by ROUTE, not capability - direct_stream and torrent both map to
  // '/streams' (see CAPABILITY_ROUTES), so an addon declaring both must
  // print that curl example ONCE, not once per capability.
  const routes = new Set(addon.manifest.capabilities.map((cap) => CAPABILITY_ROUTES[cap]));
  for (const route of routes) {
    for (const sample of SAMPLE_REQUESTS) {
      const segs = [route, sample.media_type, sample.tmdb_id, sample.s, sample.e].filter((x) => x !== undefined);
      console.log(`   curl http://localhost:${port}/${segs.join('/')}   # ${sample.label}`);
    }
  }
  console.log(`\n CORS is open (Access-Control-Allow-Origin: *) so you can also hit this from a browser dev tool.`);
  console.log(` Press Ctrl+C to stop.\n`);
}

export async function runDev(targetDir: string, opts: { port?: number } = {}): Promise<void> {
  const addon = await loadAddon(targetDir);
  await devHttpAddon(addon, opts.port ?? DEFAULT_PORT);
  // Keep the process alive for the HTTP server.
  await new Promise(() => {});
}

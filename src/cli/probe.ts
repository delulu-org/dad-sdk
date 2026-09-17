/**
 * `dad test` - validate a LIVE, deployed addon against the real DAD contract,
 * using only public-domain / freely-licensed fixtures (see fixtures.ts).
 *
 * For a given manifest URL it:
 *   1. Fetches + validates the manifest itself.
 *   2. Probes every DECLARED capability against the SAME origin the manifest
 *      was served from (DAD addons host their manifest at the server root, so
 *      `{baseUrl}/manifest.json` and the data routes are one origin).
 *   3. Runs every response through the same validators `createHttpAddonHandler`
 *      uses in production, so "passes on dad test" == "passes the contract".
 *
 * `dad dev` (or any local server) can be tested too - the manifest just needs
 * to be served from that server's root.
 *
 * Probing is hourglass-shaped: it hits the routes with public-domain TMDB IDs
 * (Big Buck Bunny, Sintel, ...) - never with copyrighted titles.
 */

import { validateManifest, CAPABILITY_ROUTES, type DadCapability, type DadRoute } from '../manifest.js';
import { isErrorResponse, validateErrorResponse } from '../errors.js';
import {
  validateMetaResponse,
  validateStreamItems,
  validateSubtitleItems,
  allowedStreamTypesForCapabilities,
  type DadStreamType,
} from '../responses.js';
import type { DadTestFixture } from '../fixtures.js';
import { DAD_TEST_FIXTURES } from '../fixtures.js';

interface ProbeResult {
  route: DadRoute;
  label: string;
  url: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

const REQUEST_TIMEOUT_MS = 15000;

async function fetchJson(url: string, apiKey?: string): Promise<{ status: number; data: unknown }> {
  const headers: Record<string, string> = {};
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${truncate(text, 200)}`);
  }
  return { status: res.status, data };
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}.` : s;
}

function validateCapabilityResponse(
  route: ProbeResult['route'],
  data: unknown,
  label: string,
  allowedStreamTypes: DadStreamType[]
): ProbeResult {
  if (route === 'streams') {
    // Mirror production's createHttpAddonHandler exactly: allowedTypes is
    // derived from the addon's DECLARED capabilities, never left empty.
    // An empty array here would silently skip the capability<->type check
    // that catches e.g. a direct_stream-only addon returning a torrent item
    // - something production 422s but a lenient probe would let through.
    const check = validateStreamItems(data, { allowedTypes: allowedStreamTypes });
    return check.valid
      ? { route, label, url: '', status: 'ok', detail: 'valid stream items' }
      : { route, label, url: '', status: 'fail', detail: check.errors.join(' ') };
  }
  if (route === 'meta') {
    const check = validateMetaResponse(data);
    return check.valid
      ? { route, label, url: '', status: 'ok', detail: 'valid meta response' }
      : { route, label, url: '', status: 'fail', detail: check.errors.join(' ') };
  }
  const check = validateSubtitleItems(data);
  return check.valid
    ? { route, label, url: '', status: 'ok', detail: 'valid subtitle items' }
    : { route, label, url: '', status: 'fail', detail: check.errors.join(' ') };
}

/**
 * Returns per-capability results. Throws on fatal problems (unreachable
 * manifest, invalid manifest, addon down) so the CLI can surface them loudly.
 *
 * `apiKey`, if given, is sent as `Authorization: Bearer <apiKey>` on every
 * probe request - testing the addon's AUTHENTICATED path (does a real key
 * actually work?) rather than just its graceful-rejection path. This also
 * changes what counts as a pass: an `unauthorized` response is graceful
 * degradation when no key was given (nobody expects to be let in), but is a
 * genuine FAILURE when a real key was supplied and still got rejected.
 */
export async function testAddon(
  manifestUrl: string,
  fixtures: DadTestFixture[] = DAD_TEST_FIXTURES,
  apiKey?: string
): Promise<{ manifest: { name: string; id: string; capabilities: DadCapability[] }; results: ProbeResult[] }> {
  const manifestRes = await fetchJson(manifestUrl, apiKey);
  if (manifestRes.status !== 200) {
    throw new Error(
      `Manifest did not return 200 - got ${manifestRes.status}. Is the addon deployed and serving ${manifestUrl}?`
    );
  }

  const manifestCheck = validateManifest(manifestRes.data);
  if (!manifestCheck.valid) {
    throw new Error(`Manifest at ${manifestUrl} is invalid: ${manifestCheck.errors.join('; ')}`);
  }

  const manifest = manifestRes.data as {
    name: string;
    id: string;
    baseUrl: string;
    capabilities: DadCapability[];
  };

  // Probe the SAME origin the manifest came from - a DAD addon hosts both its
  // manifest and its data routes on one server, so {baseUrl}/manifest.json is
  // always on the origin being tested. This also makes `dad test` work against
  // `dad dev` / any local host, not just a deployed HTTPS endpoint.
  let origin: string;
  try {
    origin = new URL(manifestUrl).origin;
  } catch {
    throw new Error(`Manifest URL is not a valid URL: ${manifestUrl}`);
  }

  const results: ProbeResult[] = [];

  // Same shared derivation production's createHttpAddonHandler uses (see
  // allowedStreamTypesForCapabilities in responses.ts) - computed once per
  // addon, reused for every probe, and guaranteed to never drift from what
  // production actually enforces.
  const allowedStreamTypes: DadStreamType[] = allowedStreamTypesForCapabilities(manifest.capabilities);

  // Group capabilities by the ROUTE they resolve to before probing - both
  // 'direct_stream' and 'torrent' map to '/streams' (see CAPABILITY_ROUTES),
  // so an addon declaring both must be probed on that route ONCE, not once
  // per capability. Probing per-capability would hit the live server twice
  // with an identical request and double-report the same result.
  const routeCapabilities = new Map<DadRoute, DadCapability[]>();
  for (const cap of new Set(manifest.capabilities)) {
    const route = CAPABILITY_ROUTES[cap];
    const existing = routeCapabilities.get(route);
    if (existing) existing.push(cap);
    else routeCapabilities.set(route, [cap]);
  }

  for (const fixture of fixtures) {
    const segs = [`${fixture.media_type}`, String(fixture.tmdb_id)];
    if (fixture.s !== undefined) segs.push(String(fixture.s));
    if (fixture.e !== undefined) segs.push(String(fixture.e));

    for (const [route, caps] of routeCapabilities) {
      const url = `${origin}/${route}/${segs.join('/')}`;
      const label = `${fixture.title} - ${route}/${segs.join('/')} (${caps.join('+')})`;

      let res: ProbeResult;
      try {
        const { status, data } = await fetchJson(url, apiKey);
        if (status === 200) {
          res = validateCapabilityResponse(route, data, label, allowedStreamTypes);
          res.url = url;
        } else if (isErrorResponse(data) && validateErrorResponse(data).valid) {
          // A well-formed DAD error is normally a CONTRACT-conformant
          // answer, not a test failure - e.g. `content_unavailable` (title
          // has nothing), `upstream_unreachable` (scraper down). The addon
          // said WHY, in the shared vocabulary - that's usually a pass.
          //
          // 'unauthorized' is the one code whose meaning depends on whether
          // we actually sent a key: rejecting an ABSENT key is graceful
          // degradation (nobody expects to get in for free). Rejecting a
          // key we DID supply is a broken key gate - a real failure, not
          // something to wave through as "the addon explained itself".
          const isUnauthorizedWithRealKey = data.error === 'unauthorized' && Boolean(apiKey);
          res = {
            route,
            label,
            url,
            status: isUnauthorizedWithRealKey ? 'fail' : 'ok',
            detail: isUnauthorizedWithRealKey
              ? `key rejected: ${data.error} - ${data.error_message} (a valid --key was supplied but the addon rejected it)`
              : `graceful error: ${data.error} - ${data.error_message}`,
          };
        } else if (status === 404 || status === 400) {
          res = {
            route,
            label,
            url,
            status: 'ok',
            detail: `returned ${status} - addon has nothing for this title (graceful)`,
          };
        } else {
          res = {
            route,
            label,
            url,
            status: 'fail',
            detail: `unexpected HTTP ${status} - response was not a valid DAD error response`,
          };
        }
      } catch (e: any) {
        res = { route, label, url, status: 'fail', detail: e.message };
      }
      results.push(res);
    }
  }

  return {
    manifest: { name: manifest.name, id: manifest.id, capabilities: manifest.capabilities },
    results,
  };
}

const STATUS_MARKS = ['\x1b[32m[OK]\x1b[0m', '\x1b[33m[--]\x1b[0m', '\x1b[31m[FAIL]\x1b[0m'] as const;
const STATUS_MARK: Record<ProbeResult['status'], string> = {
  ok: STATUS_MARKS[0],
  warn: STATUS_MARKS[1],
  fail: STATUS_MARKS[2],
};

export async function runTest(manifestUrl: string, apiKey?: string): Promise<void> {
  let out: Awaited<ReturnType<typeof testAddon>>;
  try {
    out = await testAddon(manifestUrl, DAD_TEST_FIXTURES, apiKey);
  } catch (e: any) {
    console.error(`\n DAD test FAILED: ${e.message}`);
    process.exitCode = 1;
    return;
  }

  const { manifest, results } = out;
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  console.log(`\n${'-'.repeat(60)}`);
  console.log(` DAD test - ${manifest.name} (${manifest.id})`);
  console.log(`${'-'.repeat(60)}`);
  console.log(` Capabilities: ${manifest.capabilities.join(', ')}`);
  console.log(apiKey ? ` Auth: sending Authorization: Bearer <key> (authenticated path)` : ` Auth: none (testing graceful-rejection path - pass --key to test as an authenticated caller)`);

  for (const res of results) {
    console.log(` ${STATUS_MARK[res.status]} ${res.label}`);
    if (res.detail) console.log(`      ${res.detail}`);
  }

  if (failed === 0) {
    console.log(`\n PASS - ${results.length} probes, all clean. ${warned > 0 ? `${warned} graceful empty results.` : ''}`);
  } else {
    console.log(`\n FAIL - ${failed}/${results.length} probes failed. Fix, redeploy, and re-run 'dad test'.`);
  }
  process.exitCode = failed > 0 ? 1 : 0;
}
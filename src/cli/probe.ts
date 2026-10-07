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

/** A probe plus whether the addon actually returned any data for it. */
interface ProbeOutcome {
  result: ProbeResult;
  producedData: boolean;
  /**
   * True when the probe was answered by a DECLARED apiKey gate rejecting an
   * anonymous request. Lets the caller tell "healthy but locked" apart from
   * "healthy and returning nothing at all".
   */
  gateOnly: boolean;
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
  allowedStreamTypes: DadStreamType[]
): { valid: boolean; errors: string[] } {
  if (route === 'streams') {
    // Mirror production's createHttpAddonHandler: allowedTypes comes from the
    // addon's declared capabilities, never left empty.
    return validateStreamItems(data, { allowedTypes: allowedStreamTypes });
  }
  if (route === 'meta') {
    return validateMetaResponse(data);
  }
  return validateSubtitleItems(data);
}

/** Is this origin the local machine? (`dad dev` and friends.) */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.replace(/^\[|\]$/g, '');
    return host === 'localhost' || host === '::1' || /^127\./.test(host);
  } catch {
    return false;
  }
}

/**
 * Did this response actually carry data? An empty result is a VALID response
 * and stays a passing probe on its own, but a run where NOTHING ever returns
 * data is a broken deployment - see `producedData` in testAddon's result.
 */
function responseHasData(route: ProbeResult['route'], data: unknown): boolean {
  if (route === 'meta') {
    return typeof data === 'object' && data !== null && Object.keys(data as object).length > 0;
  }
  return Array.isArray(data) && data.length > 0;
}

/**
 * Turns one HTTP response into a pass/fail verdict.
 *
 * A response passes only when it is either a valid success payload or a valid
 * DAD error of a GRACEFUL code. Server/contract errors - `internal_error`,
 * `upstream_unreachable`, `invalid_response`, `not_found`, `bad_request`,
 * `method_not_allowed` - are the addon itself failing and FAIL the probe.
 */
const GRACEFUL_ERROR_CODES: ReadonlySet<string> = new Set(['content_unavailable', 'rate_limited']);

function classifyResponse(args: {
  route: DadRoute;
  label: string;
  url: string;
  status: number;
  data: unknown;
  allowedStreamTypes: DadStreamType[];
  apiKey?: string;
  declaresKeyGate: boolean;
}): ProbeOutcome {
  const { route, label, url, status, data, allowedStreamTypes, apiKey, declaresKeyGate } = args;
  const pass = (detail: string, produced = false, gateOnly = false): ProbeOutcome => ({
    result: { route, label, url, status: 'ok', detail },
    producedData: produced,
    gateOnly,
  });
  const fail = (detail: string): ProbeOutcome => ({
    result: { route, label, url, status: 'fail', detail },
    producedData: false,
    gateOnly: false,
  });

  if (status === 200) {
    const check = validateCapabilityResponse(route, data, allowedStreamTypes);
    if (!check.valid) return fail(check.errors.join(' '));
    return pass('valid response', responseHasData(route, data));
  }

  if (isErrorResponse(data) && validateErrorResponse(data).valid) {
    // A well-formed DAD error proves the addon speaks the contract - which is
    // NOT the same as "the addon is working". Server/contract errors mean the
    // addon itself is broken, so they FAIL the probe:
    //   unauthorized    -> gate logic below (pass only when the gate is working)
    //   not_found       -> probe only hits declared capabilities with valid
    //                      routes; a DAD not_found there means a misconfigured
    //                      addon (404 for a route it declared)
    //   bad_request     -> probe sends well-formed requests; a 400 means the
    //                      addon mis-parses valid input
    //   method_not_allowed -> probe sends GET; only broken addons reject it
    //   invalid_response -> the addon's own payload failed SDK validation
    //   upstream_unreachable -> the addon's data source is down
    //   internal_error  -> the addon crashed
    // The GRACEFUL codes (content_unavailable, rate_limited) are the addon
    // functioning: "I know this title, and I have nothing for it", or "slow
    // down".
    if (data.error === 'unauthorized') {
      if (apiKey) {
        return fail(
          `key rejected: ${data.error} - ${data.error_message} (a --key was supplied but the addon rejected it)`
        );
      }
      if (declaresKeyGate) {
        return pass(`graceful error: ${data.error} - ${data.error_message} (declared apiKey gate is working)`, false, true);
      }
      return fail(
        `returned unauthorized but the manifest declares no 'apiKey' gate - ${data.error_message}. ` +
          `Declare the gate in manifest.json, or stop rejecting anonymous requests.`
      );
    }
    if (GRACEFUL_ERROR_CODES.has(data.error)) {
      return pass(`graceful error: ${data.error} - ${data.error_message}`);
    }
    return fail(
      `addon failure: ${data.error} - ${data.error_message}. ` +
        `This is a server/contract error, not an empty answer - a production-ready addon ` +
        `never answers a valid request for a declared capability this way.`
    );
  }

  // A bare 404/400 means something other than the addon is answering - a stale
  // deployment, a CDN 404 page, or the wrong route shape.
  if (status === 404 || status === 400) {
    return fail(
      `HTTP ${status} with no valid DAD error response - something other than the addon is answering ` +
        `(stale deployment, hosting 404 page, or the wrong route shape). A DAD addon answers every ` +
        `failure as { error, error_message }.`
    );
  }

  return fail(`unexpected HTTP ${status} - response was not a valid DAD error response`);
}

/**
 * Returns per-capability results. Throws on fatal problems (unreachable
 * manifest, invalid manifest, addon down) so the CLI can surface them loudly.
 *
 * `apiKey`, if given, is sent as `Authorization: Bearer <apiKey>` on every
 * probe - testing the authenticated path. This also changes what counts as a
 * pass: an `unauthorized` response is graceful when no key was given, but a
 * genuine FAILURE when a real key was supplied and still got rejected.
 */
export async function testAddon(
  manifestUrl: string,
  fixtures: DadTestFixture[] = DAD_TEST_FIXTURES,
  apiKey?: string
): Promise<{
  manifest: { name: string; id: string; capabilities: DadCapability[] };
  results: ProbeResult[];
  producedData: boolean;
  /** Non-fatal notes the caller should surface (e.g. probed localhost, not prod). */
  warnings: string[];
  /** Every probe was answered by a declared key gate - the data path is untested. */
  gateExercisedOnly: boolean;
}> {
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
    apiKey?: unknown;
  };

  // Probe the origin the manifest came from - DAD addons host manifest and data
  // routes on one server, so this also makes `dad test` work against `dad dev`.
  let origin: string;
  let declaredOrigin: string;
  try {
    origin = new URL(manifestUrl).origin;
    declaredOrigin = new URL(manifest.baseUrl).origin;
  } catch {
    throw new Error(`Manifest URL is not a valid URL: ${manifestUrl}`);
  }

  // Delulu Core sends data requests to the declared baseUrl, so it must match
  // the origin the manifest was served from (a loopback mismatch is just
  // `dad dev` - warn, but probe what is running here).
  const warnings: string[] = [];
  if (declaredOrigin !== origin) {
    if (isLoopbackOrigin(origin)) {
      warnings.push(
        `Manifest declares baseUrl '${manifest.baseUrl}' but was served from ${origin} (a local address), so these ` +
          `probes tested your LOCAL server, not the deployed one. Run 'dad test https://<your-deployed-host>/manifest.json' ` +
          `before shipping.`
      );
    } else {
      throw new Error(
        `Manifest declares baseUrl '${manifest.baseUrl}' (origin ${declaredOrigin}) but is served from ${origin}. ` +
          `Delulu Core sends all data requests to the declared baseUrl, so these must be the same host - serve the ` +
          `manifest from that host, or fix 'baseUrl' in manifest.json.`
      );
    }
  }

  // Whether the addon declares a key gate at all - decides whether a 401
  // is the gate working or a broken deployment.
  const declaresKeyGate = manifest.apiKey !== undefined && manifest.apiKey !== null;

  const results: ProbeResult[] = [];
  let producedData = false;
  let gateOnlyCount = 0;

  const allowedStreamTypes: DadStreamType[] = allowedStreamTypesForCapabilities(manifest.capabilities);

  // Group by route: 'direct_stream' and 'torrent' both map to '/streams', so
  // an addon declaring both is probed on that route once, not twice.
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

      let outcome: ProbeOutcome;
      try {
        const { status, data } = await fetchJson(url, apiKey);
        outcome = classifyResponse({ route, label, url, status, data, allowedStreamTypes, apiKey, declaresKeyGate });
      } catch (e: any) {
        outcome = {
          result: { route, label, url, status: 'fail', detail: e.message },
          producedData: false,
          gateOnly: false,
        };
      }
      if (outcome.producedData) producedData = true;
      if (outcome.gateOnly) gateOnlyCount++;
      results.push(outcome.result);
    }
  }

  return {
    manifest: { name: manifest.name, id: manifest.id, capabilities: manifest.capabilities },
    results,
    producedData,
    warnings,
    // Every probe was answered by the declared key gate - nothing was exercised.
    gateExercisedOnly: results.length > 0 && gateOnlyCount === results.length,
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

  const { manifest, results, producedData, warnings, gateExercisedOnly } = out;
  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;

  console.log(`\n${'-'.repeat(60)}`);
  console.log(` DAD test - ${manifest.name} (${manifest.id})`);
  console.log(`${'-'.repeat(60)}`);
  console.log(` Capabilities: ${manifest.capabilities.join(', ')}`);
  console.log(apiKey ? ` Auth: sending Authorization: Bearer <key> (authenticated path)` : ` Auth: none (testing graceful-rejection path - pass --key to test as an authenticated caller)`);

  for (const warning of warnings) {
    console.log(`\n\x1b[33m[--] WARNING\x1b[0m ${warning}`);
  }

  for (const res of results) {
    console.log(` ${STATUS_MARK[res.status]} ${res.label}`);
    if (res.detail) console.log(`      ${res.detail}`);
  }

  if (failed > 0) {
    console.log(`\n FAIL - ${failed}/${results.length} probes failed. Fix, redeploy, and re-run 'dad test'.`);
    process.exitCode = 1;
    return;
  }

  if (!producedData) {
    // A key-gated addon probed without a key is expected to return nothing -
    // say the data path went untested rather than implying a full verification.
    if (gateExercisedOnly && !apiKey) {
      console.log(
        `\n PASS - ${results.length} probes, all clean, but every one was a rejected anonymous request: the declared ` +
          `apiKey gate works. Nothing else was exercised.`
      );
      console.log(` Re-run with --key <your-key> to test the addon's actual data.`);
      process.exitCode = 0;
      return;
    }
    console.log(
      `\n FAIL - ${results.length} probes were all contract-valid, but NOT ONE returned any data ` +
        `(no streams, no meta, no subtitles for any fixture).`
    );
    console.log(` An addon that answers correctly with nothing is still broken - check the deployment.`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `\n PASS - ${results.length} probes, all clean.${
      warned > 0 ? ` ${warned} graceful empty result(s).` : ''
    }${warnings.length > 0 ? ' See the WARNING above before shipping.' : ''}`
  );
  process.exitCode = 0;
}
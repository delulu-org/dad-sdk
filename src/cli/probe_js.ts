import vm from 'node:vm';
import * as cheerio from 'cheerio';
import CryptoJS from 'crypto-js';
import { validateManifest, type DadCapability, type DadRoute, type JsDadManifest } from '../manifest.js';
import {
  validateMetaResponse,
  validateStreamItems,
  validateSubtitleItems,
  allowedStreamTypesForCapabilities,
  type DadStreamType,
} from '../responses.js';
import type { DadTestFixture } from '../fixtures.js';

export interface ProbeResult {
  route: DadRoute;
  label: string;
  url: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface JsTestOutcome {
  manifest: { name: string; id: string; capabilities: DadCapability[] };
  results: ProbeResult[];
  producedData: boolean;
  warnings: string[];
  gateExercisedOnly: boolean;
}

/**
 * Tests a sandboxed JavaScript addon bundle against public-domain fixtures
 * using Node's isolated vm execution context.
 */
export async function testJsAddon(
  manifest: JsDadManifest,
  bundleCode: string,
  fixtures: DadTestFixture[],
  apiKey?: string
): Promise<JsTestOutcome> {
  const warnings: string[] = [];
  const results: ProbeResult[] = [];
  let producedData = false;
  let gateOnlyCount = 0;

  // 1. Validate manifest first
  const manifestCheck = validateManifest(manifest);
  if (!manifestCheck.valid) {
    throw new Error(`Manifest is invalid: ${manifestCheck.errors.join('; ')}`);
  }

  // 2. Prepare isolated VM context with QuickJS-like globals
  // Enhance cheerio for parity with Delulu Core's native Servo engine (.details())
  const wrappedCheerio = {
    ...cheerio,
    load: ((...args: any[]) => {
      const $ = (cheerio as any).load(...args);
      if ($.fn && !($.fn as any).details) {
        ($.fn as any).details = function () {
          const results: any[] = [];
          this.each((idx: number, el: any) => {
            results.push({
              id: `doc:e${idx}`,
              text: $(el).text(),
              html: $.html(el),
              attrs: el.attribs || {},
            });
          });
          return results;
        };
      }
      if (!($ as any).details) {
        ($ as any).details = function (selector: string) {
          return $(selector).details();
        };
      }
      return $;
    }) as typeof cheerio.load,
  };

  const sandboxModule = { exports: {} as any };
  const contextObj: Record<string, any> = {
    console,
    fetch: globalThis.fetch,
    Headers: globalThis.Headers,
    Request: globalThis.Request,
    Response: globalThis.Response,
    AbortController: globalThis.AbortController,
    URL: globalThis.URL,
    URLSearchParams: globalThis.URLSearchParams,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    atob: globalThis.atob,
    btoa: globalThis.btoa,
    TextEncoder: globalThis.TextEncoder,
    cheerio: wrappedCheerio,
    CryptoJS,
    module: sandboxModule,
    exports: sandboxModule.exports,
    globalThis: {} as any,
    require: (id: string) => {
      if (id === 'cheerio' || id === 'cheerio-without-node-native' || id === 'react-native-cheerio') {
        return wrappedCheerio;
      }
      if (id === 'crypto-js') {
        return CryptoJS;
      }
      throw new Error(`Module '${id}' is not available in sandbox (bundle must be self-contained)`);
    },
  };
  contextObj.globalThis = contextObj;

  const context = vm.createContext(contextObj);

  // 3. Execute bundle in VM
  try {
    const script = new vm.Script(bundleCode, { filename: 'bundle.js' });
    script.runInContext(context);
  } catch (err: any) {
    throw new Error(`Failed to execute bundle: ${err.message || err}`);
  }

  // 4. Resolve handlers
  let mod = sandboxModule.exports;
  if (mod && mod.default && typeof mod.default === 'object') {
    mod = mod.default;
  }

  const getStreams = mod?.getStreams || contextObj.exports?.getStreams || contextObj.getStreams;
  const getMeta = mod?.getMeta || contextObj.exports?.getMeta || contextObj.getMeta;
  const getSubtitles = mod?.getSubtitles || contextObj.exports?.getSubtitles || contextObj.getSubtitles;

  const caps = new Set(manifest.capabilities);
  if ((caps.has('direct_stream') || caps.has('torrent')) && typeof getStreams !== 'function') {
    throw new Error(`Addon declares 'direct_stream'/'torrent' but does not export 'getStreams' function.`);
  }
  if (caps.has('meta') && typeof getMeta !== 'function') {
    throw new Error(`Addon declares 'meta' but does not export 'getMeta' function.`);
  }
  if (caps.has('subtitle') && typeof getSubtitles !== 'function') {
    throw new Error(`Addon declares 'subtitle' but does not export 'getSubtitles' function.`);
  }

  const allowedStreamTypes = allowedStreamTypesForCapabilities(manifest.capabilities);
  const declaresKeyGate = Boolean(manifest.apiKey);

  // 5. Probe handlers with fixtures
  for (const fixture of fixtures) {
    const req = {
      tmdb_id: fixture.tmdb_id,
      media_type: fixture.media_type,
      s: fixture.s,
      e: fixture.e,
      auth: apiKey,
      // JS aliases
      tmdbId: fixture.tmdb_id,
      mediaType: fixture.media_type,
      season: fixture.s,
      episode: fixture.e,
      apiKey: apiKey,
    };

    // Streams probe
    if (caps.has('direct_stream') || caps.has('torrent')) {
      const label = `${fixture.title} - getStreams (${manifest.capabilities.filter(c => c === 'direct_stream' || c === 'torrent').join('+')})`;
      try {
        const items = await getStreams(req);
        if (!Array.isArray(items)) {
          results.push({
            route: 'streams',
            label,
            url: 'js:getStreams',
            status: 'fail',
            detail: `getStreams must return an array, got ${typeof items}`,
          });
        } else {
          const val = validateStreamItems(items, { allowedTypes: allowedStreamTypes });
          if (!val.valid) {
            results.push({
              route: 'streams',
              label,
              url: 'js:getStreams',
              status: 'fail',
              detail: `Contract validation failed: ${val.errors.join('; ')}`,
            });
          } else if (items.length === 0) {
            if (declaresKeyGate && !apiKey) {
              gateOnlyCount++;
              results.push({
                route: 'streams',
                label,
                url: 'js:getStreams',
                status: 'ok',
                detail: `Returned 0 streams (expected for unauthenticated probe against key-gated addon)`,
              });
            } else {
              results.push({
                route: 'streams',
                label,
                url: 'js:getStreams',
                status: 'warn',
                detail: `Returned 0 streams for valid public fixture`,
              });
            }
          } else {
            producedData = true;
            const qualities = items.map((i: any) => i.resolution || i.quality || i.item_type).join(', ');
            results.push({
              route: 'streams',
              label,
              url: 'js:getStreams',
              status: 'ok',
              detail: `Returned ${items.length} stream(s) [${qualities}]`,
            });
          }
        }
      } catch (err: any) {
        if (declaresKeyGate && !apiKey && /unauthorized|auth|key/i.test(err.message)) {
          gateOnlyCount++;
          results.push({
            route: 'streams',
            label,
            url: 'js:getStreams',
            status: 'ok',
            detail: `Rejected unauthenticated probe gracefully: ${err.message}`,
          });
        } else {
          results.push({
            route: 'streams',
            label,
            url: 'js:getStreams',
            status: 'fail',
            detail: `Thrown exception: ${err.message || err}`,
          });
        }
      }
    }

    // Meta probe
    if (caps.has('meta')) {
      const label = `${fixture.title} - getMeta`;
      // Meta requests strictly support up to season level: episode is omitted
      const metaReq = {
        tmdb_id: fixture.tmdb_id,
        media_type: fixture.media_type,
        s: fixture.s,
        e: undefined,
        auth: apiKey,
        tmdbId: fixture.tmdb_id,
        mediaType: fixture.media_type,
        season: fixture.s,
        episode: undefined,
        apiKey: apiKey,
      };
      try {
        const meta = await getMeta(metaReq);
        if (meta == null) {
          results.push({
            route: 'meta',
            label,
            url: 'js:getMeta',
            status: 'warn',
            detail: `Returned null (no metadata found)`,
          });
        } else {
          const val = validateMetaResponse(meta);
          if (!val.valid) {
            results.push({
              route: 'meta',
              label,
              url: 'js:getMeta',
              status: 'fail',
              detail: `Contract validation failed: ${val.errors.join('; ')}`,
            });
          } else {
            producedData = true;
            const epCount = meta.episode_imdb_ratings ? Object.keys(meta.episode_imdb_ratings).length : 0;
            results.push({
              route: 'meta',
              label,
              url: 'js:getMeta',
              status: 'ok',
              detail: `Returned valid metadata (overall: ${meta.overall_imdb_rating ?? 'none'}, episodes: ${epCount}, trailers: ${meta.trailers?.length ?? 0})`,
            });
          }
        }
      } catch (err: any) {
        results.push({
          route: 'meta',
          label,
          url: 'js:getMeta',
          status: 'fail',
          detail: `Thrown exception: ${err.message || err}`,
        });
      }
    }

    // Subtitle probe
    if (caps.has('subtitle')) {
      const label = `${fixture.title} - getSubtitles`;
      try {
        const subs = await getSubtitles(req);
        if (!Array.isArray(subs)) {
          results.push({
            route: 'subtitles',
            label,
            url: 'js:getSubtitles',
            status: 'fail',
            detail: `getSubtitles must return an array, got ${typeof subs}`,
          });
        } else {
          const val = validateSubtitleItems(subs);
          if (!val.valid) {
            results.push({
              route: 'subtitles',
              label,
              url: 'js:getSubtitles',
              status: 'fail',
              detail: `Contract validation failed: ${val.errors.join('; ')}`,
            });
          } else if (subs.length === 0) {
            results.push({
              route: 'subtitles',
              label,
              url: 'js:getSubtitles',
              status: 'warn',
              detail: `Returned 0 subtitle tracks`,
            });
          } else {
            producedData = true;
            results.push({
              route: 'subtitles',
              label,
              url: 'js:getSubtitles',
              status: 'ok',
              detail: `Returned ${subs.length} subtitle track(s)`,
            });
          }
        }
      } catch (err: any) {
        results.push({
          route: 'subtitles',
          label,
          url: 'js:getSubtitles',
          status: 'fail',
          detail: `Thrown exception: ${err.message || err}`,
        });
      }
    }
  }

  return {
    manifest: { name: manifest.name, id: manifest.id, capabilities: manifest.capabilities },
    results,
    producedData,
    warnings,
    gateExercisedOnly: results.length > 0 && gateOnlyCount === results.length,
  };
}

/**
 * The DAD registry id guard (`dad dev` + `dad test`).
 *
 * Namespace ownership is answered by ONE live authority - the DAD registry -
 * never by string magic in the SDK and never by a hardcoded per-addon list:
 *
 *  - ids under `org.delulu.` are SEALED. They may only be used by addons that
 *    appear in the registry's `official` list (write-blocked at the registry
 *    so no third party can ever add themselves there). Any `org.delulu.*` id
 *    NOT in that list is hard-blocked.
 *  - every other id is checked for global uniqueness against the registry:
 *    an id already registered to a DIFFERENT manifest URL is a collision.
 *  - an id registered to the SAME manifest URL is the developer's own addon
 *    (re-testing after registration) - allowed.
 *
 * Failure policy: the guard NEVER bricks local work. If the registry can't be
 * fetched the check degrades to a non-blocking warning (`unreachable`).
 */

export const DAD_RESERVED_NAMESPACES = ['org.delulu.'];

export const DAD_REGISTRY_URL =
  process.env.DAD_REGISTRY_URL ?? 'https://delulu-addons.pages.dev/dad_registry.json';

export interface RegistryAddon {
  id: string;
  manifestUrl: string;
}

/** Registry document: `official` is write-blocked - only Delulu can add to it. */
export interface DadRegistryDoc {
  official: RegistryAddon[];
  addons: RegistryAddon[];
}

export type RegistryCheck =
  | { status: 'ok'; detail: string }
  | { status: 'self'; detail: string }
  | { status: 'conflict'; detail: string }
  | { status: 'sealed'; detail: string }
  | { status: 'unreachable'; detail: string };

const REGISTRY_TIMEOUT_MS = 3000;

async function fetchRegistry(registryUrl: string): Promise<DadRegistryDoc> {
  const res = await fetch(registryUrl, { signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
  if (res.status !== 200) throw new Error(`registry returned HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (typeof raw !== 'object' || raw === null) throw new Error('registry response is not an object');
  const doc = raw as Partial<DadRegistryDoc>;
  const official = Array.isArray(doc.official) ? doc.official : [];
  const addons = Array.isArray(doc.addons) ? doc.addons : [];
  return { official, addons };
}

/** Returns the reserved namespace `id` claims to be under, if any. */
export function identifySealedNamespace(id: string): string | undefined {
  const lower = id.toLowerCase();
  return DAD_RESERVED_NAMESPACES.find((ns) => lower.startsWith(ns));
}

export async function checkAddonId(opts: {
  id: string;
  manifestUrl?: string;
  registryUrl?: string;
}): Promise<RegistryCheck> {
  const id = opts.id;
  const registryUrl = opts.registryUrl ?? DAD_REGISTRY_URL;

  let registry: DadRegistryDoc;
  try {
    registry = await fetchRegistry(registryUrl);
  } catch (e: any) {
    return {
      status: 'unreachable',
      detail: `addon registry unreachable (${e.message})- id '${id}' is not verified`,
    };
  }

  const sealed = identifySealedNamespace(id);
  const isOfficial = registry.official.some((r) => r.id === id);

  if (sealed && !isOfficial) {
    return {
      status: 'sealed',
      detail:
        `'${id}' is under the reserved namespace '${sealed}' - only official Delulu addons ` +
        `(listed in the registry's 'official' set) may use it.`,
    };
  }

  const registration = [...registry.official, ...registry.addons].find((r) => r.id === id);
  if (registration) {
    if (opts.manifestUrl && registration.manifestUrl === opts.manifestUrl) {
      return { status: 'self', detail: `id '${id}' is registered to this exact URL - it's your addon` };
    }
    return {
      status: 'conflict',
      detail:
        `id '${id}' is already registered to ${registration.manifestUrl}` +
        `${opts.manifestUrl ? ` (this addon is at ${opts.manifestUrl})` : ''} - pick a unique id`,
    };
  }

  return { status: 'ok', detail: `id '${id}' is free to register` };
}
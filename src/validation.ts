/**
 * Small, shared validation primitives used across manifest.ts, catalog.ts,
 * and responses.ts. Pulled out specifically to kill duplication: before this
 * module existed, "is this an HTTPS URL" was reimplemented four times (twice
 * as a strict `new URL()` check in catalog.ts, twice as a looser regex in
 * manifest.ts/responses.ts - the regex form accepts strings like
 * 'https://.' that aren't actually valid URLs), and the `{ required,
 * pageUrl }` apiKey shape was validated independently in both manifest.ts
 * and catalog.ts with near-identical logic and different error wording.
 *
 * Nothing here is addon-domain-specific - these are the primitives the
 * DAD-specific validators in the other modules are built from.
 */

/**
 * True only for a well-formed HTTPS URL. Uses `new URL()` rather than a
 * regex prefix check, so a string that merely STARTS WITH 'https://' but
 * isn't actually parseable (e.g. 'https://.') is correctly rejected.
 */
export function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Same as `isHttpsUrl`, but also rejects a query string or fragment - for
 * fields like `baseUrl` where the value must be a bare origin+path, not
 * something carrying `?token=...` or `#fragment`.
 */
export function isBareHttpsUrl(value: unknown): value is string {
  if (!isHttpsUrl(value)) return false;
  const u = new URL(value as string);
  return u.search === '' && u.hash === '';
}

/**
 * Validates the `{ required: boolean, pageUrl: <https url> }` apiKey shape
 * shared by manifest.ts (an addon's own apiKey field) and catalog.ts (a
 * catalog entry's apiKey field). `label` prefixes each error so call sites
 * can say `apiKey` or `addons[3].apiKey` as fits their context.
 */
export function validateApiKeyShape(value: unknown, label = 'apiKey'): string[] {
  const errors: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    errors.push(`'${label}' must be an object with 'required' (boolean) and 'pageUrl' (https string)`);
    return errors;
  }
  const ak = value as Record<string, unknown>;
  if (typeof ak.required !== 'boolean') {
    errors.push(`'${label}.required' must be a boolean`);
  }
  if (!isHttpsUrl(ak.pageUrl)) {
    errors.push(`'${label}.pageUrl' must be an HTTPS URL`);
  }
  return errors;
}

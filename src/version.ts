/**
 * DAD addon versioning.
 *
 * A DAD manifest version is STRICT semantic `major.minor.patch` (e.g. "2.1.0"),
 * nothing else - no prerelease suffixes, no single "2", no "v2.1".
 *
 * There is exactly ONE version per addon: the `version` inside the addon's own
 * `manifest.json`, which is what Delulu Core acts on after fetching and
 * validating it at install time. A catalog's `version` field is a DISCOVERY
 * copy - it lets a client list "2.1.0 available" without fetching every
 * manifest - so a publisher must keep it in step with the manifest. This module
 * only validates the format; deciding whether an update is a legal bump belongs
 * to the catalog, not to the SDK.
 */

// No leading zeros on any segment (matches strict semver: '01.2.0' is
// invalid, only '1.2.0' is) - each segment is either the single digit '0'
// or a non-zero digit followed by any digits.
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True when `version` is a strict `major.minor.patch` semantic version string. */
export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}
/**
 * DAD addon versioning.
 *
 * A DAD manifest version is STRICT semantic `major.minor.patch` (e.g. "2.1.0"),
 * nothing else - no prerelease suffixes, no single "2", no "v2.1".
 *
 * There is exactly ONE version per addon: the `version` inside the addon's own
 * `manifest.json`, which is what Delulu Core acts on after fetching and
 * validating it at install time. This module only validates the format.
 */

// No leading zeros on any segment (matches strict semver: '01.2.0' is
// invalid, only '1.2.0' is) - each segment is either the single digit '0'
// or a non-zero digit followed by any digits.
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True when `version` is a strict `major.minor.patch` semantic version string. */
export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}
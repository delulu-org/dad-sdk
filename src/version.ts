/**
 * DAD addon versioning.
 *
 * A DAD manifest version is STRICT semantic `major.minor.patch` (e.g. "2.1.0"),
 * nothing else - no prerelease suffixes, no single "2", no "v2.1".
 *
 * Publishing an UPDATE REQUIRES a strict increase over the last PUBLISHED
 * version of the same addon id. The catalog is the sole source of truth for
 * that "previous" value, so these helpers never guess: the caller (dad_build
 * / CI) injects the last published version, or passes null for a FIRST
 * publish. No catalog entry for the id === first publish === allowed.
 */

// No leading zeros on any segment (matches strict semver: '01.2.0' is
// invalid, only '1.2.0' is) - each segment is either the single digit '0'
// or a non-zero digit followed by any digits.
export const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** True when `version` is a strict `major.minor.patch` semantic version string. */
export function isValidVersion(version: string): boolean {
  return VERSION_RE.test(version);
}

/** Compares two `major.minor.patch` strings: -1 (a<b), 0 (a==b), 1 (a>b). */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  if (a === b) return 0;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return -1;
    if (pa[i] > pb[i]) return 1;
  }
  return 0;
}

/**
 * True when `current` may be published given the previously published
 * version of the SAME addon id:
 * - previous === null/undefined -> FIRST publish, always allowed
 * - otherwise -> strict increase required (equal or lower = rejected)
 *
 * Malformed versions THROW instead of failing silently, so a typo (or a
 * forgotten bump) fails the publish hard rather than passing quietly.
 */
export function isVersionBump(current: string, previous: string | null | undefined): boolean {
  if (!isValidVersion(current)) {
    throw new TypeError(`Invalid manifest version '${current}' - must be 'major.minor.patch' (e.g. '2.1.0')`);
  }
  if (previous == null) return true;
  if (!isValidVersion(previous)) {
    throw new TypeError(`Invalid previous published version '${previous}' - must be 'major.minor.patch'`);
  }
  return compareVersions(current, previous) > 0;
}
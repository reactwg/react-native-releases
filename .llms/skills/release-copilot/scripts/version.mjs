/**
 * Version arithmetic for React Native release series.
 *
 * Ported from rn-release-automator/src/utils/version.js so the skill does not
 * depend on an interactive CLI. Keep behaviour in sync if that file changes.
 */

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

export function parseVersion(version) {
  const m = VERSION_RE.exec(String(version ?? '').trim());
  if (!m) {
    return null;
  }
  const [, major, minor, patch, rc] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    rc: rc == null ? null : Number(rc),
  };
}

export function formatVersion(v) {
  const base = `${v.major}.${v.minor}.${v.patch}`;
  return v.rc == null ? base : `${base}-rc.${v.rc}`;
}

export function isValidVersion(version) {
  return parseVersion(version) != null;
}

export function seriesOf(v) {
  return `${v.major}.${v.minor}`;
}

export function stableBranch(v) {
  return `${seriesOf(v)}-stable`;
}

export function isPrerelease(v) {
  return v.rc != null;
}

export function nextRC(v) {
  return {...v, patch: 0, rc: (v.rc ?? -1) + 1};
}

export function nextPatch(v) {
  return {...v, patch: v.patch + 1, rc: null};
}

export function promoteToStable(v) {
  return {...v, patch: 0, rc: null};
}

export function nextMinor(v) {
  return {major: v.major, minor: v.minor + 1, patch: 0, rc: null};
}

export function compareVersions(a, b) {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  if (a.patch !== b.patch) {
    return a.patch - b.patch;
  }
  // A stable release sorts above any rc of the same number.
  if (a.rc == null && b.rc == null) {
    return 0;
  }
  if (a.rc == null) {
    return 1;
  }
  if (b.rc == null) {
    return -1;
  }
  return a.rc - b.rc;
}

export function versionsInSeries(versions, series) {
  return versions
    .map(parseVersion)
    .filter(v => v != null && seriesOf(v) === series)
    .sort(compareVersions);
}

export function latestInSeries(versions, series) {
  const inSeries = versionsInSeries(versions, series);
  return inSeries.length > 0 ? inSeries[inSeries.length - 1] : null;
}

/**
 * The release shape implied by moving from `current` to `next`.
 * Drives which phase definition the runner uses.
 */
export function releaseShape(current, next) {
  if (current == null) {
    return 'branch-cut';
  }
  if (isPrerelease(current) && isPrerelease(next)) {
    return 'rc';
  }
  if (isPrerelease(current) && !isPrerelease(next)) {
    return 'promote';
  }
  return 'patch';
}

/**
 * The last RC a series actually shipped, from its tags.
 *
 * Only meaningful once the series has released: while it is in flight the last
 * RC so far is not the golden one, it is just the most recent. Observed range
 * across 0.82-0.87 is rc.3 to rc.7, so it cannot be predicted.
 */
export function lastRcFromTags(tags, series) {
  const re = new RegExp(`^v${series.replace('.', '\\.')}\\.0-rc\\.(\\d+)$`);
  const nums = tags.map(t => re.exec(t)).filter(Boolean).map(m => Number(m[1]));
  return nums.length ? Math.max(...nums) : null;
}

export function seriesHasReleased(tags, series) {
  return tags.includes(`v${series}.0`);
}

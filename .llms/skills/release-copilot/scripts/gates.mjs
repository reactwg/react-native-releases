/**
 * Preconditions.
 *
 * Every gate is executable and returns a verdict with a reason. Gates are hard
 * stops, not warnings. Several of these exist because of specific incidents
 * during 0.88; the comments name them so nobody removes a gate thinking it is
 * theoretical.
 */

import {parseVersion, isPrerelease, seriesOf} from './version.mjs';

const PASS = detail => ({ok: true, detail});
const FAIL = detail => ({ok: false, detail});

/**
 * Failures we have repeatedly confirmed are unrelated to the change under test.
 * Being on this list makes a failure *retryable*, never ignorable.
 */
export const FLAKE_SIGNATURES = [
  {
    id: 'rubygems-dns',
    match: /UnknownHostError|Could not download gem|rubygems\.org/i,
    reason: 'rubygems.org DNS failure on the runner',
  },
  {
    id: 'missing-artifact',
    match: /Artifact not found for name/i,
    reason: 'artifact missing because an upstream build job failed; fix that job, not this one',
  },
];

/**
 * Structural failures: real, reproducible and not fixed by retrying.
 * `cache-key-test` was one of these on every release branch until it was fixed.
 */
export const STRUCTURAL_SIGNATURES = [
  {
    id: 'release-branch-only-test',
    match: /cache-key-test/i,
    reason: 'test asserts main-build behaviour and cannot pass on a release branch',
  },
];

export function classifyFailure(text) {
  for (const s of STRUCTURAL_SIGNATURES) {
    if (s.match.test(text)) {
      return {kind: 'structural', id: s.id, reason: s.reason, retryable: false};
    }
  }
  for (const s of FLAKE_SIGNATURES) {
    if (s.match.test(text)) {
      return {kind: 'flake', id: s.id, reason: s.reason, retryable: true};
    }
  }
  return {kind: 'unknown', id: null, reason: 'not a known signature, investigate before retrying', retryable: false};
}

export const gates = {
  ciGreen(state) {
    const red = state.ci.filter(r => r.conclusion === 'failure');
    const running = state.ci.filter(r => r.status !== 'completed');
    if (running.length) {
      return FAIL(`CI still running: ${running.map(r => r.workflow).join(', ')}`);
    }
    if (!red.length) {
      return PASS(`${state.ci.length} workflow(s) green on ${state.branchTip?.slice(0, 11)}`);
    }
    const jobs = red.flatMap(r => r.failedJobs);
    return FAIL(`failing: ${jobs.join(', ')}. Classify each before proceeding, do not blanket-retry`);
  },

  noOpenPicks(state) {
    if (!state.openPicks.length) {
      return PASS('no open pick requests for this series');
    }
    return FAIL(
      `open picks: ${state.openPicks.map(p => `#${p.number}`).join(', ')}. Action or defer each before releasing`,
    );
  },

  /**
   * create-release.yml guards publishing behind `if:` on branch shape and tag
   * absence. A failed guard produces a GREEN run that did nothing, so these are
   * checked up front rather than inferred from the run conclusion afterwards.
   */
  branchShape(state) {
    return /^0\.\d+-stable$/.test(state.branch)
      ? PASS(`${state.branch} matches the release-branch pattern`)
      : FAIL(`${state.branch} does not match ^0\\.[0-9]+-stable$, the workflow would silently skip`);
  },

  tagFree(state) {
    return state.tagExistsForNext
      ? FAIL(`v${state.proposedNext} already exists, the workflow would silently skip`)
      : PASS(`v${state.proposedNext} is free`);
  },

  /**
   * The workflow's dry-run input defaults to TRUE. Forgetting it produces a
   * green run that publishes nothing.
   */
  dryRunExplicit(_state, {workflowDryRun}) {
    return workflowDryRun === false
      ? PASS('workflow dry-run input explicitly false')
      : FAIL('workflow dry-run input must be explicitly false, it defaults to true');
  },

  /** `latest` belongs to the newest stable line, never to an RC. */
  distTagCorrect(state, {isLatest}) {
    const next = parseVersion(state.proposedNext ?? '');
    if (!next) {
      return FAIL('no next version resolved');
    }
    if (isPrerelease(next) && isLatest) {
      return FAIL(`${state.proposedNext} is a prerelease and must not take the latest tag`);
    }
    if (!isPrerelease(next) && !isLatest) {
      return PASS(`stable release not taking latest, confirm that is intended for ${seriesOf(next)}`);
    }
    return PASS(isLatest ? 'stable release taking latest' : 'prerelease going to next');
  },

  hermesConsistent(state) {
    const {pinned, compiler} = state.hermes;
    if (!pinned || !compiler) {
      return FAIL(`could not read Hermes pins (version.properties=${pinned}, package.json=${compiler})`);
    }
    return pinned === compiler
      ? PASS(`Hermes pinned consistently at ${pinned}`)
      : FAIL(`Hermes mismatch: version.properties=${pinned} but package.json=${compiler}`);
  },

  /**
   * A non-breaking series must not carry [BREAKING]-annotated commits.
   *
   * This exists because #57879 shipped in 0.88.0-rc.0 while correctly annotated
   * [IOS] [BREAKING] and published in the changelog's Breaking section saying
   * modules would stop compiling. The annotation was right; nothing read it.
   */
  noBreakingChanges(state) {
    if (!state.schedule.isNonBreaking) {
      return PASS(`${state.series} is a breaking release, no restriction`);
    }
    const bc = state.breakingCommits;
    if (bc == null) {
      return FAIL(
        state.breakingScanComplete === false
          ? 'commit range was truncated, so the scan is incomplete and cannot be trusted. ' +
            'Re-run with pagination or scan locally with git log'
          : 'could not enumerate commits to check for [BREAKING] annotations',
      );
    }
    if (bc.length === 0) {
      return PASS(`no [BREAKING] commits since ${state.current}`);
    }
    return FAIL(
      `${state.series} is non-breaking and carries ${bc.length} [BREAKING] commit(s) NOT present in ` +
        `${state.breakingBaseline}: ` +
        bc.map(c => `${c.sha} ${c.title}`).join('; ') +
        `. Each needs a verdict: it is only a real break if the affected API was REACHABLE in ` +
        `${state.breakingBaseline}, per generator target. Revert or record a reviewed exception. ` +
        'See reference/breaking-changes.md',
    );
  },

  breakingWindow(state, {isBreaking}) {
    if (!isBreaking) {
      return PASS('change is not breaking');
    }
    const s = state.schedule.series;
    if (!s) {
      return FAIL('series not in the schedule, extend reference/schedule.json');
    }
    return s.type === 'breaking'
      ? PASS(`${state.series} is a breaking release`)
      : FAIL(`${state.series} is non-breaking, a breaking change must not ship in it`);
  },
};

export async function evaluate(names, state, ctx = {}) {
  const results = [];
  for (const name of names) {
    const fn = gates[name];
    if (!fn) {
      throw new Error(`unknown gate: ${name}`);
    }
    results.push({gate: name, ...(await fn(state, ctx))});
  }
  return {
    passed: results.every(r => r.ok),
    results,
  };
}

export function formatGates(evaluated) {
  return evaluated.results
    .map(r => `  ${r.ok ? 'ok  ' : 'FAIL'}  ${r.gate.padEnd(18)} ${r.detail}`)
    .join('\n');
}

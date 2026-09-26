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

/**
 * Surfaces where a change can break a consumer who does not touch their code.
 *
 * Derived from what actually broke 0.88, not from a guess. Both real breaks
 * (#57879, #58063) changed the codegen generators or parsers, which is what RN
 * emits or accepts for third-party specs. An annotation check alone would have
 * missed #58063, which carried no [BREAKING] tag.
 *
 * `removalOnly` surfaces flag only when lines are deleted, since adding to a
 * public surface is additive and safe. Without that, every additive pick trips
 * the gate and people learn to skip it.
 */
export const BREAKING_SURFACES = [
  {
    id: 'codegen-contract',
    match: /^packages\/react-native-codegen\/src\/(generators|parsers)\//,
    ignore: /__tests__|__test_fixtures__|__snapshots__/,
    removalOnly: false,
    why: 'changes what codegen emits or accepts for third-party specs, per generator target',
  },
  {
    id: 'cxx-api-snapshot',
    match: /^scripts\/cxx-api\/api-snapshots\//,
    removalOnly: true,
    why: 'removes entries from the exported C++ API surface',
  },
  {
    id: 'public-types',
    match: /(types_DEPRECATED\/|ReactNativeApi\.d\.ts$|index\.js\.flow$)/,
    removalOnly: true,
    why: 'removes from the public type surface',
  },
  {
    id: 'version-floor',
    match: /(libs\.versions\.toml$|\.podspec$)/,
    removalOnly: true,
    why: 'moves a dependency or platform floor that consumers resolve against',
  },
];

/** Surfaces a candidate touches that could break a consumer. Evidence, not a verdict. */
export function breakingSurfaces(files) {
  const hits = [];
  for (const s of BREAKING_SURFACES) {
    const matched = (files ?? []).filter(
      f => s.match.test(f.f) && !(s.ignore && s.ignore.test(f.f)) && (!s.removalOnly || f.d > 0),
    );
    if (matched.length) {
      hits.push({id: s.id, why: s.why, files: matched.map(f => f.f)});
    }
  }
  return hits;
}

/** True only for a real annotation, never the changelog template. */
export function hasBreakingTag(message) {
  const withoutComments = String(message ?? '').replace(/<!--[\s\S]*?-->/g, '');
  return [...withoutComments.matchAll(/\[([^\]]*)\]/g)].some(
    m => !m[1].includes('|') && /^\s*BREAKING\s*$/i.test(m[1]),
  );
}

export const gates = {
  ciGreen(state) {
    const red = state.ci.filter(r => r.conclusion === 'failure');
    const running = state.ci.filter(r => r.status !== 'completed');
    if (running.length) {
      return FAIL(`CI still running: ${running.map(r => r.workflow).join(', ')}`);
    }
    const stale = state.staleRed ?? [];
    if (!red.length && stale.length) {
      return FAIL(
        `tip is green but ${stale.length} workflow(s) are red on an earlier commit and have not re-run: ` +
          stale.map(s2 => `${s2.workflow} (${s2.sha})`).join('; ') +
          '. Path-filtered workflows skip commits that do not touch their paths, so this is still red.',
      );
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

  /**
   * A [BREAKING] annotation, ignoring the changelog template.
   *
   * PR bodies carry `[ANDROID|GENERAL|IOS|INTERNAL] [BREAKING|ADDED|...]` as a
   * fill-in-the-blank comment. Matching that produced a false positive on a
   * plain androidx patch bump, so brackets containing a pipe do not count and
   * HTML comments are stripped first.
   */
  hermesCurrent(state) {
    const h = state.hermesUnreleased;
    if (h == null) {
      return FAIL('could not determine whether the pinned Hermes tag is current');
    }
    if (!h.resolved) {
      return FAIL(`could not compare ${h.tag} against ${h.branch} on facebook/hermes`);
    }
    if (h.commits.length === 0) {
      return PASS(`${h.tag} is current with ${h.branch}`);
    }
    const relands = h.commits.filter(c => c.reland);
    // Say what a dispatch would produce right now, not just that one is needed.
    const cutNote = h.wouldRecut
      ? ` NOTE: npm/hermes-compiler/package.json on ${h.branch} still reads ${h.inTreeVersion}, which is already released, so dispatching now would re-cut it. Land a version bump PR first; the stable ref is protected and rejects direct pushes.`
      : h.inTreeVersion
        ? ` A release dispatched now would cut ${h.inTreeVersion}.`
        : '';
    return FAIL(
      `${h.commits.length} commit(s) on ${h.branch} are not in the pinned ${h.tag}: ` +
        h.commits.map(c => `${c.sha} ${c.subject}`).join('; ') +
        (relands.length
          ? `. ${relands.length} of these RE-LAND a previously backed-out change, which needs a human decision before pinning.`
          : '') +
        ' Cut a Hermes release and bump the pin or record why the branch is deliberately ahead.' +
        cutNote,
    );
  },

  /**
   * Assess pick CANDIDATES before they land.
   *
   * noBreakingChanges scans what is already on the branch, so on its own it can
   * only catch a breaking change after it has been picked and pushed. That is
   * how three of them reached 0.88.
   */
  picksNotBreaking(state) {
    if (!state.schedule.isNonBreaking) {
      return PASS(`${state.series} is a breaking release, no restriction on candidates`);
    }
    const cands = state.pickCandidates;
    if (cands == null) {
      return state.openPicks.length === 0
        ? PASS('no open picks to assess')
        : FAIL('could not resolve the open pick requests to commits, so they cannot be assessed');
    }

    // A pick request stays open until someone closes it, so an open issue can
    // already be on the branch. Its decision was made when it was picked; only
    // the bookkeeping is outstanding and re-assessing it as a candidate blocks
    // the release on a choice that was already taken.
    const landed = cands.filter(c => c.landed);
    const pending = cands.filter(c => !c.landed);

    const unresolved = pending.filter(c => c.resolved.length === 0);
    const annotated = pending.filter(c => c.resolved.some(r => hasBreakingTag(r.message)));

    if (annotated.length) {
      return FAIL(
        `${annotated.length} open pick(s) carry a [BREAKING] annotation and ${state.series} is non-breaking: ` +
          annotated.map(c => `#${c.number} ${c.title}`).join('; ') +
          '. Do not pick without a reviewed exception. See reference/breaking-changes.md',
      );
    }

    // The annotation is necessary but not sufficient: #58063 broke C++ codegen
    // consumers with no [BREAKING] tag at all. Inspect what the change touches.
    const touching = pending
      .map(c => ({
        c,
        hits: c.resolved.flatMap(r => breakingSurfaces(r.files)),
      }))
      .filter(x => x.hits.length);

    if (touching.length) {
      return FAIL(
        `${touching.length} open pick(s) touch a surface where a break would not be annotated: ` +
          touching
            .map(
              x =>
                `#${x.c.number} (${x.hits.map(h => `${h.id}: ${h.files.join(', ')}`).join('; ')})`,
            )
            .join('; ') +
          '. This is a trigger to inspect, not a verdict. Run the reachability test per generator ' +
          'target from reference/breaking-changes.md, then record the outcome.',
      );
    }
    if (unresolved.length) {
      return FAIL(
        `could not resolve ${unresolved.length} pick(s) to a commit, so they are unassessed: ` +
          unresolved.map(c => `#${c.number}`).join(', ') +
          '. Resolve them by hand before picking; an unassessed candidate is not a passing one.',
      );
    }
    const note = landed.length
      ? ` ${landed.length} already landed and only need closing: ${landed.map(c => `#${c.number}`).join(', ')}`
      : '';
    return PASS(
      `${pending.length} candidate(s) assessed: no [BREAKING] annotation and none touch a watched surface.` +
        note,
    );
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

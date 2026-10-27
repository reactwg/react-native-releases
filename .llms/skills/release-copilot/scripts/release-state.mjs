/**
 * Derives "where are we in this release?" from live sources only.
 *
 * There is deliberately no persisted state. Everything here is recomputed on
 * every run, so the answer cannot drift from reality while someone is mid
 * release. The cost is a handful of API calls at startup.
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';
import {
  lastRcFromTags,
  seriesHasReleased,
  parseVersion,
  formatVersion,
  seriesOf,
  stableBranch,
  latestInSeries,
  nextRC,
  nextPatch,
  promoteToStable,
  releaseShape,
  isPrerelease,
} from './version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEDULE_PATH = join(HERE, '..', 'reference', 'schedule.json');
const EXCEPTIONS_PATH = join(HERE, '..', 'reference', 'breaking-exceptions.json');
const HERMES_EXCEPTIONS_PATH = join(HERE, '..', 'reference', 'hermes-exceptions.json');
const PICK_DEFERRALS_PATH = join(HERE, '..', 'reference', 'pick-deferrals.json');

export function loadBreakingExceptions(series) {
  try {
    const d = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
    return (d.exceptions ?? []).filter(e => e.series === series);
  } catch {
    return [];
  }
}

/**
 * The recorded decision not to cut Hermes for this series, if there is one.
 *
 * Keyed by commit rather than by series, so a commit landing after the
 * decision was taken turns the gate red again instead of inheriting someone
 * else's judgement about different code.
 */
/**
 * Pick numbers the captain has triaged out of this exact version.
 *
 * Scoped to the version it was deferred FROM, so the decision does not leak
 * into the next release: rc.6 re-asks. The board's Target Release is the
 * preferred record; this covers the case where the board has no option for
 * the target yet.
 */
export function loadPickDeferrals(series, fromVersion) {
  try {
    const d = JSON.parse(readFileSync(PICK_DEFERRALS_PATH, 'utf8'));
    const entry = (d.deferrals ?? []).find(
      e => e.series === series && e.deferredFrom === fromVersion,
    );
    return entry ? {to: entry.deferredTo, numbers: (entry.picks ?? []).map(p => p.number)} : null;
  } catch {
    return null;
  }
}

/** Every recorded deferral of one pick in a series, oldest first. */
export function pickDeferralHistory(series, number) {
  try {
    const d = JSON.parse(readFileSync(PICK_DEFERRALS_PATH, 'utf8'));
    return (d.deferrals ?? [])
      .filter(e => e.series === series && (e.picks ?? []).some(p => p.number === number))
      .map(e => ({from: e.deferredFrom, to: e.deferredTo, reviewedOn: e.reviewedOn}));
  } catch {
    return [];
  }
}

/**
 * "Not picked for <version>" lives as a comment on the pick request, written
 * by the copilot's `drop` command, so the reason and the decision are in the
 * same public place. Only comments from people with write access count: anyone
 * can comment on an issue and a pasted marker must not defer someone's fix.
 */
const NOT_PICKED = /<!--\s*release-copilot:\s*not-picked\s+for=(\S+)\s+to=(\S+)\s*-->/;
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function notPickedMarker(version, to) {
  return `<!-- release-copilot: not-picked for=${version} to=${to} -->`;
}

export function notPickedFor(issue, version) {
  const hits = (issue?.comments ?? [])
    .filter(c => TRUSTED.has(c.authorAssociation ?? c.association))
    .map(c => ({m: NOT_PICKED.exec(c.body ?? ''), c}))
    .filter(x => x.m && x.m[1] === version);
  const last = hits.at(-1);
  return last ? {for: last.m[1], to: last.m[2], url: last.c.url ?? null, at: last.c.createdAt ?? null} : null;
}

/** Decisions taken for other releases of the series, shown as context only. */
export function hermesPriorDecisions(series, payloadShas, version) {
  try {
    const d = JSON.parse(readFileSync(HERMES_EXCEPTIONS_PATH, 'utf8'));
    return (d.exceptions ?? [])
      .filter(e => e.series === series && e.version !== version)
      .map(e => {
        const ack = (e.acknowledged ?? []).map(a => a.sha);
        return {
          version: e.version,
          decision: e.decision,
          reason: e.reason,
          reviewedBy: e.reviewedBy,
          reviewedOn: e.reviewedOn,
          covered: payloadShas.filter(sha => ack.some(a => sha.startsWith(a) || a.startsWith(sha))).length,
        };
      });
  } catch {
    return [];
  }
}

/**
 * Scoped to the version the decision was taken for, so a patch re-asks: a
 * "do not cut Hermes" taken to keep a golden RC stable says nothing about
 * whether the next patch should ship the same fixes.
 */
export function loadHermesException(series, payloadShas, version) {
  let entry;
  try {
    const d = JSON.parse(readFileSync(HERMES_EXCEPTIONS_PATH, 'utf8'));
    entry = (d.exceptions ?? []).find(e => e.series === series && e.version === version);
  } catch {
    return null;
  }
  if (!entry) {
    return null;
  }
  const ack = (entry.acknowledged ?? []).map(a => a.sha);
  const covers = sha => ack.some(a => sha.startsWith(a) || a.startsWith(sha));
  const unacknowledged = payloadShas.filter(sha => !covers(sha));
  return {...entry, unacknowledged};
}

/**
 * What kind of change a Hermes commit is, so the captain can tell a branch of
 * fixes (cut a release for the patch) from one carrying features (a patch would
 * reject those as picks). A lean from the text, never a verdict: anything the
 * subject and description do not settle is `unclear`.
 *
 * Evidence from the stable branch wins over the text. A graft can carry only
 * part of its original, so a commit described as a behaviour change can be one
 * that adds code nothing on the branch calls.
 */
export function classifyHermesCommit({subject = '', body = ''}, evidence = null) {
  if (evidence?.inert) {
    return {kind: 'inert'};
  }
  const t = (/^Graft "(.+)" to /.exec(subject)?.[1] ?? subject)
    .replace(/^(\[[^\]]+\]\s*)+/, '')
    .replace(/^(pick|easy):\s*/i, '');
  if (/\bCI\b|\bgithub actions?\b|\bworkflows?\b|\bVS 20\d\d\b/i.test(t)) {
    return {kind: 'infra'};
  }
  if (/\btests?\b/i.test(t)) {
    return {kind: 'test'};
  }
  if (/^(fix|revert|back out)\b|\b(fix|fixes|fixed|bug|crash|regression|leak|out-of-bounds)\b/i.test(t)) {
    return {kind: 'fix'};
  }
  if (/^(adds?|introduces?|supports?|detects?|implements?|enables?|exposes?|allows?)\b|\bnew (api|feature|option)\b/i.test(t)) {
    return {kind: 'feature'};
  }
  // "Forward String::length in RuntimeDecorator" names no fix, but its
  // description calls the gap an oversight that gives wrong answers.
  if (/\b(oversight|missed rather|bug|fix(es|ed)?|race|wrong answers?|regression|crash)\b/i.test(body)) {
    return {kind: 'fix', fromBody: true};
  }
  return {kind: 'unclear'};
}

const HERMES_KINDS = ['fix', 'feature', 'test', 'infra', 'inert', 'unclear'];

/** What the branch evidence says about a commit, in a line the captain can check. */
export function hermesEvidenceNote(ev) {
  if (!ev) {
    return null;
  }
  const notes = [];
  if (ev.inert) {
    notes.push(`adds ${ev.defs.map(d => `${d.name}()`).join(', ')}, which nothing on the branch calls, so it changes no behaviour here`);
  }
  if (ev.platforms?.claimsMore) {
    notes.push(
      `its message names ${ev.platforms.named.join(', ')} but on this branch it only touches ${ev.platforms.touched.join(', ') || 'other'} code`,
    );
  }
  return notes.length ? notes.join('; ') : null;
}

export function hermesOverview(hu, evidence = null) {
  const payload = (hu?.commits ?? []).filter(c => !c.versionBump);
  const commits = payload.map(c => {
    const ev = evidence?.commits?.[c.sha] ?? null;
    return {...c, ...classifyHermesCommit(c, ev), note: hermesEvidenceNote(ev)};
  });
  const counts = Object.fromEntries(HERMES_KINDS.map(k => [k, commits.filter(c => c.kind === k).length]));
  const tally = HERMES_KINDS.filter(k => counts[k]).map(k => `${counts[k]} ${k}`).join(', ');
  return {commits, counts, tally, evidenced: Boolean(evidence)};
}

/** The cut-or-not choice in plain words. The decision stays with the captain. */
export function hermesChoice(overview, {proposedNext, pinned} = {}) {
  const {commits, counts} = overview;
  if (!commits.length) {
    return null;
  }
  const target = proposedNext ?? 'this release';
  const stay = `ship ${target} on ${pinned ?? 'the pinned tag'} and record why in reference/hermes-exceptions.json`;
  if (counts.feature) {
    return (
      `${counts.feature} feature(s) would ship with a cut, which the pick criteria reject after RC1 (criterion 10). ` +
      `Captain's call: cut anyway, or ${stay}.`
    );
  }
  if (counts.fix === commits.length) {
    return `Every commit reads as a fix, so cutting a Hermes release for ${target} is the natural call. Or ${stay}.`;
  }
  const riders = counts.test + counts.infra + counts.inert;
  if (counts.fix && counts.fix + riders === commits.length) {
    return (
      `Every commit that changes behaviour is a fix (${counts.fix}); the other ${riders} are tests, infra or code nothing calls. ` +
      `Cutting a Hermes release for ${target} is the natural call. Or ${stay}.`
    );
  }
  return (
    `${counts.fix} fix(es)` +
    (riders ? `, ${riders} test, infra or uncalled commit(s) that ride along` : '') +
    (counts.unclear ? `, ${counts.unclear} unclear that need reading first` : '') +
    `. Captain's call: cut a Hermes release for ${target}, or ${stay}.`
  );
}

/**
 * Only RC0, RC1 and the golden RC get a manual test pass, per the release
 * process guide. A stable `.0` is promoted from the golden RC with nothing new
 * in it, so that RC's pass covers it. Patches are not manually tested.
 *
 * For an in-flight series the golden RC is assumed to be `expectedGoldenRc`
 * (rc.4) unless the captain says otherwise. That is the captain's standing
 * instruction, so it is an answer rather than a refusal. It stays a stated
 * assumption in the output, because measured from tags the real golden landed
 * anywhere from rc.3 to rc.7 across 0.82 to 0.87.
 */
export function requiresManualTesting(state, version) {
  const m = /^\d+\.\d+\.\d+(?:-rc\.(\d+))?$/.exec(version ?? '');
  if (!m) {
    return true; // unknown shape, assume it needs testing rather than skipping it
  }
  const rc = m[1] == null ? null : Number(m[1]);
  if (rc == null) {
    return false; // a stable .0 or a patch
  }
  const listed = state.schedule?.manualTestingRcs ?? [0, 1];
  if (listed.includes(rc)) {
    return true;
  }
  const golden = state.schedule?.goldenRc;
  if ((golden?.source === 'tags' || golden?.source === 'content') && golden.value != null) {
    return rc === golden.value;
  }
  const expected = state.schedule?.expectedGoldenRc;
  if (expected != null) {
    return rc === expected;
  }
  return null; // no released tags and no standing default
}

const HERMES_VERSION_FILE = 'packages/react-native/sdks/hermes-engine/version.properties';
const RN_PACKAGE_JSON = 'packages/react-native/package.json';

export function loadSchedule() {
  return JSON.parse(readFileSync(SCHEDULE_PATH, 'utf8'));
}

/**
 * The series `main` currently feeds is the first whose branch cut is still in
 * the future. Computed, never stored, because a stored verdict goes wrong the
 * moment a branch cut passes.
 */
export function mainTargets(schedule, today) {
  const t = today ?? new Date().toISOString().slice(0, 10);
  return schedule.series.find(s => s.branchCut > t) ?? null;
}

export function scheduleFor(schedule, series) {
  return schedule.series.find(s => s.version === series) ?? null;
}

export function breakingAllowedOnMain(schedule, today) {
  const target = mainTargets(schedule, today);
  if (!target) {
    return {allowed: null, reason: 'no future branch cut in the schedule, it needs extending'};
  }
  return {
    allowed: target.type === 'breaking',
    target: target.version,
    reason:
      target.type === 'breaking'
        ? `main targets ${target.version} which is breaking`
        : `main targets ${target.version} which is non-breaking, until its branch cut on ${target.branchCut}`,
  };
}

/** Jobs we have repeatedly seen fail for reasons unrelated to the change. */
function classifyRun(run, jobs) {
  // null means the jobs endpoint would not answer. Report that, rather than
  // letting an empty list stand in for "nothing failed".
  if (jobs == null) {
    return {
      runId: run.databaseId,
      workflow: run.workflowName,
      conclusion: run.conclusion,
      status: run.status,
      failedJobs: [],
      jobsUnavailable: true,
      totals: {},
    };
  }
  const failed = jobs.filter(j => j.conclusion === 'failure');
  return {
    runId: run.databaseId,
    workflow: run.workflowName,
    conclusion: run.conclusion,
    status: run.status,
    failedJobs: failed.map(j => j.name),
    totals: jobs.reduce((acc, j) => {
      const k = j.conclusion ?? j.status;
      acc[k] = (acc[k] ?? 0) + 1;
      return acc;
    }, {}),
  };
}

/**
 * Releases ship on Monday, weekly. Slips happen when something blocks and the
 * release then goes out on the first clear day after.
 *
 * The next expected date is derived from the last ACTUAL publish, not from the
 * milestone dates in the schedule. Those are planning targets and have been
 * observed to drift by days, which is how a confidently wrong "rc.2 is due next
 * Monday" got produced on this skill's first real use.
 */
const DAY_MS = 86400000;
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayName(iso) {
  return DAY_NAMES[new Date(`${iso}T12:00:00Z`).getUTCDay()];
}

function onOrBeforeReleaseDay(iso, releaseDay) {
  const target = DAY_NAMES.indexOf(releaseDay);
  const d = new Date(`${iso}T12:00:00Z`);
  while (d.getUTCDay() !== target) {
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return d.toISOString().slice(0, 10);
}

export function cadencePosition(schedule, lastPublishISO, todayISO) {
  if (!lastPublishISO) {
    return null;
  }
  const last = lastPublishISO.slice(0, 10);

  // A slip must not push the next release out. rc.1 shipped Tuesday 09-15 but
  // was due Monday 09-14, so the next one is due Monday 09-21, not 09-28. Snap
  // back to the intended release day before adding the cadence.
  const intended = onOrBeforeReleaseDay(last, schedule.releaseDay);
  const slipDays = Math.round((Date.parse(last) - Date.parse(intended)) / DAY_MS);

  const dueDate = new Date(`${intended}T12:00:00Z`);
  dueDate.setUTCDate(dueDate.getUTCDate() + schedule.cadenceDays);
  const due = dueDate.toISOString().slice(0, 10);
  const daysUntilDue = Math.round((Date.parse(due) - Date.parse(todayISO)) / DAY_MS);

  return {
    lastPublished: last,
    lastPublishedDay: dayName(last),
    lastIntended: intended,
    lastSlipDays: slipDays,
    releaseDay: schedule.releaseDay,
    due,
    dueDay: dayName(due),
    daysUntilDue,
    dueToday: daysUntilDue === 0,
    overdue: daysUntilDue < 0,
    daysSinceLastPublish: Math.round((Date.parse(todayISO) - Date.parse(last)) / DAY_MS),
  };
}

export async function deriveState(sources, {series, today, shape: wantShape} = {}) {
  const schedule = loadSchedule();

  const distTags = await sources.npmDistTags('react-native');
  const allVersions = await sources.npmVersions('react-native');
  const publishTimes = await sources.npmPublishTimes('react-native');

  // Infer the active series when not told: the newest series that has a
  // prerelease published, else the series behind `latest`.
  const resolvedSeries =
    series ??
    (() => {
      const next = parseVersion(distTags.next ?? '');
      if (next) {
        return seriesOf(next);
      }
      const latest = parseVersion(distTags.latest ?? '');
      return latest ? seriesOf(latest) : null;
    })();

  if (!resolvedSeries) {
    throw new Error('could not determine the active series from npm dist-tags');
  }

  const branch = `${resolvedSeries}-stable`;
  const current = latestInSeries(allVersions, resolvedSeries);

  const candidates = current
    ? {
        nextRc: formatVersion(nextRC(current)),
        promote: formatVersion(promoteToStable(current)),
        nextPatch: formatVersion(nextPatch(current)),
      }
    : {};

  const picks = await sources.openPicks(resolvedSeries);
  const board = await sources.projectItems(resolvedSeries);

  // Nothing substantive landed since the last RC
  // identical to it.
  let sinceLastRc = null;
  if (current && isPrerelease(current)) {
    try {
      const {commits, complete} = await sources.commitsBetween(`v${formatVersion(current)}`, branch);
      if (complete) {
        const substantive = commits.filter(
          c =>
            !/^\[LOCAL\]/.test(c.message) &&
            !/^Release \d+\.\d+\.\d+/.test(c.message) &&
            !/^Bump Podfile\.lock/.test(c.message),
        );
        sinceLastRc = {count: substantive.length, from: formatVersion(current)};
      }
    } catch {
      sinceLastRc = null;
    }
  }

  // The golden RC is decided by content: an RC with nothing after it and no
  // pick still aimed at the series' .0 was the last one, so the next release is
  // .0. Proposing rc.7 here after rc.6 had shipped with nothing behind it
  // contradicted the rule the rcHasContent gate enforces.
  const pickAimedAt = (p, version) => {
    if (notPickedFor(p, version)) {
      return false;
    }
    const onBoard =
      (board?.items ?? []).find(i => i.content?.number === p.number)?.['target Release'] ?? null;
    if (onBoard) {
      return onBoard === version;
    }
    return !loadPickDeferrals(resolvedSeries, version)?.numbers.includes(p.number);
  };
  // Only inside the golden window: right after an early RC nothing has landed
  // yet either, and that is not a signal the series is done.
  const lastRcWasGolden =
    current != null &&
    isPrerelease(current) &&
    schedule.expectedGoldenRc != null &&
    current.rc >= schedule.expectedGoldenRc &&
    sinceLastRc?.count === 0 &&
    !picks.some(p => pickAimedAt(p, candidates.promote));

  // Default proposal: keep going in the same shape we are already in, unless
  // the last RC was golden. An explicit --shape overrides it, because otherwise
  // `--shape promote` only changed which STEPS ran and still published the next RC.
  const byShape = {
    rc: candidates.nextRc,
    promote: candidates.promote,
    patch: candidates.nextPatch,
    'branch-cut': series ? `${series}.0-rc.0` : null,
  };
  const proposedNext =
    (wantShape ? byShape[wantShape] : null) ??
    (current
      ? isPrerelease(current)
        ? lastRcWasGolden
          ? candidates.promote
          : candidates.nextRc
        : candidates.nextPatch
      : // No release on this series yet, so the next thing is its RC0.
        (series ? `${series}.0-rc.0` : null));

  const shape =
    wantShape ??
    (current && proposedNext ? releaseShape(current, parseVersion(proposedNext)) : 'branch-cut');

  const tags = await sources.gitTags();
  const tip = await sources.branchTip(branch);
  // A branch cut needs main's SHA to create the ref. The step used to send the
  // literal string MAIN_SHA, so a guided cut would take the captain's
  // confirmation and then POST a ref with that text.
  const mainTip = shape === 'branch-cut' ? await sources.branchTip('main') : null;

  const runs = await sources.workflowRuns(branch);
  const tipRuns = runs.filter(r => r.headSha && tip && r.headSha.startsWith(tip.slice(0, 11)));

  // Path-filtered workflows do not re-run on every commit, so a workflow can be
  // red on an older commit and simply be absent from the tip. Filtering CI to
  // the tip SHA hid a red "Validate C++ API Snapshots" on the very commit that
  // shipped 0.88.0-rc.2. Track the latest run per workflow as well.
  const latestPerWorkflow = new Map();
  for (const r of runs) {
    if (!latestPerWorkflow.has(r.workflowName)) {
      latestPerWorkflow.set(r.workflowName, r);
    }
  }
  const staleRed = [...latestPerWorkflow.values()]
    .filter(r => r.conclusion === 'failure')
    .filter(r => !(tip && r.headSha && r.headSha.startsWith(tip.slice(0, 11))))
    .map(r => ({workflow: r.workflowName, sha: r.headSha.slice(0, 11), at: r.createdAt}));
  const ci = [];
  for (const run of tipRuns) {
    const jobs = await sources.workflowJobs(run.databaseId);
    ci.push(classifyRun(run, jobs));
  }

  const hermesProps = await sources.fileAt(branch, HERMES_VERSION_FILE);
  const hermesPinned = hermesProps
    ? (/HERMES_VERSION_NAME=(.+)/.exec(hermesProps)?.[1] ?? '').trim() || null
    : null;

  const rnPkgRaw = await sources.fileAt(branch, RN_PACKAGE_JSON);
  let hermesCompiler = null;
  if (rnPkgRaw) {
    try {
      hermesCompiler = JSON.parse(rnPkgRaw).dependencies?.['hermes-compiler'] ?? null;
    } catch {
      /* leave null, the gate will flag it */
    }
  }

  // Baseline for "is this breaking change NEW in this series".
  //
  // It must be the latest PUBLISHED version of the previous line, not its .0. A
  // change already shipped in 0.87.1 went out on the breaking 0.87 line, so it is
  // not something 0.88 introduces and consumers upgrading already have it.
  const prevSeriesLatest = (() => {
    const cur = parseVersion(distTags.latest ?? '');
    if (!cur) {
      return null;
    }
    const s = seriesOf(cur);
    if (s === resolvedSeries) {
      return null;
    }
    // Empty on a fresh checkout or a series with nothing published yet, which
    // is exactly the branch-cut case.
    const latest = latestInSeries(allVersions, s);
    return latest ? `v${formatVersion(latest)}` : null;
  })();

  // A patch only adds what landed since the release it patches, so that tag is
  // its baseline. Once `.0` is out `latest` belongs to this series, so the
  // previous-series baseline came out null and the scan silently never ran.
  const breakingBaseline =
    shape === 'patch' && current && !isPrerelease(current)
      ? `v${formatVersion(current)}`
      : prevSeriesLatest;
  // No baseline means nothing was scanned, which must not read as clean.
  let breakingCommits = breakingBaseline ? [] : null;
  let breakingScanComplete = null;
  let breakingExceptions = [];

  if (breakingBaseline) {
    try {
      const {commits, complete} = await sources.commitsBetween(breakingBaseline, branch);
      breakingScanComplete = complete;

      if (!complete) {
        // Refuse to judge on a partial range. A short read here produced a
        // confidently clean verdict over a 554-commit range that the compare
        // endpoint truncated to 250.
        breakingCommits = null;
      } else {
        // A revert means the branch no longer carries it.
        const reverted = new Set();
        for (const c of commits) {
          const m = /This reverts commit ([0-9a-f]{7,40})/.exec(c.message);
          if (m) {
            reverted.add(m[1]);
          }
        }

        // Meta's import rewrites SHAs, so a change can exist on both `main` and
        // the previous release branch as different objects and `merge-base`
        // reports a false negative. The CHANGELOG cites the main-side SHA of
        // everything each version shipped, so it is the reliable test.
        //
        // It has to come from `main`: changelog entries land there, not on the
        // release branches, so a copy read at the previous tag is stale.
        // Sections are newest-first, so everything after the current series'
        // earliest heading belongs to older releases.
        const mainChangelog = (await sources.changelogAt('main')) ?? '';
        const headings = [...mainChangelog.matchAll(/^## v(\d+\.\d+)\./gm)];
        const firstOlder = headings.find(h => h[1] !== resolvedSeries);
        const shippedEarlier = firstOlder
          ? mainChangelog.slice(firstOlder.index)
          : '';

        // Subjects of commits the older releases already shipped. A change can
        // be re-landed under a second SHA (#57420 then #57476, same subject),
        // and the changelog cites only one of them, so SHA matching alone leaves
        // the superseded commit looking new.
        const shippedSubjects = new Set(
          commits
            .filter(c => shippedEarlier.includes(c.sha.slice(0, 10)))
            .map(c => c.message.split('\n')[0].trim()),
        );

        const subjectOf = c => c.message.split('\n')[0].trim();
        // Drop the trailing "(#12345)" so a re-land under a new PR number matches.
        const normalize = t => t.replace(/\s*\(#\d+\)\s*$/, '').trim();
        const shippedNormalized = new Set([...shippedSubjects].map(normalize));

        breakingCommits = commits
          .filter(c => /\[BREAKING\]/i.test(c.message))
          .filter(c => ![...reverted].some(r => r.startsWith(c.sha) || c.sha.startsWith(r)))
          .filter(c => !shippedEarlier.includes(c.sha.slice(0, 10)))
          .filter(c => !shippedNormalized.has(normalize(subjectOf(c))))
          .map(c => ({sha: c.sha.slice(0, 11), title: subjectOf(c)}));

        // Reviewed exceptions are kept visible rather than filtered away, so a
        // waved-through commit still shows up with the reason it was allowed.
        const exempt = loadBreakingExceptions(resolvedSeries);
        breakingExceptions = exempt.filter(e =>
          breakingCommits.some(c => c.sha.startsWith(e.sha) || e.sha.startsWith(c.sha)),
        );
        breakingCommits = breakingCommits.filter(
          c => !exempt.some(e => c.sha.startsWith(e.sha) || e.sha.startsWith(c.sha)),
        );
      }
    } catch {
      breakingCommits = null;
    }
  }

  // Is the pinned Hermes tag current with its branch? A consistency check
  // between the two pin files cannot answer this.
  let hermesUnreleased = null;
  if (hermesPinned) {
    try {
      hermesUnreleased = await sources.hermesUnreleased(hermesPinned);
    } catch {
      hermesUnreleased = null;
    }
  }

  // Resolve open picks to commits so candidates can be assessed before landing.
  // A pick already triaged out of this release is not a candidate for it, so
  // it is neither assessed nor allowed to block: the decision was the triage.
  const pickDeferral = loadPickDeferrals(resolvedSeries, proposedNext);
  const candidatePicks = picks.filter(
    p => !pickDeferral?.numbers.includes(p.number) && !notPickedFor(p, proposedNext),
  );

  let pickCandidates = null;
  if (candidatePicks.length) {
    try {
      pickCandidates = await sources.pickCandidates(candidatePicks, branch);
    } catch {
      pickCandidates = null;
    }
  } else {
    pickCandidates = [];
  }

  const seriesSchedule = scheduleFor(schedule, resolvedSeries);

  const nextParsed = proposedNext ? parseVersion(proposedNext) : null;

  // The golden RC is the LAST one before .0 and it is not predictable: across
  // 0.82-0.87 it landed anywhere from rc.3 to rc.7. It is only knowable once the
  // series has shipped, so for an in-flight series say unknown rather than guess.
  const released = seriesHasReleased(tags, resolvedSeries);
  const lastRc = lastRcFromTags(tags, resolvedSeries);
  // goldenByContent overrides the tags when an RC was cut after golden, as
  // 0.88's rc.6 was for a single pick.
  const goldenRc = !released
    ? {value: null, source: 'unknown'}
    : seriesSchedule?.goldenByContent != null
      ? {value: seriesSchedule.goldenByContent, source: 'content', lastRc}
      : {value: lastRc, source: 'tags'};

  // Historical spread, so the captain has context when deciding.
  const priorGolden = schedule.series
    .map(x => x.version)
    .filter(v => seriesHasReleased(tags, v))
    .map(v => {
      const lastRc = lastRcFromTags(tags, v);
      const byContent = schedule.series.find(x => x.version === v)?.goldenByContent;
      return {series: v, rc: byContent ?? lastRc, lastRc};
    })
    .filter(x => x.rc != null);

  // For an in-flight series, assume expectedGoldenRc is the golden one. That is
  // the captain's standing instruction, overridable by the captain.
  const assumedGolden =
    goldenRc.value != null ? goldenRc.value : (schedule.expectedGoldenRc ?? null);
  const isGoldenNext = nextParsed?.rc != null && assumedGolden != null && nextParsed.rc === assumedGolden;

  // The blog post draft is due from the golden RC onwards, so for a rc.5-golden
  // series it starts the moment rc.4 is out. The crew needs a week to iterate on
  // the draft and turn it into a website PR before `.0` and the captain is the
  // only person who can write the first one.
  const blogPostDue =
    shape === 'promote' ||
    (nextParsed?.rc != null && assumedGolden != null && nextParsed.rc >= assumedGolden);

  // The same rule the crew status message uses, so the gate and the message
  // cannot disagree. Null when it cannot be known, so the caller asks.
  const needsManualTesting =
    nextParsed == null
      ? null
      : requiresManualTesting(
          {schedule: {manualTestingRcs: schedule.manualTestingRcs, goldenRc, expectedGoldenRc: schedule.expectedGoldenRc}},
          proposedNext,
        );

  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const lastPublishedAt = current ? publishTimes[formatVersion(current)] ?? null : null;
  // Patches have no weekly slot: they ship when the picks are in.
  const cadence =
    shape === 'patch'
      ? lastPublishedAt
        ? {
            unscheduled: true,
            lastPublished: lastPublishedAt.slice(0, 10),
            daysSinceLastPublish: Math.round(
              (Date.parse(todayStr) - Date.parse(lastPublishedAt.slice(0, 10))) / DAY_MS,
            ),
          }
        : null
      : cadencePosition(schedule, lastPublishedAt, todayStr);
  const daysBetween = (a, b) =>
    Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

  return {
    derivedAt: new Date().toISOString(),
    sourceKind: sources.kind,
    series: resolvedSeries,
    branch,
    branchTip: tip,
    current: current ? formatVersion(current) : null,
    proposedNext,
    candidates,
    shape,
    distTags,
    mainTip,
    tagExistsForNext: proposedNext ? tags.includes(`v${proposedNext}`) : false,
    // A release is half-done when its tag is cut but npm never got the package.
    // 0.88.0-rc.4 sat like this overnight: tag public, sibling packages
    // published, react-native itself missing and nothing in the copilot could
    // say so. Re-triggering is wrong here; the publish has to be resumed.
    halfReleased: proposedNext
      ? tags.includes(`v${proposedNext}`) && !allVersions.includes(proposedNext)
      : false,
    ci,
    // Carry each pick's Target Release from the board. A pick explicitly
    // aimed at a later version is deferred, not outstanding and the board is
    // where that decision actually lives.
    openPicks: (() => {
      const deferral = loadPickDeferrals(resolvedSeries, proposedNext);
      return picks.map(p => {
        const item = (board?.items ?? []).find(i => i.content?.number === p.number);
        const onBoard = item?.['target Release'] ?? null;
        // The board wins when it says anything. The recorded deferral is the
        // fallback for a target the board cannot express yet.
        const recorded = deferral?.numbers.includes(p.number) ? deferral.to : null;
        // A "not picked" comment is the newest decision there is, so it wins
        // over a board target that was only ever the default.
        const notPicked = notPickedFor(p, proposedNext);
        return {
          number: p.number,
          title: p.title,
          targetRelease: notPicked?.to ?? onBoard ?? recorded,
          targetOnBoard: onBoard,
          notPicked,
        };
      });
    })(),
    board,
    hermes: {pinned: hermesPinned, compiler: hermesCompiler},
    hermesUnreleased,
    // A recorded decision not to cut Hermes for this series. Null when there
    // is none, which is the normal case.
    hermesException: loadHermesException(
      resolvedSeries,
      (hermesUnreleased?.commits ?? []).filter(c => !c.versionBump).map(c => c.sha),
      proposedNext,
    ),
    hermesPriorDecisions: hermesPriorDecisions(
      resolvedSeries,
      (hermesUnreleased?.commits ?? []).filter(c => !c.versionBump).map(c => c.sha),
      proposedNext,
    ),
    pickCandidates,
    staleRed,
    breakingCommits,
    breakingBaseline,
    breakingScanComplete,
    breakingExceptions,
    schedule: {
      series: seriesSchedule,
      isNonBreaking: seriesSchedule ? seriesSchedule.type === 'non-breaking' : null,
      manualTestingRcs: schedule.manualTestingRcs,
      mainTargets: mainTargets(schedule, today),
      breakingOnMain: breakingAllowedOnMain(schedule, today),
      today: todayStr,
      isGoldenNext,
      blogPostDue,
      needsManualTesting,
      goldenRc,
      priorGolden,
      expectedGoldenRc: schedule.expectedGoldenRc ?? null,
      sinceLastRc,
      lastRcWasGolden,
      daysToRelease: seriesSchedule ? daysBetween(todayStr, seriesSchedule.release) : null,
      cadence,
    },
  };
}

export function summarize(state) {
  // Defensive on every field: this is display code and a partially populated
  // state (a scenario, a fixture recorded mid-flight) must not take down a run.
  const L = [];
  const distTags = state.distTags ?? {};
  const ci = state.ci ?? [];
  const openPicks = state.openPicks ?? [];
  const hermes = state.hermes ?? {};
  const sched = state.schedule ?? {};
  L.push(`Series        ${state.series}  (${sched.series?.type ?? 'unknown type'})`);
  L.push(`Branch        ${state.branch} @ ${state.branchTip?.slice(0, 11) ?? 'unknown'}`);
  L.push(`Published     ${state.current ?? 'nothing yet'}`);
  L.push(`Next          ${state.proposedNext ?? 'n/a'}   (shape: ${state.shape})`);
  L.push(
    `npm tags      latest=${distTags.latest ?? '?'}  next=${distTags.next ?? '?'}`,
  );
  L.push(`Hermes        ${hermes.pinned ?? '?'} (compiler ${hermes.compiler ?? '?'})`);
  const hu = state.hermesUnreleased;
  // Match the gate: a version bump is plumbing for the next cut, not unreleased
  // work. Listing it here contradicted hermesCurrent, which passes on it.
  const ho = hermesOverview(hu, state.hermesEvidence);
  if (hu?.resolved && ho.commits.length) {
    L.push(`              ${ho.commits.length} commit(s) on ${hu.branch} NOT in the pinned tag: ${ho.tally}`);
    for (const c of ho.commits) {
      const kind = `${c.kind}${c.fromBody ? '*' : ''}`.padEnd(8);
      L.push(`                ${kind} ${c.sha} ${c.reland ? '[RE-LAND] ' : ''}${c.subject.slice(0, 54)}`);
      if (c.note) {
        L.push(`                         ${c.note}`);
      }
    }
    if (ho.commits.some(c => c.fromBody)) {
      L.push('              * read as a fix from its description, the subject does not say');
    }
    if (!ho.evidenced) {
      L.push('              classified from the commit messages only; plan and run also check each diff on the branch');
    }
    L.push(`              ${hermesChoice(ho, {proposedNext: state.proposedNext, pinned: hermes.pinned})}`);
  }

  const red = ci.filter(r => r.conclusion === 'failure');
  const running = ci.filter(r => r.status !== 'completed');
  L.push(`CI on tip     ${ci.length} workflow(s), ${red.length} failing, ${running.length} running`);
  for (const sr of state.staleRed ?? []) {
    L.push(`              RED off-tip: ${sr.workflow} failed on ${sr.sha} and has not re-run`);
  }
  for (const r of red) {
    L.push(`                ${r.workflow}: ${r.failedJobs.join(', ')}`);
  }

  L.push(
    `Open picks    ${openPicks.length ? openPicks.map(p => `#${p.number}`).join(', ') : 'none'}`,
  );
  if (sched.breakingOnMain?.reason) {
    L.push(`Breaking      ${sched.breakingOnMain.reason}`);
  }
  if (sched.isNonBreaking) {
    const bc = state.breakingCommits;
    L.push(
      `              ` +
        (state.breakingBaseline == null
          ? 'no baseline to scan from, so [BREAKING] commits were NOT checked'
          : bc == null
            ? 'could not check for [BREAKING] commits'
            : bc.length === 0
              ? `no [BREAKING] commits new in ${state.series} (baseline ${state.breakingBaseline})`
              : `${bc.length} [BREAKING] commit(s) NEW in ${state.series}, absent from ${state.breakingBaseline}: ${bc.map(c => c.sha).join(', ')}`),
    );
    for (const e of state.breakingExceptions ?? []) {
      L.push(`              exception: ${e.sha} ${e.title} (reviewed ${e.reviewedOn} by ${e.reviewedBy})`);
    }
    L.push(
      '',
    );
  }

  const s = sched;
  if (s.cadence?.unscheduled) {
    const c = s.cadence;
    L.push('');
    L.push('Cadence       patches are unscheduled, ship once the picks are in');
    L.push(`              last  ${c.lastPublished} (${c.daysSinceLastPublish}d ago)`);
  } else if (s.cadence) {
    const c = s.cadence;
    const verdict = c.dueToday
      ? 'DUE TODAY'
      : c.overdue
        ? `OVERDUE by ${-c.daysUntilDue}d`
        : `due in ${c.daysUntilDue}d`;
    L.push('');
    L.push(`Cadence       ships ${c.releaseDay}, weekly`);
    L.push(
      `              last  ${c.lastPublished} (${c.lastPublishedDay})` +
        (c.lastSlipDays > 0 ? `, slipped ${c.lastSlipDays}d from ${c.lastIntended}` : ''),
    );
    L.push(`              next  ${c.due} (${c.dueDay})  ${verdict}`);
  }
  const testing = `${state.proposedNext} ${
    s.needsManualTesting === true
      ? 'REQUIRES manual release testing'
      : s.needsManualTesting === false
        ? 'needs no manual testing'
        : 'MAY need manual testing, confirm whether it is the golden RC'
  }`;
  // Golden RCs and .0 targets mean nothing once the series is out.
  if (s.series && state.shape === 'patch') {
    L.push('');
    L.push(`Testing       ${testing}`);
  } else if (s.series) {
    L.push('');
    // Project the rest of the series from the golden assumption rather than
    // showing the schedule's .0 date, which goes stale the moment the RC count
    // differs from what was planned. Showing "0.88.0 on 10-05" next to "next
    // release is rc.4 on 10-05" is a contradiction the reader has to untangle.
    const golden = s.goldenRc?.value ?? s.expectedGoldenRc ?? null;
    const nextRc = parseVersion(state.proposedNext)?.rc ?? null;
    if (golden != null && nextRc != null && s.cadence?.due) {
      const remaining = [];
      const day = new Date(`${s.cadence.due}T12:00:00Z`);
      for (let rc = nextRc; rc <= golden; rc++) {
        remaining.push(`${state.series}.0-rc.${rc}${rc === golden ? ' (golden)' : ''} ${day.toISOString().slice(0, 10)}`);
        day.setUTCDate(day.getUTCDate() + (s.cadenceDays ?? 7));
      }
      remaining.push(`${state.series}.0 ${day.toISOString().slice(0, 10)}`);
      L.push(`Projected     ${remaining[0]}`);
      for (const r of remaining.slice(1)) {
        L.push(`              ${r}`);
      }
      L.push(`              assumes rc.${golden} is golden, weekly. Schedule says .0 ${s.series.release}`);
    } else if (state.shape === 'promote' && s.cadence?.due) {
      L.push(`Projected     ${state.proposedNext} ${s.cadence.due}. Schedule says .0 ${s.series.release}`);
    } else {
      L.push(`Targets       ${s.series.version}.0 ${s.series.release} (planning target only, they drift)`);
    }
    const g = s.goldenRc ?? {source: 'unknown'};
    if (g.source === 'content' && g.value != null) {
      L.push(`Golden RC     rc.${g.value} by content, last RC rc.${g.lastRc} (series already released)`);
    } else if (g.source === 'tags' && g.value != null) {
      L.push(`Golden RC     rc.${g.value} (from tags, series already released)`);
    } else {
      const hist = (s.priorGolden ?? [])
        .map(p => `${p.series}:rc.${p.rc}${p.lastRc != null && p.lastRc !== p.rc ? ` (last rc.${p.lastRc})` : ''}`)
        .join('  ');
      const exp = s.expectedGoldenRc;
      const currentRc = parseVersion(state.current ?? '')?.rc ?? null;
      L.push(
        s.lastRcWasGolden && currentRc != null
          ? `Golden RC     rc.${currentRc}: nothing substantive landed since it and no pick is aimed at ${state.series}.0`
          : exp != null && currentRc != null && currentRc >= exp
            ? `Golden RC     past the rc.${exp} planning prior, the last RC that carries a change is golden`
            : exp != null
              ? `Golden RC     assumed rc.${exp} (standing default). Tell the copilot if it changes.`
              : `Golden RC     not decided yet. Confirm with the captain.`,
      );
      if (hist) {
        L.push(`              prior series ended at: ${hist}`);
      }
      const sl = s.sinceLastRc;
      if (sl && sl.count === 0) {
        // Report the fact, do not suggest moving the golden. rc.5 is the
        // captain's standing assumption and only the captain changes it.
        L.push(`              nothing substantive landed since ${sl.from} yet`);
      } else if (sl) {
        L.push(`              ${sl.count} substantive commit(s) since ${sl.from}`);
      }
    }
    L.push(`              ${testing}`);
  }
  return L.join('\n');
}

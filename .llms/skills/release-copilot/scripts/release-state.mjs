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

export function loadBreakingExceptions(series) {
  try {
    const d = JSON.parse(readFileSync(EXCEPTIONS_PATH, 'utf8'));
    return (d.exceptions ?? []).filter(e => e.series === series);
  } catch {
    return [];
  }
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
const KNOWN_FLAKY = [
  {match: /rubygems\.org|UnknownHostError|Could not download gem/i, reason: 'rubygems DNS / network'},
  {match: /Artifact not found for name/i, reason: 'missing artifact, cascade from a failed upstream build job'},
];

function classifyRun(run, jobs) {
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
 * Releases ship on Monday, weekly. Slips happen when something blocks, and the
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

export async function deriveState(sources, {series, today} = {}) {
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

  // Default proposal: keep going in the same shape we are already in.
  const proposedNext = current
    ? isPrerelease(current)
      ? candidates.nextRc
      : candidates.nextPatch
    : null;

  const shape = current && proposedNext ? releaseShape(current, parseVersion(proposedNext)) : 'branch-cut';

  const tags = await sources.gitTags();
  const tip = await sources.branchTip(branch);

  const runs = await sources.workflowRuns(branch);
  const tipRuns = runs.filter(r => r.headSha && tip && r.headSha.startsWith(tip.slice(0, 11)));
  const ci = [];
  for (const run of tipRuns) {
    const jobs = await sources.workflowJobs(run.databaseId);
    ci.push(classifyRun(run, jobs));
  }

  const picks = await sources.openPicks(resolvedSeries);
  const board = await sources.projectItems(resolvedSeries);

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
    return s === resolvedSeries ? null : `v${formatVersion(latestInSeries(allVersions, s))}`;
  })();

  let breakingCommits = [];
  let breakingBaseline = prevSeriesLatest;
  let breakingScanComplete = null;
  let breakingExceptions = [];

  if (prevSeriesLatest) {
    try {
      const {commits, total, complete} = await sources.commitsBetween(prevSeriesLatest, branch);
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
        // the previous release branch as different objects, and `merge-base`
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

  const seriesSchedule = scheduleFor(schedule, resolvedSeries);

  const nextParsed = proposedNext ? parseVersion(proposedNext) : null;

  // The golden RC is the LAST one before .0, and it is not predictable: across
  // 0.82-0.87 it landed anywhere from rc.3 to rc.7. It is only knowable once the
  // series has shipped, so for an in-flight series say unknown rather than guess.
  const released = seriesHasReleased(tags, resolvedSeries);
  const lastRc = lastRcFromTags(tags, resolvedSeries);
  const goldenRc = released ? {value: lastRc, source: 'tags'} : {value: null, source: 'unknown'};

  // Historical spread, so the captain has context when deciding.
  const priorGolden = schedule.series
    .map(x => x.version)
    .filter(v => seriesHasReleased(tags, v))
    .map(v => ({series: v, rc: lastRcFromTags(tags, v)}))
    .filter(x => x.rc != null);

  // Nothing substantive landed since the last RC means another RC would be
  // identical, which is the team's cue that the current one can be declared
  // golden. A signal for the captain, never a decision the skill makes.
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

  const isGoldenNext =
    nextParsed?.rc != null && goldenRc.value != null && nextParsed.rc === goldenRc.value;

  // RC0 and RC1 always. Golden too, but if we cannot know whether this is the
  // golden RC, report null so the caller asks instead of silently deciding.
  const listed = nextParsed?.rc != null && schedule.manualTestingRcs.includes(nextParsed.rc);
  const needsManualTesting =
    nextParsed == null
      ? null
      : nextParsed.rc == null
        ? true
        : listed
          ? true
          : goldenRc.source === 'unknown'
            ? null
            : isGoldenNext;

  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const lastPublishedAt = current ? publishTimes[formatVersion(current)] ?? null : null;
  const cadence = cadencePosition(schedule, lastPublishedAt, todayStr);
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
    tagExistsForNext: proposedNext ? tags.includes(`v${proposedNext}`) : false,
    ci,
    openPicks: picks.map(p => ({number: p.number, title: p.title})),
    board,
    hermes: {pinned: hermesPinned, compiler: hermesCompiler},
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
      needsManualTesting,
      goldenRc,
      priorGolden,
      expectedGoldenRc: schedule.expectedGoldenRc ?? null,
      sinceLastRc,
      daysToGolden: seriesSchedule ? daysBetween(todayStr, seriesSchedule.golden) : null,
      daysToRelease: seriesSchedule ? daysBetween(todayStr, seriesSchedule.release) : null,
      cadence,
    },
  };
}

export function summarize(state) {
  // Defensive on every field: this is display code, and a partially populated
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

  const red = ci.filter(r => r.conclusion === 'failure');
  const running = ci.filter(r => r.status !== 'completed');
  L.push(`CI on tip     ${ci.length} workflow(s), ${red.length} failing, ${running.length} running`);
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
        (bc == null
          ? 'could not check for [BREAKING] commits'
          : bc.length === 0
            ? `no [BREAKING] commits new in ${state.series} (baseline ${state.breakingBaseline ?? '?'})`
            : `${bc.length} [BREAKING] commit(s) NEW in ${state.series}, absent from ${state.breakingBaseline ?? '?'}: ${bc.map(c => c.sha).join(', ')}`),
    );
    for (const e of state.breakingExceptions ?? []) {
      L.push(`              exception: ${e.sha} ${e.title} (reviewed ${e.reviewedOn} by ${e.reviewedBy})`);
    }
    L.push(
      '',
    );
  }

  const s = sched;
  if (s.cadence) {
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
  if (s.series) {
    L.push('');
    L.push(`Targets       ${s.series.version}.0 ${s.series.release} (planning target only, they drift)`);
    const g = s.goldenRc ?? {source: 'unknown'};
    if (g.source === 'tags' && g.value != null) {
      L.push(`Golden RC     rc.${g.value} (from tags, series already released)`);
    } else {
      const hist = (s.priorGolden ?? []).map(p => `${p.series}:rc.${p.rc}`).join('  ');
      const exp = s.expectedGoldenRc;
      L.push(
        `Golden RC     not decided yet${exp != null ? `, planning default is rc.${exp}` : ''}. Confirm with the captain.`,
      );
      if (hist) {
        L.push(`              prior series ended at: ${hist}`);
      }
      const sl = s.sinceLastRc;
      if (sl && sl.count === 0) {
        L.push(
          `              nothing substantive landed since ${sl.from}, so the team may declare an earlier golden`,
        );
      } else if (sl) {
        L.push(`              ${sl.count} substantive commit(s) since ${sl.from}`);
      }
    }
    L.push(
      `              ${state.proposedNext} ${
        s.needsManualTesting === true
          ? 'REQUIRES manual release testing'
          : s.needsManualTesting === false
            ? 'needs no manual testing'
            : 'MAY need manual testing -- confirm whether it is the golden RC'
      }`,
    );
  }
  return L.join('\n');
}

export {KNOWN_FLAKY};

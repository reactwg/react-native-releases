/**
 * Tests. Run with: node --test scripts/../__tests__
 *
 * No network. Gate tests build state objects directly; the integration test
 * replays a recorded fixture. If a test can reach npm or GitHub it will
 * eventually fail for reasons that have nothing to do with the skill.
 */

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {fixtureSources} from '../scripts/sources.mjs';
import {deriveState} from '../scripts/release-state.mjs';
import {evaluate, classifyFailure} from '../scripts/gates.mjs';
import {declare, render, Runner, MODES} from '../scripts/actions.mjs';
import {runPhase} from '../scripts/run-phase.mjs';
import {parseVersion, nextRC, promoteToStable, releaseShape, formatVersion} from '../scripts/version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'fixtures', '0.88-rc2-published');

const baseState = over => ({
  series: '0.88',
  branch: '0.88-stable',
  branchTip: '579212e15c9aaaa',
  current: '0.88.0-rc.1',
  proposedNext: '0.88.0-rc.2',
  tagExistsForNext: false,
  ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}],
  openPicks: [],
  hermes: {pinned: '260318099.0.3', compiler: '260318099.0.3'},
  schedule: {series: {version: '0.88', type: 'non-breaking'}, isNonBreaking: true},
  breakingCommits: [],
  breakingBaseline: 'v0.87.1',
  breakingScanComplete: true,
  ...over,
});

// ---------------------------------------------------------------- version

test('version arithmetic', () => {
  const rc1 = parseVersion('0.88.0-rc.1');
  assert.equal(formatVersion(nextRC(rc1)), '0.88.0-rc.2');
  assert.equal(formatVersion(promoteToStable(rc1)), '0.88.0');
  assert.equal(releaseShape(rc1, parseVersion('0.88.0-rc.2')), 'rc');
  assert.equal(releaseShape(rc1, parseVersion('0.88.0')), 'promote');
  assert.equal(releaseShape(parseVersion('0.87.1'), parseVersion('0.87.2')), 'patch');
});

// ------------------------------------------------------------------ gates

test('gate: red CI blocks', async () => {
  const state = baseState({
    ci: [{workflow: 'Test All', conclusion: 'failure', status: 'completed', failedJobs: ['test_js (24)']}],
  });
  const ev = await evaluate(['ciGreen'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /test_js/);
});

test('gate: running CI blocks, it is not green yet', async () => {
  const state = baseState({ci: [{workflow: 'Test All', conclusion: null, status: 'in_progress', failedJobs: []}]});
  const ev = await evaluate(['ciGreen'], state, {});
  assert.equal(ev.passed, false);
});

test('gate: an existing tag blocks, because the workflow would skip silently', async () => {
  const ev = await evaluate(['tagFree'], baseState({tagExistsForNext: true}), {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /silently skip/);
});

test('gate: a non-release branch blocks, same silent-skip reason', async () => {
  const ev = await evaluate(['branchShape'], baseState({branch: 'main'}), {});
  assert.equal(ev.passed, false);
});

test('gate: workflow dry-run must be explicitly false', async () => {
  assert.equal((await evaluate(['dryRunExplicit'], baseState(), {workflowDryRun: undefined})).passed, false);
  assert.equal((await evaluate(['dryRunExplicit'], baseState(), {workflowDryRun: true})).passed, false);
  assert.equal((await evaluate(['dryRunExplicit'], baseState(), {workflowDryRun: false})).passed, true);
});

test('gate: a prerelease must not take the latest tag', async () => {
  const ev = await evaluate(['distTagCorrect'], baseState(), {isLatest: true});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /must not take the latest tag/);
});

test('gate: mismatched Hermes pins block', async () => {
  const ev = await evaluate(
    ['hermesConsistent'],
    baseState({hermes: {pinned: '260318099.0.3', compiler: '260318099.0.2'}}),
    {},
  );
  assert.equal(ev.passed, false);
});

test('gate: a breaking change is blocked in a non-breaking series', async () => {
  assert.equal((await evaluate(['breakingWindow'], baseState(), {isBreaking: true})).passed, false);
  assert.equal((await evaluate(['breakingWindow'], baseState(), {isBreaking: false})).passed, true);
  const breaking = baseState({schedule: {series: {version: '0.89', type: 'breaking'}}});
  assert.equal((await evaluate(['breakingWindow'], breaking, {isBreaking: true})).passed, true);
});

// ------------------------------------------------- failure classification

test('classifier: real incidents from the 0.88 cycle', () => {
  const dns = classifyFailure('Gem::RemoteFetcher::UnknownHostError no such name (https://rubygems.org/gems/ethon.gem)');
  assert.equal(dns.kind, 'flake');
  assert.equal(dns.retryable, true);

  const artifact = classifyFailure('Unable to download artifact(s): Artifact not found for name: RNTesterApp-NewArch-Debug');
  assert.equal(artifact.kind, 'flake');
  assert.match(artifact.reason, /upstream build job/);

  const structural = classifyFailure('FAIL packages/react-native-babel-preset/src/__tests__/cache-key-test.js');
  assert.equal(structural.kind, 'structural');
  assert.equal(structural.retryable, false);

  const unknown = classifyFailure('Segmentation fault in some new thing');
  assert.equal(unknown.kind, 'unknown');
  assert.equal(unknown.retryable, false, 'unknown failures must never be auto-retried');
});

// ----------------------------------------------------------- action seam

test('printed command is rendered from the same record the executor consumes', () => {
  const a = declare({
    step: 's',
    why: 'w',
    cmd: 'gh',
    args: ['workflow', 'run', 'Create release', '-f', 'version=0.88.0-rc.2'],
    impact: ['publishes to npm'],
  });
  const printed = render(a);
  assert.equal(printed, "gh workflow run 'Create release' -f version=0.88.0-rc.2");
  // The executor uses a.cmd + a.args; assert the rendering is derived from them
  // rather than being an independently authored string.
  assert.ok(printed.startsWith(a.cmd));
  for (const arg of a.args) {
    assert.ok(printed.includes(arg.replace(/'/g, '')), `rendered command is missing ${arg}`);
  }
});

test('dry-run executes nothing, not even reads', async () => {
  const runner = new Runner({mode: MODES.DRY_RUN, log: () => {}});
  await runner.run(
    declare({step: 's', why: 'w', cmd: 'gh', args: ['workflow', 'run', 'x'], impact: ['publishes']}),
  );
  await runner.run(declare({step: 's', why: 'read', mutates: false, cmd: 'git', args: ['ls-remote']}));
  assert.equal(runner.executed.length, 0, 'dry-run must be free of side effects and network');
  assert.equal(runner.plan().length, 2, 'dry-run must still produce the full plan');
});

test('gates still evaluate for real in dry-run, they read state not actions', async () => {
  const red = baseState({
    ci: [{workflow: 'Test All', conclusion: 'failure', status: 'completed', failedJobs: ['build_android']}],
  });
  const ev = await evaluate(['ciGreen'], red, {});
  assert.equal(ev.passed, false, 'a dry-run on a red branch must still hard-stop');
});

test('meta-only actions are delegated, never executed', async () => {
  const runner = new Runner({mode: MODES.GUIDED, log: () => {}, confirm: async () => true});
  const res = await runner.run(
    declare({step: 's', why: 'w', metaOnly: true, cmd: 'echo', args: ['js1 publish']}),
  );
  assert.equal(res.skipped, 'meta-only');
  assert.equal(runner.executed.length, 0);
});

// ------------------------------------------------------- guided-only guard

test('there is no unattended mode', async () => {
  assert.deepEqual(Object.values(MODES).sort(), ['dry-run', 'guided']);
  assert.throws(
    () => new Runner({mode: 'autonomous', log: () => {}}),
    /never unattended/,
    'an unknown mode must be refused rather than silently treated as guided',
  );
});

test('a mutating action cannot be declared without describing its impact', () => {
  assert.throws(
    () => declare({step: 'publish', why: 'w', cmd: 'gh', args: ['workflow', 'run', 'x']}),
    /declares no impact/,
    'a human cannot consent to something the skill will not describe',
  );
  // Read-only and meta-only actions are exempt: nothing changes or a human runs it.
  assert.ok(declare({step: 's', why: 'w', mutates: false, cmd: 'git', args: ['status']}));
  assert.ok(declare({step: 's', why: 'w', metaOnly: true, cmd: 'echo', args: ['x']}));
});

test('guided mode executes nothing the human declines', async () => {
  const runner = new Runner({mode: MODES.GUIDED, log: () => {}, confirm: async () => false});
  const res = await runner.run(
    declare({
      step: 'publish',
      why: 'w',
      cmd: 'gh',
      args: ['workflow', 'run', 'x'],
      impact: ['publishes to npm'],
    }),
  );
  assert.equal(res.skipped, 'declined');
  assert.equal(runner.executed.length, 0);
  assert.equal(runner.declined.length, 1);
});

test('the human is shown the command and its impact before being asked', async () => {
  const lines = [];
  const runner = new Runner({
    mode: MODES.GUIDED,
    log: l => lines.push(l),
    confirm: async () => false,
  });
  await runner.run(
    declare({
      step: 'publish',
      why: 'Publish 0.88.0-rc.3 from 0.88-stable',
      cmd: 'gh',
      args: ['workflow', 'run', 'Create release', '-f', 'version=0.88.0-rc.3'],
      impact: ['publishes react-native@0.88.0-rc.3 to npm, publicly and permanently'],
      reversible: 'not really',
    }),
  );
  const shown = lines.join('\n');
  assert.match(shown, /Publish 0\.88\.0-rc\.3 from 0\.88-stable/, 'must say what it does');
  assert.match(shown, /version=0\.88\.0-rc\.3/, 'must show the exact command');
  assert.match(shown, /publicly and permanently/, 'must state the impact');
  assert.match(shown, /undo:/, 'must say whether it can be undone');
});

test('the publish action makes the human retype the version', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const state = baseState({proposedNext: '0.88.0-rc.3'});
  const publishStep = phaseFor('rc').steps.find(s => s.id === 'publish');
  const [action] = publishStep.actions(state, {isLatest: false});
  // A wrong version is the failure mode this guards, so "y" must not be enough.
  assert.equal(action.confirmToken, '0.88.0-rc.3');
  assert.ok(
    action.impact.some(i => i.includes('npm')),
    'the human must be told this reaches npm',
  );
});

test('a prerelease publish says latest is untouched, a stable one says it moves', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const publishStep = phaseFor('rc').steps.find(s => s.id === 'publish');
  const state = baseState({proposedNext: '0.88.0-rc.3'});

  const [rc] = publishStep.actions(state, {isLatest: false});
  assert.ok(rc.impact.some(i => /"latest" is unchanged/.test(i)));

  const [stable] = publishStep.actions({...state, proposedNext: '0.88.0'}, {isLatest: true});
  assert.ok(stable.impact.some(i => /moves the npm "latest" tag/.test(i)));
});

// ------------------------------------------------- breaking-change sweep

test('gate: a [BREAKING] commit blocks a non-breaking series', async () => {
  const state = baseState({
    breakingCommits: [{sha: 'd84c13d5111', title: 'Enforce the ArrayBuffer borrow contract'}],
    breakingBaseline: 'v0.87.1',
  });
  const ev = await evaluate(['noBreakingChanges'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /d84c13d5111/);
});

test('gate: a breaking series is unrestricted', async () => {
  const state = baseState({
    schedule: {series: {version: '0.89', type: 'breaking'}, isNonBreaking: false},
    breakingCommits: [{sha: 'abc', title: 'x'}],
  });
  assert.equal((await evaluate(['noBreakingChanges'], state, {})).passed, true);
});

test('gate: undeterminable commit history is a failure, not a pass', async () => {
  const state = baseState({breakingCommits: null});
  const ev = await evaluate(['noBreakingChanges'], state, {});
  assert.equal(ev.passed, false, 'must never pass when it could not check');
});

test('gate: a TRUNCATED commit scan fails loudly and says so', async () => {
  // The compare endpoint caps at 250 commits while reporting the real total.
  // An unpaginated read of a 554-commit range returned 250 and produced a
  // confidently clean verdict. Never judge on a partial range.
  const state = baseState({breakingCommits: null, breakingScanComplete: false});
  const ev = await evaluate(['noBreakingChanges'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /truncated/i);
});

test('gate: a clean non-breaking series passes', async () => {
  assert.equal((await evaluate(['noBreakingChanges'], baseState({breakingCommits: []}), {})).passed, true);
});

// -------------------------------------------------- release-crew message

test('status message: unverifiable steps are never ticked', async () => {
  const {buildStatusMessage} = await import('../scripts/release-message.mjs');
  const state = baseState({ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}]});
  const msg = buildStatusMessage(state, {
    version: '0.88.0-rc.2',
    prevVersion: '0.88.0-rc.1',
    artifacts: {maven: true, upgradeHelper: true, npmPublished: true, release: {isDraft: false, url: 'u'}, changelogPr: {url: 'p'}, testReport: null},
  });
  for (const step of ['Verify template', 'Communicate release', 'Update GitHub project']) {
    const l = msg.split('\n').find(x => x.includes(step));
    assert.match(l, /hourglass/, `"${step}" has no signal and must not be ticked`);
  }
});

test('status message: a draft GitHub release is not ticked', async () => {
  const {buildStatusMessage} = await import('../scripts/release-message.mjs');
  const msg = buildStatusMessage(baseState(), {
    version: '0.88.0-rc.2',
    artifacts: {release: {isDraft: true, url: 'u'}},
  });
  assert.match(msg.split('\n').find(l => l.includes('Create GitHub release')), /hourglass/);
});

test('status message: testing requirement, golden known vs unknown', async () => {
  const {requiresManualTesting} = await import('../scripts/release-message.mjs');

  // Series already released: golden is derivable from tags, so answer definitively.
  const done = baseState({
    schedule: {manualTestingRcs: [0, 1], goldenRc: {value: 4, source: 'tags'}},
  });
  assert.equal(requiresManualTesting(done, '0.87.0-rc.0'), true);
  assert.equal(requiresManualTesting(done, '0.87.0-rc.1'), true);
  assert.equal(requiresManualTesting(done, '0.87.0-rc.3'), false);
  assert.equal(requiresManualTesting(done, '0.87.0-rc.4'), true, 'golden RC needs testing');
  assert.equal(requiresManualTesting(done, '0.87.0'), true, 'stable always needs testing');

  // In flight: any RC past rc.1 MAY be golden, so refuse to decide.
  const live = baseState({
    schedule: {manualTestingRcs: [0, 1], goldenRc: {value: null, source: 'unknown'}},
  });
  assert.equal(requiresManualTesting(live, '0.88.0-rc.1'), true, 'rc.1 is unconditional');
  assert.equal(
    requiresManualTesting(live, '0.88.0-rc.3'),
    null,
    'must not claim testing is unnecessary while golden is unknown',
  );
});

test('golden RC: the planning default is never treated as a decision', async () => {
  const {requiresManualTesting} = await import('../scripts/release-message.mjs');
  // expectedGoldenRc is a planning default. Even with it set, an in-flight
  // series must return null (ask) rather than deciding off the default.
  const live = baseState({
    schedule: {
      manualTestingRcs: [0, 1],
      goldenRc: {value: null, source: 'unknown'},
      expectedGoldenRc: 5,
    },
  });
  assert.equal(
    requiresManualTesting(live, '0.88.0-rc.5'),
    null,
    'must ask even when the RC matches the planning default',
  );
  assert.equal(requiresManualTesting(live, '0.88.0-rc.3'), null);
});

test('golden RC is derived from tags, never from a fixed number', async () => {
  const {lastRcFromTags, seriesHasReleased} = await import('../scripts/version.mjs');
  // Measured reality: a fixed goldenRc was wrong for three of four series.
  const tags = [
    'v0.86.0-rc.0','v0.86.0-rc.1','v0.86.0-rc.2','v0.86.0-rc.3','v0.86.0',
    'v0.87.0-rc.0','v0.87.0-rc.4','v0.87.0',
    'v0.88.0-rc.0','v0.88.0-rc.1','v0.88.0-rc.2',
  ];
  assert.equal(lastRcFromTags(tags, '0.86'), 3);
  assert.equal(lastRcFromTags(tags, '0.87'), 4);
  assert.equal(seriesHasReleased(tags, '0.87'), true);
  assert.equal(seriesHasReleased(tags, '0.88'), false, '0.88 has not shipped, golden unknowable');
});

test('status message: red CI is not reported as green', async () => {
  const {buildStatusMessage} = await import('../scripts/release-message.mjs');
  const red = baseState({ci: [{workflow: 'Test All', conclusion: 'failure', status: 'completed', failedJobs: ['x']}]});
  const msg = buildStatusMessage(red, {version: '0.88.0-rc.2', artifacts: {}});
  assert.match(msg.split('\n').find(l => l.includes('E2E tests are green')), /hourglass/);
});

// ---------------------------------------------------------------- cadence

test('cadence: a slip does not push the next release out', async () => {
  const {cadencePosition} = await import('../scripts/release-state.mjs');
  const sched = {releaseDay: 'Monday', cadenceDays: 7};

  // rc.1 shipped Tuesday 2026-09-15, one day late from Monday 09-14.
  // The next release is due Monday 09-21, not 09-28. Getting this wrong
  // produced a confidently wrong answer on the skill's first real use.
  const c = cadencePosition(sched, '2026-09-15T10:00:00.000Z', '2026-09-21');
  assert.equal(c.lastIntended, '2026-09-14');
  assert.equal(c.lastSlipDays, 1);
  assert.equal(c.due, '2026-09-21');
  assert.equal(c.dueToday, true);
});

test('cadence: an on-time release advances exactly one week', async () => {
  const {cadencePosition} = await import('../scripts/release-state.mjs');
  const sched = {releaseDay: 'Monday', cadenceDays: 7};
  const c = cadencePosition(sched, '2026-09-14T10:00:00.000Z', '2026-09-14');
  assert.equal(c.lastSlipDays, 0);
  assert.equal(c.due, '2026-09-21');
  assert.equal(c.daysUntilDue, 7);
});

test('cadence: a release past due is reported overdue', async () => {
  const {cadencePosition} = await import('../scripts/release-state.mjs');
  const sched = {releaseDay: 'Monday', cadenceDays: 7};
  const c = cadencePosition(sched, '2026-09-14T10:00:00.000Z', '2026-09-24');
  assert.equal(c.overdue, true);
  assert.equal(c.daysUntilDue, -3);
});

// ------------------------------------------------------------------ doctor

test('doctor: every failing check explains how to fix itself', async () => {
  const {runDoctor} = await import('../scripts/doctor.mjs');
  const r = await runDoctor({checkout: '/definitely/not/a/checkout'});
  const broken = r.checks.filter(c => c.status === 'fail' || c.status === 'warn');
  for (const c of broken) {
    assert.ok(c.fix, `check "${c.name}" reports a problem with no fix instruction`);
  }
  // The bogus checkout must be caught rather than silently accepted.
  assert.ok(r.checks.some(c => c.name.includes('checkout') && c.status === 'fail'));
});

test('doctor: covers all four repos a release touches', async () => {
  const {REPOS} = await import('../scripts/doctor.mjs');
  const slugs = REPOS.map(r => r.slug);
  for (const s of [
    'react/react-native',
    'react-native-community/template',
    'facebook/hermes',
    'reactwg/react-native-releases',
  ]) {
    assert.ok(slugs.includes(s), `doctor does not check access to ${s}`);
  }
});

// ------------------------------------------------------------------ evals

test('evals: all scenarios pass and the agenda is fully covered', async () => {
  const {execFileSync} = await import('node:child_process');
  const {fileURLToPath} = await import('node:url');
  const {dirname, join} = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));
  const out = execFileSync(process.execPath, [join(here, '..', 'evals', 'run.mjs'), '--json'], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  });
  const r = JSON.parse(out);
  const failed = r.results.filter(x => !x.ok);
  assert.deepEqual(failed.map(f => ({id: f.id, why: f.failures})), [], 'eval scenarios failed');
  assert.equal(r.gaps, 0, 'documented release steps are not all implemented and exercised');
});

// ------------------------------------------------------------ integration

test('fixture: derives the 0.88 state without network', async () => {
  const state = await deriveState(fixtureSources(FIXTURE), {series: '0.88', today: '2026-09-22'});
  assert.equal(state.series, '0.88');
  assert.equal(state.current, '0.88.0-rc.2');
  assert.equal(state.proposedNext, '0.88.0-rc.3');
  assert.equal(state.shape, 'rc');
  assert.equal(state.distTags.latest, '0.87.1');
  assert.equal(state.hermes.pinned, '260318099.0.3');
  assert.equal(state.schedule.isNonBreaking, true);
  assert.equal(state.schedule.mainTargets.version, '0.89');
  assert.equal(state.schedule.breakingOnMain.allowed, true);
});

test('fixture: a reviewed exception clears the sweep but stays visible', async () => {
  const state = await deriveState(fixtureSources(FIXTURE), {series: '0.88', today: '2026-09-22'});

  // d84c13d5111 is [BREAKING]-annotated but exempt: the Java ArrayBuffer API it
  // constrains is itself 0.88-only, so no 0.87 consumer can exist.
  assert.equal(state.breakingCommits.length, 0, 'the exception should clear the blocker');
  assert.ok(
    state.breakingExceptions.some(e => e.sha === 'd84c13d5111'),
    'the exception must remain visible, not be silently filtered away',
  );
  assert.ok(state.breakingExceptions[0].reason, 'an exception must carry its reasoning');
  assert.ok(state.breakingExceptions[0].reviewedBy, 'an exception must name a reviewer');

  const ev = await evaluate(['noBreakingChanges'], state, {});
  assert.equal(ev.passed, true);
});

test('fixture: rc dry-run reaches publish once gates are clear, executing nothing', async () => {
  const derived = await deriveState(fixtureSources(FIXTURE), {series: '0.88', today: '2026-09-22'});
  // Normalise CI: the fixture may be recorded mid-run and this asserts the plan
  // rather than whatever the branch happened to be doing at record time.
  const state = {
    ...derived,
    ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}],
    openPicks: [],
  };
  const result = await runPhase(state, {
    mode: MODES.DRY_RUN,
    ctx: {isLatest: false, workflowDryRun: false, isBreaking: false},
    log: () => {},
  });
  const publish = result.plan.find(p => p.step === 'publish');
  assert.ok(publish, 'should reach the publish step');
  assert.match(publish.command, /version=0\.88\.0-rc\.3/);
  assert.match(publish.command, /dry-run=false/);
  assert.match(publish.command, /is-latest-on-npm=false/, 'a prerelease must not take latest');
});

test('golden plan: rc phase step order is stable', async () => {
  const state = await deriveState(fixtureSources(FIXTURE), {series: '0.88', today: '2026-09-22'});
  // Normalise the gate inputs so this asserts the PLAN, not whatever CI happened to
  // be doing when the fixture was recorded.
  const clean = {
    ...state,
    openPicks: [],
    breakingCommits: [],
    ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}],
  };
  const result = await runPhase(clean, {
    mode: MODES.DRY_RUN,
    ctx: {isLatest: false, workflowDryRun: false, isBreaking: false},
    log: () => {},
  });
  assert.equal(result.completed, true);
  assert.deepEqual(
    result.plan.filter(p => p.mutates).map(p => p.command),
    [
      'git switch 0.88-stable',
      "gh workflow run 'Create release' --repo react/react-native --ref 0.88-stable -f version=0.88.0-rc.3 -f is-latest-on-npm=false -f dry-run=false",
      "echo 'post announcement to Workplace'",
    ],
  );
});

test('checklist parity: rc phase covers every canonical checklist step', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const ids = phaseFor('rc').steps.map(s => s.id);
  // Derived from .github/ISSUE_TEMPLATE/release_checklist.yml and the
  // guide-release-process.md headings. A miss here blocks deleting the docs.
  for (const required of [
    'checkout',
    'picks',
    'breaking-sweep',
    'artifacts',
    'test',
    'pre-flight',
    'publish',
    'verify-publish',
    'changelog',
    'github-release',
    'announce',
    'board',
  ]) {
    assert.ok(ids.includes(required), `rc phase is missing the "${required}" step`);
  }
});

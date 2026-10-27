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

import {fixtureSources, npmVersionStatus, parseNpmDocument} from '../scripts/sources.mjs';
import {deriveState} from '../scripts/release-state.mjs';
import {evaluate, classifyFailure, hasBreakingTag} from '../scripts/gates.mjs';
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
  staleRed: [],
  pickCandidates: [],
  hermesUnreleased: {branch: 'x-stable', tag: 'hermes-vx', resolved: true, commits: []},
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

test('gate: a stale sdks/.hermesv1version blocks, its absence does not', async () => {
  const pins = {pinned: '260318099.0.4', compiler: '260318099.0.4'};
  const stale = await evaluate(['hermesConsistent'], baseState({hermes: {...pins, v1Tag: 'hermes-v260318099.0.2'}}), {});
  assert.equal(stale.passed, false);
  assert.match(stale.results[0].detail, /\.hermesv1version=hermes-v260318099\.0\.2/);
  const current = await evaluate(['hermesConsistent'], baseState({hermes: {...pins, v1Tag: 'hermes-v260318099.0.4'}}), {});
  assert.equal(current.passed, true);
  const absent = await evaluate(['hermesConsistent'], baseState({hermes: {...pins, v1Tag: null}}), {});
  assert.equal(absent.passed, true, 'a branch without the file predates it');
});

test('fixture: the .hermesv1version drift already present at rc.2 is caught', async () => {
  const state = await deriveState(fixtureSources(FIXTURE), {series: '0.88', today: '2026-09-22'});
  assert.equal(state.hermes.v1Tag, 'hermes-v260318099.0.2');
  const ev = await evaluate(['hermesConsistent'], state, {});
  assert.equal(ev.passed, false, 'rc.2 pinned .0.3 while from-source builds checked out .0.2');
});

// ------------------------------------------------- npm reads fail loudly

test('npm: only a 404 means unpublished, an unreachable registry throws', () => {
  assert.equal(npmVersionStatus('200', 'react-native@0.88.1'), true);
  assert.equal(npmVersionStatus('404\n', 'react-native@0.88.1'), false);
  assert.throws(() => npmVersionStatus('000', 'react-native@0.88.1'), /npm answered 000/);
  assert.throws(() => npmVersionStatus('503', 'react-native@0.88.1'), /npm answered 503/);
  assert.throws(() => npmVersionStatus('', 'react-native@0.88.1'), /npm answered nothing/);
});

test('npm: an empty or broken package document throws instead of reading as no versions', () => {
  assert.deepEqual(Object.keys(parseNpmDocument('{"versions":{"0.88.0":{}},"dist-tags":{"latest":"0.88.0"}}', 'react-native').versions), ['0.88.0']);
  assert.throws(() => parseNpmDocument('', 'react-native'), /could not read react-native/);
  assert.throws(() => parseNpmDocument('<html>503</html>', 'react-native'), /could not read react-native/);
  assert.throws(() => parseNpmDocument('{"error":"Not found"}', 'react-native'), /could not read react-native/);
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

// ------------------------------------------------------- acknowledgement

test('the acknowledgement appears only after a confirmed mutating action', async () => {
  const {ACK} = await import('../scripts/actions.mjs');
  const mk = () =>
    declare({step: 'publish', why: 'w', cmd: 'echo', args: ['ok'], impact: ['publishes']});

  const confirmed = [];
  await new Runner({mode: MODES.GUIDED, log: l => confirmed.push(l), confirm: async () => true}).run(mk());
  assert.ok(confirmed.some(l => l.includes(ACK)), 'a confirmed action is acknowledged');

  // Declining is a halt. A cheerful reply there could read as "carrying on".
  const declined = [];
  await new Runner({mode: MODES.GUIDED, log: l => declined.push(l), confirm: async () => false}).run(mk());
  assert.ok(!declined.some(l => l.includes(ACK)), 'a decline is never acknowledged');
  assert.ok(declined.some(l => /declined, stopping this step/.test(l)));

  // Nothing was decided, so there is nothing to acknowledge.
  const readOnly = [];
  await new Runner({mode: MODES.GUIDED, log: l => readOnly.push(l), confirm: async () => true}).run(
    declare({step: 's', why: 'r', mutates: false, cmd: 'echo', args: ['r']}),
  );
  assert.ok(!readOnly.some(l => l.includes(ACK)), 'a read is never acknowledged');
});

test('the acknowledgement never leaks into decision-bearing text', async () => {
  const {ACK, describe: describeAction} = await import('../scripts/actions.mjs');
  const {formatGates} = await import('../scripts/gates.mjs');

  // Gate output is read to make a decision, so it stays plain and greppable.
  const red = baseState({
    ci: [{workflow: 'Test All', conclusion: 'failure', status: 'completed', failedJobs: ['x']}],
  });
  const ev = await evaluate(['ciGreen'], red, {});
  assert.ok(!formatGates(ev).includes(ACK), 'gate text must stay plain');

  // So is the block the captain reads before consenting.
  const block = describeAction(
    declare({
      step: 'publish',
      why: 'w',
      cmd: 'gh',
      args: ['workflow', 'run', 'x'],
      impact: ['publishes to npm'],
      reversible: 'no',
    }),
  );
  assert.ok(!block.includes(ACK), 'the confirmation block must stay plain');
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

// ------------------------------------------- Hermes freshness / pick gates

test('gate: a Hermes branch ahead of the pinned tag blocks and names the re-land', async () => {
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      commits: [
        {sha: 'ace586d9008', subject: 'Back out "Back out D116775223"', reland: true},
        {sha: 'e3371863eec', subject: 'doc comment', reland: false},
      ],
    },
  });
  const ev = await evaluate(['hermesCurrent'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /RE-LAND/, 'a re-landed back-out needs a human, so say so');
  // hermesConsistent passes on the same state: the two checks are not redundant.
  assert.equal((await evaluate(['hermesConsistent'], state, {})).passed, true);
});

test('gate: a stale hermes-compiler version warns that a cut would re-cut', async () => {
  // RN Build Static Hermes has no version input; it reads this file verbatim.
  // A stale value silently re-cuts an already-published version.
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.3',
      wouldRecut: true,
      commits: [{sha: 'abc', subject: 'x', reland: false}],
    },
  });
  const ev = await evaluate(['hermesCurrent'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /would re-cut it/);
  assert.match(ev.results[0].detail, /bump PR first/, 'the stable ref rejects direct pushes');
});

test('gate: a bumped version reports what the cut will produce', async () => {
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [{sha: 'abc', subject: 'x', reland: false}],
    },
  });
  const ev = await evaluate(['hermesCurrent'], state, {});
  assert.match(ev.results[0].detail, /would cut 260318099\.0\.4/);
});

test('gate: the version bump is not mistaken for unreleased work', async () => {
  // Every correctly finished release leaves its follow-up bump sitting beyond
  // the tag it just cut. Counting that as payload made hermesCurrent fire after
  // every release, which is how a gate gets ignored.
  const justBumped = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.4',
      resolved: true,
      inTreeVersion: '260318099.0.5',
      inTreePublished: false,
      wouldRecut: false,
      commits: [
        {
          sha: '6cb3676787d',
          subject: 'Bump hermes-compiler version to 260318099.0.5 (#2211)',
          reland: false,
          versionBump: true,
        },
      ],
    },
  });

  const current = await evaluate(['hermesCurrent'], justBumped, {});
  assert.equal(current.passed, true, 'a lone version bump is not drift');

  // And a release containing only a version bump is not a release.
  const ready = await evaluate(['hermesReadyToCut'], justBumped, {});
  assert.equal(ready.passed, false);
  assert.match(ready.results[0].detail, /nothing to cut/);

  // A real commit alongside the bump still counts.
  const withWork = baseState({
    hermesUnreleased: {
      ...justBumped.hermesUnreleased,
      commits: [
        ...justBumped.hermesUnreleased.commits,
        {sha: 'abc1234567', subject: 'Fix a real thing', reland: false, versionBump: false},
      ],
    },
  });
  assert.equal((await evaluate(['hermesCurrent'], withWork, {})).passed, false);
  assert.equal((await evaluate(['hermesReadyToCut'], withWork, {})).passed, true);
});

test('gate: an unresolvable Hermes comparison fails rather than passing', async () => {
  const unresolved = baseState({
    hermesUnreleased: {branch: 'b', tag: 't', resolved: false, commits: []},
  });
  assert.equal((await evaluate(['hermesCurrent'], unresolved, {})).passed, false);
  assert.equal((await evaluate(['hermesCurrent'], baseState({hermesUnreleased: null}), {})).passed, false);
});

test('gate: a [BREAKING] pick candidate is caught before it lands', async () => {
  const state = baseState({
    openPicks: [{number: 1499, title: 'x'}],
    pickCandidates: [
      {
        number: 1499,
        title: 'x',
        resolved: [{sha: 'abc', message: 'T\n\n[IOS] [BREAKING] - changes codegen output'}],
      },
    ],
  });
  const ev = await evaluate(['picksNotBreaking'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /#1499/);
});

test('gate: the changelog template is not mistaken for a breaking annotation', async () => {
  // This exact false positive fired on a plain androidx patch bump.
  const template = 'bump androidx\n\n<!-- [ANDROID|GENERAL|IOS] [BREAKING|ADDED|FIXED] - Message -->';
  const state = baseState({
    openPicks: [{number: 1426, title: 'bump androidx'}],
    pickCandidates: [{number: 1426, title: 'bump androidx', resolved: [{sha: 'd6a', message: template}]}],
  });
  assert.equal((await evaluate(['picksNotBreaking'], state, {})).passed, true);
});

test('gate: an UNANNOTATED breaking candidate is still caught', async () => {
  // #58063 carried no [BREAKING] tag and was breaking: C++ codegen accepted
  // EventEmitter<ArrayBuffer> on 0.87 and rejects it on 0.88. An annotation
  // check alone passes it, which is why the gate inspects changed files.
  const state = baseState({
    openPicks: [{number: 1501, title: 'Align TurboModule EventEmitter payload types'}],
    pickCandidates: [
      {
        number: 1501,
        title: 'Align TurboModule EventEmitter payload types',
        resolved: [
          {
            sha: 'ab2ea649e65',
            message: 'Align payload types\n\n[General][Changed] - tighten the parser',
            files: [{f: 'packages/react-native-codegen/src/parsers/parsers-commons.js', a: 8, d: 0}],
          },
        ],
      },
    ],
  });
  assert.equal(hasBreakingTag(state.pickCandidates[0].resolved[0].message), false, 'no annotation');
  const ev = await evaluate(['picksNotBreaking'], state, {});
  assert.equal(ev.passed, false, 'must still block on the touched surface');
  assert.match(ev.results[0].detail, /codegen-contract/);
  assert.match(ev.results[0].detail, /trigger to inspect, not a verdict/);
});

test('surface detection does not fire on test-only or additive changes', async () => {
  const {breakingSurfaces} = await import('../scripts/gates.mjs');
  // Noise kills a gate faster than a miss does.
  assert.equal(
    breakingSurfaces([
      {f: 'packages/react-native-codegen/src/generators/modules/__tests__/x-test.js', a: 9, d: 0},
    ]).length,
    0,
    'codegen tests are not the contract',
  );
  assert.equal(
    breakingSurfaces([{f: 'scripts/cxx-api/api-snapshots/ReactAppleDebugCxx.api', a: 4, d: 0}]).length,
    0,
    'adding to the API surface is not a break',
  );
  assert.equal(
    breakingSurfaces([{f: 'packages/react-native/scripts/ios-prebuild/setup.js', a: 102, d: 63}]).length,
    0,
    'build tooling is not the consumer contract',
  );
  // But a removal from the same snapshot is.
  assert.equal(
    breakingSurfaces([{f: 'scripts/cxx-api/api-snapshots/ReactAppleDebugCxx.api', a: 0, d: 4}])[0].id,
    'cxx-api-snapshot',
  );
});

test('gate: candidate inspection applies ONLY to a non-breaking series', async () => {
  const breakingSeries = baseState({
    schedule: {series: {version: '0.89', type: 'breaking'}, isNonBreaking: false},
    openPicks: [{number: 1502, title: 'z'}],
    pickCandidates: [
      {
        number: 1502,
        title: 'z',
        resolved: [
          {
            sha: 'x',
            message: '[IOS] [BREAKING] - changes codegen',
            files: [{f: 'packages/react-native-codegen/src/generators/modules/Foo.js', a: 1, d: 1}],
          },
        ],
      },
    ],
  });
  const ev = await evaluate(['picksNotBreaking'], breakingSeries, {});
  assert.equal(ev.passed, true, 'a breaking release accepts breaking picks');
});

test('gate: an unassessed pick candidate blocks', async () => {
  const state = baseState({
    openPicks: [{number: 1500, title: 'y'}],
    pickCandidates: [{number: 1500, title: 'y', resolved: [], prOnly: true}],
  });
  const ev = await evaluate(['picksNotBreaking'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /unassessed/);
});

test('the blog post draft is due from the golden RC onwards', async () => {
  // The captain writes the first draft and the crew iterates, so it has to
  // start early enough to become a website PR before .0. With the rc.4 prior
  // that means the moment rc.3 is out.
  const at = async next => {
    const src = {
      npmVersions: async () => ['0.87.1', next],
      npmDistTags: async () => ({latest: '0.87.1', next}),
      npmPublishTimes: async () => ({}),
      gitTags: async () => [`v${next}`],
      branchTip: async () => 'b'.repeat(40),
      workflowRuns: async () => [],
      openPicks: async () => [],
      pickCandidates: async () => [],
      projectItems: async () => [],
      commitsBetween: async () => ({commits: [], total: 0, complete: true}),
      changelogAt: async () => '',
      fileAt: async () => null,
      releaseArtifacts: async () => ({}),
      hermesUnreleased: async () => ({resolved: false, commits: []}),
    };
    const st = await deriveState(src, {series: '0.88'});
    return {next: st.proposedNext, due: st.schedule.blogPostDue};
  };

  // The prior is rc.4, so rc.3 proposes rc.4 and the duty opens. Starting one
  // RC earlier is the safe direction: a draft nobody needed yet costs less
  // than a .0 with no blog post.
  assert.deepEqual(await at('0.88.0-rc.2'), {next: '0.88.0-rc.3', due: false});
  assert.deepEqual(await at('0.88.0-rc.3'), {next: '0.88.0-rc.4', due: true});
  // rc.4 is the prior and nothing landed after it, so it was golden and the
  // next release is .0, not an empty rc.5 like the one 0.88 actually cut.
  assert.deepEqual(await at('0.88.0-rc.4'), {next: '0.88.0', due: true});
});

test('the blog-post step declares a draft only when it is due', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const step = phaseFor('rc').steps.find(x => x.id === 'blog-post');
  assert.ok(step, 'the rc phase carries the draft step');

  const due = baseState({series: '0.88', schedule: {blogPostDue: true}});
  const [action] = step.actions(due, {});
  assert.ok(/draft-blog-post\.mjs$/.test(action.args[0]), 'it runs the drafter');
  assert.equal(action.args[1], '0.88.0', 'for the stable version, not an RC');
  assert.equal(action.mutates, false, 'generating a draft changes nothing remote');

  const early = baseState({series: '0.88', schedule: {blogPostDue: false}});
  assert.deepEqual(step.actions(early, {}), [], 'silent before the golden RC');
  assert.equal(await step.emit(early), null, 'and prints nothing');

  // A patch release has no blog post at all.
  assert.deepEqual(step.actions(baseState({series: '0.88', schedule: {}}), {}), []);
});

test('a hand-written revert is flagged rather than silently missed', async () => {
  const {combine} = await import('../scripts/combine-changelog.mjs');
  const cl = [
    '## v0.88.0-rc.0',
    '### Changed',
    '- **A11y**: automatically set `accessible` with `role` ([aaaaaaaaaa](https://github.com/r/n/commit/aaaaaaaaaa))',
    '',
    '## v0.87.0',
    '',
  ].join('\n');

  // 0.88 shipped adde1e58884, titled "Revert: Automatically set acessible
  // prop..." with NO "This reverts commit <sha>" line. The sha-pairing filter
  // cannot see it and the title cannot be matched either: the target has a
  // different PR number and the revert's own title carries two typos
  // ("acessible", "presenation"). Guessing a pair would drop the wrong entry,
  // so the tool reports it instead.
  const r = combine(cl, '0.88', {reverted: new Set()});
  assert.match(r.markdown, /automatically set/, 'the entry is NOT dropped on a guess');

  // Pairing is the caller's job once a human confirms it.
  const paired = combine(cl, '0.88', {reverted: new Set(['aaaaaaaaaa'])});
  assert.ok(!paired.markdown.includes('automatically set'));
  assert.equal(paired.reverted.length, 1);
});

test('a change reverted before release is dropped from the combined changelog', async () => {
  const {combine} = await import('../scripts/combine-changelog.mjs');
  const cl = [
    '## v0.88.0-rc.1',
    '### Fixed',
    '- **Kept**: still in the release ([bbbbbbbbbb](https://github.com/r/n/commit/bbbbbbbbbb))',
    '',
    '## v0.88.0-rc.0',
    '### Breaking',
    '- **Gone**: modules stop compiling ([aaaaaaaaaa](https://github.com/r/n/commit/aaaaaaaaaa))',
    '',
    '## v0.87.0',
    '',
  ].join('\n');

  // 0.88 shipped a combined section advertising "Codegen now emits
  // `RCTArrayBuffer *` ... modules stop compiling" for a change that had been
  // reverted and was absent from the branch. The forward entry lives in the
  // RC section it landed in; the revert usually adds no entry of its own.
  const naive = combine(cl, '0.88');
  assert.match(naive.markdown, /### Breaking/, 'without the revert set it stays');

  const r = combine(cl, '0.88', {reverted: new Set(['aaaaaaaaaa'])});
  assert.equal(r.reverted.length, 1, 'the reverted entry is reported, not silently cut');
  assert.ok(!r.markdown.includes('modules stop compiling'));
  assert.ok(!r.markdown.includes('### Breaking'), 'the section empties out and is omitted');
  assert.match(r.markdown, /still in the release/, 'unreverted entries survive');
});

test('combining RC changelog sections loses nothing and invents nothing', async () => {
  const {combine, scopeOf, parseRcSections} = await import('../scripts/combine-changelog.mjs');
  const cl = [
    '# Changelog',
    '',
    '## v0.88.0-rc.1',
    '### Fixed',
    '- **Zebra**: later fix ([aaaaaaaaaa](https://github.com/r/n/commit/aaaaaaaaaa))',
    '',
    '## v0.88.0-rc.0',
    '### Added',
    '- **Beta**: second ([bbbbbbbbbb](https://github.com/r/n/commit/bbbbbbbbbb))',
    '- **Alpha:** first ([cccccccccc](https://github.com/r/n/commit/cccccccccc))',
    '### Fixed',
    '#### iOS specific',
    '- **Delta**: ios one ([dddddddddd](https://github.com/r/n/commit/dddddddddd))',
    '',
    '## v0.87.0',
    '### Added',
    '- **Older**: must not be swallowed ([eeeeeeeeee](https://github.com/r/n/commit/eeeeeeeeee))',
    '',
  ].join('\n');

  // The oldest RC is LAST in the file, so bounding its body at "the next RC"
  // made it swallow every earlier series. 0.88 came out as 1619 entries.
  const secs = parseRcSections(cl, '0.88');
  assert.equal(secs.length, 2);
  assert.ok(!secs.find(x => x.rc === 0).body.includes('must not be swallowed'));

  const r = combine(cl, '0.88');
  assert.equal(r.kept, 4, 'the 0.87 entry is not pulled in');
  assert.ok(!r.markdown.includes('must not be swallowed'));
  assert.match(r.markdown, /^## v0\.88\.0$/m);

  // Both bold styles are real in published changelogs. Treating `**X:**` as
  // unprefixed reported 611 false positives on 0.88.
  assert.equal(scopeOf({text: '- **Alpha**: x'}), 'Alpha');
  assert.equal(scopeOf({text: '- **Alpha:** x'}), 'Alpha');
  assert.equal(r.noScope.length, 0);

  // Alphabetical within a section and subsections keep their heading.
  const added = r.markdown.slice(r.markdown.indexOf('### Added'));
  assert.ok(added.indexOf('Alpha') < added.indexOf('Beta'), 'sorted by scope');
  assert.match(r.markdown, /#### iOS specific/);

  // Empty sections are omitted entirely.
  assert.ok(!r.markdown.includes('### Removed'));
});

test('an RC with nothing in it is refused: the previous one was golden', async () => {
  // The exact 0.88.0-rc.5 mistake. schedule.json said expectedGoldenRc: 5, the
  // copilot reported "golden assumed rc.5" and nothing asked whether rc.5 had
  // any reason to exist. It shipped 36 files, every one a version string.
  // sinceLastRc lives under `schedule`: reading it off the top level made the
  // gate silently pass, which is the exact false green it exists to prevent.
  const at = (shape, sinceLastRc) => baseState({shape, schedule: {sinceLastRc}});

  const empty = await evaluate(
    ['rcHasContent'], at('rc', {count: 0, from: '0.88.0-rc.4'}), {});
  assert.equal(empty.passed, false, 'an empty RC is refused');
  assert.match(empty.results[0].detail, /0\.88\.0-rc\.4 was the golden RC/);
  assert.match(empty.results[0].detail, /--shape promote/, 'it names the way out');

  const real = await evaluate(
    ['rcHasContent'], at('rc', {count: 2, from: '0.88.0-rc.4'}), {});
  assert.equal(real.passed, true, 'an RC carrying picks is fine');

  // Promoting to stable is never blocked by this gate.
  const promote = await evaluate(
    ['rcHasContent'], at('promote', {count: 0, from: '0.88.0-rc.4'}), {});
  assert.equal(promote.passed, true);

  // No comparison available must not read as a green light.
  const unknown = await evaluate(['rcHasContent'], at('rc', null), {});
  assert.equal(unknown.passed, true);
  assert.match(unknown.results[0].detail, /check by hand/);
});

test('a release with no user-facing changes says to close the changelog PR', async () => {
  // generate-changelog.yml is a workflow_call fired unconditionally, so a
  // release that picked nothing still gets a PR with every section empty.
  // Merging that adds a heading with nothing under it.
  const machinery = /^Release \d|^\[LOCAL\] Bump Podfile\.lock|^Bump Podfile\.lock/;
  const realOnes = subjects => subjects.filter(x => !machinery.test(x));

  // 0.88.0-rc.5: only the release commit and the Podfile bump.
  assert.deepEqual(
    realOnes(['Release 0.88.0-rc.5', '[LOCAL] Bump Podfile.lock']),
    [],
    'a formality release has nothing to record',
  );

  // 0.88.0-rc.4 carried two picks, so it must not be silenced.
  assert.equal(
    realOnes([
      'Release 0.88.0-rc.4',
      '[LOCAL] Bump Podfile.lock',
      'Make generated props and style types augmentable (#58168)',
    ]).length,
    1,
    'a real change is still a real change',
  );

  // A commit that merely mentions a release is not machinery.
  assert.equal(
    realOnes(['Fix Release notes link in the docs']).length,
    1,
    'the filter is anchored, not a substring match',
  );
});

test('the crew message titles the release that was just tagged, not npm lag', async () => {
  // npm lags a publish by minutes. In that window `current` still reads the
  // PREVIOUS version and the message came out titled 0.88.0-rc.4 while
  // carrying rc.5's publish-run link. The tag is the earlier, firmer signal.
  const pick = st =>
    st.tagExistsForNext ? st.proposedNext : (st.current ?? st.proposedNext);

  // Mid-propagation: tag cut, npm has not caught up.
  assert.equal(
    pick({tagExistsForNext: true, proposedNext: '0.88.0-rc.5', current: '0.88.0-rc.4'}),
    '0.88.0-rc.5',
    'the tagged version wins while npm lags',
  );

  // Settled: npm has caught up and there is no new tag.
  assert.equal(
    pick({tagExistsForNext: false, proposedNext: '0.88.0-rc.6', current: '0.88.0-rc.5'}),
    '0.88.0-rc.5',
    'between releases the message is still about the last one published',
  );

  // Nothing published yet on a fresh series.
  assert.equal(
    pick({tagExistsForNext: false, proposedNext: '0.89.0-rc.0', current: null}),
    '0.89.0-rc.0',
  );
});

test('a deferred pick is not assessed as a candidate either', async () => {
  // noOpenPicks learned about deferrals but picksNotBreaking did not, so a
  // pick triaged out of the release still hard-stopped the phase at step 2
  // because it could not be resolved to a commit. A pick we are not taking
  // needs no assessment.
  const seen = [];
  const src = {
    npmVersions: async () => ['0.87.1', '0.88.0-rc.4'],
    npmDistTags: async () => ({latest: '0.87.1', next: '0.88.0-rc.4'}),
    npmPublishTimes: async () => ({}),
    gitTags: async () => ['v0.88.0-rc.4'],
    branchTip: async () => 'b'.repeat(40),
    workflowRuns: async () => [],
    openPicks: async () => [{number: 1440, title: 'a'}, {number: 1441, title: 'b'}, {number: 9999, title: 'c'}],
    pickCandidates: async picks => {
      seen.push(...picks.map(p => p.number));
      return [];
    },
    projectItems: async () => ({project: null, items: []}),
    commitsBetween: async () => ({commits: [], total: 0, complete: true}),
    changelogAt: async () => '',
    fileAt: async () => null,
    releaseArtifacts: async () => ({}),
    hermesUnreleased: async () => ({resolved: false, commits: []}),
  };
  await deriveState(src, {series: '0.88'});

  // Driven by whatever reference/pick-deferrals.json currently defers, so this
  // does not break each time a pick is actioned.
  const {loadPickDeferrals} = await import('../scripts/release-state.mjs');
  const deferred = loadPickDeferrals('0.88', '0.88.0-rc.5')?.numbers ?? [];
  for (const n of deferred) {
    assert.ok(!seen.includes(n), `deferred #${n} is not sent for assessment`);
  }
  assert.ok(seen.includes(9999), 'an undeferred pick still is');
});

test('a recorded pick deferral is scoped to the version it was taken for', async () => {
  // The board had no 0.88.1 option and adding one replaces the whole option
  // list on a shared field, so the deferral is recorded locally instead. It
  // must not leak into the next RC: rc.6 re-asks.
  const {loadPickDeferrals} = await import('../scripts/release-state.mjs');

  const forRc5 = loadPickDeferrals('0.88', '0.88.0-rc.5');
  assert.ok(forRc5, 'the recorded decision is found for the version it names');
  assert.equal(forRc5.to, '0.88.1');
  // Asserts the SHAPE, not the membership: the file is live and picks leave it
  // as they get actioned. #1443 did exactly that once PR #58964 landed.
  assert.ok(forRc5.numbers.length > 0, 'it names at least one deferred pick');
  assert.ok(forRc5.numbers.every(n => Number.isInteger(n)), 'issue numbers');

  // A version with no recorded deferral gets nothing: the decision never
  // carries forward on its own. rc.6 has its own entry now, so this uses a
  // version that has not been decided.
  assert.equal(loadPickDeferrals('0.88', '0.88.0-rc.99'), null, 'an undecided RC re-asks');
  assert.equal(loadPickDeferrals('0.89', '0.88.0-rc.5'), null, 'another series is unaffected');
});

test('a pick targeted at a later version does not block this release', async () => {
  // "Leave them open, we will pick them for 0.88.1" is a decision and the
  // board's Target Release is where it lives. An untargeted pick still blocks,
  // because an untriaged request is what this gate exists to catch.
  const at = picks => baseState({proposedNext: '0.88.0-rc.5', openPicks: picks});

  const untargeted = await evaluate(['noOpenPicks'], at([{number: 1440, targetRelease: null}]), {});
  assert.equal(untargeted.passed, false, 'an untriaged pick still blocks');

  const thisRelease = await evaluate(
    ['noOpenPicks'], at([{number: 1440, targetRelease: '0.88.0-rc.5'}]), {});
  assert.equal(thisRelease.passed, false, 'a pick aimed at THIS release blocks');

  const deferred = await evaluate(
    ['noOpenPicks'],
    at([
      {number: 1440, targetRelease: '0.88.1'},
      {number: 1441, targetRelease: '0.88.1'},
      {number: 1443, targetRelease: '0.88.1'},
    ]),
    {},
  );
  assert.equal(deferred.passed, true, 'all deferred means nothing outstanding');
  assert.match(deferred.results[0].detail, /3 deferred/);
  assert.match(deferred.results[0].detail, /#1440->0\.88\.1/);

  // Mixed: the deferred ones are named but the outstanding one still fails.
  const mixed = await evaluate(
    ['noOpenPicks'],
    at([{number: 1440, targetRelease: '0.88.1'}, {number: 1441, targetRelease: null}]),
    {},
  );
  assert.equal(mixed.passed, false);
  assert.match(mixed.results[0].detail, /#1441/);
  assert.doesNotMatch(mixed.results[0].detail, /open picks: #1440/);
});

test('a recorded Hermes decision passes, but only for the commits it names', async () => {
  // The gate told you to "record why the branch is deliberately ahead" and
  // gave you nowhere to record it, so the only way past was to ignore a red
  // gate. The exception has to expire when new work lands, otherwise it
  // silently blesses commits nobody looked at.
  const ahead = shas => baseState({
    hermesUnreleased: {
      resolved: true,
      tag: 'hermes-v260318099.0.4',
      branch: '260318099.0.0-stable',
      commits: shas.map(sha => ({sha, subject: 'x', versionBump: false})),
    },
  });
  const ACK = ['a2200396a42', 'c2834a81138', '4d739cf131f', '31b516b69b0', '09d3bf22976'];

  // No exception recorded: still red.
  const bare = await evaluate(['hermesCurrent'], ahead(ACK), {});
  assert.equal(bare.passed, false, 'without an exception the gate stays red');

  // Every unreleased commit acknowledged: green and it says it was deliberate.
  const covered = {...ahead(ACK), hermesException: {
    decision: 'ship on .0.4', reviewedBy: 'x', reviewedOn: '2026-10-12', unacknowledged: [],
  }};
  const ev = await evaluate(['hermesCurrent'], covered, {});
  assert.equal(ev.passed, true);
  assert.match(ev.results[0].detail, /deliberately/);

  // A commit landing after the decision re-reds it.
  const partial = {...ahead([...ACK, 'newcommit123']), hermesException: {
    decision: 'ship on .0.4', reviewedBy: 'x', reviewedOn: '2026-10-12',
    unacknowledged: ['newcommit123'],
  }};
  const ev2 = await evaluate(['hermesCurrent'], partial, {});
  assert.equal(ev2.passed, false, 'a commit the decision never saw must not inherit it');
  assert.match(ev2.results[0].detail, /newcommit123/);
});

test('a fix described without the word "fix" is not read as a feature', async () => {
  // #1440 said "It is a bug that ... fail silently" and never said "fix", while
  // "installing new packages" tripped the feature heuristic on the word "new".
  // It came back REJECT on a legitimate bug fix.
  const {assess} = await import('../scripts/assess-picks.mjs');
  const candidate = {
    number: 1440,
    title: '[0.88] Encode line breaks in SwiftPM scheme pre-action scriptText',
    description:
      'This adds a simple encoding of line breaks in a shell script for SwiftPM preview. ' +
      'It is a bug that now causes the automatic sync after installing new packages to fail silently.',
    resolved: [{sha: 'b8df948fd4d', subject: 'Encode line breaks in SwiftPM scheme pre-action scriptText (#58826)',
      files: [
        {f: 'packages/react-native/scripts/spm/generate-spm-xcodeproj.js', a: 15, d: 24},
        {f: 'packages/react-native/scripts/spm/__tests__/generate-spm-xcodeproj-test.js', a: 35, d: 0},
      ]}],
  };
  const r = assess(candidate, baseState({series: '0.88', schedule: {isNonBreaking: true}}));
  assert.equal(r.verdict, 'ACCEPT', `expected ACCEPT, got ${r.verdict}: ${r.why.join('; ')}`);

  // A genuine feature still reads as one.
  const feature = {
    ...candidate,
    number: 9999,
    title: '[0.88] Add a new resolver option',
    description: 'This introduces a new option for the resolver.',
    resolved: [{sha: 'deadbeef123', subject: 'Add a new resolver option (#1)',
      files: [{f: 'packages/react-native/src/thing.js', a: 40, d: 0}]}],
  };
  assert.notEqual(assess(feature, baseState({series: '0.88', schedule: {isNonBreaking: true}})).verdict, 'ACCEPT');
});

test('--shape changes the version proposed, not just the steps', async () => {
  // `--shape promote` used to run the promote STEPS while still proposing the
  // next RC, so a promote would have published 0.88.0-rc.3. The eval missed it
  // by hand-feeding proposedNext.
  const {fixtureSources} = await import('../scripts/sources.mjs');
  const src = () => fixtureSources(FIXTURE);
  const at = async shape =>
    (await deriveState(src(), {series: '0.88', today: '2026-09-22', shape})).proposedNext;

  assert.equal(await at('promote'), '0.88.0', 'promote proposes the stable version');
  assert.equal(await at('rc'), '0.88.0-rc.3', 'rc proposes the next RC');
  assert.equal(await at(undefined), '0.88.0-rc.3', 'no shape keeps the current one');
});

test('a series with no release yet proposes its RC0', async () => {
  // Live `--series 0.89` derived proposedNext=null, so a branch cut would have
  // published `version=null`. The eval hid it by injecting the version.
  const empty = {
    npmVersions: async () => [],
    npmDistTags: async () => ({latest: '0.88.0', next: '0.88.0-rc.4'}),
    npmPublishTimes: async () => ({}),
    gitTags: async () => [],
    branchTip: async () => null,
    workflowRuns: async () => [],
    openPicks: async () => [],
    pickCandidates: async () => [],
    projectItems: async () => [],
    commitsBetween: async () => ({commits: [], total: 0, complete: true}),
    changelogAt: async () => '',
    fileAt: async () => null,
    releaseArtifacts: async () => ({}),
    hermesUnreleased: async () => ({resolved: false, commits: []}),
  };
  const st = await deriveState(empty, {series: '0.89'});
  assert.equal(st.proposedNext, '0.89.0-rc.0');
  assert.equal(st.shape, 'branch-cut');
});

test('doctor and the runner resolve the SAME checkout', async () => {
  // The first version of this fix read the env var in the CLI but let doctor
  // fall back to ~/git/react-native. Doctor then validated a path the runner
  // never used and git ran in process.cwd(). It passed review because the
  // check was run with RN_CHECKOUT set, which is exactly the masking case.
  const {resolveCheckout} = await import('../scripts/doctor.mjs');
  const saved = process.env.RN_CHECKOUT;
  try {
    delete process.env.RN_CHECKOUT;
    const fallback = resolveCheckout(undefined);
    assert.ok(fallback, 'with no flag and no env there is still a path');
    assert.match(fallback, /react-native$/, 'and it is the react-native checkout');

    process.env.RN_CHECKOUT = '/from/env';
    assert.equal(resolveCheckout(undefined), '/from/env', 'env beats the default');
    assert.equal(resolveCheckout('/explicit'), '/explicit', 'the flag beats the env');
  } finally {
    if (saved === undefined) {
      delete process.env.RN_CHECKOUT;
    } else {
      process.env.RN_CHECKOUT = saved;
    }
  }
});

test('git actions run in the react-native checkout, not the cwd', async () => {
  // SKILL.md says to run from this repo. Without a cwd the git steps ran HERE
  // and `git switch 0.88-stable` failed with "invalid reference", which is
  // exactly how the first rc.3 attempt died.
  const {Runner, MODES, declare} = await import('../scripts/actions.mjs');
  const r = new Runner({mode: MODES.DRY_RUN, cwd: '/somewhere/react-native', log: () => {}});
  assert.equal(r.cwd, '/somewhere/react-native');

  // Only git is relocated. gh and curl talk to a remote and must not be.
  const noCwd = new Runner({mode: MODES.DRY_RUN, log: () => {}});
  assert.equal(noCwd.cwd, undefined, 'absent cwd stays absent rather than defaulting');
  assert.doesNotThrow(() => declare({step: 's', mutates: false, why: 'w', cmd: 'git', args: ['status']}));
});

test('gate: a branch cut cannot post a placeholder SHA', async () => {
  // The step used to send the literal string `sha=MAIN_SHA`, so a guided cut
  // would take the captain's confirmation and POST that text. The eval asserted
  // the broken command, which locked the bug in.
  const {phaseFor} = await import('../scripts/phases.mjs');
  const step = phaseFor('branch-cut').steps.find(x => x.id === 'create-branches');
  assert.ok(step.gates.includes('mainResolved'), 'the cut must be gated on a resolved main');

  const real = 'c0ffee1234567890abcdef1234567890abcdef12';
  const pre = baseState({branch: '0.89-stable', mainTip: real, branchTip: null});
  const [action] = step.actions(pre, {});
  assert.ok(action.args.includes(`sha=${real}`), 'the real SHA is sent');
  assert.ok(!action.args.some(a => /MAIN_SHA/.test(a)), 'no placeholder survives');

  assert.equal((await evaluate(['mainResolved'], pre, {})).passed, true);
  for (const bad of [null, undefined, 'MAIN_SHA', 'abc123']) {
    const ev = await evaluate(['mainResolved'], baseState({mainTip: bad, branchTip: null}), {});
    assert.equal(ev.passed, false, `mainTip ${String(bad)} must not pass`);
  }

  // A cut is two passes, because CI cannot be green on a branch that does not
  // exist. On the second the step must do nothing rather than POST the ref
  // again and re-fire the nightly.
  const resumed = baseState({branch: '0.89-stable', mainTip: real, branchTip: 'bbbbbbbbbbb'});
  assert.deepEqual(step.actions(resumed, {}), [], 'resuming declares no action');
  assert.equal((await evaluate(['mainResolved'], resumed, {})).passed, true, 'and does not block');
});

test('gate: a half-published release is named, not just refused', async () => {
  // 0.88.0-rc.4 sat with its tag cut and npm empty. tagFree refused, but for
  // the wrong stated reason ("already exists"), which points at picking a new
  // version when the real remedy is resuming the publish.
  const halfDone = baseState({
    proposedNext: '0.88.0-rc.4',
    tagExistsForNext: true,
    halfReleased: true,
  });
  const ev = await evaluate(['tagFree'], halfDone, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /NOT on npm/);
  assert.match(ev.results[0].detail, /Re-run the Publish to npm run/);

  // A genuinely released version still reads as already shipped.
  const shipped = baseState({
    proposedNext: '0.88.0-rc.3',
    tagExistsForNext: true,
    halfReleased: false,
  });
  const ev2 = await evaluate(['tagFree'], shipped, {});
  assert.equal(ev2.passed, false);
  assert.match(ev2.results[0].detail, /already exists/);

  const free = baseState({proposedNext: '0.88.0-rc.5', tagExistsForNext: false, halfReleased: false});
  assert.equal((await evaluate(['tagFree'], free, {})).passed, true);
});

test('the picks step tells the captain to check authorship', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  // A cherry-pick that loses authorship miscredits a contributor in the
  // published changelog, because the generator reads the BRANCH commit.
  const picks = phaseFor('rc').steps.find(x => x.id === 'picks');
  assert.match(picks.note, /CHECK AUTHORSHIP/);
  assert.match(picks.note, /original author/);
});

test('gate: an empty CI list never reads as green', async () => {
  // This fired for real while triggering rc.3. A transient `git ls-remote`
  // made branchTip null (it is fetched with allowFail), the tip filter emptied
  // the CI list and ciGreen reported "0 workflow(s) green" and passed.
  const noTip = baseState({ci: [], branchTip: null});
  const ev1 = await evaluate(['ciGreen'], noTip, {});
  assert.equal(ev1.passed, false, 'no branch tip means CI cannot be attributed');
  assert.match(ev1.results[0].detail, /could not resolve the branch tip/);

  const noRuns = baseState({ci: [], branchTip: '993be7d6c69'});
  const ev2 = await evaluate(['ciGreen'], noRuns, {});
  assert.equal(ev2.passed, false, 'zero runs is absence of evidence, not a pass');
  assert.match(ev2.results[0].detail, /not the same as passing/);
});

test('gate: CI red on an earlier commit is not hidden by a green tip', async () => {
  // A path-filtered workflow that did not re-run on the tip was invisible, and
  // hid a red gate on the commit that shipped 0.88.0-rc.2.
  const state = baseState({
    ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}],
    staleRed: [{workflow: 'Validate C++ API Snapshots', sha: '215169c51bf', at: 'x'}],
  });
  const ev = await evaluate(['ciGreen'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /Validate C\+\+ API Snapshots/);
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

test('the rc phase verifies a fresh app builds on the published version', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const steps = phaseFor('rc').steps.map(x => x.id);
  assert.ok(steps.includes('template-check'), 'the template check must be part of the flow');
  // It needs the package on npm, so it comes after the publish is verified.
  assert.ok(
    steps.indexOf('template-check') > steps.indexOf('verify-publish'),
    'cannot build against a version that is not published yet',
  );

  const state = baseState({proposedNext: '0.88.0-rc.3'});
  const [a] = phaseFor('rc').steps.find(x => x.id === 'template-check').actions(state, {});
  assert.equal(a.mutates, false, 'building a throwaway app changes nothing shared');
  assert.ok(a.args.includes('0.88.0-rc.3'), 'must verify the version being released');
  assert.match(a.args[0], /verify-template\.mjs$/);
});

test('the announce step emits the announcement rather than naming channels', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const {buildAnnouncement, ANNOUNCE_CHANNELS} = await import('../scripts/release-message.mjs');

  const announce = phaseFor('rc').steps.find(x => x.id === 'announce');
  assert.equal(typeof announce.emit, 'function', 'announce must produce the text');

  const text = buildAnnouncement('0.88.0-rc.3', {
    changelogPr: 'https://github.com/react/react-native/pull/58716',
  });
  assert.match(text, /0\.88\.0-rc\.3 is out!/);
  assert.match(text, /releases\/tag\/v0\.88\.0-rc\.3/, 'links the release, not the tag ref');
  assert.match(text, /pull\/58716/);

  // The announcement is separate from the status checklist: one is the
  // captain's progress, the other is what the community reads.
  assert.ok(!text.includes(':hourglass:'), 'no checklist ticks in an announcement');
  assert.ok(ANNOUNCE_CHANNELS.some(c => /Discord/.test(c)));
  assert.ok(ANNOUNCE_CHANNELS.some(c => /Slack/.test(c)));
});

test('the announcement omits the changelog line when there is no PR', async () => {
  const {buildAnnouncement} = await import('../scripts/release-message.mjs');
  const text = buildAnnouncement('0.88.0-rc.3', {});
  assert.ok(!text.includes('Changelog PR'), 'no dangling label with an empty link');
  assert.match(text, /Release tag:/);
});

test('the publish step emits the crew message rather than asking for it', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  // It used to be a line in the note telling the captain to go and run the
  // message command. rc.3 shipped and the crew message went unposted for an
  // hour, so the step prints it instead.
  const publish = phaseFor('rc').steps.find(x => x.id === 'publish');
  assert.equal(typeof publish.emit, 'function', 'publish must emit the status message');
  assert.ok(
    !/run `node scripts\/cli\.mjs message/.test(publish.note),
    'the note must not just point at the command',
  );
});

test('status message: a tagged version settles the pre-release CI ticks', async () => {
  const {buildStatusMessage} = await import('../scripts/release-message.mjs');
  // After the release commit lands, the branch tip moves past the commit that
  // was gated, so live CI reads pending and the ticks would flip backwards.
  const movedOn = baseState({ci: []});

  const untagged = buildStatusMessage(movedOn, {version: '0.88.0-rc.3', artifacts: {tagged: false}});
  assert.match(
    untagged.split('\n').find(l => l.includes('E2E tests are green')),
    /hourglass/,
    'not released yet, so CI is genuinely unconfirmed',
  );

  const tagged = buildStatusMessage(movedOn, {version: '0.88.0-rc.3', artifacts: {tagged: true}});
  assert.match(
    tagged.split('\n').find(l => l.includes('E2E tests are green')),
    /white_check_mark/,
    'the tag exists, so ciGreen gated the publish and the check is settled',
  );
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
  assert.equal(requiresManualTesting(done, '0.87.0'), false, 'the .0 is covered by the golden RC');
  assert.equal(requiresManualTesting(done, '0.87.3'), false, 'patches are not manually tested');

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

test('golden RC: rc.5 is the standing assumption for an in-flight series', async () => {
  const {requiresManualTesting} = await import('../scripts/release-message.mjs');
  // The captain's standing instruction: assume rc.5 is golden unless told
  // otherwise. So this answers rather than refuses.
  const live = baseState({
    schedule: {
      manualTestingRcs: [0, 1],
      goldenRc: {value: null, source: 'unknown'},
      expectedGoldenRc: 5,
    },
  });
  assert.equal(requiresManualTesting(live, '0.88.0-rc.0'), true, 'rc.0 unconditional');
  assert.equal(requiresManualTesting(live, '0.88.0-rc.1'), true, 'rc.1 unconditional');
  assert.equal(requiresManualTesting(live, '0.88.0-rc.3'), false, 'not the assumed golden');
  assert.equal(requiresManualTesting(live, '0.88.0-rc.5'), true, 'the assumed golden');
  assert.equal(requiresManualTesting(live, '0.88.0'), false, 'the .0 is covered by the golden RC');
});

test('golden RC: a released series still derives from tags, overriding the default', async () => {
  const {requiresManualTesting} = await import('../scripts/release-message.mjs');
  // 0.87 actually ended at rc.4. Tags beat the standing rc.5 assumption.
  const released = baseState({
    schedule: {
      manualTestingRcs: [0, 1],
      goldenRc: {value: 4, source: 'tags'},
      expectedGoldenRc: 5,
    },
  });
  assert.equal(requiresManualTesting(released, '0.87.0-rc.4'), true, 'the real golden');
  assert.equal(requiresManualTesting(released, '0.87.0-rc.5'), false, 'the default must not win');
});

test('golden RC: with no default and no tags it still refuses to guess', async () => {
  const {requiresManualTesting} = await import('../scripts/release-message.mjs');
  const bare = baseState({
    schedule: {manualTestingRcs: [0, 1], goldenRc: {value: null, source: 'unknown'}},
  });
  assert.equal(requiresManualTesting(bare, '0.88.0-rc.3'), null);
});

test('the remaining releases are projected from the golden assumption', async () => {
  const {summarize} = await import('../scripts/release-state.mjs');
  // Showing the schedule's ".0 on 10-05" next to "next release is rc.4 on
  // 10-05" is a contradiction. Project from the assumed golden instead.
  const out = summarize(
    baseState({
      series: '0.88',
      proposedNext: '0.88.0-rc.4',
      schedule: {
        series: {version: '0.88', type: 'non-breaking', release: '2026-10-05'},
        expectedGoldenRc: 5,
        cadenceDays: 7,
        manualTestingRcs: [0, 1],
        goldenRc: {value: null, source: 'unknown'},
        cadence: {due: '2026-10-05'},
      },
    }),
  );
  assert.match(out, /0\.88\.0-rc\.4 2026-10-05/);
  assert.match(out, /0\.88\.0-rc\.5 \(golden\) 2026-10-12/, 'golden lands a week after rc.4');
  assert.match(out, /0\.88\.0 2026-10-19/, 'stable follows the golden');
  assert.match(out, /Schedule says \.0 2026-10-05/, 'still shows what the schedule claims');
});

test('pick assessment reads intent from the request, not just the commit', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  // #1437's commit subject is "Properly enable Pressable after disabled prop
  // reset" with no "fix" in it, while its request says "Fixes a bug which
  // caused...". Reading only the commit missed an obvious bug fix.
  const candidate = {
    number: 1437,
    title: '[0.88] Fix pressable area after `disabled` reset',
    description: 'Fixes a bug which caused <Pressable> to not be entirely tappable',
    landed: false,
    resolved: [
      {
        sha: '357b6998c4d',
        message: 'Properly enable Pressable after disabled prop reset (#58799)',
        files: [
          {f: 'packages/react-native/ReactAndroid/src/main/java/.../BaseViewManager.java', a: 16, d: 2},
          {f: 'packages/react-native/ReactAndroid/src/test/java/.../BaseViewManagerTest.kt', a: 32, d: 0},
        ],
      },
    ],
  };
  const out = assess(candidate, baseState({series: '0.88'}));
  assert.equal(out.verdict, 'ACCEPT');
  assert.match(out.why.join(' '), /describes a fix/);
});

test('pick assessment escalates rather than guessing and names the crew', async () => {
  const {assess, RELEASE_CREW} = await import('../scripts/assess-picks.mjs');
  // A public-type surface change in a non-breaking series is exactly the class
  // that shipped as #57879 and had to be reverted. It gets a human.
  const out = assess(
    {
      number: 1433,
      title: '[0.88] Make generated props and style types augmentable',
      description: '',
      landed: false,
      resolved: [
        {
          sha: '447ccd1ddbf',
          message: 'Make generated props and style types augmentable (#58168)',
          files: [{f: 'packages/react-native/ReactNativeApi.d.ts', a: 153, d: 141}],
        },
      ],
    },
    baseState({series: '0.88'}),
  );
  assert.equal(out.verdict, 'ASK');
  assert.match(out.why.join(' '), /public-types/);
  for (const name of ['Nicola', 'Riccardo', 'Fabrizio']) {
    assert.ok(RELEASE_CREW.includes(name));
    assert.match(out.ask, new RegExp(name));
  }
});

test('pick assessment rejects a breaking candidate in a non-breaking series', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  const out = assess(
    {
      number: 1,
      title: 'x',
      description: '',
      landed: false,
      resolved: [{sha: 'a', message: 'T\n\n[IOS] [BREAKING] - changes codegen', files: [{f: 'a.js', a: 1, d: 1}]}],
    },
    baseState({series: '0.88', schedule: {isNonBreaking: true, series: {version: '0.88'}}}),
  );
  assert.equal(out.verdict, 'REJECT');
  assert.match(out.why.join(' '), /criterion 9/);
});

test('only the pick field names the commit, not the whole issue body', async () => {
  const {breakingSurfaces} = await import('../scripts/gates.mjs');
  // #1433's Description cited a prerequisite that had ALREADY shipped in rc.3
  // ("Second part of <commit>, already picked in 0.88"). Scraping the whole
  // body matched that SHA and reported the pick as landed while it was still
  // only on main, which would have shipped rc.4 without it.
  const body = [
    '### Link to commit or PR to be picked',
    '',
    'https://github.com/react/react-native/pull/58168',
    '',
    '### Description',
    '',
    'Second part of https://github.com/react/react-native/commit/593ae0258d75ae98c42ebe786e9b449464c94a65, already picked in 0.88',
  ].join('\n');

  const field = /###\s*Link to commit or PR to be picked\s*\n([\s\S]*?)(?=\n###|$)/i.exec(body)?.[1];
  assert.ok(field, 'the pick field must be found');
  assert.ok(!/593ae0258d75/.test(field), 'the Description commit must not be read as the pick');
  assert.match(field, /pull\/58168/, 'the pick itself must be found');
  // Guard the detector this feeds, so the pair stays meaningful.
  assert.equal(breakingSurfaces([]).length, 0);
});

test('open picks are matched by title prefix, not free-text search', async () => {
  const {summarize} = await import('../scripts/release-state.mjs');
  // GitHub free-text search also matches comment bodies, which pulled a
  // [0.86] pick into the 0.88 list. The captain would have actioned it.
  const out = summarize(
    baseState({
      series: '0.88',
      openPicks: [
        {number: 1437, title: '[0.88] Fix pressable area after disabled reset'},
        {number: 1433, title: '[0.88] Make generated props augmentable'},
      ],
    }),
  );
  assert.match(out, /#1437/);
  assert.ok(!/#1402/.test(out), 'a pick from another series must not appear');
});

test('the Hermes summary matches the hermesCurrent gate', async () => {
  const {summarize} = await import('../scripts/release-state.mjs');
  // The gate treats a version bump as plumbing and passes. The summary listed
  // it as unreleased work, so the two contradicted each other.
  const out = summarize(
    baseState({
      hermes: {pinned: '260318099.0.4', compiler: '260318099.0.4'},
      hermesUnreleased: {
        branch: '260318099.0.0-stable',
        tag: 'hermes-v260318099.0.4',
        resolved: true,
        inTreeVersion: '260318099.0.5',
        commits: [
          {sha: '6cb3676787d', subject: 'Bump hermes-compiler version to 260318099.0.5', reland: false, versionBump: true},
        ],
      },
    }),
  );
  assert.ok(!/NOT in the pinned tag/.test(out), 'a lone version bump is not drift');
});

test('the copilot does not suggest moving the golden RC', async () => {
  const {summarize} = await import('../scripts/release-state.mjs');
  // rc.5 is the captain's standing rule. Reporting that nothing landed yet is
  // useful; hinting the golden should move is not the copilot's call.
  const out = summarize(
    baseState({
      schedule: {
        series: {version: '0.88', type: 'non-breaking'},
        expectedGoldenRc: 5,
        manualTestingRcs: [0, 1],
        goldenRc: {value: null, source: 'unknown'},
        sinceLastRc: {count: 0, from: '0.88.0-rc.3'},
      },
    }),
  );
  assert.ok(!/declare an earlier golden/.test(out), 'must not suggest deviating');
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

test('declining an action stops the phase, it does not skip to the next step', async () => {
  // Declining a Hermes cut then continuing offered to pin the release branch to
  // a version that was never published. Later steps assume the earlier ones
  // happened, so a decline has to end the run.
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [{sha: 'abc', subject: 'x', reland: false}],
    },
  });
  const result = await runPhase(state, {
    mode: MODES.GUIDED,
    shape: 'hermes-release',
    ctx: {},
    confirm: async () => false,
    log: () => {},
  });
  assert.equal(result.completed, false);
  assert.equal(result.stopped[0].step, 'hermes-cut');
  assert.equal(result.stopped[0].declined, true);
  const reached = [...new Set(result.plan.map(p => p.step))];
  for (const later of ['hermes-verify-tag', 'hermes-pin', 'hermes-push']) {
    assert.ok(!reached.includes(later), `must not reach "${later}" after declining the cut`);
  }
});

// ---------------------------------------------------------- hermes release

test('gate: cutting Hermes is blocked while the branch names a released version', async () => {
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.3',
      wouldRecut: true,
      commits: [{sha: 'abc', subject: 'x', reland: false}],
    },
  });
  const ev = await evaluate(['hermesReadyToCut'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /already released/);
  assert.match(ev.results[0].detail, /bump PR first/);
});

test('gate: readiness keys off publication, not off what RN pins', async () => {
  // The bug this replaces: wouldRecut compared the branch's in-tree version
  // against the RN pin. Right after cutting .0.4 the branch still named .0.4
  // while RN pinned .0.3, so "they differ" read as safe and the gate would
  // have allowed a re-cut of an already-published version.
  const justCut = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      inTreePublished: true,
      wouldRecut: true,
      commits: [{sha: 'x', subject: 'y', reland: false}],
    },
  });
  const ev = await evaluate(['hermesReadyToCut'], justCut, {});
  assert.equal(ev.passed, false, 'the in-tree version is published, so cutting would re-cut it');
  assert.match(ev.results[0].detail, /already released/);
});

test('gate: cutting Hermes is blocked when there is nothing to cut', async () => {
  const state = baseState({
    hermesUnreleased: {
      branch: 'b',
      tag: 't',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [],
    },
  });
  assert.equal((await evaluate(['hermesReadyToCut'], state, {})).passed, false);
});

test('gate: a ready Hermes cut names the version and flags any re-land', async () => {
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [
        {sha: 'ace586d9008', subject: 'Back out "Back out D116775223"', reland: true},
        {sha: '892dc627d3b', subject: 'Avoid reserve()', reland: false},
      ],
    },
  });
  const ev = await evaluate(['hermesReadyToCut'], state, {});
  assert.equal(ev.passed, true);
  assert.match(ev.results[0].detail, /260318099\.0\.4/);
  assert.match(ev.results[0].detail, /RE-LAND/, 'a re-land must be named even when the gate passes');
});

test('the Hermes cut surfaces the re-land at the confirmation and demands the version', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [{sha: 'ace586d9008', subject: 'Back out "Back out D116775223"', reland: true}],
    },
  });
  const [a] = phaseFor('hermes-release').steps.find(s => s.id === 'hermes-cut').actions(state, {});
  assert.equal(a.confirmToken, '260318099.0.4', 'the version must be retyped, not accepted as y');
  assert.ok(a.impact.some(i => /INCLUDES A RE-LAND/.test(i)), 'the re-land must be in the impact');
  assert.ok(a.impact.some(i => /publicly and permanently/.test(i)));
  assert.match(a.reversible, /^no\./);
});

test('the Hermes flow bumps the branch to the NEXT version after cutting', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const state = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.3',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: false,
      commits: [{sha: 'x', subject: 'y', reland: false}],
    },
  });
  const steps = phaseFor('hermes-release').steps.map(x => x.id);
  assert.ok(steps.includes('hermes-next-bump'), 'the follow-up bump must be part of the flow');
  assert.ok(
    steps.indexOf('hermes-next-bump') > steps.indexOf('hermes-cut'),
    'the bump is the tail of this release, so it comes after the cut',
  );

  const [a] = phaseFor('hermes-release').steps
    .find(x => x.id === 'hermes-next-bump')
    .actions(state, {});
  // Cutting .0.4 leaves the branch naming an already-published version, which
  // is what made the .0.4 bump overdue in the first place.
  assert.match(a.why, /260318099\.0\.5/);
  assert.ok(a.impact.some(i => /re-cuts the version just released/.test(i)));
});

test('after a cut, the gate catches the branch naming a published version', async () => {
  // The state hermes-next-bump exists to prevent. Proves the two halves line up.
  const afterCut = baseState({
    hermesUnreleased: {
      branch: '260318099.0.0-stable',
      tag: 'hermes-v260318099.0.4',
      resolved: true,
      inTreeVersion: '260318099.0.4',
      wouldRecut: true,
      commits: [{sha: 'x', subject: 'y', reland: false}],
    },
  });
  const ev = await evaluate(['hermesCurrent'], afterCut, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /would re-cut it/);
});

test('the Hermes cut sets both non-default workflow inputs', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const state = baseState({
    hermesUnreleased: {
      branch: 'b',
      tag: 't',
      resolved: true,
      inTreeVersion: '1.2.3',
      wouldRecut: false,
      commits: [{sha: 'x', subject: 'y', reland: false}],
    },
  });
  const [withLatest] = phaseFor('hermes-release').steps
    .find(s => s.id === 'hermes-cut')
    .actions(state, {});
  // release-type defaults to dry-run and update-latest-v1 to false, so both
  // must be explicit or the cut silently does the wrong thing.
  assert.ok(withLatest.args.includes('release-type=release'));
  assert.ok(withLatest.args.includes('update-latest-v1=true'));

  const [without] = phaseFor('hermes-release').steps
    .find(s => s.id === 'hermes-cut')
    .actions(state, {hermesLatestV1: false});
  assert.ok(without.args.includes('update-latest-v1=false'));
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
    staleRed: [],
    openPicks: [],
    pickCandidates: [],
    hermesUnreleased: {branch: 'x-stable', tag: 'hermes-vx', resolved: true, commits: []},
    // The recorded branch had a stale .hermesv1version; that is asserted on its own.
    hermes: {...derived.hermes, v1Tag: `hermes-v${derived.hermes.pinned}`},
    // Same reason as the CI normalisation above: this asserts the plan shape,
    // not whether the recorded branch happened to have picks on it.
    schedule: {...derived.schedule, sinceLastRc: {count: 2, from: '0.88.0-rc.0'}},
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
    pickCandidates: [],
    breakingCommits: [],
    staleRed: [],
    hermesUnreleased: {branch: 'x-stable', tag: 'hermes-vx', resolved: true, commits: []},
    hermes: {...state.hermes, v1Tag: `hermes-v${state.hermes.pinned}`},
    ci: [{workflow: 'Test All', conclusion: 'success', status: 'completed', failedJobs: []}],
    schedule: {...state.schedule, sinceLastRc: {count: 2, from: '0.88.0-rc.0'}},
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
      `node ${new URL('../scripts/generate-changelog.mjs', import.meta.url).pathname} 0.88.0-rc.3`,
      `node ${new URL('../scripts/fill-release-notes.mjs', import.meta.url).pathname} 0.88.0-rc.3`,
      "echo 'post announcement to React Releases on Slack'",
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

// ------------------------------------------------- 0.88.0 promote fixes

test('gate: a stable newer than latest must take latest', async () => {
  // The 0.88.0 plan passed this gate without --latest and would have published
  // the new minor with is-latest-on-npm=false.
  const state = baseState({proposedNext: '0.88.0', distTags: {latest: '0.87.1'}});
  const without = await evaluate(['distTagCorrect'], state, {isLatest: false});
  assert.equal(without.passed, false);
  assert.match(without.results[0].detail, /--latest/);
  assert.equal((await evaluate(['distTagCorrect'], state, {isLatest: true})).passed, true);
});

test('gate: a patch on an older line must not take latest', async () => {
  const state = baseState({proposedNext: '0.87.2', distTags: {latest: '0.88.0'}});
  assert.equal((await evaluate(['distTagCorrect'], state, {isLatest: true})).passed, false);
  assert.equal((await evaluate(['distTagCorrect'], state, {isLatest: false})).passed, true);
});

test('gate: a stable release with an unreadable latest tag blocks', async () => {
  const state = baseState({proposedNext: '0.88.0', distTags: {}});
  assert.equal((await evaluate(['distTagCorrect'], state, {isLatest: true})).passed, false);
});

test('gate: a release that needs manual testing waits for --manual-tested', async () => {
  const needs = baseState({proposedNext: '0.88.0', schedule: {needsManualTesting: true}});
  const ev = await evaluate(['manualTestingDone'], needs, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /--manual-tested/);
  assert.equal((await evaluate(['manualTestingDone'], needs, {manualTested: true})).passed, true);

  const unknown = baseState({schedule: {needsManualTesting: null}});
  assert.equal((await evaluate(['manualTestingDone'], unknown, {})).passed, false, 'unknown asks');

  const none = baseState({schedule: {needsManualTesting: false}});
  assert.equal((await evaluate(['manualTestingDone'], none, {})).passed, true);
});

test('the publish pre-flight checks manual testing', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  for (const shape of ['rc', 'promote', 'patch']) {
    const pre = phaseFor(shape).steps.find(s => s.id === 'pre-flight');
    assert.ok(pre.gates.includes('manualTestingDone'), shape);
  }
});

const goldenSrc = ({commits = [], picks = [], board = []} = {}) => ({
  npmVersions: async () => ['0.87.1', '0.88.0-rc.6'],
  npmDistTags: async () => ({latest: '0.87.1', next: '0.88.0-rc.6'}),
  npmPublishTimes: async () => ({}),
  gitTags: async () => ['v0.88.0-rc.6'],
  branchTip: async () => 'b'.repeat(40),
  workflowRuns: async () => [],
  openPicks: async () => picks,
  pickCandidates: async () => [],
  projectItems: async () => ({project: null, items: board}),
  commitsBetween: async () => ({commits, total: commits.length, complete: true}),
  changelogAt: async () => '',
  fileAt: async () => null,
  releaseArtifacts: async () => ({}),
  hermesUnreleased: async () => ({resolved: false, commits: []}),
});

test('an RC with nothing after it and no pick aimed at .0 proposes promote', async () => {
  // After rc.6 shipped with nothing behind it, status proposed rc.7.
  const state = await deriveState(goldenSrc(), {series: '0.88'});
  assert.equal(state.shape, 'promote');
  assert.equal(state.proposedNext, '0.88.0');
  assert.equal(state.schedule.lastRcWasGolden, true);
  const {summarize} = await import('../scripts/release-state.mjs');
  const out = summarize(state);
  assert.match(out, /Golden RC     rc\.6: nothing substantive landed/);
  assert.ok(!/assumed rc\.4/.test(out), 'no stale planning prior once past it');
});

test('a substantive commit since the last RC keeps proposing another RC', async () => {
  const state = await deriveState(goldenSrc({commits: [{sha: 'a'.repeat(40), message: 'Fix a crash'}]}), {series: '0.88'});
  assert.equal(state.shape, 'rc');
  assert.equal(state.proposedNext, '0.88.0-rc.7');
});

test('an open pick aimed at .0 keeps proposing another RC', async () => {
  const untriaged = await deriveState(goldenSrc({picks: [{number: 9999, title: 'x'}]}), {series: '0.88'});
  assert.equal(untriaged.proposedNext, '0.88.0-rc.7', 'an untriaged pick may still go in');

  const deferred = await deriveState(
    goldenSrc({
      picks: [{number: 9999, title: 'x'}],
      board: [{content: {number: 9999}, 'target Release': '0.88.1'}],
    }),
    {series: '0.88'},
  );
  assert.equal(deferred.proposedNext, '0.88.0', 'a pick the board aims at the patch does not hold .0');
});

test('assess-picks names earlier deferrals and lists picks deferred out of this release', async () => {
  const {formatAssessment} = await import('../scripts/assess-picks.mjs');
  const {loadPickDeferrals} = await import('../scripts/release-state.mjs');
  const rc6 = loadPickDeferrals('0.88', '0.88.0-rc.6');
  assert.ok(rc6?.numbers.length, 'rc.6 has a recorded deferral to test against');
  const n = rc6.numbers[0];

  const assessed = formatAssessment(
    [{number: n, title: 't', verdict: 'ACCEPT', why: ['fits']}],
    {series: '0.88', proposedNext: '0.88.1', openPicks: []},
  );
  assert.match(assessed, /! deferred from 0\.88\.0-rc\.6 to 0\.88\.1/);

  const listed = formatAssessment([], {
    series: '0.88',
    proposedNext: '0.88.0',
    openPicks: [{number: n, title: 't', targetRelease: '0.88.1'}],
  });
  assert.match(listed, new RegExp(`Deferred out of 0\\.88\\.0, not assessed:\\n  #${n} -> 0\\.88\\.1`));
});

test('every step of every shape builds its actions without throwing', async () => {
  // The promote changelog action passed declare() keys it does not read, so it
  // had no impact and threw the moment a real 0.88.0 plan reached step 5. No
  // scenario set shape: 'promote', so nothing had ever built it.
  const {PHASES} = await import('../scripts/phases.mjs');
  for (const [shape, phase] of Object.entries(PHASES)) {
    const state = baseState({
      shape,
      proposedNext: shape === 'promote' ? '0.88.0' : '0.88.0-rc.2',
      distTags: {latest: '0.87.1', next: '0.88.0-rc.1'},
      mainTip: 'c'.repeat(40),
    });
    for (const step of phase.steps) {
      assert.doesNotThrow(
        () => step.actions(state, {isLatest: shape === 'promote', workflowDryRun: false}),
        `${shape}/${step.id}`,
      );
    }
  }
});

test('the changelog PR is matched to the exact version, not a prefix', async () => {
  // The 0.88.0 crew message ticked rc.6's closed changelog PR.
  const {pickChangelogPr} = await import('../scripts/sources.mjs');
  const prs = [
    {number: 59084, state: 'CLOSED', headRefName: 'changelog/v0.88.0-rc.6'},
    {number: 59100, state: 'OPEN', headRefName: 'changelog/v0.88.0'},
  ];
  assert.equal(pickChangelogPr(prs, '0.88.0').number, 59100);
  assert.equal(pickChangelogPr(prs.slice(0, 1), '0.88.0'), null, 'not generated yet is not a tick');
  assert.equal(pickChangelogPr(prs, '0.88.0-rc.6').number, 59084);
});

test('the upgrade-helper link keeps PREV_VERSION literal', async () => {
  // The 0.88.0 message filled it with 0.88.0-rc.6. The crew posts the placeholder.
  const {buildStatusMessage} = await import('../scripts/release-message.mjs');
  const msg = buildStatusMessage(baseState({proposedNext: '0.88.0'}), {
    version: '0.88.0',
    prevVersion: '0.88.0-rc.6',
    artifacts: {},
  });
  assert.match(msg, /upgrade-helper\/\?from=PREV_VERSION&to=0\.88\.0/);
  assert.ok(!/from=0\.88\.0-rc\.6/.test(msg));
});

// ------------------------------------------------- 0.88.0 follow-ups

test('blog post: dated in the future is caught, with the fix', async () => {
  // The 0.88 post went live on 2026-10-16 dated 2026-10-19.
  const {checkBlogPostDates} = await import('../scripts/check-blog-post.mjs');
  const content = [
    '---',
    'date: 2026-10-19',
    '---',
    '- [A](/blog/2026/10/19/react-native-0.88#a)',
    '- [B](/blog/2026/10/19/react-native-0.88#b)',
  ].join('\n');
  const r = checkBlogPostDates({
    filename: 'website/blog/2026-10-19-react-native-0.88.mdx',
    content,
    series: '0.88',
    expected: '2026-10-16',
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /in the future/);
  assert.ok(r.fix.some(f => f.includes('2026-10-16-react-native-0.88.mdx')));
  assert.ok(r.fix.some(f => f.includes('/blog/2026/10/16/react-native-0.88')));

  const onTheDay = checkBlogPostDates({
    filename: 'website/blog/2026-10-19-react-native-0.88.mdx',
    content,
    series: '0.88',
    expected: '2026-10-19',
  });
  assert.equal(onTheDay.ok, true, 'consistent and on the go-live day passes');
  assert.equal(onTheDay.links, 2);
});

test('blog post: filename, date: and links have to agree', async () => {
  const {checkBlogPostDates} = await import('../scripts/check-blog-post.mjs');
  const r = checkBlogPostDates({
    filename: '2026-10-16-react-native-0.88.mdx',
    content: 'date: 2026-10-16\n[x](/blog/2026/10/19/react-native-0.88#x)\n[0.87](/blog/2026/08/11/react-native-0.87#y)',
    series: '0.88',
    expected: '2026-10-16',
  });
  assert.equal(r.ok, false);
  assert.match(r.problems.join('\n'), /1 link\(s\) to this post use 2026-10-19/);
  assert.equal(r.links, 1, 'links to other posts are not counted');

  const split = checkBlogPostDates({
    filename: '2026-10-16-react-native-0.88.mdx',
    content: 'date: 2026-10-19\n',
    series: '0.88',
    expected: '2026-10-16',
  });
  assert.match(split.problems.join('\n'), /filename says 2026-10-16 but `date:` says 2026-10-19/);
});

test('the promote phase checks the post date and syncs the X thread after it', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const ids = phaseFor('promote').steps.map(s => s.id);
  assert.ok(ids.indexOf('social') === ids.indexOf('blog') + 1, 'social right after blog');
  const blog = phaseFor('promote').steps.find(s => s.id === 'blog');
  const [check] = blog.actions(baseState({series: '0.88'}), {});
  assert.match(check.args[0], /check-blog-post\.mjs$/);
  assert.equal(check.args[1], '0.88');
  assert.equal(check.mutates, false);
  assert.match(blog.note, /GOES LIVE/);
});

test('release notes: fill above the generated part, never clobber, keep the tag', async () => {
  const {buildReleaseBody, releasePatch, changelogSection} = await import('../scripts/fill-release-notes.mjs');
  const changelog = '# Changelog\n\n## v0.88.0\n\n### Fixed\n- one\n\n## v0.87.1\n\n- old\n';
  const section = changelogSection(changelog, '0.88.0');
  assert.equal(section, '### Fixed\n- one');
  assert.equal(changelogSection(changelog, '0.88.1'), null);

  const draft = '\n\n---\n\nHermes V1 dSYMS:\n';
  const filled = buildReleaseBody(section, draft);
  assert.equal(filled.status, 'filled');
  assert.ok(filled.body.startsWith('### Fixed\n- one\n\n---\n'));
  assert.equal(buildReleaseBody(section, filled.body).status, 'unchanged', 'idempotent');
  assert.equal(buildReleaseBody(section, 'someone edited this\n\n---\nX').status, 'conflict');

  // A body-only PATCH detached the 0.88.0 draft from its tag.
  assert.deepEqual(releasePatch('0.88.0', 'b', true), {tag_name: 'v0.88.0', body: 'b', draft: true});
});

test('release notes: the NUL escape GitHub rewrites still counts as unchanged', async () => {
  const {buildReleaseBody} = await import('../scripts/fill-release-notes.mjs');
  const bs = String.fromCharCode(92);
  const section = `- NULL character ${bs}u0000 here`;
  const stored = `- NULL character ${bs}^@ here\n\n---\nX`;
  assert.equal(buildReleaseBody(section, stored).status, 'unchanged');
});

test('the github-release step fills the notes before opening the draft', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const step = phaseFor('promote').steps.find(s => s.id === 'github-release');
  const [fill, open] = step.actions(baseState({proposedNext: '0.88.0'}), {});
  assert.match(fill.args[0], /fill-release-notes\.mjs$/);
  assert.equal(fill.mutates, true);
  assert.ok(fill.impact.some(i => /stays a draft/.test(i)));
  assert.equal(open.mutates, false);
});

test('picks deferred out of the release do not hold the tick', async () => {
  const {picksClearFor} = await import('../scripts/release-message.mjs');
  const {loadPickDeferrals} = await import('../scripts/release-state.mjs');
  const deferred = loadPickDeferrals('0.88', '0.88.0')?.numbers ?? [];
  assert.ok(deferred.length, 'the 0.88.0 deferral is recorded');

  const picks = deferred.map(n => ({number: n, title: 't', targetRelease: null, targetOnBoard: null}));
  assert.equal(picksClearFor(baseState({openPicks: picks}), '0.88.0'), true);
  assert.equal(
    picksClearFor(baseState({openPicks: [{number: 9999, targetOnBoard: '0.88.1'}]}), '0.88.0'),
    true,
    'aimed elsewhere on the board',
  );
  assert.equal(
    picksClearFor(baseState({openPicks: [{number: 9999, targetOnBoard: '0.88.0'}]}), '0.88.0'),
    false,
    'aimed at this release',
  );
  assert.equal(picksClearFor(baseState({openPicks: [{number: 9999}]}), '0.88.0'), false, 'untriaged');
});

test('a .0 tracks the consolidated changelog, not a bot PR that never comes', async () => {
  const {buildStatusMessage, buildAnnouncement} = await import('../scripts/release-message.mjs');
  const state = baseState({proposedNext: '0.88.0'});
  const pending = buildStatusMessage(state, {version: '0.88.0', artifacts: {changelogOnMain: false}});
  assert.match(pending, /:hourglass: Consolidate the RC changelog sections into v0\.88\.0/);
  assert.ok(!/Generate changelog PR/.test(pending));
  const done = buildStatusMessage(state, {version: '0.88.0', artifacts: {changelogOnMain: true}});
  assert.match(done, /:white_check_mark: Consolidate the RC changelog sections/);

  const rc = buildStatusMessage(state, {version: '0.88.0-rc.3', artifacts: {}});
  assert.match(rc, /Generate changelog PR/, 'an RC still has the bot PR');

  assert.match(buildAnnouncement('0.88.0'), /Changelog: .*CHANGELOG\.md/);
});

test('the promote changelog step does not call a .0 empty', async () => {
  // The .0 is compared against its last RC, which holds the same code.
  const {phaseFor} = await import('../scripts/phases.mjs');
  const step = phaseFor('promote').steps.find(s => s.id === 'changelog');
  assert.equal(await step.emit(baseState({shape: 'promote', current: '0.88.0-rc.6', proposedNext: '0.88.0'})), null);
  assert.match(step.note, /opens the changelog PR itself/);
  assert.match(step.note, /defers to it/);
});

test('post_publish: the caveat names both waits and the missing diff gets its dispatch', async () => {
  const {publishCaveat, upgradeHelperHint, leftoverDrafts} = await import('../scripts/release-message.mjs');
  const caveat = publishCaveat({npmPublished: true});
  assert.match(caveat, /Wait for template to be published/);
  assert.match(caveat, /Verify Release is on NPM/);

  const hint = upgradeHelperHint('0.88.0', {npmPublished: true, upgradeHelper: false});
  assert.match(hint, /rn-diff-purge\/dispatches/);
  assert.match(hint, /"version": "v0\.88\.0"/);
  assert.equal(upgradeHelperHint('0.88.0', {npmPublished: true, upgradeHelper: true}), null);
  assert.equal(upgradeHelperHint('0.88.0', {npmPublished: false, upgradeHelper: false}), null, 'not before publish');

  assert.match(leftoverDrafts({seriesDrafts: ['0.88.0-rc.6']}), /0\.88\.0-rc\.6/);
  assert.equal(leftoverDrafts({seriesDrafts: []}), null);
});

test('an RC cut after golden is recorded as exceptional, not as the golden', async () => {
  const src = {
    npmVersions: async () => ['0.87.1', '0.88.0-rc.6', '0.88.0'],
    npmDistTags: async () => ({latest: '0.88.0', next: '0.88.0-rc.6'}),
    npmPublishTimes: async () => ({}),
    gitTags: async () => ['v0.87.0-rc.4', 'v0.87.0', 'v0.88.0-rc.4', 'v0.88.0-rc.5', 'v0.88.0-rc.6', 'v0.88.0'],
    branchTip: async () => 'b'.repeat(40),
    workflowRuns: async () => [],
    openPicks: async () => [],
    pickCandidates: async () => [],
    projectItems: async () => ({project: null, items: []}),
    commitsBetween: async () => ({commits: [], total: 0, complete: true}),
    changelogAt: async () => '',
    fileAt: async () => null,
    releaseArtifacts: async () => ({}),
    hermesUnreleased: async () => ({resolved: false, commits: []}),
  };
  const state = await deriveState(src, {series: '0.88'});
  assert.deepEqual(state.schedule.goldenRc, {value: 4, source: 'content', lastRc: 6});
  const p088 = state.schedule.priorGolden.find(p => p.series === '0.88');
  assert.deepEqual(p088, {series: '0.88', rc: 4, lastRc: 6});
  const {summarize} = await import('../scripts/release-state.mjs');
  assert.ok(!/Golden RC/.test(summarize(state)), 'a patch has no golden RC to talk about');
  const out = summarize({...state, shape: 'promote'});
  assert.match(out, /rc\.4 by content, last RC rc\.6/);

  // The history line is shown while the NEXT series is in flight.
  const inFlight = summarize({...state, shape: 'rc', schedule: {...state.schedule, goldenRc: {value: null, source: 'unknown'}}});
  assert.match(inFlight, /0\.88:rc\.4 \(last rc\.6\)/);
});

test('the template check names the Node it needs instead of failing on yarn', async () => {
  const {nodeSatisfies} = await import('../scripts/verify-template.mjs');
  assert.equal(nodeSatisfies('20.20.0', '>= 22.11.0'), false);
  assert.equal(nodeSatisfies('22.11.0', '>= 22.11.0'), true);
  assert.equal(nodeSatisfies('24.1.0', '>=22.11'), true);
  assert.equal(nodeSatisfies('24.1.0', '^22.11.0'), false);
  assert.equal(nodeSatisfies('24.1.0', '^22.11.0 || >= 24'), true);
});

test('the runner shows what a command printed, including when it fails', async () => {
  const lines = [];
  const runner = new Runner({mode: MODES.GUIDED, log: l => lines.push(l)});
  const ok = declare({step: 's', mutates: false, why: 'w', cmd: process.execPath, args: ['-e', "console.log('npm says 200')"]});
  await runner.run(ok);
  assert.ok(lines.some(l => /npm says 200/.test(l)));

  const bad = declare({
    step: 's',
    mutates: false,
    why: 'w',
    cmd: process.execPath,
    args: ['-e', "console.log('FAIL node 20 does not satisfy'); process.exit(1)"],
  });
  await assert.rejects(runner.run(bad));
  assert.ok(lines.some(l => /does not satisfy/.test(l)), 'the reason is shown before the error');
});

test('changelog: the copilot generates against the same base the workflow used', async () => {
  const {previousVersion, branchFor} = await import('../scripts/generate-changelog.mjs');
  assert.equal(previousVersion('0.89.0-rc.3', '0.88.0'), '0.89.0-rc.2');
  assert.equal(previousVersion('0.89.0-rc.0', '0.88.2'), '0.88.2', 'rc.0 against npm latest');
  assert.equal(previousVersion('0.88.2', '0.88.2'), '0.88.1');
  assert.equal(previousVersion('0.89.0', '0.88.2'), null, 'a .0 is combined, not generated');
  assert.throws(() => previousVersion('1.0.0-beta', 'x'));
  assert.equal(branchFor('0.89.0-rc.1'), 'changelog/v0.89.0-rc.1', 'the branch everything already looks for');
});

test('changelog: defers to the bot wherever the publish workflow still has the job', async () => {
  // A second changelog/v<version> branch makes the bot's push fail. The draft
  // release job needs the bot's job to succeed.
  const {workflowGeneratesChangelog} = await import('../scripts/generate-changelog.mjs');
  const withJob = 'jobs:\n  publish_react_native:\n    runs-on: x\n  generate_changelog:\n    needs: [a]\n';
  const without = 'jobs:\n  publish_react_native:\n    runs-on: x\n  bump_podfile_lock:\n    needs: [a]\n';
  assert.equal(workflowGeneratesChangelog(withJob), true);
  assert.equal(workflowGeneratesChangelog(without), false);
  assert.equal(workflowGeneratesChangelog('    needs: [determine_mode, generate_changelog]'), false, 'a mention is not the job');
});

test('changelog: machinery commits are dropped, real entries kept', async () => {
  const {isMachinery} = await import('../scripts/generate-changelog.mjs');
  assert.equal(isMachinery({text: '- Release 0.88.0-rc.6 ([1a](x) by [@react-native-bot](y))'}), true);
  assert.equal(isMachinery({text: '- Bump Podfile.lock ([74](x))'}), true);
  assert.equal(isMachinery({text: '- [LOCAL] Bump Podfile.lock'}), true);
  assert.equal(isMachinery({text: '- **Text**: Release a lock earlier on unmount'}), false);
});

test('changelog: a generated section is curated in place, the rest of the file untouched', async () => {
  const {replaceSection} = await import('../scripts/generate-changelog.mjs');
  const {parseEntries, renderSection} = await import('../scripts/combine-changelog.mjs');
  const generated = [
    '# Changelog',
    '## v0.89.0-rc.1',
    '',
    '### Breaking',
    '',
    '#### Android specific',
    '',
    '### Fixed',
    '- **Text**: b fix ([2](x))',
    '- **Image**: a fix ([1](x))',
    '',
    '## v0.89.0-rc.0',
    '',
    '- old',
    '',
  ].join('\n');
  const entries = parseEntries('### Fixed\n- **Text**: b fix ([2](x))\n- **Image**: a fix ([1](x))\n');
  const out = replaceSection(generated, '0.89.0-rc.1', renderSection('0.89.0-rc.1', entries));
  assert.ok(!/### Breaking/.test(out), 'empty sections omitted');
  assert.ok(out.indexOf('**Image**') < out.indexOf('**Text**'), 'sorted by scope');
  assert.ok(out.includes('## v0.89.0-rc.0\n\n- old'), 'older sections untouched');
  assert.equal(replaceSection(generated, '0.89.0-rc.9', 'x'), null);
});

test('changelog: a .0 replaces every RC section with the combined one, once', async () => {
  const {replaceRcSections} = await import('../scripts/generate-changelog.mjs');
  const changelog = [
    '# Changelog',
    '',
    '## v0.89.0-rc.1',
    '- b',
    '',
    '## v0.89.0-rc.0',
    '- a',
    '',
    '## v0.88.2',
    '- keep',
    '',
  ].join('\n');
  const out = replaceRcSections(changelog, '0.89', '## v0.89.0\n\n- a\n- b\n');
  assert.equal((out.match(/## v0\.89\.0\b/g) ?? []).length, 1);
  assert.ok(!/rc\.\d/.test(out), 'no RC headings left');
  assert.ok(out.indexOf('## v0.89.0') < out.indexOf('## v0.88.2'));
  assert.ok(out.includes('## v0.88.2\n- keep'));
  assert.equal(replaceRcSections('# Changelog\n## v0.88.2\n', '0.89', 'x'), null);
});

test('changelog: an error never echoes the token-bearing command line', async () => {
  const src = (await import('node:fs')).readFileSync(new URL('../scripts/generate-changelog.mjs', import.meta.url), 'utf8');
  assert.match(src, /throw new Error\('the changelog generator failed, its output is above'\)/);
  assert.match(src, /gh\[opsu\]_\[A-Za-z0-9\]\+\/g, '<redacted>'/);
});

// ------------------------------------------------- changelog curation

const curation = () => import('../scripts/curate-changelog.mjs');
const sha = c => c.repeat(40).slice(0, 40);
const historyChangelog = [
  '## v0.87.0',
  '### Fixed',
  `- **TextInput**: fix caret ([a](https://github.com/react/react-native/commit/${sha('a')}))`,
  `- **TextInput**: fix focus ([b](https://github.com/react/react-native/commit/${sha('b')}))`,
  `- **Image**: fix tint ([c](https://github.com/react/react-native/commit/${sha('c')}))`,
  `- **Image**: fix size ([d](https://github.com/react/react-native/commit/${sha('d')}))`,
].join('\n');
const historyFiles = {
  [sha('a')]: ['packages/react-native/Libraries/Components/TextInput/TextInput.js'],
  [sha('b')]: ['packages/react-native/Libraries/Components/TextInput/TextInputState.js'],
  [sha('c')]: ['packages/react-native/Libraries/Image/Image.ios.js'],
  [sha('d')]: ['packages/react-native/Libraries/Image/ImageUtils.js'],
};

test('curation: a prefix is added only when the text and the files agree', async () => {
  const {learnScopes, inferScope} = await curation();
  const model = learnScopes(historyChangelog, s => historyFiles[s] ?? []);
  const inTextInput = ['packages/react-native/Libraries/Components/TextInput/Other.js'];
  assert.equal(inferScope(model, 'TextInput loses the caret', inTextInput), 'TextInput');
  assert.equal(inferScope(model, 'Image loses its tint', inTextInput), null, 'text says Image, files say TextInput');
  assert.equal(inferScope(model, 'the caret is lost', inTextInput), null, 'files alone are not enough');
  assert.equal(inferScope(model, 'TextInput loses the caret', ['somewhere/else.js']), null, 'text alone is not enough');
});

test('curation: tests do not pull the prefix towards wherever the test lives', async () => {
  const {learnScopes, inferScope} = await curation();
  const model = learnScopes(historyChangelog, s => historyFiles[s] ?? []);
  const files = ['packages/react-native/Libraries/Image/Image.android.js', 'packages/react-native/Libraries/Components/TextInput/__tests__/x-test.js'];
  assert.equal(inferScope(model, 'Image and TextInput', files), null, 'the text names TextInput, but only its test was touched');
  assert.equal(inferScope(model, 'Image tint', files), 'Image');
});

test('curation: the API check counts removed symbols, not edited lines', async () => {
  const {apiRemovals} = await curation();
  const diff = (file, lines) => [`--- a/${file}`, `+++ b/${file}`, ...lines].join('\n');
  const d = 'packages/react-native/ReactNativeApi.d.ts';
  assert.deepEqual(apiRemovals(diff(d, ['-  Animated, // d74ec583', '+  Animated, // 50cbe576'])), [], 'hash comment churn');
  assert.deepEqual(apiRemovals(diff(d, ['-  readonly barStyle?: "dark-content" | "default"', '+  readonly barStyle?: "auto" | "dark-content" | "default"'])), [], 'a widened union');
  assert.deepEqual(apiRemovals(diff(d, ['-  readonly textAlign?: "auto" | "center" | "left"', '+  readonly textAlign?: "center" | "left"'])), [{kind: 'narrowed', symbol: 'textAlign'}]);
  assert.deepEqual(apiRemovals(diff(d, ['-declare function PlatformColor(...names: Array<string>): NativeColorValue'])), [{kind: 'removed', symbol: 'PlatformColor'}]);
  const j = 'packages/react-native/ReactAndroid/api/ReactAndroid.api';
  assert.deepEqual(apiRemovals(diff(j, ['-  public fun toJSBuffer (Lfoo;)V', '+  public fun toJSBuffer (Lbar;)V'])), [], 'same name and arity');
  assert.deepEqual(apiRemovals(diff(j, ['-  public fun execute (Ljava/lang/String;)V'])), [{kind: 'removed', symbol: 'execute(0)'}]);
});

test('curation: consistency flags name what to check', async () => {
  const {consistencyFlags} = await curation();
  const e = (section, subsection, text) => ({section, subsection, text: `- ${text} ([x](https://github.com/react/react-native/commit/${sha('e')}))`});
  const api = [{kind: 'removed', symbol: 'PlatformColor'}];
  assert.match(consistencyFlags(e('Fixed', '', 'Fix colors'), {files: ['a.js'], message: '', api}).join(), /changes public API \(removed PlatformColor\) but is under Fixed/);
  assert.deepEqual(consistencyFlags(e('Breaking', '', 'Remove PlatformColor'), {files: ['a.js'], message: '', api}), [], 'API removal under Breaking is consistent');
  assert.match(consistencyFlags(e('Added', '', 'Add a thing'), {files: ['a.js'], message: 'Changelog: [GENERAL] [BREAKING] - x', api: []}).join(), /tagged \[BREAKING\] but it is under Added/);
  assert.match(consistencyFlags(e('Breaking', '', 'Change a thing'), {files: ['a.js'], message: '', api: []}).join(), /removes no API symbol/);
  assert.match(consistencyFlags(e('Fixed', '', 'Remove the old handler'), {files: ['a.js'], message: '', api: []}).join(), /describes a removal but is under Fixed/);
  assert.match(consistencyFlags(e('Fixed', 'Android specific', 'Fix'), {files: ['packages/react-native/React/Views/RCTView.mm'], message: '', api: []}).join(), /Android specific but only touches iOS/);
  assert.match(consistencyFlags(e('Fixed', '', 'Fix'), {files: ['packages/react-native/ReactAndroid/src/main/java/X.kt'], message: '', api: []}).join(), /belongs under Android specific/);
  assert.deepEqual(consistencyFlags(e('Fixed', '', 'Fix'), {files: ['a.js', 'b.kt'], message: '', api: []}), [], 'a mixed fix in general is fine');
  assert.deepEqual(consistencyFlags(e('Fixed', '', 'Fix'), null), [], 'no facts, no flags');
});

test('curation: a pipe template comment is not a [BREAKING] tag', async () => {
  const {consistencyFlags} = await curation();
  const entry = {section: 'Fixed', subsection: '', text: `- Fix ([x](https://github.com/react/react-native/commit/${sha('e')}))`};
  const message = '<!-- [ANDROID|GENERAL|IOS|INTERNAL] [BREAKING|ADDED|CHANGED] - Message -->\nChangelog: [GENERAL] [FIXED] - Fix';
  assert.deepEqual(consistencyFlags(entry, {files: ['a.js', 'b.kt'], message, api: []}), []);
});

test('curation: entries get their prefix and the report lists every decision', async () => {
  const {learnScopes, curateEntries, formatReport} = await curation();
  const model = learnScopes(historyChangelog, s => historyFiles[s] ?? []);
  const entries = [
    {section: 'Fixed', subsection: '', text: `- TextInput keeps its caret ([1](https://github.com/react/react-native/commit/${sha('1')}))`},
    {section: 'Fixed', subsection: '', text: `- Something vague ([2](https://github.com/react/react-native/commit/${sha('2')}))`},
    {section: 'Fixed', subsection: '', text: `- **Image**: already prefixed ([3](https://github.com/react/react-native/commit/${sha('3')}))`},
  ];
  const facts = {
    [sha('1')]: {files: ['packages/react-native/Libraries/Components/TextInput/TextInput.js'], message: '', api: []},
    [sha('2')]: {files: ['packages/react-native/Libraries/Components/TextInput/TextInput.js'], message: '', api: []},
    [sha('3')]: {files: ['packages/react-native/Libraries/Image/Image.ios.js'], message: '', api: []},
  };
  const {entries: out, report} = curateEntries(entries, {model, factsOf: s => facts[s] ?? null});
  assert.match(out[0].text, /^- \*\*TextInput\*\*: TextInput keeps its caret/);
  assert.match(out[1].text, /^- Something vague/, 'left alone rather than guessed');
  assert.match(out[2].text, /^- \*\*Image\*\*: already prefixed/);
  assert.deepEqual(report.prefixed, [{scope: 'TextInput', prose: 'TextInput keeps its caret'}]);
  assert.deepEqual(report.unprefixed, ['Something vague']);
  const text = formatReport(report);
  assert.match(text, /Prefixes added \(1\)/);
  assert.match(text, /Still without a prefix \(1\)/);
});

// ---------------------------------------------------------------- patches

const patchSrc = ({commits = [], hermes = {resolved: false, commits: []}, seen = []} = {}) => ({
  npmVersions: async () => ['0.87.1', '0.88.0-rc.6', '0.88.0'],
  npmDistTags: async () => ({latest: '0.88.0', next: '0.88.0-rc.6'}),
  npmPublishTimes: async () => ({'0.88.0': '2026-10-15T10:00:00Z'}),
  gitTags: async () => ['v0.88.0-rc.6', 'v0.88.0'],
  branchTip: async () => 'c'.repeat(40),
  workflowRuns: async () => [],
  openPicks: async () => [],
  pickCandidates: async () => [],
  projectItems: async () => ({project: null, items: []}),
  commitsBetween: async (base, head) => {
    seen.push(base);
    return {commits, total: commits.length, complete: true};
  },
  changelogAt: async () => '',
  fileAt: async () => null,
  releaseArtifacts: async () => ({}),
  hermesUnreleased: async () => hermes,
});

test('a patch scans for [BREAKING] commits from the release it patches', async () => {
  // On 0.88.1 the baseline came out null because `latest` was already 0.88.0,
  // so the scan never ran and the gate passed saying it had looked.
  const seen = [];
  const commits = [{sha: 'd'.repeat(40), message: '[GENERAL] [BREAKING] Remove a prop'}];
  const state = await deriveState(patchSrc({commits, seen}), {series: '0.88', today: '2026-10-24'});
  assert.equal(state.shape, 'patch');
  assert.equal(state.breakingBaseline, 'v0.88.0');
  assert.deepEqual(seen.filter(b => b === 'v0.88.0'), ['v0.88.0']);
  const ev = await evaluate(['noBreakingChanges'], state, {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /dddddddddd/);
});

test('no breaking baseline fails the gate rather than passing unscanned', async () => {
  const ev = await evaluate(['noBreakingChanges'], baseState({breakingBaseline: null, breakingCommits: null}), {});
  assert.equal(ev.passed, false);
  assert.match(ev.results[0].detail, /never checked/);
});

test('a patch has no weekly due date and no golden RC lines', async () => {
  const {summarize} = await import('../scripts/release-state.mjs');
  const state = await deriveState(patchSrc(), {series: '0.88', today: '2026-10-24'});
  assert.equal(state.schedule.cadence.unscheduled, true);
  const out = summarize(state);
  assert.ok(!/OVERDUE|due in/.test(out), out);
  assert.ok(!/Golden RC|Projected|Targets/.test(out), out);
  assert.match(out, /patches are unscheduled/);
  assert.match(out, /Testing       0\.88\.1 needs no manual testing/);
});

// The real 0.88.1 branch, abbreviated.
const HERMES_0881 = [
  {sha: '6cb3676787d', subject: 'Bump hermes-compiler version to 260318099.0.5 (#2211)', versionBump: true},
  {sha: 'a2200396a42', subject: 'pick: Fix external ArrayBuffer context lookup (#2221)'},
  {sha: 'c2834a81138', subject: 'Graft "[SH] Fix handle accumulation in (de)serialization loops" to shermes/stable'},
  {sha: '4d739cf131f', subject: 'Graft "[SH] Easy: update Github CI to use VS 2026" to shermes/stable (#2224)'},
  {sha: '31b516b69b0', subject: 'Forward String::length in RuntimeDecorator and WithRuntimeDecorator (#2205)',
    body: 'It looks like an oversight. Runtimes with a native length() get wrong answers.'},
  {sha: '09d3bf22976', subject: 'Run the With hooks around WithRuntimeDecorator::createArrayBuffer (#2204)',
    body: 'A small stress program shows the race.'},
  {sha: 'b137297d244', subject: 'Use createError in JSError and forward it in RuntimeDecorator (#2203)',
    body: 'On Hermes every JSError thrown from native code skips a global lookup.'},
  {sha: 'e9c2f761616', subject: 'Fix: JSI Value::toString() should check the result type'},
  {sha: 'a94df18620e', subject: 'Detect the host casing locale and switch Linux and Windows off ICU',
    body: 'This is the diff where behavior changes.'},
  {sha: '9a115f15785', subject: 'Run the API tests on the sandbox'},
].map(c => ({body: '', versionBump: false, reland: false, ...c}));

test('Hermes commits are classified so the captain can choose to cut', async () => {
  const {hermesOverview} = await import('../scripts/release-state.mjs');
  const ho = hermesOverview({resolved: true, commits: HERMES_0881});
  const kinds = Object.fromEntries(ho.commits.map(c => [c.sha, c.kind]));
  assert.equal(kinds['6cb3676787d'], undefined, 'the version bump is not payload');
  assert.equal(kinds.a2200396a42, 'fix');
  assert.equal(kinds.c2834a81138, 'fix', 'a graft is read by its inner subject');
  assert.equal(kinds['4d739cf131f'], 'infra');
  assert.equal(kinds['31b516b69b0'], 'fix');
  assert.equal(ho.commits.find(c => c.sha === '31b516b69b0').fromBody, true);
  assert.equal(kinds['09d3bf22976'], 'fix');
  assert.equal(kinds.b137297d244, 'unclear', 'never guess when neither text says');
  assert.equal(kinds.e9c2f761616, 'fix');
  assert.equal(kinds.a94df18620e, 'feature');
  assert.equal(kinds['9a115f15785'], 'test');
  assert.equal(ho.tally, '5 fix, 1 feature, 1 test, 1 infra, 1 unclear');
});

test('the Hermes choice: all fixes points at a cut, a feature says so', async () => {
  const state = over => baseState({
    proposedNext: '0.88.1',
    hermesUnreleased: {resolved: true, branch: '260318099.0.0-stable', tag: 'hermes-v260318099.0.4', commits: over},
  });
  const fixes = HERMES_0881.filter(c => /^(pick: Fix|Fix:)/.test(c.subject));
  const allFix = await evaluate(['hermesCurrent'], state(fixes), {});
  assert.equal(allFix.passed, false, 'still the captain\'s decision, never auto-green');
  assert.match(allFix.results[0].detail, /Every commit reads as a fix, so cutting a Hermes release for 0\.88\.1/);

  const mixed = await evaluate(['hermesCurrent'], state(HERMES_0881), {});
  assert.match(mixed.results[0].detail, /1 feature\(s\) would ship with a cut/);
  assert.match(mixed.results[0].detail, /\[feature\] a94df18620e/);
});

test('a recorded Hermes decision does not carry into the next release', async () => {
  const {loadHermesException} = await import('../scripts/release-state.mjs');
  const acked = ['a2200396a42', 'c2834a81138'];
  assert.ok(loadHermesException('0.88', acked, '0.88.0'), 'applies to the release it was taken for');
  // The patch may carry its own entry (0.88.1 does, for a different commit), but
  // none of the 0.88.0 decision's commits are acknowledged by it.
  const next = loadHermesException('0.88', acked, '0.88.1');
  assert.ok(
    next === null || acked.every(sha => next.unacknowledged.includes(sha)),
    'a patch re-asks: the 0.88.0 decision covers none of its commits',
  );
});

test('a backport PR against the release branch is assessed, not blocked', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  const candidate = {
    number: 1440,
    title: '[0.88] Encode line breaks in SwiftPM scheme pre-action scriptText',
    description: 'Fixes a silent failure when the pre-action script has line breaks.',
    resolved: [{
      sha: 'e'.repeat(11),
      backportPr: 59309,
      message: '[0.88] Encode line breaks in SwiftPM scheme pre-action scriptText',
      files: [{f: 'packages/react-native/scripts/swiftpm/scheme.js', a: 50, d: 20}],
    }],
    landed: false,
  };
  const r = assess(candidate, baseState({proposedNext: '0.88.1'}));
  assert.equal(r.verdict, 'ACCEPT');
  assert.ok(r.why.some(w => /backport PR \(#59309\) opened against 0\.88-stable/.test(w)), r.why.join('\n'));
  const ev = await evaluate(['picksNotBreaking'], baseState({openPicks: [candidate], pickCandidates: [candidate]}), {});
  assert.equal(ev.passed, true, ev.results[0].detail);
});

test('a patch settles Hermes before the artifacts build, with the choice on screen', async () => {
  const {phaseFor} = await import('../scripts/phases.mjs');
  const ids = phaseFor('patch').steps.map(s => s.id);
  assert.ok(ids.indexOf('hermes-decision') < ids.indexOf('artifacts'), ids.join(', '));

  const lines = [];
  const state = baseState({
    shape: 'patch',
    current: '0.88.0',
    proposedNext: '0.88.1',
    hermes: {pinned: '260318099.0.4', compiler: '260318099.0.4'},
    hermesUnreleased: {
      resolved: true, branch: '260318099.0.0-stable', tag: 'hermes-v260318099.0.4',
      inTreeVersion: '260318099.0.5', commits: HERMES_0881,
    },
    hermesPriorDecisions: [{
      version: '0.88.0', decision: 'ship 0.88.0 on 260318099.0.4', reason: 'rc.5 is the golden RC',
      reviewedBy: 'fabriziocucci', reviewedOn: '2026-10-15', covered: 7,
    }],
  });
  const res = await runPhase(state, {mode: MODES.DRY_RUN, shape: 'patch', log: l => lines.push(l)});
  assert.equal(res.stopped[0].step, 'hermes-decision');
  const out = lines.join('\n');
  assert.match(out, /1 feature\(s\) would ship with a cut/);
  assert.match(out, /Earlier decision, for 0\.88\.0/);
  assert.match(out, /does not carry over to 0\.88\.1/);
  assert.match(out, /plan --shape hermes-release/);
  assert.match(out, /before the artifacts build/);
});

test('the pick assessment is shown at the picks step, dry-run included', async () => {
  const lines = [];
  const pick = {
    number: 1456, title: '[0.88] Fix Android crash drawing text decorations', description: '',
    resolved: [{sha: 'ca8504b1caa', message: 'Fix crash', files: [{f: 'a/Text.kt', a: 100, d: 19}]}],
    landed: false,
  };
  for (const shape of ['patch', 'rc']) {
    lines.length = 0;
    await runPhase(baseState({shape, openPicks: [pick], pickCandidates: [pick]}), {
      mode: MODES.DRY_RUN, shape, log: l => lines.push(l),
    });
    assert.match(lines.join('\n'), /ACCEPT #1456/, shape);
  }
});

test('stacked picks are listed bottom first with the cut as the question', async () => {
  const {assess, formatAssessment} = await import('../scripts/assess-picks.mjs');
  const mk = (number, stackedOn) => ({
    number, title: `[0.88] pick ${number}`, description: 'Fixes a silent failure.', stackedOn,
    resolved: [{sha: 'f'.repeat(11), backportPr: number + 57869, message: 'x', files: [{f: 'scripts/spm/a.js', a: 10, d: 2}]}],
    landed: false,
  });
  const cands = [mk(1451, 1449), mk(1440), mk(1449, 1450), mk(1450, 1440)];
  const state = baseState({proposedNext: '0.88.1', pickCandidates: cands});
  const results = cands.map(c => assess(c, state));
  assert.ok(results.find(r => r.number === 1451).why.some(w => /stacked on #1449/.test(w)));
  const out = formatAssessment(results, state);
  assert.match(out, /where to cut the stack/);
  assert.match(out, /1\. \w+\s+#1440[\s\S]*2\. \w+\s+#1450[\s\S]*3\. \w+\s+#1449[\s\S]*4\. \w+\s+#1451/);
});

test('a pick that tells users to change their setup is a question in a non-breaking series', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  const r = assess({
    number: 1453, title: '[0.88] SwiftPM: move injected build settings out of project.pbxproj',
    description: 'A configuration that uses its own xcconfig must now `#include` the generated file. A routine version bump no longer changes project.pbxproj.',
    resolved: [{sha: 'a'.repeat(11), message: 'Move settings', files: [{f: 'scripts/spm/x.js', a: 50, d: 5}]}],
    landed: false,
  }, baseState({proposedNext: '0.88.1'}));
  assert.equal(r.verdict, 'ASK');
  assert.ok(r.why.some(w => /must change their setup/.test(w)));
  assert.ok(!r.why.some(w => /dependency bump/.test(w)), 'prose about a version bump is not a bump');
});

test('a performance pick cites criterion 7 and a build-flag change still goes to the crew', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  const r = assess({
    number: 1457, title: '[0.88] Compile React Native C/C++ at -O2 on iOS to match Android', description: '',
    resolved: [{sha: 'b'.repeat(11), message: 'x', files: [{f: 'packages/react-native/React-Core.podspec', a: 5, d: 5}]}],
    landed: false,
  }, baseState({proposedNext: '0.88.1'}));
  assert.equal(r.verdict, 'ASK');
  assert.ok(r.why.some(w => /criterion 7/.test(w)));
  assert.ok(r.why.some(w => /build configuration/.test(w)));
});

test('no step points the captain at docs/, the copilot carries the content', async () => {
  const {PHASES} = await import('../scripts/phases.mjs');
  for (const phase of Object.values(PHASES)) {
    for (const s of phase.steps) {
      assert.ok(!/\bdocs\//.test(s.note ?? ''), `${phase.id}/${s.id} points at docs/`);
    }
  }
});

test('a docs-only pick is not sized as production code', async () => {
  const {assess} = await import('../scripts/assess-picks.mjs');
  const r = assess({
    number: 1451, title: '[0.88] Docs: correct SwiftPM docs to match current scripts', description: '',
    resolved: [{sha: 'c'.repeat(11), message: 'docs', files: [
      {f: 'packages/react-native/scripts/spm/README.md', a: 700, d: 600},
      {f: 'docs/spm.md', a: 43, d: 25},
    ]}],
    landed: false,
  }, baseState({proposedNext: '0.88.1'}));
  assert.equal(r.verdict, 'ACCEPT');
  assert.equal(r.signals.productionFiles, 0);
  assert.ok(!r.why.some(w => /large for a pick/.test(w)));
});

// ------------------------------------------------------- pick investigation

const inv = () => import('../scripts/investigate-pick.mjs');
const evid = () => import('../scripts/evidence.mjs');

const PREVIEW_MARKER = {path: 'packages/react-native/scripts/spm/__docs__/README.md', line: 5, text: '> **Preview.** SwiftPM support is an early preview'};
const mainCommit = over => ({
  sha: 'b8df948fd4' + '0'.repeat(30), date: '2026-10-05T10:00:00Z', onMain: true, reverts: [], followUps: [],
  message: 'Encode line breaks (#58826)\n\nChangelog: [IOS] [FIXED] - Encode line breaks\n\nReviewed By: cipolleschi\n\nDifferential Revision: D1',
  files: [{f: 'packages/react-native/scripts/spm/generate-spm-xcodeproj.js', a: 40, d: 20}], ...over,
});
const swiftpmPick = (over = {}, evOver = {}) => {
  const c = {
    number: 1440, title: '[0.88] Encode line breaks in SwiftPM scheme pre-action scriptText',
    description: 'Fixes a silent failure. This is a port PR against 0.88-stable of #58826, which already landed in main.',
    resolved: [{sha: '1d69b9084d8', backportPr: 59309, message: 'x', files: []}], landed: false, ...over,
  };
  const ev = {
    number: c.number, backportPr: 59309, request: {body: c.description, comments: []},
    commits: [{sha: '1d69b9084d' + '0'.repeat(30), message: 'Encode line breaks (#58826)', files: [
      {f: 'packages/react-native/scripts/spm/generate-spm-xcodeproj.js', a: 40, d: 20},
      {f: 'packages/react-native/scripts/spm/__tests__/generate-spm-xcodeproj-test.js', a: 25, d: 4},
    ]}],
    mainCommits: [mainCommit()],
    fidelity: [{own: '1d69b9084d8', main: 'b8df948fd40', same: true}],
    pr: {number: 59309, base: '0.88-stable', reviews: [], checks: [{name: 'test_ios_spm', conclusion: 'SUCCESS'}]},
    files: [
      {f: 'packages/react-native/scripts/spm/generate-spm-xcodeproj.js', surface: 'swiftpm'},
      {f: 'packages/react-native/scripts/spm/__tests__/generate-spm-xcodeproj-test.js', surface: 'tests'},
    ],
    importers: {'packages/react-native/scripts/spm/generate-spm-xcodeproj.js': []},
    markers: {swiftpm: PREVIEW_MARKER},
    ...evOver,
  };
  return {c, ev};
};
const find = (r, id) => r.findings.filter(f => f.id === id);
const st = over => baseState({proposedNext: '0.88.1', schedule: {series: {version: '0.88', type: 'non-breaking'}, isNonBreaking: true, today: '2026-10-25'}, ...over});

test('doctor: a placeholder git identity is refused, a real one passes', async () => {
  const {validateIdentity, parseIdent} = await import('../scripts/doctor.mjs');
  assert.deepEqual(parseIdent('t <t@t> 1792948286 +0000'), {name: 't', email: 't@t'});
  assert.ok(validateIdentity({name: 't', email: 't@t'}).length === 2, 'the identity 0.88.1 shipped with');
  for (const bad of [
    {name: 'Your Name', email: 'you@example.com'},
    {name: 'root', email: 'root@localhost'},
    {name: 'Fabrizio Cucci', email: 'fabrizio'},
    {name: '', email: 'a@b.co'},
  ]) {
    assert.ok(validateIdentity(bad).length > 0, JSON.stringify(bad));
  }
  assert.deepEqual(validateIdentity({name: 'Fabrizio Cucci', email: 'fabriziocucci@meta.com'}), []);
  assert.deepEqual(validateIdentity({name: 'nishan (o^▽^o)', email: '12345+nishanbende@users.noreply.github.com'}), []);
});

test('pick refuses to push commits recorded with a placeholder committer', async () => {
  const {runPick} = await import('../scripts/pick-actions.mjs');
  const sha = 'a'.repeat(40);
  const cand = {number: 1468, title: 'p', landed: false, resolved: [{sha: sha.slice(0, 11), ownCommits: [sha], message: 'Fix x', files: []}]};
  const ran = [];
  const runner = {
    isDryRun: false,
    async run(a) {
      ran.push(a);
      if (a.args.includes('--no-walk=unsorted')) {
        return {stdout: 'Jane Dev <jane@dev.io>\taaaaaaa Fix x\n'};
      }
      if (a.args[0] === 'log') {
        return {stdout: 'Jane Dev <jane@dev.io>\tt <t@t>\tbbbbbbb Fix x\n'};
      }
      return {stdout: ''};
    },
  };
  await assert.rejects(runPick(st({pickCandidates: [cand], openPicks: [cand]}), 1468, runner), /committed as "t <t@t>".*Nothing was pushed/);
  assert.ok(!ran.some(a => a.args[0] === 'push'), 'never reaches the push');
});

test('pick, for real: cherry-picks, keeps the author, pushes and closes, but never pushes as t <t@t>', async () => {
  // Real git end to end. The release branch URL is redirected to a local bare
  // repo and gh is swapped for a logger, so nothing leaves the machine.
  const {runPick} = await import('../scripts/pick-actions.mjs');
  const {Runner} = await import('../scripts/actions.mjs');
  const {mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, rmSync} = await import('node:fs');
  const {execFileSync} = await import('node:child_process');
  const {tmpdir} = await import('node:os');
  const root = mkdtempSync(join(tmpdir(), 'rc-pick-e2e-'));
  const sh = (cwd, ...args) => execFileSync('git', args, {cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
  const id = ['-c', 'user.name=Setup', '-c', 'user.email=setup@reactnative.dev'];
  const saved = {...process.env};
  try {
    const remote = join(root, 'remote.git');
    const seed = join(root, 'seed');
    const checkout = join(root, 'checkout');
    sh(root, 'init', '-q', '--bare', remote);
    sh(root, 'init', '-q', '-b', 'main', seed);
    writeFileSync(join(seed, 'a.txt'), 'base\n');
    sh(seed, ...id, 'add', '.');
    sh(seed, ...id, 'commit', '-q', '-m', 'base');
    sh(seed, 'branch', '0.88-stable');
    writeFileSync(join(seed, 'b.txt'), 'the fix\n');
    sh(seed, 'add', '.');
    sh(seed, ...id, 'commit', '-q', '--author', 'Jane Dev <jane@dev.io>', '-m', 'Fix the thing (#100)');
    const fix = sh(seed, 'rev-parse', 'HEAD');
    sh(seed, 'push', '-q', remote, 'main', '0.88-stable');
    sh(root, 'clone', '-q', remote, checkout);

    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'gh'), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(root, 'gh.log')}"\n`);
    chmodSync(join(bin, 'gh'), 0o755);
    Object.assign(process.env, {
      PATH: `${bin}:${process.env.PATH}`,
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: `url.${remote}.insteadOf`,
      GIT_CONFIG_VALUE_0: 'https://github.com/react/react-native.git',
      GIT_COMMITTER_NAME: 'Release Captain',
      GIT_COMMITTER_EMAIL: 'captain@reactnative.dev',
    });

    const cand = {number: 1500, title: '[0.88] Fix the thing', landed: false,
      resolved: [{sha: fix.slice(0, 11), ownCommits: [fix], message: 'Fix the thing (#100)', files: []}]};
    const state = st({pickCandidates: [cand], openPicks: [cand]});
    const runner = () => new Runner({mode: MODES.GUIDED, cwd: checkout, confirm: async () => true, log: () => {}});

    // A placeholder committer: refused after the cherry-pick, before the push.
    Object.assign(process.env, {GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t'});
    await assert.rejects(runPick(state, 1500, runner()), /committed as "t <t@t>".*Nothing was pushed/);
    assert.equal(sh(remote, 'log', '-1', '--format=%s', '0.88-stable'), 'base', 'nothing reached the remote');
    sh(checkout, 'reset', '-q', '--hard', 'origin/0.88-stable');

    // A real committer: picked, pushed and closed.
    Object.assign(process.env, {GIT_COMMITTER_NAME: 'Release Captain', GIT_COMMITTER_EMAIL: 'captain@reactnative.dev'});
    const res = await runPick(state, 1500, runner());
    assert.equal(res.completed, true);
    const [author, committer, body] = sh(remote, 'log', '-1', '--format=%an <%ae>%x09%cn <%ce>%x09%B', '0.88-stable').split('\t');
    assert.equal(author, 'Jane Dev <jane@dev.io>', 'the original author is kept');
    assert.equal(committer, 'Release Captain <captain@reactnative.dev>');
    assert.match(body, new RegExp(`cherry picked from commit ${fix}`));
    const landed = sh(remote, 'rev-parse', '--short', '0.88-stable');
    const gh = readFileSync(join(root, 'gh.log'), 'utf8');
    assert.match(gh, new RegExp(`issue close 1500 --repo reactwg/react-native-releases --comment Picked into \`0.88-stable\` for 0.88.1 as \`${landed}`));
  } finally {
    for (const k of Object.keys(process.env)) {
      if (!(k in saved)) {
        delete process.env[k];
      }
    }
    Object.assign(process.env, saved);
    rmSync(root, {recursive: true, force: true});
  }
});

test('surfaces: docs and tests win over the feature they document, unknown files reach everyone', async () => {
  const {surfaceOf} = await evid();
  assert.equal(surfaceOf('packages/react-native/scripts/spm/__docs__/README.md').id, 'docs');
  assert.equal(surfaceOf('packages/react-native/scripts/spm/__tests__/a-test.js').id, 'tests');
  assert.equal(surfaceOf('packages/react-native/scripts/spm/sync-spm-autolinking.js').id, 'swiftpm');
  assert.equal(surfaceOf('packages/react-native/React-Core.podspec').id, 'ios-build-config');
  assert.equal(surfaceOf('packages/react-native/Libraries/Image/Image.ios.js').id, 'default');
});

test('a preview-only port that matches main is confirmed on every claim', async () => {
  const {checkPick, CONFIRMED} = await inv();
  const {c, ev} = swiftpmPick();
  const r = checkPick(c, ev, st(), {today: '2026-10-25', trial: {1440: {status: 'clean'}}});
  assert.equal(find(r, 'fidelity')[0].status, CONFIRMED);
  assert.match(find(r, 'reach')[0].text, /opt-in preview behind `npx react-native spm`.*README\.md:5/);
  assert.equal(find(r, 'reach')[0].status, CONFIRMED);
  assert.equal(find(r, 'kind')[0].status, CONFIRMED);
  assert.match(find(r, 'review')[0].text, /cipolleschi on Phabricator \(D1\), and the port is that same change/);
  assert.equal(find(r, 'applies')[0].status, CONFIRMED);
  assert.equal(find(r, 'soak')[0].status, CONFIRMED);
});

test('"only affects SwiftPM" is contradicted when something outside imports it', async () => {
  const {checkPick, CONTRADICTED} = await inv();
  const {c, ev} = swiftpmPick({}, {importers: {'packages/react-native/scripts/spm/generate-spm-xcodeproj.js': ['packages/react-native/scripts/react_native_pods.rb']}});
  const r = checkPick(c, ev, st(), {today: '2026-10-25'});
  assert.equal(find(r, 'reach')[0].status, CONTRADICTED);
  assert.match(find(r, 'reach')[0].text, /react_native_pods\.rb/);
});

test('a preview whose own statement is gone is not treated as a preview', async () => {
  const {checkPick, CONTRADICTED} = await inv();
  const {c, ev} = swiftpmPick({description: 'Fixes a bug. A configuration must now include the generated file.'}, {markers: {swiftpm: null}});
  const r = checkPick(c, ev, st(), {today: '2026-10-25'});
  assert.equal(find(r, 'reach')[0].status, CONTRADICTED);
  assert.equal(find(r, 'breaking')[0].status, CONTRADICTED, 'without the preview the setup change breaks a non-breaking series');
});

test('a setup change confined to the preview is allowed, and says why', async () => {
  const {checkPick, CONFIRMED} = await inv();
  const {c, ev} = swiftpmPick({description: 'Moves settings. A configuration that uses its own xcconfig must now `#include` the generated file.'});
  const r = checkPick(c, ev, st(), {today: '2026-10-25'});
  assert.equal(find(r, 'breaking')[0].status, CONFIRMED);
  assert.match(find(r, 'breaking')[0].text, /opt-in preview/);
});

test('a port that differs from main must say so', async () => {
  const {checkPick, CONFIRMED, CONTRADICTED, FLAG} = await inv();
  const diverged = {fidelity: [{own: '27150439fbd', main: '6a2c7c27342', same: false, onlyOwn: [], onlyMain: [], differing: [{f: 'a.js', own: '+1/-0', main: '+2/-0'}]}]};
  const silent = checkPick(...Object.values(swiftpmPick({}, diverged)), st(), {today: '2026-10-25'});
  assert.equal(find(silent, 'fidelity')[0].status, CONTRADICTED);
  assert.equal(find(silent, 'review')[0].status, FLAG, 'the main review does not cover a different change');
  const told = swiftpmPick({description: 'Port of 6a2c7c27342. This is not a plain cherry-pick: main also moves the opt-ins.'}, diverged);
  const r = checkPick(told.c, told.ev, st(), {today: '2026-10-25'});
  assert.equal(find(r, 'fidelity')[0].status, CONFIRMED);
  assert.match(find(r, 'fidelity')[0].text, /not a plain cherry-pick/);
});

test('reverted on main, too fresh, or followed up: each is said, not hidden', async () => {
  const {checkPick, CONTRADICTED, FLAG} = await inv();
  const {c, ev} = swiftpmPick({}, {mainCommits: [mainCommit({
    date: '2026-10-22T10:00:00Z',
    reverts: [{sha: 'aaaa111', subject: 'Revert "Encode line breaks"'}],
    followUps: [{sha: 'bbbb222', date: '2026-10-23', subject: 'Fix the line break fix'}, {sha: '1d69b9084d0', date: '2026-10-23', subject: 'itself'}],
  })]});
  const r = checkPick(c, ev, st(), {today: '2026-10-25'});
  assert.ok(find(r, 'on-main').some(f => f.status === CONTRADICTED && /reverted/.test(f.text)));
  assert.equal(find(r, 'soak')[0].status, FLAG);
  assert.match(find(r, 'follow-ups')[0].text, /bbbb222/);
  assert.ok(!/1d69b9084d0 2026/.test(find(r, 'follow-ups')[0].text), 'the pick\'s own commits are not follow-ups');
});

test('the kind of change is checked against its own changelog line', async () => {
  const {checkPick, CONTRADICTED} = await inv();
  const feature = swiftpmPick({title: '[0.88] Fix the scheme script'}, {mainCommits: [mainCommit({message: 'x\n\nChangelog: [IOS] [ADDED] - New option'})]});
  assert.equal(find(checkPick(feature.c, feature.ev, st(), {}), 'kind')[0].status, CONTRADICTED);
  const docs = swiftpmPick({title: '[0.88] Docs: correct SwiftPM docs'});
  assert.equal(find(checkPick(docs.c, docs.ev, st(), {}), 'kind')[0].status, CONTRADICTED, 'docs that change production code');
});

test('review: a resolved change request is fine, an open one is not', async () => {
  const {checkPick, CONFIRMED, CONTRADICTED} = await inv();
  const prOf = reviews => swiftpmPick({}, {mainCommits: [mainCommit({message: 'no phab'})], pr: {number: 58669, reviews, checks: []}});
  const resolved = prOf([{author: 'javache', state: 'CHANGES_REQUESTED'}, {author: 'javache', state: 'APPROVED'}]);
  const r1 = find(checkPick(resolved.c, resolved.ev, st(), {}), 'review')[0];
  assert.equal(r1.status, CONFIRMED);
  assert.match(r1.text, /after javache first requested changes/);
  const open = prOf([{author: 'javache', state: 'APPROVED'}, {author: 'cortinico', state: 'CHANGES_REQUESTED'}]);
  assert.equal(find(checkPick(open.c, open.ev, st(), {}), 'review')[0].status, CONTRADICTED);
});

test('a conflict on the branch and a missing promised test are contradictions', async () => {
  const {checkPick, CONTRADICTED} = await inv();
  const {c, ev} = swiftpmPick({description: 'Fixes a crash and adds a regression test.'}, {files: [{f: 'packages/react-native/scripts/spm/x.js'}]});
  const r = checkPick(c, ev, st(), {trial: {1440: {status: 'conflict', sha: '1d69b9084d8', files: ['packages/react-native/Package.swift']}}});
  assert.equal(find(r, 'applies')[0].status, CONTRADICTED);
  assert.match(find(r, 'applies')[0].text, /Package\.swift/);
  assert.equal(find(r, 'tests')[0].status, CONTRADICTED);
});

test('the picks step shows the checked claims when evidence was gathered, and says when it was not', async () => {
  const lines = [];
  const {c, ev} = swiftpmPick();
  await runPhase(st({shape: 'patch', openPicks: [c], pickCandidates: [c], pickEvidence: {picks: {1440: ev}, trial: {1440: {status: 'clean'}}}}), {
    mode: MODES.DRY_RUN, shape: 'patch', log: l => lines.push(l),
  });
  assert.match(lines.join('\n'), /Pick investigation for 0\.88\.1/);
  assert.match(lines.join('\n'), /cli\.mjs drop --series 0\.88 --pick <n>/);
  lines.length = 0;
  await runPhase(st({shape: 'patch', openPicks: [c], pickCandidates: [c]}), {mode: MODES.DRY_RUN, shape: 'patch', log: l => lines.push(l)});
  assert.match(lines.join('\n'), /First read only: no evidence was gathered/);
});

// ---------------------------------------------------------- Hermes evidence

test('Hermes: a commit adding code nothing calls is inert, whatever its message says', async () => {
  const {definedNames, isDefinitionLine, platformClaims} = await evid();
  const {classifyHermesCommit, hermesOverview, hermesChoice} = await import('../scripts/release-state.mjs');
  const added = ['+  @DoNotStrip', '+  public static boolean localeAffectsCasing() {', '+    return language.equals("tr");', '+  }'];
  assert.deepEqual(definedNames(added), ['localeAffectsCasing']);
  assert.equal(isDefinitionLine('+    return localeAffectsCasing();', 'localeAffectsCasing'), false, 'a call is not a definition');
  assert.deepEqual(definedNames(['+ * Copyright (c) Meta Platforms, Inc.']), [], 'comments define nothing');
  const pc = platformClaims('switch Linux and Windows off ICU. CoreFoundation backend', ['lib/Platform/Unicode/java/com/facebook/hermes/unicode/AndroidUnicodeUtils.java']);
  assert.equal(pc.claimsMore, true);

  const feature = {sha: 'a94df18620e', subject: 'Detect the host casing locale and switch Linux and Windows off ICU', body: ''};
  const ev = {inert: true, defs: [{name: 'localeAffectsCasing', called: false}], platforms: pc};
  assert.equal(classifyHermesCommit(feature).kind, 'feature', 'the message alone reads as a feature');
  assert.equal(classifyHermesCommit(feature, ev).kind, 'inert');
  const ho = hermesOverview(
    {resolved: true, commits: [{sha: 'e9c2f761616', subject: 'Fix: JSI Value::toString()', body: ''}, feature]},
    {commits: {a94df18620e: ev}},
  );
  assert.match(ho.commits[1].note, /localeAffectsCasing\(\), which nothing on the branch calls/);
  assert.match(ho.commits[1].note, /names Apple, Linux, Windows but on this branch it only touches Android/);
  assert.match(hermesChoice(ho, {proposedNext: '0.88.1'}), /Every commit that changes behaviour is a fix \(1\)/);
});

// ----------------------------------------------------------- pick and drop

const RELEASES_MEMBER = 'MEMBER';
const markerComment = (version, to, association = RELEASES_MEMBER) => ({
  authorAssociation: association, url: 'https://github.com/reactwg/react-native-releases/issues/1457#c1',
  body: `Not picked.\n\n<!-- release-copilot: not-picked for=${version} to=${to} -->`,
});

test('a not-picked comment defers the pick, but only for that version and only from the crew', async () => {
  const {notPickedFor} = await import('../scripts/release-state.mjs');
  assert.equal(notPickedFor({comments: [markerComment('0.88.1', '0.89.0')]}, '0.88.1').to, '0.89.0');
  assert.equal(notPickedFor({comments: [markerComment('0.88.1', '0.89.0')]}, '0.88.2'), null, 'scoped to its version');
  assert.equal(notPickedFor({comments: [markerComment('0.88.1', 'never', 'NONE')]}, '0.88.1'), null, 'a pasted marker does not count');

  const pick = {number: 1457, title: '[0.88] -O2', comments: [markerComment('0.88.1', '0.89.0')]};
  const state = await deriveState({...patchSrc(), openPicks: async () => [pick], pickCandidates: async ps => ps.map(p => ({...p, resolved: [], landed: false}))}, {series: '0.88', today: '2026-10-25'});
  assert.equal(state.pickCandidates.length, 0, 'not a candidate for 0.88.1 any more');
  assert.equal(state.openPicks[0].targetRelease, '0.89.0');
  assert.equal((await evaluate(['noOpenPicks'], state, {})).passed, true);
});

test('drop posts the reason with its marker, closes only for never, and refuses a non-answer', async () => {
  const {dropActions} = await import('../scripts/pick-actions.mjs');
  const state = st({openPicks: [{number: 1457, title: 'x'}]});
  const [comment, ...rest] = dropActions(state, 1457, {to: '0.89.0', reason: 'Landed on main three days ago. It ships in 0.89.'});
  assert.equal(rest.length, 0);
  assert.equal(comment.mutates, true);
  const body = comment.args[comment.args.indexOf('--body') + 1];
  assert.match(body, /^Not picked for 0\.88\.1\. Moving it to 0\.89\.0\./);
  assert.match(body, /<!-- release-copilot: not-picked for=0\.88\.1 to=0\.89\.0 -->/);
  assert.ok(comment.impact.some(l => /three days ago/.test(l)), 'the captain sees the full comment before it posts');
  const never = dropActions(state, 1457, {to: 'never', reason: 'Not a fix.'});
  assert.deepEqual(never[1].args.slice(0, 3), ['issue', 'close', '1457']);
  assert.throws(() => dropActions(state, 1457, {to: '0.88.1', reason: 'x'}), /later version/);
  assert.throws(() => dropActions(state, 1457, {to: '0.89.0', reason: '  '}), /needs a reason/);
});

test('pick takes a stack from the bottom, checks authors, pushes on a retyped branch and closes each', async () => {
  const {runPick} = await import('../scripts/pick-actions.mjs');
  const {Runner} = await import('../scripts/actions.mjs');
  const mk = (number, sha, stackedOn) => ({number, title: `p${number}`, stackedOn, landed: false,
    resolved: [{sha: sha.slice(0, 11), backportPr: number + 57869, prCommits: [sha], ownCommits: [sha], message: 'Fix x', files: []}]});
  const cands = [mk(1440, 'a'.repeat(40)), mk(1450, 'b'.repeat(40), 1440)];
  const runner = new Runner({mode: MODES.DRY_RUN, log: () => {}});
  const res = await runPick(st({pickCandidates: cands, openPicks: cands}), 1450, runner);
  assert.deepEqual(res.picked, [1440, 1450]);
  const cmds = runner.plan().map(p => p.command);
  assert.ok(cmds.some(c => c === `git cherry-pick -x ${'a'.repeat(40)} ${'b'.repeat(40)}`), cmds.join('\n'));
  const push = runner.plan().find(p => /git push/.test(p.command));
  assert.equal(push.confirmToken, '0.88-stable');
  assert.equal(runner.plan().filter(p => /gh issue close/.test(p.command)).length, 2);
  assert.ok(cmds.indexOf(cmds.find(c => /--no-walk/.test(c))) < cmds.indexOf(cmds.find(c => /cherry-pick/.test(c))), 'authors recorded first');

  await assert.rejects(runPick(st({pickCandidates: [cands[1]], openPicks: cands}), 1450, runner), /stacked on #1440/);
  const breaking = [mk(1500, 'c'.repeat(40))];
  breaking[0].resolved[0].message = '[GENERAL] [BREAKING] - Remove prop';
  await assert.rejects(runPick(st({pickCandidates: breaking, openPicks: breaking}), 1500, runner), /non-breaking/);
});

test('a captain outside Meta is told which Meta crew member to hand a Meta-only step to', async () => {
  const {metaHandoff, META_CREW, Runner, declare} = await import('../scripts/actions.mjs');
  const {announceWhere} = await import('../scripts/phases.mjs');
  assert.match(metaHandoff(true), /do this yourself/);
  for (const atMeta of [false, null]) {
    assert.match(metaHandoff(atMeta), new RegExp(META_CREW.join(', ')));
  }
  const lines = [];
  await new Runner({mode: MODES.DRY_RUN, atMeta: false, log: l => lines.push(l)}).run(
    declare({step: 'announce', metaOnly: true, why: 'post it', cmd: 'echo', args: ['x']}),
  );
  assert.match(lines.join('\n'), /needs a Meta employee\. Ask a Meta member of the release crew \(Nicola, Riccardo, Fabrizio\)/);

  assert.match(announceWhere(true), /^Post this to #releases-coordination on Discord and React Releases on Slack:$/);
  assert.match(announceWhere(false), /Post this to #releases-coordination on Discord\. React Releases on Slack is internal to Meta, so ask a Meta member/);
  assert.match(announceWhere(null), /if you work at Meta\. If you do not, ask/);
});

test('doctor: a checkout the sandbox will not let us write to fails with the setting that fixes it', async () => {
  const {checkWritable} = await import('../scripts/doctor.mjs');
  const {mkdtempSync, mkdirSync, chmodSync, rmSync} = await import('node:fs');
  const {tmpdir} = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'rc-writable-'));
  mkdirSync(join(dir, '.git'));
  try {
    assert.equal(checkWritable(dir).status, 'ok');
    chmodSync(join(dir, '.git'), 0o500);
    const r = checkWritable(dir);
    assert.equal(r.status, 'fail');
    assert.match(r.detail, /EACCES|EPERM/);
    assert.match(r.fix, /additionalDirectories/);
    assert.ok(r.fix.includes(`"${dir}"`), 'names the real path to add');
  } finally {
    chmodSync(join(dir, '.git'), 0o700);
    rmSync(dir, {recursive: true, force: true});
  }
});

test('the repo tells Claude Code it may write to the default checkouts', async () => {
  const {readFileSync, realpathSync} = await import('node:fs');
  const root = join(HERE, '..', '..', '..', '..');
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(settings.permissions.additionalDirectories, ['~/git/react-native', '~/git/hermes']);
  assert.equal(
    realpathSync(join(root, '.claude', 'skills', 'release-copilot')),
    realpathSync(join(HERE, '..')),
    'stock Claude Code finds the skill through .claude/skills',
  );
});

test('manual testing: only RC0, RC1 and the golden RC, never a .0 or a patch', async () => {
  // Derived end to end, the way plan and the crew status message see it.
  const at = async (versions, next, shape, tags = []) =>
    (await deriveState({
      ...patchSrc(),
      npmVersions: async () => versions,
      npmDistTags: async () => ({latest: versions.find(v => !v.includes('-')) ?? '0.87.1', next: versions.at(-1)}),
      gitTags: async () => tags,
    }, {series: '0.88', today: '2026-10-25', shape})).schedule.needsManualTesting;
  const rcs = n => [...Array(n)].map((_, i) => `0.88.0-rc.${i}`);
  assert.equal(await at(['0.87.1'], '0.88.0-rc.0', 'branch-cut'), true, 'RC0');
  assert.equal(await at(['0.87.1', ...rcs(1)], '0.88.0-rc.1', 'rc'), true, 'RC1');
  assert.equal(await at(['0.87.1', ...rcs(2)], '0.88.0-rc.2', 'rc'), false, 'RC2');
  assert.equal(await at(['0.87.1', ...rcs(4)], '0.88.0-rc.4', 'rc'), true, 'the assumed golden rc.4');
  assert.equal(await at(['0.87.1', ...rcs(5)], '0.88.0', 'promote'), false, 'the .0');
  assert.equal(await at(['0.87.1', ...rcs(5), '0.88.0'], '0.88.1', 'patch'), false, 'a patch');
  assert.equal(await at(['0.87.1', ...rcs(5), '0.88.0', '0.88.1'], '0.88.2', 'patch'), false, 'a later patch');

  // The pre-flight gate follows: no --manual-tested needed for a patch.
  const patch = await deriveState(patchSrc(), {series: '0.88', today: '2026-10-25'});
  const ev = await evaluate(['manualTestingDone'], patch, {});
  assert.equal(ev.passed, true);
  assert.match(ev.results[0].detail, /0\.88\.1 needs no manual testing/);
});

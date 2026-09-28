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
  assert.ok(ANNOUNCE_CHANNELS.some(c => /GChat/.test(c)));
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
  assert.equal(requiresManualTesting(live, '0.88.0'), true, 'stable always');
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

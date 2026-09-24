/**
 * Phase definitions.
 *
 * Declarative on purpose: the up-front summary, the guided prompts, the
 * guided runner and the dry-run printer all read these same objects, so
 * they cannot describe different releases. This is the thing that replaces
 * release_checklist.yml rather than duplicating it.
 *
 * `actions` is a function of (state, ctx) returning declared actions, so a step
 * can adapt to the derived state without any phase knowing how to execute.
 */

import {declare} from './actions.mjs';

const RN = 'react/react-native';

const triggerCreateRelease = (state, ctx) =>
  declare({
    step: 'publish',
    why: `Publish ${state.proposedNext} from ${state.branch}`,
    cmd: 'gh',
    args: [
      'workflow',
      'run',
      'Create release',
      '--repo',
      RN,
      '--ref',
      state.branch,
      '-f',
      `version=${state.proposedNext}`,
      '-f',
      `is-latest-on-npm=${ctx.isLatest ? 'true' : 'false'}`,
      '-f',
      'dry-run=false',
    ],
    impact: [
      `publishes react-native@${state.proposedNext} to npm, publicly and permanently`,
      `creates the git tag v${state.proposedNext} on ${state.branch}`,
      ctx.isLatest
        ? 'moves the npm "latest" tag, so every `npm install react-native` resolves to this'
        : 'goes to the npm "next" tag, "latest" is unchanged',
      'triggers the Podfile.lock bump, the changelog PR and a draft GitHub release',
    ],
    reversible:
      'not really. npm deprecates rather than unpublishes and the tag is public the moment it is pushed.',
    // A typo in the version is the failure this guards. Typing it back is the
    // cheapest check that the human read what they are about to publish.
    confirmToken: state.proposedNext,
  });

const checkoutStep = {
  id: 'checkout',
  title: 'Check out the release branch locally',
  gates: [],
  actions: state => [
    declare({
      step: 'checkout',
      mutates: false,
      why: 'fetch commits and tags before picking',
      cmd: 'git',
      args: ['fetch', '--all', '--tags'],
    }),
    declare({
      step: 'checkout',
      why: `switch to ${state.branch}`,
      cmd: 'git',
      args: ['switch', state.branch],
      impact: [`changes your local checkout to ${state.branch}`],
      reversible: 'yes, switch back to the branch you were on',
    }),
  ],
  note:
    'Check your toolchain matches what this series needs, Node version in particular. See docs/support.md for the supported external dependencies.',
};

/**
 * Signals a gate cannot judge: the codegen output contract, the public API
 * snapshots and the unsnapshotted surfaces all need a human reading diffs.
 */
const breakingSweepStep = {
  id: 'breaking-sweep',
  title: 'Sweep for breaking changes (non-breaking series)',
  gates: ['noBreakingChanges'],
  actions: () => [],
  note:
    'The gate covers changelog and commit annotations. Still diff the codegen snapshots by hand: they catch changes to what RN emits for third-party modules, which the public API snapshots miss. See reference/breaking-changes.md.',
};

/**
 * Artifacts come from the LAST workflow run on the branch, so this gate exists
 * to stop people pushing during testing and silently invalidating what they are
 * about to test.
 */
const artifactsStep = {
  id: 'artifacts',
  title: 'Wait for branch artifacts to build',
  gates: ['ciGreen'],
  actions: () => [],
  note:
    'Release testing uses artifacts from the most recent workflow run on the branch. Avoid pushing more commits from here until testing is done, otherwise you wait for a rebuild and must retest.',
};

/** Shared tail: everything from publish to board update. */
const commonPublishSteps = [
  {
    id: 'pre-flight',
    title: 'Pre-flight checks',
    gates: ['branchShape', 'tagFree', 'ciGreen', 'noOpenPicks', 'noBreakingChanges', 'hermesConsistent', 'distTagCorrect', 'dryRunExplicit'],
    actions: () => [],
    note: 'All gates are hard stops. A red CI failure must be classified, never blanket-retried.',
  },
  {
    id: 'publish',
    title: 'Create the release',
    gates: [],
    actions: (state, ctx) => [triggerCreateRelease(state, ctx)],
    note:
      'Create Release pushes the branch with --follow-tags, which creates the tag. The tag push then fires Publish to npm, which also calls bump-podfile-lock. Do not hand-commit a Podfile.lock bump. Now post the release-crew status message: `node scripts/cli.mjs message --series <x.y> --run <run-url>`, then re-run it and edit the message in place as steps complete.',
  },
  {
    id: 'verify-publish',
    title: 'Verify the release actually happened',
    gates: [],
    actions: state => [
      declare({
        step: 'verify-publish',
        mutates: false,
        why: 'confirm the tag exists on the remote',
        cmd: 'git',
        args: ['ls-remote', '--tags', `https://github.com/${RN}.git`, `refs/tags/v${state.proposedNext}`],
      }),
      declare({
        step: 'verify-publish',
        mutates: false,
        why: 'confirm the version resolves on npm (per-version endpoint, not the cached package doc)',
        cmd: 'curl',
        args: ['-s', '-o', '/dev/null', '-w', '%{http_code}\\n', `https://registry.npmjs.org/react-native/${state.proposedNext}`],
      }),
      declare({
        step: 'verify-publish',
        mutates: false,
        why: 'confirm the bot committed the Podfile.lock bump',
        cmd: 'gh',
        args: ['api', `repos/${RN}/commits`, '-f', `sha=${state.branch}`, '--jq', '.[0:5][].commit.message'],
      }),
    ],
    note:
      'Never conclude from the workflow conclusion alone. Guard-skipped runs go green having done nothing. Expect post_publish to fail on a 3-minute npm verify timeout while the publish itself succeeded. A "[LOCAL] Bump Podfile.lock" commit should appear on the branch; if it is missing, see reference/field-notes.md before bumping by hand.',
  },
  {
    id: 'changelog',
    title: 'Curate the changelog PR',
    gates: [],
    actions: () => [],
    note:
      'The generator emits empty sections and an Unknown bucket. See reference/changelog.md: drop internals, promote genuinely user-facing entries, add bold scope prefixes, sort alphabetically, omit empty sections.',
  },
  {
    id: 'github-release',
    title: 'Publish the draft GitHub release',
    gates: [],
    actions: state => [
      declare({
        step: 'github-release',
        mutates: false,
        why: 'open the draft release for review',
        cmd: 'gh',
        args: ['release', 'view', `v${state.proposedNext}`, '--repo', RN, '--web'],
      }),
    ],
    note: 'Pre-release for an RC, Latest for a stable on the newest series.',
  },
  {
    id: 'announce',
    title: 'Announce',
    gates: [],
    actions: () => [
      declare({
        step: 'announce',
        metaOnly: true,
        why: 'post the same announcement to the React Native Releases Workplace group',
        cmd: 'echo',
        args: ['post announcement to Workplace'],
      }),
    ],
    note: 'Discord #release-coordination, then the Workplace group (Meta only).',
  },
  {
    id: 'status-message',
    title: 'Refresh the release-crew status message',
    gates: [],
    actions: () => [],
    note:
      'Re-run `node scripts/cli.mjs message --series <x.y>` and edit the Discord message in place. Ticks are derived live, so do not copy the previous RC\'s message: that is how stale links and premature ticks get posted.',
  },
  {
    id: 'board',
    title: 'Update the release project board',
    gates: [],
    actions: () => [],
    note:
      'Close actioned pick requests; closing moves them to Done / Picked automatically. Also set Target Release on each, from where the commit actually landed. It defaults to the series first RC and is wrong for almost every item otherwise. See reference/picks.md.',
  },
];

export const PHASES = {
  'branch-cut': {
    id: 'branch-cut',
    title: 'Cut a release branch (RC0)',
    steps: [
      {
        id: 'external-deps',
        title: 'Update the external dependencies table',
        gates: [],
        actions: () => [],
        note: 'Open a PR rather than committing to main, the repo notifies watchers.',
      },
      {
        id: 'create-branches',
        title: 'Create the stable branch and the matching template branch',
        gates: [],
        actions: state => [
          declare({
            step: 'create-branches',
            why: `Create the release branch ${state.branch} from main`,
            cmd: 'gh',
            args: ['api', `repos/${RN}/git/refs`, '-f', `ref=refs/heads/${state.branch}`, '-f', 'sha=MAIN_SHA'],
            impact: [
              `creates ${state.branch} on ${RN}, visible to everyone`,
              'from this point main targets the next version, so picks must be requested rather than merged',
            ],
            reversible: 'the branch can be deleted, but anything cut from it cannot be recalled',
            confirmToken: state.branch,
          }),
        ],
        note:
          'Also create the matching branch in react-native-community/template. Tell #cli: they must bump the CLI before RC1.',
      },
      {
        id: 'hermes',
        title: 'Publish a Hermes release and pin it',
        gates: [],
        actions: () => [
          declare({
            step: 'hermes',
            metaOnly: true,
            why: 'publish the Hermes tag',
            cmd: 'echo',
            args: ['see reference/hermes.md'],
          }),
        ],
        note: 'Do not proceed until the branch carries the Hermes bump. See reference/hermes.md for the latest-v1 rule.',
      },
      breakingSweepStep,
      {
        id: 'nightly',
        title: 'Trigger a nightly from main',
        gates: [],
        actions: () => [
          declare({
            step: 'nightly',
            why: 'Trigger a nightly build from main',
            cmd: 'gh',
            args: ['workflow', 'run', 'nightly.yml', '--repo', RN, '--ref', 'main'],
            impact: ['publishes a nightly to npm that partners may integrate against'],
            reversible: 'no, but nightlies are expected to churn',
          }),
        ],
      },
      artifactsStep,
      ...commonPublishSteps,
      {
        id: 'bump-main',
        title: 'Bump main to the next minor',
        gates: [],
        actions: () => [
          declare({
            step: 'bump-main',
            metaOnly: true,
            why: 'point main monorepo packages at the next version',
            cmd: 'echo',
            args: ['js1 publish react-native 0.<next>.0-main'],
          }),
        ],
      },
    ],
  },

  rc: {
    id: 'rc',
    title: 'Publish an incremental release candidate',
    steps: [
      checkoutStep,
      {
        id: 'picks',
        title: 'Action pick requests',
        gates: [],
        actions: () => [],
        note:
          'Every change must be on the board before picking. Pick in dependency order, not chronological order. See reference/picks.md.',
      },
      breakingSweepStep,
      artifactsStep,
      {
        id: 'test',
        title: 'Release testing',
        gates: [],
        actions: () => [],
        note: 'Manual testing only for RC0, RC1 and the golden RC. E2E must be green regardless.',
      },
      ...commonPublishSteps,
    ],
  },

  promote: {
    id: 'promote',
    title: 'Promote a release candidate to stable',
    steps: [
      ...commonPublishSteps,
      {
        id: 'support-table',
        title: 'Update the support policy table',
        gates: [],
        actions: () => [],
        note: 'facebook/react-native-website, website/src/components/releases/_releases-table.md',
      },
      {
        id: 'blog',
        title: 'Ship the blog post',
        gates: [],
        actions: () => [],
      },
      {
        id: 'website-version',
        title: 'Cut a new website version',
        gates: [],
        actions: () => [],
      },
    ],
  },

  patch: {
    id: 'patch',
    title: 'Publish a patch on a stable series',
    steps: [
      checkoutStep,
      {
        id: 'picks',
        title: 'Action pick requests',
        gates: [],
        actions: () => [],
        note: 'Patch criteria are stricter than RC criteria. See reference/picks.md.',
      },
      artifactsStep,
      ...commonPublishSteps,
    ],
  },
};

export function phaseFor(shape) {
  const p = PHASES[shape];
  if (!p) {
    throw new Error(`no phase definition for shape "${shape}"`);
  }
  return p;
}

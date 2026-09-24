---
name: release-copilot
description: Run a React Native release end to end. Use when cutting a branch, publishing an RC, promoting to stable or shipping a patch and when asking where a release currently stands or why its CI is red. Derives live state, gates every step and confirms every mutating action with the release captain before running it.
---

# Release co-pilot

The executable source of truth for running a React Native release. It derives where
the release actually is, refuses to proceed through a failed gate and walks the
captain through each step, describing what it is about to do before it does it.

## First, check your environment

```sh
node scripts/cli.mjs doctor
```

Checks Node, `gh` auth, the `read:project,project` scope the board needs, push access
to all four repos a release touches and that your `react-native` checkout is not
shallow. Every failing check says how to fix itself.

`run` and `plan` call it automatically and refuse to start on a broken environment.
`--skip-doctor` overrides.

The shallow-clone check matters more than it looks: `git merge-base --is-ancestor`
silently returns the wrong answer on a shallow clone and pick ordering and every
breaking-change check depend on it.

## Start here

```sh
cd .llms/skills/release-copilot

node scripts/cli.mjs status --series 0.88      # where are we?
node scripts/cli.mjs plan   --series 0.88      # what would happen? executes nothing
node scripts/cli.mjs run    --series 0.88      # guided, confirms each mutating step
```

Always `plan` before `run`. `plan` evaluates every gate against live state, so it
hard-stops on a red branch exactly where a real run would. It is a pre-flight
check, not a rehearsal of the happy path.

## The release-crew status message

When you trigger an RC, the captain posts a status message in the release-crew Discord
channel and edits it in place as the release proceeds. Generate it, do not copy the
previous RC's:

```sh
node scripts/cli.mjs message --series 0.88 --run <publish-run-url>   # when triggering
node scripts/cli.mjs message --series 0.88                           # refresh as it proceeds
```

Ticks are **derived from live state**, not tracked by hand: open picks, branch CI, npm
publication, Maven artifacts, the rn-diff-purge diff, the changelog PR and whether the
GitHub release is still a draft. A step with no signal (verify template, communicate,
update the project) stays `:hourglass:` and is listed at the end for you to confirm.

It never posts. It prints the block for you to paste.

Copying the previous RC's message is how rc.2's draft ended up carrying rc.1's
upgrade-helper link and four ticks for steps that had not happened.

## How it decides what to do

Nothing is stored between runs. Every invocation re-derives state from npm
dist-tags, git tags, the branch tip, branch CI, the open pick requests, the
release project board and `reference/schedule.json`. A persisted "we are on step
4" would go wrong the moment someone else pushed, so there isn't one.

From that it computes the series, the last published version, the next version,
and the release shape: `branch-cut`, `rc`, `promote` or `patch`. Each shape is a
list of steps in `scripts/phases.mjs`. The summary, the prompts and the runner
all read those same objects, so they cannot describe different releases.

## The golden RC is never assumed

The golden RC is the last one before `.0`. It is **decided by the team, not by the
schedule**, so the skill surfaces what it knows and asks rather than deciding.

Measured from tags: 0.82 rc.5, 0.83 rc.5, 0.84 rc.5, 0.85 rc.7, 0.86 rc.3, 0.87 rc.4.
A fixed value in the schedule was wrong for three of the four series it covered, and
`docs/guide-release-process.md`'s hardcoded "RC4 (Golden RC)" is right only for 0.87.

So:

- **Released series:** derived exactly from tags.
- **In-flight series:** reported as not decided, alongside the planning default
  (`expectedGoldenRc`, currently rc.5), what prior series did and whether anything
  substantive landed since the last RC. The team may declare an earlier RC golden when
  nothing was picked between RCs, because another RC would be identical.

Manual testing is three-valued for the same reason. RC0 and RC1 are unconditional;
beyond that, while the series is in flight the skill reports *may need testing, confirm*
rather than ticking or demanding. Matching the planning default is **not** a decision.

## Modes

| Mode | Reads | Mutations |
| --- | --- | --- |
| `plan` | live | printed, never executed |
| `run` (guided) | live | described in full, then confirmed one at a time |
| tests | fixture | printed |

**There is no unattended mode, by design.** A release publishes state that cannot
be taken back: an npm version can be deprecated but not meaningfully unpublished
and a tag is public the moment it is pushed. Passing an unknown mode throws
rather than falling back to guided.

Gate failures hard-stop in both modes.

## What a confirmation looks like

Before any mutating action the captain sees what it does, the exact command, what
changes and whether it can be undone:

```
  Publish 0.88.0-rc.3 from 0.88-stable

    command:  gh workflow run 'Create release' --repo react/react-native --ref 0.88-stable \
                -f version=0.88.0-rc.3 -f is-latest-on-npm=false -f dry-run=false
    changes:  publishes react-native@0.88.0-rc.3 to npm, publicly and permanently
              creates the git tag v0.88.0-rc.3 on 0.88-stable
              goes to the npm "next" tag, "latest" is unchanged
              triggers the Podfile.lock bump, the changelog PR and a draft GitHub release
    undo:     not really. npm deprecates rather than unpublishes and the tag is
              public the moment it is pushed.

    type "0.88.0-rc.3" to confirm, anything else to skip:
```

`declare()` refuses to build a mutating action with no `impact`, so a step cannot
ask for consent to something it will not describe.

The riskiest actions (publishing a version, cutting a release branch) ask the
captain to **retype the version or branch** rather than accept `y`. A wrong
version is the failure that guard exists for and retyping it is the cheapest
check that the captain read what they are about to publish.

## Gates

Preconditions are executable and block. The non-obvious ones exist because of
specific incidents, so do not remove them as theoretical:

- **`tagFree` and `branchShape`**: `create-release.yml` guards publishing behind
  `if:` conditions. A failed guard produces a **green run that did nothing**.
- **`dryRunExplicit`**: the workflow's own `dry-run` input **defaults to true**.
- **`distTagCorrect`**: `latest` belongs to the newest stable line. An RC goes to
  `next`.
- **`ciGreen`**: on red, classify before acting. It also fails when a path-filtered
  workflow is red on an earlier commit and simply did not re-run on the tip, which
  previously hid a red gate on the commit that shipped an RC. `scripts/gates.mjs` knows the
  rubygems DNS failure and the missing-artifact cascade as retryable and a
  release-branch-only test failure as structural. Anything unrecognised is
  **not** auto-retryable.
- **`hermesConsistent`**: `version.properties` and `package.json` must agree.
- **`hermesCurrent`**: the pinned tag must be current with its Hermes branch. Consistency
  between the two pin files says nothing about whether the branch has moved on, which is
  how two unreleased Hermes commits went unnoticed during 0.88. A re-landed back-out is
  called out by name, since that needs a human rather than an automatic bump.
- **`picksNotBreaking`**: assesses pick CANDIDATES before they land and only in a
  non-breaking series. `noBreakingChanges` scans what is already on the branch, so on its
  own it only catches a breaking change after it has been picked and pushed. It does not
  judge from the changelog line: #58063 carried no `[BREAKING]` tag and broke C++ codegen
  consumers, so it also inspects the changed files against the surfaces where a break
  would not be annotated. A hit is a trigger to inspect, not a verdict. An unresolvable
  candidate blocks rather than passes.
- **`breakingWindow`**: a breaking change must not ship in a non-breaking series.

## Verify, never trust the tick

After publishing, confirm the tag exists on the remote and the version resolves on
npm's **per-version** endpoint. The full package document is CDN-cached and served
stale for `react-native`; it lied for several minutes during 0.88.0-rc.1.

Expect `post_publish` to fail on its 3-minute "Verify Release is on NPM" timeout
while the publish itself succeeded. Read the `publish_react_native` log for
`+ react-native@<version>` before concluding anything.

## Things that are already automated, so do not do them by hand

- **Podfile.lock.** `publish-npm.yml` calls `bump-podfile-lock.yml`, which commits
  `[LOCAL] Bump Podfile.lock`. Hand-committing one just gets overwritten.
- **The changelog PR and the draft GitHub release** are generated by the publish
  workflow. Curate them, do not create them.

## Reference

- `reference/process.md`: the full step content per phase
- `reference/picks.md`: pick criteria, ordering and the board
- `reference/reverts.md`: how to scope a revert so it does not ship a second break
- `reference/changelog.md`: curation rules the generator does not apply
- `reference/hermes.md`: the coupling and the `latest-v1` rule
- `reference/testing.md`: which releases need manual testing
- `reference/field-notes.md`: failures with their signatures and remedies
- `reference/schedule.json`: cadence data, the source for breaking-window gating

## Evals: proving it follows the captain's agenda

```sh
node evals/run.mjs           # human-readable
node evals/run.mjs --md      # markdown, for a PR description
node evals/run.mjs --json    # machine-readable
```

Unit tests prove the code does what the code says. The evals prove it does what the
**release documentation** says, which is the claim that matters.

`evals/scenarios.json` holds named release situations as data, readable without
reading test code. Each states the situation, the state it produces and what the skill
must decide. They cover the two critical flows end to end (**branch cut + RC0** and an
**incremental RC**), promote-to-stable and eight ways a release must be blocked, each
drawn from something that actually happened.

The runner also emits an **agenda coverage matrix**: every step the release docs
prescribe, the phase step implementing it and the scenarios that reach it. A
documented step with no implementing step or with no scenario exercising it, is a
counted gap and fails the run. That is the mechanism that lets the docs be retired:
when the matrix is complete, the skill demonstrably covers the agenda.

`evals/REPORT.md` is the generated matrix, regenerate it with `--md` when steps change.

## Fixtures and tests

```sh
node --test __tests__/copilot.test.mjs                        # offline, no network
node scripts/cli.mjs record --series 0.88 --out fixtures/foo  # snapshot live state
node scripts/cli.mjs plan --fixture fixtures/foo              # replay it
```

Tests must never reach the network. A fixture missing an entry throws rather than
falling back to a live call, so a test cannot pass by accident. The suite also runs the
evals, so a broken scenario or a new agenda gap fails the normal test run.

## Reverting

A breaking change that reached a non-breaking release has to come out. Scoping that is
its own problem: on 0.88 the reported commit was only half of it, because the value had
moved twice inside the release. See `reference/reverts.md` before starting and open the
pick request with the scope analysis **before** pushing.

## Meta-only steps

`js1 publish`, the Hermes tag publish and the Workplace announcement cannot run
outside Meta. They are marked `metaOnly` and are printed and delegated rather than
attempted, so a community releaser is told exactly what to hand over.

## Status

v1 covers the full lifecycle. The `docs/` guides in this repo remain authoritative
until this skill has driven a few releases; the intent is to retire them once it
has. If you find a step the skill does not know, that gap blocks deleting the docs,
so add it here.

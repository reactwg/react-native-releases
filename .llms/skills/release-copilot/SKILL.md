---
name: release-copilot
description: Run a React Native release end to end. Use when cutting a branch, publishing an RC, promoting to stable or shipping a patch and when asking where a release currently stands or why its CI is red. Derives live state, gates every step and confirms every mutating action with the release captain before running it.
---

# Release co-pilot

An executable runbook for a React Native release. It derives where the release
actually is, refuses to proceed through a failed gate and walks the captain through
each step, describing what it is about to do before it does it. The `docs/` guides
stay authoritative.

## First, check your environment

```sh
node scripts/cli.mjs doctor
```

Checks Node, `gh` auth, the `read:project,project` scope the board needs, push access
to all four repos a release touches and that your `react-native` checkout is not
shallow. Every failing check says how to fix itself.

`run` and `plan` call it automatically and refuse to start on a broken environment.
`--skip-doctor` overrides.

The shallow-clone check matters for the hand-run commands in `reference/`, several of
which use `git merge-base --is-ancestor`. On a shallow clone that returns a wrong answer
rather than an error. The scripted breaking-change scan does not use ancestry at all: it
reads the compare API and the changelog, because Meta's import rewrites SHAs and ancestry
gives false negatives across that boundary.

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
channel and edits it in place as the release proceeds. The publish step prints it with
the run link resolved, so you do not have to remember. Refresh it as steps land:

```sh
node scripts/cli.mjs message --series 0.88                  # refresh
node scripts/cli.mjs message --series 0.88 --run <run-url>  # pin a specific run
```

Ticks are **derived from live state**, not tracked by hand: open picks, branch CI, npm
publication, Maven artifacts, the rn-diff-purge diff, the changelog PR and whether the
GitHub release is still a draft. A step with no signal (verify template, communicate,
update the project) stays `:hourglass:` and is listed at the end for you to confirm.

It prints, it never posts. Generate it rather than copying the previous RC's, which is
how rc.2's draft carried rc.1's upgrade-helper link and four premature ticks.

## Verifying the template

```sh
node scripts/verify-template.mjs 0.88.0-rc.4
```

Builds a throwaway app on the published version for both platforms, run by the
`template-check` step after the publish is verified. It is the one release check
nothing else can infer and it reports which Hermes a consumer actually resolves.
See `reference/testing.md`.

## Assessing pick requests

```sh
node scripts/assess-picks.mjs 0.88
```

The `picks` step runs this and prints **ACCEPT**, **REJECT** or **ASK** per open
request, reading the request's own title and description for intent rather than the
commit subject. ASK is a real answer: it names the release crew rather than guessing,
and it fires on a watched surface, a large diff or a dependency bump. The signals are
evidence for a human judgement, never the judgement. Criteria in `reference/picks.md`.

## The release blog post

Every minor gets an announcement post in `react/react-native-website`. The crew
iterates on it, but the **first draft is the captain's** and it is due from the
**golden RC onwards** so there is time to review it before `.0`.

```sh
node scripts/draft-blog-post.mjs 0.88.0 --date <projected .0 date>
```

It reads the most recent release post from the website repo and follows its shape,
rather than carrying a template here that would rot. It fills in the commit count,
the contributor count and a ranked list to choose the acknowledgements from, and
leaves every editorial call as a `TODO`.

Review happens on a **Google Doc**, then the PR against the website repo is where
the final pass happens. The `blog-post` step prints the right path for where you
work. See `reference/blog-post.md`.

## Cutting a Hermes release

A Hermes cut is not tied to a branch cut. 0.88 needed one at rc.1 and again before
rc.3 and the RN release cannot proceed until the new pin lands, so it is its own
phase:

```sh
node scripts/cli.mjs plan --series 0.88 --shape hermes-release
node scripts/cli.mjs run  --series 0.88 --shape hermes-release
```

Seven steps: `hermes-preflight`, `hermes-cut`, `hermes-monitor`, `hermes-verify-tag`,
`hermes-pin`, `hermes-next-bump`, `hermes-push`. The pin is a local commit that
`hermes-push` pushes to the release branch. The next-version bump is printed as an
instruction, because the Hermes stable ref is protected and it has to go through a PR.

The gate that matters is `hermesReadyToCut`, because `RN Build Static Hermes` has **no
version input** and reads `npm/hermes-compiler/package.json` verbatim. A re-land is
named in the confirmation, since that is the last cheap moment to stop. Verifying the
tag means checking what it **contains**, not that it exists.

See `reference/hermes.md` for all three traps and their evidence.

## How it decides what to do

Nothing is stored between runs. Every invocation re-derives state from npm
dist-tags, git tags, the branch tip, branch CI, the open pick requests, the
release project board and `reference/schedule.json`. A persisted "we are on step
4" would go wrong the moment someone else pushed, so there isn't one.

From that it computes the series, the last published version, the next version,
and the release shape: `branch-cut`, `rc`, `promote` or `patch`. Each shape is a
list of steps in `scripts/phases.mjs`. The summary, the prompts and the runner
all read those same objects, so they cannot describe different releases.

## The golden RC

The golden RC is the last one before `.0`.

- **Released series:** derived exactly from tags.
- **In-flight series:** the skill assumes `expectedGoldenRc` from `reference/schedule.json`,
  currently **rc.5**. It labels that an assumption and never suggests moving it. Only the
  release captain changes it.

The spread across 0.82 to 0.87 (rc.5, rc.5, rc.5, rc.7, rc.3, rc.4) is why it is a
default rather than something derived.

Manual testing follows from it: RC0 and RC1 unconditionally, then the golden RC and the
stable release. Tags win over the assumption, so a released series is always answered from
what actually shipped.

## Modes

`plan` evaluates every gate against live state and executes nothing. `run` is guided:
every mutating action is described, then confirmed. **There is no unattended mode**,
and passing an unknown one throws rather than falling back. Gate failures hard-stop in
both. A release publishes state that cannot be taken back.

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

Once you confirm, it answers `Aye aye, Captain.` and runs. That is the only
decoration in the output, confined to acknowledgements so it cannot distort a
decision. Gate failures, commands and undo lines stay plain and a decline stays a
blunt `declined, stopping this step`. A test asserts it cannot leak.

The riskiest actions (publishing a version, cutting a release branch) ask the
captain to **retype the version or branch** rather than accept `y`.

## Gates

Preconditions are executable and block. Each prints why it failed, so the rationale
is in `scripts/gates.mjs` and `reference/field-notes.md` rather than repeated here.

| Gate | Blocks when |
| --- | --- |
| `branchShape`, `tagFree` | the branch or tag would trip the workflow's `if:` guards, giving a green run that did nothing |
| `tagFree` | the tag exists but npm does not have the version, so the release is half done |
| `dryRunExplicit` | the workflow's `dry-run` input is not explicitly false. It defaults to true |
| `distTagCorrect` | a prerelease would take `latest` |
| `ciGreen` | tip red or running, no runs found at all, a path-filtered workflow red on an earlier commit that never re-ran |
| `noOpenPicks` | any pick request for the series is still open |
| `noBreakingChanges` | new `[BREAKING]` commits in a non-breaking series or a truncated scan |
| `picksNotBreaking` | an open pick is annotated breaking or touches a watched surface |
| `hermesConsistent` | the two Hermes pin files disagree |
| `hermesCurrent` | the pinned Hermes tag is behind its branch |
| `hermesReadyToCut` | the Hermes branch still names a published version, which would re-cut it |
| `mainResolved` | a branch cut has no resolved SHA for main |

`classifyFailure` in `gates.mjs` encodes which CI failures are flakes and which are
structural. `ciGreen` does not call it, so classify by hand before retrying.

## Verify, never trust the tick

After publishing, confirm the tag exists on the remote and the version resolves on
npm's **per-version** endpoint. The full package document is CDN-cached and served
stale for `react-native`; it lied for several minutes during 0.88.0-rc.1.

A failed `post_publish`, a half-published release and the other publish-time traps
are in `reference/field-notes.md` with their signatures and remedies.

## Already automated, so do not do them by hand

The Podfile.lock bump, the changelog PR and the draft GitHub release are all produced
by the publish workflow. Curate them, do not create them. See
`reference/process.md` for the workflow chain.

## Reference

- `reference/process.md`: the workflow chain and prerequisites
- `reference/picks.md`: pick criteria, ordering, the board and the authorship check
- `reference/reverts.md`: how to scope a revert so it does not ship a second break
- `reference/changelog.md`: curation rules the generator does not apply
- `reference/hermes.md`: the coupling, the `latest-v1` rule and the timing trap
- `reference/testing.md`: which releases need manual testing
- `reference/blog-post.md`: the release post template, review flow and timing
- `reference/field-notes.md`: failures with their signatures and remedies
- `reference/schedule.json`: cadence and the golden-RC default

## Evals

```sh
node evals/run.mjs           # human-readable
node evals/run.mjs --md      # markdown, regenerates evals/REPORT.md
node evals/run.mjs --json    # machine-readable
```

Unit tests prove the code does what the code says. The evals prove it does what the
**release documentation** says. `evals/scenarios.json` holds the situations as data,
and the runner prints an agenda coverage matrix. A new step in `docs/` needs a row in
`AGENDA` or it is not counted.

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

Two steps are marked `metaOnly`, printed and delegated rather than attempted:
`bump-main` (`js1 publish` in fbsource) and `announce` (the GChat post). Curating the
changelog diff also needs Meta tooling, but that step runs no commands at all, so it
is a note rather than a flag. See `reference/changelog.md`.

The **Hermes cut is not in that list**. It is `gh workflow run` against
`facebook/hermes`, so it needs dispatch access to that repo rather than a Meta
machine and `doctor` checks exactly that. Run it through `plan --shape hermes-release`.

## Status

Used for a Hermes cut and two RCs of 0.88. A branch cut is two passes, because CI
cannot be green on a branch that does not exist yet: the first creates it, the second
publishes RC0. If you find a step it does not know, add it here and add a row to
`AGENDA` in `evals/run.mjs` so the gap is counted.

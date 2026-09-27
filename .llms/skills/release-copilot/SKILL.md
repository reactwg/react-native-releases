---
name: release-copilot
description: Run a React Native release end to end. Use when cutting a branch, publishing an RC, promoting to stable or shipping a patch and when asking where a release currently stands or why its CI is red. Derives live state, gates every step and confirms every mutating action with the release captain before running it.
---

# Release co-pilot

An executable runbook for a React Native release. It derives where the release
actually is, refuses to proceed through a failed gate and walks the captain through
each step, describing what it is about to do before it does it. It carries the
process itself: a step should never need a guide open next to it.

## First, check your environment

```sh
node scripts/cli.mjs doctor
```

Checks Node, `gh` auth, the `read:project,project` scope the board needs, push access
to all four repos a release touches and that your `react-native` and `hermes` checkouts
exist and are not shallow (`--checkout`, `--hermes-checkout`, or `RN_CHECKOUT` and
`HERMES_CHECKOUT`). Every failing check says how to fix itself.

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

## Investigating picks

A pick request makes claims: it is a fix, it already landed on main, the port is the
same change, it only touches an opt-in feature, it needs no migration. Before anyone
decides, the copilot checks every claim against evidence.

```sh
node scripts/investigate-pick.mjs 0.88              # every open pick
node scripts/investigate-pick.mjs 0.88 --pick 1457  # one, with the stack below it
```

`plan` and `run` gather the same evidence and print it at the `picks` step. For each
pick it reports every claim as **CONFIRMED**, **CONTRADICTED** or **UNVERIFIED**, plus
**FLAG** for facts to weigh that nobody claimed (two days on main, a build-flag change).

| Check | What it rests on |
| --- | --- |
| identity | the commits the pick adds, stacks resolved to their own commits |
| on-main, soak | the main commit, how long it has been there and any revert since |
| follow-ups | later main commits on the same files, in case the pick needs one of them too |
| fidelity | `git patch-id` of the port against the main commit, and whether the request admits a difference |
| kind | what the request calls it against the commit's own changelog line |
| reach | which surface each file is in (`reference/surfaces.json`) and whether anything outside an opt-in surface imports it, with the preview's own statement read from the branch |
| breaking | `[BREAKING]` tags, watched surfaces and "users must change their setup", weighed against reach |
| review, ci | GitHub reviews or the Phabricator `Reviewed By` on the main commit, and the PR's checks |
| applies | a trial `cherry-pick` onto the branch tip in a throwaway worktree, stacks in order |

The first-read verdict from `assess-picks.mjs` is still shown next to each pick. It is a
keyword lean, not a check.

**What the agent does with it.** For each pick:

1. Read the findings. Everything not CONFIRMED is a question to answer, not a verdict.
2. Dig until it is answered: read the diff, the linked issue, the main commit and any
   follow-up it lists. Read a failing check's log before calling it unrelated.
3. Draft **PICK** or **DROP** with the version it moves to, in two or three sentences
   that cite the evidence. For a stack, draft where to cut it.
4. Put the drafts to the captain. Act only on the captain's decision.

**Acting on the decision.** Both commands are guided: every mutating step is shown in
full and confirmed. `--dry-run` prints them only.

```sh
node scripts/cli.mjs pick --series 0.88 --pick 1449
node scripts/cli.mjs drop --series 0.88 --pick 1457 --to 0.89.0 --reason reason.md
```

`pick` cherry-picks the pick with `-x`, a stack from the bottom, checks the commits kept
their original authors, pushes once the captain retypes the branch and closes each
request with the SHA it landed as. It refuses a `[BREAKING]` pick in a non-breaking
series and a stacked pick whose base is not a candidate.

`drop` posts the reason on the pick request, closing it for `--to never`. The comment
ends with a marker naming the version it was not picked for and where it goes. That
comment is the record: the copilot reads it back, so the pick stops blocking this
release and comes back for the version it moved to. Only markers from members and
collaborators count. Write the reason for the author: what was found and what would
change the answer.

Pick criteria, ordering and the authorship check are in `reference/picks.md`.

## The release blog post

Every minor gets an announcement post in `react/react-native-website`. The crew
iterates on it, but the **first draft is the captain's** and it is due from the
**golden RC onwards** so there is time to review it before `.0`.

```sh
node scripts/draft-blog-post.mjs 0.88.0 --date <projected .0 date>
node scripts/check-blog-post.mjs 0.88     # before merging: dated the day it goes live
```

It reads the most recent release post from the website repo and follows its shape,
rather than carrying a template here that would rot. It fills in the commit count,
the contributor count and a ranked list to choose the acknowledgements from, and
leaves every editorial call as a `TODO`.

Review happens on a **Google Doc**, then the PR against the website repo is where
the final pass happens. The `blog-post` step prints the right path for where you
work.

The post is dated **the day it goes live**, not the projected date it was drafted with
and not the `.0` publish date. 0.88's post went live dated three days in the future. The
date sits in the filename, `date:` and every Highlights link. The `blog` step stops if
they disagree or are not today. The X thread links the post, so the `social` step
merges the post and posts the thread together. See `reference/blog-post.md`.

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

Whether a cut is worth it depends on what the unreleased commits are, so `plan` and
`run` classify each one from its diff on the stable branch, not its message, using the
local Hermes checkout. A commit that only adds functions nothing on the branch calls is
**inert**, whatever its message says, and one whose message names platforms its diff
does not touch is called out. A graft can carry only part of its original.

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

- **Released series:** derived from tags, unless `goldenByContent` says otherwise.
- **In-flight series:** the golden RC is decided by CONTENT, not by a number. The last RC
  that carried a real change was the golden one. `expectedGoldenRc` in
  `reference/schedule.json` is only a planning prior for projecting dates. rc.4 is the
  usual golden, but history varies (0.82 rc.5, 0.83 rc.5, 0.84 rc.5, 0.85 rc.7, 0.86 rc.3,
  0.87 rc.4, 0.88 rc.4).
  The `rcHasContent` gate enforces the real rule: if nothing substantive landed since the
  last RC then that RC was golden and the next action is `--shape promote` to stable, not
  another RC. Cut another RC only when a critical fix still has to be picked.

The spread is why it is a default rather than something derived.

An RC cut **after** golden is exceptional. 0.88 ended at rc.6 by tag: rc.4 was golden, rc.5
shipped with nothing in it, then rc.6 carried a single pick. A released series records
that as `goldenByContent` in `schedule.json`, so the history shows `0.88:rc.4 (last rc.6)`
and does not read as a series that needed six RCs.

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
              triggers the Podfile.lock bump and a draft GitHub release
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
| `rcHasContent` | an RC with nothing in it: the previous RC was golden, promote instead |
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

The Podfile.lock bump and the draft GitHub release are produced by the publish workflow.
Do not create them by hand. The changelog PR is the copilot's own `changelog` step, except
on a release branch whose publish workflow still has the `generate_changelog` job, where
the bot opens it. See `reference/process.md` for the workflow chain.

## Reference

- `reference/process.md`: the workflow chain and prerequisites
- `reference/picks.md`: pick criteria, ordering, the board and the authorship check
- `reference/reverts.md`: how to scope a revert so it does not ship a second break
- `reference/changelog.md`: opening the changelog PR, what curation does on its own (with its measured precision) and what is left for a human
- `reference/hermes.md`: the coupling, the `latest-v1` rule and the timing trap
- `reference/testing.md`: which releases need manual testing
- `reference/blog-post.md`: the release post template, review flow and timing
- `reference/field-notes.md`: failures with their signatures and remedies
- `reference/schedule.json`: cadence and the golden-RC default
- `reference/todo.md`: work the copilot still needs, with when to do it

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

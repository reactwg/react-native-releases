# Pick requests

Changes reach a release branch from `main` by cherry-pick or by a PR against the
branch. Release branches do not take direct feature PRs.

## Default to cherry-pick and push

Even when a PR already targets the release branch, the normal route is to cherry-pick
its commit with `-x` and push, rather than merging the PR:

```sh
git fetch origin pull/<n>/head:pr-<n>
git cherry-pick -x <sha>
```

Reasons: the branch has usually moved on since the PR was opened, `-x` records the
origin in the commit message so provenance survives, authorship is preserved and the
history stays consistent with the other release-branch commits. Then comment on the
PR saying it was imported manually and close it.

Merging the PR is not wrong, but it is the exception and on a protected release
branch it needs approvals the cherry-pick route does not.

## Open the pick request before you push

For anything beyond a trivial pick, file the request **first**, with the reasoning in
the body, then pick, then close it with the resulting SHA.

The request is where the *why* lives: which criteria it passes under, what the scope
analysis found, what was deliberately left out. Written after the fact it degrades
into "picked as abc123", which tells a future reader nothing. This matters most for
reverts and for anything applied to the release branch with no counterpart on `main`.

## Before picking

The change must be on the release project board first. The board is **Projects v2
at the org level**, not a classic repo project:

```
https://github.com/orgs/reactwg/projects/<n>     "React Native <series> Releases"
```

`github.com/reactwg/react-native-releases/projects` is empty by design and will
make you think nothing is tracked. Issues labelled `Type Pick Request` are added
automatically and closing an issue moves it to Done / Picked.

```sh
gh project list --owner reactwg --limit 50
gh project item-list <n> --owner reactwg --limit 200 --format json
```

## Criteria

Accepted:

1. Fixes for regressions to core APIs
2. Fixes to bugs in core React Native
3. Fixes to APIs used by third-party libraries and out-of-tree platforms
4. Patch-version dependency bumps
5. Security fixes
6. Fixes and reverts of accidental breaking changes
7. Performance improvements
8. **Anything at all while the release is still on RC0**

Not accepted after RC1:

9. Breaking changes
10. New features
11. Major or minor dependency bumps
12. Pre-release dependency versions
13. Changes to testing infrastructure
14. Multi-commit picks with several merge conflicts
15. Non-critical improvements
16. Nice-to-haves

Criterion 8 is the one people forget: during RC0 the bar is open and it tightens
sharply at RC1.

## Ordering

Pick in **dependency order**, not the order the requests were filed and not
chronological order on `main` unless that happens to match.

Read each commit's own summary. A commit that says "this was blocked until X
landed" depends on X even when the request does not mention it. Two requests filed
independently can still be a chain.

Verify against the branch rather than trusting the request:

```sh
git merge-base --is-ancestor <sha> origin/<branch> && echo present || echo missing
```

A SHA cited in a request may not be on `main` at all. Meta's import flow lands
commits under different SHAs and export branches carry SHAs that never reach
`main`.

## Conflicts

A clean pick in the right order is the signal that the order was right. If a pick
conflicts, check whether a prerequisite is missing before hand-resolving. Resolving
a conflict by writing calls to functions the branch does not have produces code
that parses and fails at runtime.

## Set Target Release when you close, not when you open

The board's `Target Release` defaults to the series' first RC when an issue is
auto-added and nothing updates it when the pick actually lands. Left alone it is
wrong for almost every item: on 0.88, **seven of eleven** were still marked
`0.88.0-rc.0` despite every one of them shipping in rc.1, because the requests were
all filed after rc.0 had already gone out.

Set it as part of closing, from where the commit actually landed rather than from
when the request was filed:

```sh
git merge-base --is-ancestor <sha> v0.88.0-rc.1 && echo "shipped in rc.1 or earlier" || echo "ships in the next RC"
```

A pick pushed after the last tag ships in the **next** RC, not the current one.

## Describe a pick as what it is, not as what it resembles

The heading a reader skims decides whether they look closer. Group a pick by its
risk, not by the shape of its diff.

**A re-land is not a fix.** A commit whose subject is `Back out "Back out ..."`
puts a previously reverted change back into the release. Its risk profile is the
opposite of a fix: something was wrong enough to revert it once and the question
is whether that has actually been resolved. Filing it under a "fixes" heading
means a reviewer skims "two fixes, good" and approves the riskiest thing in the
release.

Give it its own section, use the real commit subject rather than the original
change's friendlier title and state the chain: what landed, what backed it out
and why, what re-lands it. Then say whether the stated mitigation was verified.

This happened on `260318099.0.4`. `ace586d90` was twice described as "Avoid
unnecessary rescans of VariableScopes", which is the title of the *original*
change, making a revert-of-a-revert read like a routine optimisation. It is the
only risky commit in that release.

The same applies to a revert, a partial pick or anything carried for bookkeeping.
Label it so the reader's first guess is right.

## Closing

Comment with where it landed, then close:

```
Picked manually into `0.88-stable` as <sha>.
```

Closing moves the board item to Done / Picked.

For a change applied directly to the release branch with no counterpart on `main`,
file the request anyway as a record and say plainly in the body that it is
deliberate and why. Undocumented divergence between a release branch and `main` is
the thing nobody can reconstruct later.

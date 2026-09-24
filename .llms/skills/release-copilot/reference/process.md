# Process reference

Step detail behind the phase definitions in `scripts/phases.mjs`. The phases are
the executable spec; this file is the prose a human needs when a step is not
obvious.

## The workflow chain

One dispatch drives the whole publish:

1. **Create release** (`create-release.yml`), dispatched on the release branch with
   `version`, `is-latest-on-npm`, `dry-run`. It sets versions, commits, and pushes
   the branch with `--follow-tags`, creating `v<version>`.
2. The tag push matches `v0.*.*` and fires **Publish to npm**
   (`publish-npm.yml`), the single entry point for npm OIDC trusted publishing.
3. That calls **bump-podfile-lock** (`bump-podfile-lock.yml`), which regenerates
   `packages/rn-tester/Podfile.lock` and commits `[LOCAL] Bump Podfile.lock`.
4. It also generates the changelog PR and a draft GitHub release.

So after one dispatch you curate outputs rather than creating them.

## branch-cut (RC0)

1. **External dependencies table.** Add a column for the new RC in
   `docs/support.md`. Open a PR rather than committing to `main`, the repo
   notifies watchers.
2. **Create branches.** `X.Y-stable` in `react/react-native`, plus the matching
   branch in `react-native-community/template`. Tell the `#cli` Discord channel:
   they must bump `@react-native-community/cli` and its compatibility table
   **before RC1**.
3. **Hermes.** Publish the Hermes release and land the version bump on the branch.
   Do not continue until the branch carries it. See `hermes.md`.
4. **Nightly.** Trigger one from `main` before release-specific fixes land, so
   partners integrating with nightlies get a clean one.
5. Then the common publish path.
6. **Bump `main`.** `js1 publish react-native 0.<next>.0-main` in fbsource. Meta
   only.

## rc

1. **Picks.** See `picks.md`. Dependency order, board first.
2. **Testing.** See `testing.md`. Manual only for RC0, RC1 and golden.
3. Then the common publish path.

## promote

The common publish path targeting `X.Y.0` with `is-latest-on-npm=true`, then:

1. **Support policy table** in `facebook/react-native-website`,
   `website/src/components/releases/_releases-table.md`. Shift every row down one.
2. **Blog post.**
3. **Cut a new website version.** Merge the release-candidate PRs first.

## patch

Same as `rc` but on a stable series, with stricter pick criteria and `latest`
handling. A patch on the newest stable line takes `latest`; a patch on an older
line does not.

## Common publish path

1. **Pre-flight.** All gates. Hard stops.
2. **Create the release.** One workflow dispatch.
3. **Verify.** Tag on the remote, version on npm's per-version endpoint, dist-tags
   moved as intended. Never conclude from the workflow conclusion alone.
4. **Changelog.** Curate the generated PR. See `changelog.md`. It lands on `main`.
5. **GitHub release.** Publish the draft. Pre-release for an RC, Latest for a
   stable on the newest line.
6. **Announce.** Discord `#release-coordination`, then the Workplace group (Meta
   only).
7. **Board.** Close actioned picks, which moves them to Done / Picked.

## Keeping the crew informed

A progress message in `#release-crew`, updated in place, works well: ⌛ started,
✅ complete, 🚨 problem. One line per step of the common publish path.

## Prerequisites

Write access to `react/react-native`, `react-native-community/template`,
`facebook/hermes` and `reactwg/react-native-releases`. Plus `gh auth login`, and
`gh auth refresh -s read:project,project` for the board.

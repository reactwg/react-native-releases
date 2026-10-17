# Changelog curation

`publish-npm.yml` opens a `changelog/v<version>` PR against `main`. It is a
starting point, not a finished section. The generator emits scaffolding the
published changelog never contains.

## A `.0` publishes ONE section, not one per RC

The RCs each leave a `## vX.Y.0-rc.N` heading. The stable release replaces all of them
with a single `## vX.Y.0`. 0.88 had 171 entries across five RCs, so do not merge by hand:

```bash
node scripts/combine-changelog.mjs 0.88
```

It reads `CHANGELOG.md` from `origin/main` (entries land on main, so a working tree can
be days stale), parses, dedupes by commit sha, sorts alphabetically by scope and omits
empty sections. It writes nothing: the output is a block to paste over the per-RC
sections. Once main already carries the single `## vX.Y.0`, it says so and stops.

**There is no generated PR for a `.0`.** `generate-changelog.yml` logs "Skipping changelog
generation for X.Y.0 as we already have it from the RCs" and the job goes green. So the
consolidation is a change you open on main yourself. For 0.88 that was
[#59122](https://github.com/react/react-native/pull/59122), landed the day after `.0`
shipped. Open it before publishing the GitHub release, since the release notes come
from it.

What it CANNOT decide and reports as TODOs:
- entries with no `**Scope**:` prefix
- entries that look internal
- a package bumped more than once, where only the last should survive
- anything in the `Unknown` bucket

Both `**Scope**: text` and `**Scope:** text` are real in published changelogs and both
count as prefixed.

## When there is nothing to record, close the PR

A release that picked nothing still gets a changelog PR: `generate-changelog.yml` is a
`workflow_call` fired unconditionally by the publish workflow, so it cannot be skipped
from the release side.

If the only commits since the previous release are the release commit and the
Podfile.lock bump, **close the PR instead of curating it**. Merging it adds a version
heading with no entries under it, which is noise for the next person reading the file.
The `changelog` step detects this and prints a comment to paste.

0.88.0-rc.5 was the first of these: golden RC, nothing picked, Hermes pin unchanged, so
every section came out empty.

## What the generator gets wrong

**Empty sections.** It emits `Breaking`, `Added`, `Changed`, `Deprecated`,
`Removed`, `Fixed`, `Security`, each with `#### Android specific` and
`#### iOS specific`, whether or not they have content. Published sections omit
empty ones entirely.

**An `Unknown` bucket**, plus `#### Android Unknown`, `#### iOS Unknown` and
`#### Failed to parse`. `Unknown` collects commits that landed without a
`Changelog:` entry; `Failed to parse` collects ones whose entry it could not read.
Neither belongs in the published section, but you cannot just delete them, see
below.

**No scope prefix.** It writes the raw changelog line. Published entries lead with
a bold scope.

## The conventions it does not apply

Take the immediately preceding section as the model, not an older release, since
style drifts.

```markdown
## v0.88.0-rc.1

### Added

- **EventTarget**: Enable the imperative EventTarget API on native view refs in canary ([8480b86820](https://github.com/react/react-native/commit/8480b86820b4535c9bec2967a0f16afed5292a0e) by [@rubennorte](https://github.com/rubennorte))

### Changed

- **Events**: Enabled Web-based event dispatching refactor ([31d33ce91b](...) by [@rubennorte](...))
- **Hermes**: Bump Hermes to 260318099.0.3 ([79024f7c59](...) by [@fabriziocucci](...))

### Fixed

#### iOS specific

- **Codegen**: No longer crawls `node_modules` or follows symlinks when discovering components ([39751d864d](...) by [@gabrieldonadel](...))
```

- `- **Scope**: Description ([shortsha](full-commit-url) by [@user](profile-url))`
- Alphabetical by scope within each section
- Omit empty sections and empty platform subsections
- Short SHA in the link text, full SHA in the URL

## Triage the `Unknown` bucket, do not delete it

Most entries there are release plumbing and should go:

- `Release 0.88.0-rc.1`
- `[LOCAL] Bump Podfile.lock`
- internal test fixes with no user-facing effect

But some are genuinely user-facing and only landed in `Unknown` because their
commit lacked a `Changelog:` line. A Hermes bump is the recurring example and it
is usually the single most significant change in the release. It belongs under
`Changed`:

```markdown
- **Hermes**: Bump Hermes to 260318099.0.3 (...)
```

Deleting the whole bucket loses it silently. Read every entry before dropping it.

## Other rules

- Drop anything tagged `[Internal]`, plus BUCK-file and pure-refactor commits.
- Collapse superseded dependency bumps. If X went to 0.7.0 and later to 0.8.0 in
  the same release, keep only 0.8.0.
- For a large section (RC0 or a `.0`), a link to `CHANGELOG.md` at the bottom of
  the GitHub release is enough; the full text does not need repeating there.

## How to actually edit it

The generator opens a PR against `main`. Do not push commits to that PR: import it
and edit the diff, which is the normal Meta flow for a PR we intend to fix
ourselves rather than send back.

```sh
# 1. the import usually happens on its own. Confirm it and get the D number:
gh pr view <pr> --repo react/react-native --json statusCheckRollup \
  --jq '.statusCheckRollup[] | select(.name|test("Import";"i")) | .detailsUrl'

# 2. the diff should sit in "Changes Planned" while you iterate, not "Needs
#    Review". That is the signal to reviewers that you are still editing it.
#    The changelog import lands there already; check rather than assume.
meta phabricator.diff describe --number=D<n>   # expect: Changes Planned

# 3. edit in your checkout
sl goto <commit>          # the commit_hash from the diff
jf sync                   # pull the real PR content over the import stub
#    ... curate CHANGELOG.md ...
sl amend
jf submit                 # add --update-fields if you changed the summary too

# 4. move it back for review, then land
```

Two traps. Plain `jf submit` updates the code but leaves the old summary, so pass
`--update-fields` when the description changed. And check the rendered section
against the previous release before landing, since the diff alone hides ordering
mistakes.

The changelog goes on `main`, not the release branch.

## The same text goes in the GitHub release

The draft release the workflow generates has the dSYM links, the pick-request link
and the Upgrade Helper boilerplate, but its notes section is **empty**. The
`github-release` step fills it from the landed section, so the release page and
`CHANGELOG.md` say the same thing:

```sh
node scripts/fill-release-notes.mjs <version> --dry-run
node scripts/fill-release-notes.mjs <version>
```

It refuses to overwrite notes that are already on the draft and differ. It always sends
`tag_name`. A body-only update on the 0.88.0 draft detached it from `v0.88.0`, after
which `gh release view v0.88.0` could not find it. A draft is also not reachable through
`releases/tags/<tag>`, which is why the script lists releases and matches by name.

Keep the generated boilerplate as-is: its dSYM URLs already carry the right version
and the right Hermes version. Editing the notes leaves the release a draft, so
publishing it stays a separate deliberate step.

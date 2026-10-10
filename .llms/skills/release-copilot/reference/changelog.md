# Changelog curation

`publish-npm.yml` opens a `changelog/v<version>` PR against `main`. It is a
starting point, not a finished section. The generator emits scaffolding the
published changelog never contains.

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
and the Upgrade Helper boilerplate, but its notes section is **empty**. Paste the
curated section in above that boilerplate, so the release page and `CHANGELOG.md`
say the same thing:

```sh
gh release view v<version> --repo react/react-native --json body --jq '.body' > /tmp/cur.md
# prepend the curated section, keep the boilerplate verbatim
gh release edit v<version> --repo react/react-native --notes-file /tmp/body.md
```

Keep the generated boilerplate as-is: its dSYM URLs already carry the right version
and the right Hermes version. Editing the notes leaves the release a draft, so
publishing it stays a separate deliberate step.

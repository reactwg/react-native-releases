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
commit lacked a `Changelog:` line. A Hermes bump is the recurring example, and it
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
- For a large section (RC0, or a `.0`), a link to `CHANGELOG.md` at the bottom of
  the GitHub release is enough; the full text does not need repeating there.

## Landing it

The changelog goes on `main`, not the release branch. A Meta engineer imports the
PR, gets the diff accepted and lands it. Check the rendered section against the
previous one before landing, since the diff alone hides ordering mistakes.

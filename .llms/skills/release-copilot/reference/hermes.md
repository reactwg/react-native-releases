# Hermes

Hermes is released separately and pinned by React Native. The Hermes release must
happen **before** the RN release that consumes it.

## Where the version lives

Two files on the release branch and they must agree:

```
packages/react-native/sdks/hermes-engine/version.properties   HERMES_VERSION_NAME=...
packages/react-native/package.json                            dependencies["hermes-compiler"]
```

On `main`, `hermes-compiler` is the `0.0.0` placeholder. On a release branch it is
the real version. Do not copy a main-side bump onto a release branch.

`packages/rn-tester/Podfile.lock` also pins `hermes-engine` with a checksum, but
the publish workflow regenerates it. See field-notes.

Gate `hermesConsistent` checks the two files agree.

## Branch naming

The Hermes stable branch is named after its first version and carries the whole
patch line. `260318099.0.0-stable` holds `.0.0`, `.0.1`, `.0.2` and so on. Tags are
`hermes-v<version>`.

React Native 0.87 consumed the `250829098` line; 0.88 moved to `260318099`.

## The version bump goes through a PR, always

`RN Build Static Hermes` has **no version input**. It reads the version verbatim from
`npm/hermes-compiler/package.json`:

```js
// utils/scripts/hermes/version-utils.js
async function getMainVersion() {
  const packageJson = JSON.parse(await fs.readFile('npm/hermes-compiler/package.json'));
  return packageJson.version;
}
async function getVersion(buildType) {
  if (buildType === 'dry-run') return `${mainVersion}-${shortCommit}`;
  return mainVersion;              // release: verbatim
}
```

So the file must already name the version you want before you dispatch. Dispatching
while it still names the released version re-cuts that version. Check it first:

```sh
curl -s https://raw.githubusercontent.com/facebook/hermes/<branch>/npm/hermes-compiler/package.json \
  | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])"
```

**Propose a PR for the bump, never a direct push.** The stable branches are protected and
the remote rejects it outright:

```
remote: - Changes must be made through a pull request.
remote: - Cannot update this protected ref.
```

Every previous bump went the same way (`.0.1` #2102, `.0.2` #2110, `.0.3` #2178). A
feature branch pushes fine; only the stable ref is protected.

Convention, from those three: title `Bump hermes-compiler version to <version>`, summary
noting that the file should point at the **next** version to publish. Which means the
bump is really the tail of the previous release, so if it is still on the released
version, the last release skipped its follow-up.

## Releasing

Workflow: **RN Build Static Hermes** (`rn-build-hermes.yml`), dispatched on the
Hermes stable branch.

```sh
gh workflow run "RN Build Static Hermes" --repo facebook/hermes \
  --ref 260318099.0.0-stable \
  -f release-type=release \
  -f update-latest-v1=true
```

Inputs:

- `release-type`: `release` or `dry-run`, **defaults to `dry-run`**
- `update-latest-v1`: boolean, **defaults to false**

The in-tree version in `npm/hermes-compiler/package.json` decides what gets cut, so
bump it before releasing.

## The `latest-v1` rule

Tick `update-latest-v1` only when the version being published should be the latest
for its line:

- **Never** from the `25xxxx` line.
- **From the `26xxxx` line, yes**, while it is the newest line.
- **Exception:** if a newer minor exists (say `26xxxx.1.0`) and you are patching an
  older one (`26xxxx.0.3`), that patch is not latest.

Check the live dist-tags rather than assuming:

```sh
npm view hermes-compiler dist-tags
```

`latest-v1` tracks the current line, `latest` tracks the older one. Both being
present is normal.

## Timing trap

A tag cut before a fix lands does not contain it and nothing in the version number
says so. `hermes-v260318099.0.2` was tagged eight hours before a crash-causing
change was backed out, so `.0.2` shipped the bad version while the branch was
already clean.

Before pinning a Hermes version, confirm the **tag** contains what you expect, not
just the branch:

```sh
git merge-base --is-ancestor <fix-commit> hermes-v<version> && echo in || echo NOT in
```

## Picks

Hermes picks are Meta-only. Flag them to a Meta release crew member rather than
attempting them. A Hermes pick blocks the RN release until the branch carries the
resulting bump.

Watch for the two-sided pattern: a JSI declaration and its Hermes implementation
are separate commits and picking only the declaration leaves the API resolving to
the base implementation with no error at all.

## The upstream copy

`static_h` is the source the next `stable` sync pulls from. A fix backed out of
`stable` but left in `static_h` returns on the next promotion. When a back-out
names `static_h` as a follow-up, that follow-up is load-bearing.

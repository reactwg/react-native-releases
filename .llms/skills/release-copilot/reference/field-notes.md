# Field notes

Failures that cost real time, with the signature to recognise them by and what to
do. None of these are in the release guides. Most were learned during 0.88.

---

## A green workflow run that did nothing

**Signature:** `Create release` completes `success`, but no tag appears and npm is
unchanged.

`create-release.yml` guards its publish steps with `if:` on two conditions:

- the branch matches `^0\.[0-9]+-stable$`
- the tag `v<version>` does not already exist

A failed guard **skips the step and the run still goes green**. The conclusion is
indistinguishable from a real release.

**Do:** check both preconditions before dispatching and confirm the tag exists on
the remote afterwards. Both are gates in this skill (`branchShape`, `tagFree`).

---

## `dry-run` defaults to true

**Signature:** same as above, a green run that published nothing.

The `dry-run` workflow input **defaults to `true`**. Omitting it gives you a
rehearsal, not a release.

**Do:** always pass `-f dry-run=false` explicitly. Gate: `dryRunExplicit`.

---

## `post_publish` fails while the publish succeeded

**Signature:**

```
FAILED: Verify Release is on NPM
##[error]The action 'Verify Release is on NPM' has timed out after 3 minutes.
```

The publish worked. The verifier gave npm three minutes to reflect it and npm took
longer. Riccardo hit the same thing on 0.88.0-rc.0.

**Do:** read the `publish_react_native` job log and look for:

```
npm notice Publishing to https://registry.npmjs.org/ with tag next
+ react-native@<version>
```

If that line is there, the release happened. Do not re-run the publish.

---

## npm says the version does not exist, but it does

**Signature:** `npm view react-native@<v>` 404s and `dist-tags` still shows the
previous version, minutes after a confirmed publish.

The full package document at `https://registry.npmjs.org/react-native` is large and
heavily CDN-cached. It serves stale for a while.

**Do:** query the per-version endpoint, which is authoritative:

```sh
curl -s -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/react-native/<version>
```

`200` means published, whatever the cached document says. The state deriver uses
this endpoint for exactly this reason.

---

## Podfile.lock is bumped for you

**Signature:** you are about to hand-commit a `Podfile.lock` update after a Hermes
bump.

`publish-npm.yml` calls `bump-podfile-lock.yml`, which deletes the lockfile, runs
`pod install` on macos-15 and commits `[LOCAL] Bump Podfile.lock`. It runs on the
version tag push.

**Do:** nothing. A hand-committed bump is churn the bot overwrites. Regenerating it
locally is also unreliable: `pod install` on a release branch can fail in codegen
before it gets that far.

---

## Resuming a half-published release

**Signature:** the tag `v<version>` exists, npm does not have `<version>` and the
sibling packages (`@react-native/metro-config`, `gradle-plugin`, `codegen`) ARE
published at it.

One push fires TWO runs of `Publish to npm`, because Create Release pushes with
`--follow-tags` and the workflow triggers on both tag and branch:

```
ref=<branch>        mode=bumped-packages  -> publishes the siblings
ref=v<version>      mode=release          -> publishes react-native
```

If the tag-ref run dies, the branch-ref run still goes green having published the
siblings, so the run list looks half-healthy and npm has an orphaned version set.
Those orphans are inert, since nothing resolves them without the matching
`react-native`, so they are not worth cleaning up.

**Do:** re-run the TAG-ref run, not Create Release. `tagFree` now names this case
explicitly rather than just refusing.

**Do NOT use `gh run rerun --failed` here.** `build_android` creates a Sonatype
staging repository and uploads the Android artifacts into it, then cleanup drops it
when the publish fails. `--failed` skips `build_android` because it already
succeeded, so `publish_react_native` re-runs with nothing to publish from:

```
Execution failed for task ':findSonatypeStagingRepository'.
> No staging repositories found for stagingProfileId: com.facebook,
  descriptionRegex: react-native:v<version>:github-run-<run-id>
```

A full `gh run rerun <id>` is the remedy. It re-runs `build_android`, which
recreates the staging repo and the run id is unchanged so the description still
matches. Costs the full ~2h Android build.

---

## `build_android` lint crashes at random

**Signature:** `lintAnalyzeDebug FAILED`, with lint saying so itself:

```
Unexpected failure during lint analysis
  (this is a bug in lint or one of the libraries it depends on)
  Error while resolving ...LLFirPartialBodyResolveTarget
  KotlinIllegalArgumentExceptionWithAttachments
```

This is lint crashing inside the Kotlin FIR analysis API, not a lint finding
against your code. It is non-deterministic: on 0.88.0-rc.4 the SAME commit passed
`build_android` on attempts 1 and 4 and crashed on attempt 3, naming a file the
release had not touched.

**Do:** re-run once before investigating. Prove it is a flake by checking whether
that job already passed on the same SHA, which is stronger evidence than the file
it names. If it fails twice on the same commit, stop treating it as flake.

---

## Stale job results after a partial rerun

**Signature:** a run shows some jobs green and others red and the red ones have an
old `startedAt`.

Re-running a single job creates a new attempt. Jobs not re-run keep their previous
attempt's result and look current.

**Do:** compare `startedAt` against the rerun time before believing a red job.
Rerunning one job also invalidates the other job IDs from the earlier attempt, so
re-run them together or take them in sequence.

---

## A red job that is not your fault

Two recurring shapes, both retryable:

**rubygems DNS**

```
Gem::RemoteFetcher::UnknownHostError no such name (https://rubygems.org/gems/<x>.gem)
```

Runner networking. Retry.

**Missing artifact**

```
Unable to download artifact(s): Artifact not found for name: RNTesterApp-NewArch-Debug
```

The job that produces the artifact failed, so its upload steps were **skipped**.
Fix the upstream build job, not this one. Retrying this job alone cannot work.

Anything not matching a known signature is **not** auto-retryable. Classify it
first. `scripts/gates.mjs` encodes these.

---

## A test that cannot pass on a release branch

**Signature:** `test_js` fails on one assertion, on every run, on the release
branch only, while `main` is green.

`cache-key-test.js` asserted behaviour that only holds when the package version
ends in `-main`. It was added five days before the 0.88 cut, so 0.88 was the first
branch to inherit it and it was red from rc.0.

**Do:** treat a failure that reproduces on the pre-change commit as structural.
Structural failures are never fixed by retrying. This particular one is fixed, but
the shape recurs: a test written against `main` semantics with no version guard.

---

## A change that spans two repos

The most expensive pattern of the cycle. It happened four times:

| Change | Landed | Missed |
| --- | --- | --- |
| React 19.3 sync | `react/react-native` | `react-native-community/template` react pin |
| Hermes JSI batch | JSI declarations | Hermes implementations |
| Same batch again | 6 impl commits | 4 SynthTrace commits |
| SPM deployment target | the fix | its two prerequisites |

Symptoms differ (ERESOLVE, silent `any`, incomplete traces, a conflicting pick) but
the cause is identical: only one side of a two-sided change got picked.

**Do:** when picking, ask what else had to change for this to work and where that
lives. Check the template repo and Hermes explicitly, since neither is in
`react/react-native` and neither shows up in its CI until something breaks.

---

## The template repo is branch-matched

`scripts/e2e/init-project-e2e.js` clones `react-native-community/template` at run
time and checks out the branch matching the release branch. It rewrites only the
`@react-native/*` scoped dependencies and `react-native` itself. It never rewrites
`react`.

So the `react` pin on the template's release branch has to be correct on its own. A
mismatch surfaces as `ERESOLVE` in all four template e2e jobs at once, before any
platform-specific work.

Because the clone happens at run time, fixing the template repo makes a **rerun**
of the existing RN job pass. No new RN commit is needed.

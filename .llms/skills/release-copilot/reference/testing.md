# Release testing

## Which releases get manually tested

Only these:

- **RC0**
- **RC1**
- **the golden RC**, meaning the last one before `.0`
- **stable** `.0` and patches on the latest line

Everything else needs no manual pass. One release crew member is enough.

The golden RC number is **not derivable in advance**. Measured from tags it landed at
rc.5, rc.5, rc.5, rc.7, rc.3 then rc.4 across 0.82 to 0.87. For a released series
`status` derives it from tags. For one in flight it assumes `expectedGoldenRc` from
`schedule.json`, currently rc.5, labels that an assumption and never suggests moving
it. Only the captain changes it.

## E2E must be green regardless

Independent of manual testing, the E2E jobs on the release branch must be green
before publishing. These are the ones that catch template and integration breakage
that unit tests miss.

```
test_e2e_ios_templateapp / test (Debug|Release)
test_e2e_android_templateapp / test (debug|release)
test_e2e_ios_rntester / test (Debug|Release)
test_e2e_android_rntester / test (debug|release)
```

Two things to know when reading them:

**The template jobs can be skipped.** They do not always run on every commit. A
green run with the template e2e skipped is not evidence the template works. Check
they actually ran.

**The `*_retry_*` variants being skipped is the good case.** They only run when the
first attempt failed. A skipped retry means the first attempt passed.

## Artifacts come from the last workflow run

Release testing uses artifacts from the most recent workflow on the branch. Pushing
another commit invalidates them and you wait for a rebuild.

So avoid pushing to the release branch once testing has started. If you must,
expect to wait for `build_npm_package` again before testing with the new artifacts.

## Reading a red branch

Classify before acting:

- Does the same job fail on the commit **before** the change? If so it is
  pre-existing and not yours.
- Does the failure match a known flake signature (rubygems DNS, missing artifact)?
  Retryable.
- Anything else: investigate. Do not blanket-retry.

A failure whose fix lives in another repo, such as the template's `react` pin, is
fixed by a rerun once that repo is fixed, with no new RN commit, because the
template is cloned at test time.


## Verifying the template

Separate from release testing and the only release check with **no derivable
signal**: npm having the package says nothing about whether a consumer can build
with it.

```sh
node scripts/verify-template.mjs 0.88.0-rc.3            # both platforms
node scripts/verify-template.mjs 0.88.0-rc.3 --ios-only
node scripts/verify-template.mjs 0.88.0-rc.3 --keep     # leave the app to poke at
```

The `template-check` step runs this after `verify-publish`, since you cannot build
against a version that is not published yet. It creates a throwaway app in a temp
directory, so it mutates nothing shared and it cleans up unless you pass `--keep`.

What it checks beyond "the build is green":

- the template **pins the version you asked for** rather than drifting to latest,
- which Hermes a consumer actually resolves, which is the thing a mid-cycle Hermes
  pick is trying to deliver. On rc.3 that confirmed `260318099.0.4` reached a fresh
  app, closing the loop from the cut through the pin to the published package.

Roughly ten minutes cold, about 90 seconds with warm yarn and CocoaPods caches, and
around 4GB.

**Android needs a JDK 17 or newer.** The machine default is often older (1.8 on a
long-lived Mac), so the script looks for one: `JAVA_HOME`, then Android Studio's
bundled JBR, then a brew `openjdk@17`. It skips a platform it cannot build rather
than failing, so a missing Android SDK does not fail the check, it reports as
skipped. Read the output rather than only the exit code.

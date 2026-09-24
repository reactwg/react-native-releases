# Release testing

## Which releases get manually tested

Only these:

- **RC0**
- **RC1**
- **the golden RC** (the last one before `.0`, RC4 on a normal cadence, RC2 for 0.88)
- **stable** `.0` and patches on the latest line

Everything else needs no manual pass. One release crew member is enough.

The golden RC number varies by series. Read `goldenRc` from
`reference/schedule.json` rather than assuming RC4.

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

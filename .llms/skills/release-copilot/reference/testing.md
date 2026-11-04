# Release testing

## Which releases get manually tested

Only these:

- **RC0**
- **RC1**
- **the golden RC**, meaning the last one before `.0`

Everything else needs no manual pass, including the stable `.0` and every patch. The `.0`
is promoted from the golden RC with nothing new in it, so the golden RC's pass covers it.
One release crew member is enough. The copilot can be that member (below).

The golden RC number is **not derivable in advance**. Measured from tags it landed at
rc.5, rc.5, rc.5, rc.7, rc.3 then rc.4 across 0.82 to 0.87. For a released series
`status` derives it from tags. For one in flight it assumes `expectedGoldenRc` from
`schedule.json`, currently rc.5, labels that an assumption and never suggests moving
it. Only the captain changes it.

## The copilot runs the test pass

`scripts/release-test.mjs` does what the crew used to do by hand: it builds and launches
RNTester and a fresh RNTestProject on iOS and Android, runs the cases in
`release-tests.json`, takes a screenshot per case and files the `[<version>] Test Report`.

```sh
node scripts/release-test.mjs run 0.89.0-rc.0                       # all four, about 15 minutes warm
node scripts/release-test.mjs run 0.89.0-rc.0 --only rntester-ios   # one dimension while iterating
node scripts/release-test.mjs confirm 0.89.0-rc.0 --case rntestproject-ios/launch --fail "warning toast on launch"
node scripts/release-test.mjs report 0.89.0-rc.0                    # print the report body
node scripts/release-test.mjs file 0.89.0-rc.0                      # what the test step runs, after you confirm
```

What it uses, so nothing of the captain's is touched:

- the branch's **own CI artifacts** from the green Test All run at the tip
  (`RNTesterApp-NewArch-Debug`, `rntester-debug`, `maven-local`, `react-native-package`),
  the same ones the published RC is built from;
- a **worktree** of the release branch under `~/Library/Caches/release-copilot/release-test/`
  for Metro and for generating RNTestProject with RN's own `scripts/e2e/init-project-e2e.js`;
- a dedicated **"RN Release Test" simulator** and an **`RN_Release_Test` AVD** on port 5580,
  created on first use and left running afterwards so a failure can be looked at;
- port **8081** for Metro. If something is already on it the pass refuses rather than
  killing it.

How each case is checked, per `release-tests.json`:

- `maestro`: a flow in `maestro/` asserts text and ids and takes the screenshot.
- `script`: the debugger (a Chrome DevTools session evaluates JavaScript in Hermes), the dev
  menu (opened through the `DevMenu` module) and Fast Refresh (an edit must update the screen
  while a marker set in the JS runtime survives, which tells a hot update from a full reload).
- `agent`: **you** open the screenshot and record what it shows with `confirm`. The run
  lists every pending one with the screenshot path and what to look for. Look at the whole
  screen, not just the asserted text: a warning toast or a red box is a failure even when the
  flow passed. Say what you see in the reason; it goes into the report.

It also records the **console warnings and errors at launch** for each dimension. Judge
each one: a new warning on a freshly generated app is a regression. On 0.89.0-rc.0 that is
how the StatusBar regression showed up, as a warning toast on RNTestProject iOS.

Screenshots are for you only. They stay in the run directory and are never uploaded or
linked from the issue.

The report's body carries a marker with the version, the branch tip it tested and every
case's result. `manualTestingDone` passes only on a marker for the version being published
at the current branch tip with every case passed: nothing failed, unconfirmed or skipped. A
push after the pass means new artifacts, so the gate asks for a new pass. `--manual-tested`
still overrides, after the captain has read the report.

`--run <id>` tests the artifacts of a Test All run at the tip that has not finished, for
example while a job lost to infrastructure is re-run. `ciGreen` still gates the publish.
After the publish, `report` and `file` find the pass through the bot's `Release <version>`
commit, which changes no app code. `file` sets the report's Target Release on the board.

On Android the dev menu is opened with the menu key, as Cmd+M does. `DevMenu.show()` from
JavaScript builds the dialog off the UI thread there (`DevMenuModule.show()` has no
`runOnUiThread`, unlike `reload()`) and dismissing it crashed RNTestProject on
0.89.0-rc.0. That is an upstream bug, unchanged since 0.88.

**Never run it under a dot directory** (`~/.cache` and the like). codegen's build picks
files with micromatch, whose `**` does not cross a dot directory, so under one it copies raw
Flow into `lib/` and prints OK. Every app then fails in codegen with "SyntaxError:
Unexpected token '{'". The script refuses such a path.

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
against a version that is not published yet.

A sandboxed Claude Code session may not be able to run the Android half. On 0.88.1 the
Gradle client could not reach its own daemon on `127.0.0.1` ("Could not connect to the
Gradle daemon"), which is the session's restriction, not the release. Run
`verify-template.mjs <version> --android-only` from your own terminal in that case. The
iOS half and `init` work in the session. It creates a throwaway app in a temp
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

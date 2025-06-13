# Releases Support Policy

## What versions are currently supported?

| Version  | Type                       | Support level |
| -------- | -------------------------- | ------------- |
| 0.81.x   | Next version               | Future        |
| 0.80.x   | Latest stable              | Active        |
| 0.79.x   | Previous (-1) minor series | Active        |
| 0.78.x   | Previous (-2) minor series | End of Cycle  |
| <=0.77.x | Old minor series           | Unsupported   |

### What level of support can be expected?

To set clear expectations and provide a sustainable upgrading experience for the community, the level of support provided by the release crew to the various versions of React Native is weighted to focus on the newer versions, while maintaining the previous two minors.

The different statuses presented in the table are defined as such:

* `Future`

After a [new version branch gets cut](https://reactnative.dev/contributing/release-branch-cut-and-rc0), creating new Release Candidates to allow the community to test the upcoming version is very important. New RC releases are done at a high pace, as soon as viable.

* `Active`

Stable releases in active support receive frequent updates. Latest stable has the highest priority, and at the start of its stable cycle (right after [.0 is released](https://reactnative.dev/contributing/release-stable-minor)) multiple patches will be done as soon as possible to stabilize the version and ensure a good upgrade experience to the community.

* `End of Cycle`

A version in this support bracket will receive less patches, unless some important regressions need to be addressed. Once a next version becomes the new latest stable, before the version in EoC moves over into `Unsupported` one last patch released will be produced to honor the open "Should we release X.Y.Z?" discussion.

* `Unsupported`

When a version is in the unsupported stage, no new released are to be expected. Only very important regressions might create exceptions to this rule; it is recommended that codebases using an unsupported version upgrade as soon as possible.

## External Dependencies Supported

| Version               | Android SDK minimum   | JDK version           | Xcode Version min.    | Cocoapods             | Node min.             |
| --------------------- | --------------------- | --------------------- | --------------------- | --------------------- | --------------------- |
| 0.79                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.78                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.77                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.76                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.75                  | Android 6.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.74                  | Android 6.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.73                  | Android 5.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.72                  | Android 5.0           | JDK 11                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 16                    |
| 0.71                  | Android 5.0           | JDK 11                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 16                    |

## Cherry-Pick Requests

A **cherry-pick request** is the request to include a fix in one of the **supported versions**.

Cherry-Pick requests should be submitted as a [cherry-pick issue](https://github.com/reactwg/react-native-releases/issues/new/choose) in this repo. It will be triaged by the release crew.

Please note that each cherry-pick request will be assessed and approved individually, following the criteria highlighted below.

> [!IMPORTANT]  
> The release crew evaluates each pick on a case-by-case basis (for example a fix may be included in one supported version but not another). The release crew have a lot of flexibility so long as they feel the change would significantly improve the quality or stability of a version of React Native.

### Which pick requests we accept:

1. ✅ Fixes for regressions to core APIs. Examples:
    * A core component is behaving differently between version 0.X and 0.X-1
    * The TurboModule.getEnforcing function is throwing an assertion error which is not expected.
2. ✅ Fixes to bugs in the core React Native’s experience. Examples:
    * Breakpoints in React Native DevTools not working correctly in the debugger
    * Fast Refresh not working as expected
    * Metro bundler not starting properly or ignoring the configuration file
    * Buttons that are not clickable
3. ✅ Fixes to APIs used by 3P libraries and Out-of-tree platforms. Examples:
    * An API that is used by `react-native-macos` is not behaving as expected or regressing
4. ✅ Bump of patch version of dependencies. Example:
    * Bump Gradle from 8.11.0 to 8.11.1
5. ✅ Fixes for Low/High Security Vulnerability. Example:
    * Bump Gradle from 8.11.0 to 8.12.0 if there is a security vulnerability in 8.11 and there is no version 8.11.x which would contain the same fix.
6. ✅ Fixes and reverts of accidental breaking changes. Example:
    * Reverting or fix-forwarding a migration to Kotlin of a file (say `ReactRootView.java` ) if that is causing a breaking change for the whole React Native ecosystem.
7. ✅ Performance improvements picks. Examples:
    * Fixing unnecessary rendering on FlatList.
8. ✅ Any pick if the release is still in RC0 (after RC1 the previous listed criteria applies)

### Which pick requests we don’t accept

9. ❌ Any pick that will introduce a breaking change after RC1. Example:
    * A bugfix that contains a refactoring, resulting in changes to the public API of a class
10. ❌ Any pick that introduces a new feature after RC1. Example:
    * A commit that introduces a new API or a specific feature for a component.
11. ❌ Bump of major/minor version of dependencies. Example:
    * Bump Gradle from 8.11.0 to 8.12.0
    * Bump Gradle from 8.11.0 to 9.0.0
12. ❌ Bump of a dependency to a non stable/alpha/beta version. Example:
    * Bump Gradle from 8.11.0 to 8.11.1-beta.1
13. ❌ Any pick that introduces changes to the testing infrastructure of React Native after RC1. Examples:
    * Changes to the GitHub Actions workflows to optimize it, even if they’re on main.
    * Changes to the logic used to publish packages to NPM or Maven Central
14. ❌ Pick composed by various commits that has several merge conflicts
    * If your pick is too complicated to apply on the release branch, we’re going to reject it.
15. ❌ Any other non-critical improvement that landed on main.
    * In general those will ship in the following version unless they fit in one of the criteria above
16. ❌ Any other pick which is considered “small enough” to make it into a release.
    * If your pick is a one liner but is a ‘nice to have’, we won’t be picking it, as it has the risk of destabilizing the release and further delaying the release.

### What makes for a good pick

In order to increase the chance for your pick to be considered, please consider doing the following:

* Have a pick that contains only one commit from `main`, or only one PR against the release branch.
* Have a clear explanation of why your pick should be considered, ideally referencing one of the criteria above.
* Target only one minor version of React Native (e.g. 0.76). If you want your pick to be applied to more versions, please open different picks.

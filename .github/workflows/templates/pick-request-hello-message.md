Thank you for opening a new pick-request for React Native.
Those are the criterias we follow when accepting/rejecting a pick request ([source](https://github.com/reactwg/react-native-releases/blob/main/docs/support.md)).

If your pick does not satisfy the criteria below, please close it as it will not be considered.

<details>
<summary>✅ Which pick requests we accept</summary>

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
</details>

<details>
<summary>❌ Which pick requests we don’t accept</summary>

9. ❌ Any pick that will introduce a breaking change after RC1. Example:
    * A bugfix that contains a refactoring, resulting in changes to the public API of a class
10. ❌ Any pick that introduces a new feature after RC1. Example:
    * A commit that introduces a new API or a specific feature for a component.
11. ❌ Bump of major/minor version of dependencies. Example:
    * Bump Gradle from 8.11.0 to 8.12.0
    * Bump Gradle from 8.11.0 to 9.0.0
12. ❌Bump of a dependency to a non stable/alpha/beta version. Example:
    * Bump Gradle from 8.11.0 to 8.11.1-beta.1
13. ❌Any pick that introduces changes to the testing infrastructure of React Native after RC1. Examples:
    * Changes to the GitHub Actions workflows to optimize it, even if they’re on main.
    * Changes to the logic used to publish packages to NPM or Maven Central
14. ❌ Pick composed by various commits that has several merge conflicts
    * If your pick is too complicated to apply on the release branch, we’re going to reject it.
15. ❌ Any other non-critical improvement that landed on main.
    * In general those will ship in the following version unless they fit in one of the criteria above
16. ❌ Any other pick which is considered “small enough” to make it into a release.
    * If your pick is a one liner but is a ‘nice to have’, we won’t be picking it, as it has the risk of destabilizing the release and further delaying the release.
</details>

<details>
<summary>ℹ️ What makes for a good pick</summary>

In order for your pick to be considered, please do the following:

* ℹ️ Have a pick that contains only one commit from `main`, or only one PR against the release branch.
* ℹ️ Have a clear explanation of why your pick should be considered, ideally referencing one of the criteria above.
* ℹ️ Target only one minor version of React Native (e.g. [0.76]). If you want your pick to be applied to more versions, please open different picks.
</details>
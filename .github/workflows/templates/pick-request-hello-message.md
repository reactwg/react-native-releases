Thank you for opening a new React Native Pick Request.

These are the criteria we follow when accepting or rejecting a code change into a React Native release branch ([source](https://github.com/reactwg/react-native-releases/blob/main/docs/support.md)).

If your Pick Request does not satisfy the criteria below, please close it as it will not be considered.

<details>
<summary>✅ Which Pick Requests we accept</summary>

1. ✅ Fixes for regressions to core APIs. Examples:
    * A core component is behaving differently between versions 0.X and 0.X-1
    * The `TurboModule.getEnforcing` function is throwing an unexpected assertion error.
2. ✅ Fixes to bugs in core React Native. Examples:
    * Breakpoints in React Native DevTools not working correctly in the debugger
    * Fast Refresh not working as expected
    * Metro bundler not starting properly or ignoring the configuration file
    * Buttons that are not clickable
3. ✅ Fixes to APIs used by third-party libraries and out-of-tree platforms. Examples:
    * An API used by `react-native-macos` is not behaving as expected or is regressing
4. ✅ Bump of patch version of dependencies. Example:
    * Bump Gradle from 8.11.0 to 8.11.1
5. ✅ Fixes for low/high severity security vulnerabilities. Example:
    * Bump Gradle from 8.11.0 to 8.12.0 if there is a security vulnerability in 8.11 and no 8.11.x version contains the same fix.
6. ✅ Fixes and reverts of accidental breaking changes. Example:
    * Reverting or fix-forwarding a Kotlin migration of a file (e.g. `ReactRootView.java`) if it is causing a breaking change for the React Native ecosystem.
7. ✅ Performance improvements. Examples:
    * Fixing unnecessary re-renders in FlatList.
8. ✅ Any Pick Request if the release is still in RC0 (after RC1, the previously listed criteria apply)
</details>

<details>
<summary>❌ Which Pick Requests we don't accept</summary>

9. ❌ Any Pick Request that introduces a breaking change after RC1. Example:
    * A bugfix that contains a refactoring, resulting in changes to the public API of a class
10. ❌ Any Pick Request that introduces a new feature after RC1. Example:
    * A commit that introduces a new API or a specific feature for a component.
11. ❌ Bump of major or minor version of dependencies. Examples:
    * Bump Gradle from 8.11.0 to 8.12.0
    * Bump Gradle from 8.11.0 to 9.0.0
12. ❌ Bump of a dependency to a pre-release version. Example:
    * Bump Gradle from 8.11.0 to 8.11.1-beta.1
13. ❌ Any Pick Request that introduces changes to the React Native testing infrastructure after RC1. Examples:
    * Changes to GitHub Actions workflows to optimize them, even if they are on main.
    * Changes to the logic used to publish packages to NPM or Maven Central
14. ❌ Pick Request composed of multiple commits that have several merge conflicts.
    * If your Pick Request is too complex to apply to the release branch, it will be rejected.
15. ❌ Any non-critical improvement that landed on main.
    * These will generally ship in the following version unless they fit one of the criteria above.
16. ❌ Any Pick Request considered a "nice to have".
    * Even one-line changes carry a risk of destabilizing and further delaying the release.
</details>

<details>
<summary>ℹ️ What makes for a good Pick Request</summary>

In order for your Pick Request to be considered, please do the following:

* ℹ️ Limit your Pick Request to one commit from `main`, or one PR against the release branch.
* ℹ️ Include a clear explanation of why your Pick Request should be considered, ideally referencing one of the criteria above.
* ℹ️ Target only one minor version of React Native (e.g. [0.76]). To have your Pick Request applied to more versions, please open separate Pick Requests.
</details>

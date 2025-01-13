# Releases Support Policy

## What versions are currently supported?

| Version  | Type                       | Support level |
| -------- | -------------------------- | ------------- |
| 0.77.x   | Next version               | Future        |
| 0.76.x   | Latest stable              | Active        |
| 0.75.x   | Previous (-1) minor series | Active        |
| 0.74.x   | Previous (-2) minor series | End of Cycle  |
| <=0.73.x | Old minor series           | Unsupported   |

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
| 0.78                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.77                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.76                  | Android 7.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.75                  | Android 6.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.74                  | Android 6.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.73                  | Android 5.0           | JDK 17                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 18                    |
| 0.72                  | Android 5.0           | JDK 11                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 16                    |
| 0.71                  | Android 5.0           | JDK 11                | 15.1                  | 1.13.x/1.14.x/1.15.2  | 16                    |

## Cherry-Pick Requests

We’re **accepting cherry-pick requests** for the currently supported versions. A cherry-pick request is the request to include a fix in one of the supported versions and release a new point release with it.

Cherry-Pick requests should be submitted as a [cherry-pick issue](https://github.com/reactwg/react-native-releases/issues/new/choose) in this repo. It will be triaged by the release crew.

Please note that each cherry-pick request will be assessed and approved individually. Cherry-Pick requests against unsupported versions will be rejected unless they involve security issues.

## Release Issues and Pick Request Escalation

The following is how we escalate release issues and pick requests.

- P0
    - Immediate escalation to address and release patches for all affected versions in support window.
- P1
    - Regression should be triaged, addressed and shipped in a patch in a 2 week window for affected versions in support window. Priority will be given to latest stable version.
- P2 / No Pick
    - No prioritization will be given and no guarantee it will be picked. May still be shipped with with P0/P1 escalated patches upon discretion of release crew.

### Escalation Framework

| Regression Area                                       | Default   | 0.76      | 0.75      | 0.74      | 0.73      |
| ----------------------------------------------------- | -         | -         | -         | -         | -         |
| Build regression for recommended workflows | P0 |
| Publishing to App/Play Store | P0 |
| Security risks (High vulnerability) | P0 |
| Security risks (Low vulnerability) | P1 |
| Developer Workflows (Fast Refresh, Dev Menu, see debugging flavors) | P0 |
| Poor Developer Experience that does not break functionality | P1 |
| Flipper Debugging (Hermes)                            | -         | No Pick   | No Pick   | P0        | P0        |
| Flipper Debugging (JSC)                               | -         | No Pick   | No Pick   | P0        | P0        |
| [Chrome Remote Debugging (JSC)](chrome-debugigng)     | -         | No Pick   | P1        | P0        | P0        |
| [Chrome Remote Debugging (Hermes)](chrome-debugging)  | -         | P0        | P0        | P0        | P0        |
| [Experimental Debugger](experimental-debugging)       | -         | P1        | No Pick   | n/a       | n/a       |
| New regressions on documented Core APIs (components, APIs) | P0 |
| Core APIs (components, APIs) with workarounds | P1 |
| Regressions on non-recommended tooling, ex. pnpm, Swift | P1 |
| P0 Regressions only affecting out-of-tree platforms (subject to release-crew) | P1 |
| Non-critical improvements that have landed on `main` | P2 |
| Performance improvement work | P2 |

Affected platform will also be considered with the following priority:
- Mobile (Android, iOS)
- Desktop (macOS, Windows)
- Web
- TV
- Skia
- Other

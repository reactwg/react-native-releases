# React Native Releases

This repository is dedicated to coordinating React Native releases; if you want to learn more about _how_ a release is worked on, please refer to the [releases documentation](https://reactnative.dev/contributing/release-roles-responsibilities).

## Releases Support Policy

### Which versions are currently supported?

| Version  | Type                       | Support level |
| -------- | -------------------------- | ------------- |
| 0.74.x   | Next version               | Future        |
| 0.73.x   | Latest stable              | Active        |
| 0.72.x   | Previous (-1) minor series | Active        |
| 0.71.x   | Previous (-2) minor series | End of Cycle  |
| <=0.70.x | Old minor series           | Unsupported   |

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

### What defines which issues and PRs are worked on?

Due to support bandwidth, the React Native team, with the community's help, looks into issues & PRs opened against the supported versions.

Issues & PRs opened against older versions would be considered only in exceptional cases, so we recommend to [update](https://reactnative.dev/docs/upgrading) your applications and libraries to one of the supported versions.

Issues should contain a [**reproducer**](https://stackoverflow.com/help/minimal-reproducible-example) project regardless of which version they target, for them to be considered.
Issues without a reproducer will require more effort to understand and fix, and are less likely to receive attention.

At this point in time, we are prioritizing issues that are related to:

* Latest version of React Native and two previous minor series.
* Use of the New Architecture
* Use of the Hermes Engine

### Cherry-Pick Requests

We’re **accepting cherry-pick requests** for the currently supported versions. A cherry-pick request is the request to include a fix in one of the supported versions and release a new point release with it.

Cherry-Pick requests should be submitted in the corresponding [discussion thread](https://github.com/reactwg/react-native-releases/discussions) in this repo.

Please note that each cherry-pick request will be assessed and approved individually. Cherry-Pick requests against unsupported versions will be rejected unless they involve security issues.

### Security Issues

Meta has [a bounty program](https://www.facebook.com/whitehat/) for the safe disclosure of security bugs. In those cases, please go through the process outlined on that page and do not file a public issue.

### Glossary

For further clarity, here's a glossary of the terms used for releases:

* **stable version** - Any version that doesn’t have a -alpha, -beta, -RC postfix in the version name.
* **latest version** - The latest stable version with the highest version number (e.g. 0.68.2).
  * The highest version number is defined following the [NPM semver algorithm](https://github.com/npm/node-semver) tagged as "latest".
* **next version** - The next version that hasn’t been fully released yet, and is currently in development/testing (e.g. 0.69.0-RC1).
* **minor series** - A collection of versions (either stable or not stable) sharing the same minor version (e.g. **0.68**.0-RC0, **0.68**.0, **0.68**.1 are all part of the **0.68** minor series).

_Note: Stable versions are fully tested versions that are stable at the moment of release. These versions can potentially contain experimental features but only behind experimental feature flags, which need to be explicitly enabled to become active._

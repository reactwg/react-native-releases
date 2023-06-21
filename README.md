# React Native Releases


This repository is dedicated to coordinating React Native releases; if you want to learn more about *how* a release is worked on, please refer to the [releases documentation](https://reactnative.dev/contributing/release-roles-responsibilities).

## Releases Support Policy

### Which versions are currently supported?

We are supporting the **latest version**, and the **two previous minor series.**
We also work on the **next version** being developed, which will become the new stable after its 0.Y.0 release.

Current versions supported:

| Version    | Type                  | Status           |
| ---------- | --------------------- | ---------------- |
| 0.73.x     | Next version          | Not started      |
| 0.72.x     | Latest stable         | In support       |
| 0.71.x     | Previous minor series | In support       |
| 0.70.x     | Previous minor series | In support       |
| <=0.69.x   | Old minor series      | Unsupported      |

### What level of support can be expected?

Due to support bandwidth, the React Native team, with the community's help, looks into issues & PRs opened against the supported versions.

Issues & PRs opened against older versions would be considered only in exceptional cases, so we recommend to [update](https://reactnative.dev/docs/upgrading) your applications and libraries to one of the supported versions.

Issues should contain a [**reproducer**](https://stackoverflow.com/help/minimal-reproducible-example) project regardless of which version they target, for them to be considered.
Issues without a reproducer will require more effort to understand and fix, and are less likely to receive attention.

At this point in time, we are prioritizing issues that are related to:

- Latest version of React Native and two previous minor series.
- Use of the New Architecture
- Use of the Hermes Engine

### Cherry-Pick Requests

We’re **accepting cherry-pick requests** for the currently supported versions. A cherry-pick request is the request to include a fix in one of the supported versions and release a new point release with it.

Cherry-Pick requests should be submitted in the corresponding [discussion thread](https://github.com/reactwg/react-native-releases/discussions) in this repo.

Please note that each cherry-pick request will be assessed and approved individually. Cherry-Pick requests against unsupported versions will be rejected unless they involve security issues.

### Security Issues

Meta has [a bounty program](https://www.facebook.com/whitehat/) for the safe disclosure of security bugs. In those cases, please go through the process outlined on that page and do not file a public issue.

### Glossary

For further clarity, here's a glossary of the terms used for releases:

- **stable version** - Any version that doesn’t have a -alpha, -beta, -RC postfix in the version name.
- **latest version** - The latest stable version with the highest version number (e.g. 0.68.2).
  - The highest version number is defined following the [NPM semver algorithm](https://github.com/npm/node-semver) tagged as "latest".
- **next version** - The next version that hasn’t been fully released yet, and is currently in development/testing (e.g. 0.69.0-RC1).
- **minor series** - A collection of versions (either stable or not stable) sharing the same minor version (e.g. **0.68**.0-RC0, **0.68**.0, **0.68**.1 are all part of the **0.68** minor series).

*Note: Stable versions are fully tested versions that are stable at the moment of release. These versions can potentially contain experimental features but only behind experimental feature flags, which need to be explicitly enabled to become active.*

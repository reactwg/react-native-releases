# React Native Releases

This repository is dedicated to coordinating React Native releases. It contains documentation and information on _how_ React Native is released, which versions are supported, and how to request a new Pick Request.

## Pick Requests and Support Policy

### What is a pick request?

A pick request is a request for the React Native Release Crew to **include a commit** into a specific React Native release. As the development of React Native happens on main, you can request for a specific commit or Pull Request to be included in one of the previous version of React Native. We accepts pick requests only for versions of React Native that are **currently supported**

### What versions of React Native are currently supported?

Please refer to the official [Support Policy](https://github.com/reactwg/react-native-releases/blob/main/docs/support.md#what-versions-are-currently-supported) to know which versions are currently supported.

## Running a React Native Release

React Native releases are run by a group of volunteers called the **Release Crew**.
In those docs you can find clarification about the roles of the various members of the Release Crew:

- [Roles & Responsibilities of Release Crew](./docs/roles-and-responsibilities.md)
- [Release Escalation & Support Policy](./docs/support.md)
- [FAQ](./docs/faq.md)
- [Glossary](./docs/glossary.md)

In those docs instead you can find step-by-step guides on how to run a React Native release

- Guide: [Running a Release (Version >= 0.75)](./docs/guide-release-process.md)
- [Guide: Release Candidates](./docs/guide-release-candidate.md)
  - [How to setup a new release project](./docs/guide-release-project-setup.md)
  - [How to cut a release candidate](./docs/guide-release-candidate.md#cut-a-release-candidate)
  - [Release Candidate patches](./docs/guide-release-candidate.md#release-patches-on-release-candidate)
  - [Promote release candidate to stable](./docs/guide-release-candidate.md#promote-release-candidate-to-stable)
- [Guide: Hermes Release](./docs/guide-hermes-release.md)
- [Guide: Release Testing](./docs/guide-release-testing.md)
- [Notable Call-outs / Gotchas](./docs/gotchas.md)

### Reference Documentation

These docs are not relevant for most releases but keeping them around in case of needing to patch an older release.

- [Deprecated: Upgrade Helper](./docs/upgrade-helper.md)
- [Deprecated: Release Dependencies](./docs/dependencies.md)

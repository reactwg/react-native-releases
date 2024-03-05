# Glossary

## stable version

Any version that doesn’t have a -alpha, -beta, -RC postfix in the version name.

_Note: Stable versions are fully tested versions that are stable at the moment of release. These versions can potentially contain experimental features but only behind experimental feature flags, which need to be explicitly enabled to become active._

## latest version

The latest stable version with the highest version number (e.g. 0.68.2).

The highest version number is defined following the [NPM semver algorithm](https://github.com/npm/node-semver) tagged as "latest".

## next version

The version of React Native is not fully released yet and is currently in development/testing. "next version" may refer to the active release candidate or the anticipated release candidate that has not yet been cut from `main`.

## release candidate

A React Native release that has a `rc.<number>` suffix and has been cut from `main`. It is not considered stable and is not recommended for production yet.

## minor series
A collection of versions (either stable or not stable) sharing the same minor version (e.g. **0.68**.0-RC0, **0.68**.0, **0.68**.1 are all part of the **0.68** minor series).

## release branch

Every release minor has a separate release branch. Ex. all 0.72.x releases are shipped from `0.72-stable` branch. Every release branch follows the format `<major>.<minor>-stable`.

## monorepo packages

This refers to packages under `react-native/packages`. Technically, `react-native` is a "monorepo package" but the term generally means any package we publish under the `@react-native` scope on npm.

Monorepo packages ([RFC](https://github.com/react-native-community/discussions-and-proposals/pull/480)) were iterated on in 0.71 and officially [shipped in 0.72](https://reactnative.dev/blog/2023/06/21/0.72-metro-package-exports-symlinks#package-renames).

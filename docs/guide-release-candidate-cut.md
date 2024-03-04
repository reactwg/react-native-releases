# Cutting a Release Candidate

> [!Note] Release Candidates will primarily handled by Meta release crew. Community releasers can aid in testing and triaging issues.

### Pre-requisites

- Write access to [react-native](https://github.com/facebook/react-native) repository.
- Write access to [hermes](https://github.com/facebook/hermes) repository.
- Write access to [releases](https://github.com/reactwg/react-native-releases) repository.
- One CircleCI personal API token - see [here](https://circleci.com/docs/managing-api-tokens#creating-a-personal-api-token) how to set one.

### 1. Create a new release branch

- Create the release branch in `react-native` repo with the appropriate name (usually `0.XX-stable`).

  ```bash
  git checkout main
  git pull origin main
  git checkout -b 0.69-stable
  ```

### 2. Update the Hermes version

- Head to the [Publish Tag](https://github.com/facebook/hermes/actions/workflows/create-tag.yml) workflow in the Hermes repo. Click the "Run Workflow" button and input the RN stable version you are targeting (e.g. 0.69.0). You need to have write access to the facebook/hermes repo to do so or ask a Meta employee to help you on this step.

- Bump the Hermes version on the release branch using this command:

  ```bash
  # Replace <the_hermes_tag> with the tag that will look like 'hermes-2022-07-20-RNv0.70.0-bc97c5399e0789c0a323f8e1431986e207a9e8ba'
  ./packages/react-native/scripts/hermes/bump-hermes-version.js -t <the_hermes_tag>
  ```
- Add and commit the extra file that got created at `packages/react-native/sdks/hermes/.hermesversion`.

### 3. Push the branch and wait for artifacts to build

You can now push the branch you created so that others can also start testing:

```bash
git push origin 0.69-stable
```

Before continuing further, follow the [testing guide](/contributing/release-testing) to ensure the code doesn't have any major issues.

> [!Note]
> Since testing is a time consuming activity (>1 hrs) it is recommended that the release crew coordinates on the steps above then do testing on at least two separate systems in an async way.

### 4. Bump monorepo packages

- Update monorepo package dependencies by running `yarn bump-all-updated-packages`. Bear in mind that all the package bumps must be on patch level, and be on the minor you are working on. Read more about this script and how it works [here](./release-updating-packages).
- Push the newly generated commit. A CI workflow will publish the new versions of each monorepo package (excluding `react-native`) to npm.
- Wait for this workflow to successfully complete before continuing.

### 5. Kick off the build of `0.{minor}.0-rc.0`

Once you're done with the testing, you can kick-off the bump and publishing of RC0:

```bash
# This will walk you through what version you are releasing
yarn trigger-react-native-release --to-version 0.69.0-rc.0 --token <YOUR_CIRCLE_CI_TOKEN>
```

- Once you have run that script, head to CircleCI and you should see under the releases workflow, a `prepare-package-for-release` job.

  <figure>
    <img width="400" alt="CircleCI showing publish release" src="https://user-images.githubusercontent.com/1309636/150040711-cfbc2fe3-91eb-42b9-bd06-de2aa7fb94ea.png"/>
    <figcaption>CircleCI showing publish release.</figcaption>
  </figure>

- This script runs and commits any changes and triggers a deploy job, `build_and_publish_npm_package`.
- Note: Look under "All Branches" to find the publish job. CircleCI does not give a way to search for these jobs.
- Once complete you should be able to run `npm view react-native` and verify that under the `next` tag, the version is the expected release version.

  ```bash
  npm view react-native
  ...
  dist-tags:
  latest: 0.68.1            next: 0.69.0-rc.0         nightly: 0.0.0-f617e022c
  ```

- Hermes artifacts will be uploaded to the [Maven repository](https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/). It might take ~20 minutes for Maven to process them.

### 6. Create a PR of the changelog using the generator

To generate the changelog, we rely on a dedicated tool called [`@rnx-kit/rn-changelog-generator`](https://github.com/microsoft/rnx-kit/tree/main/incubator/rn-changelog-generator) that will parse the custom changelog messages that contributors write in their PRs.

Note: Due to the number of commits for an RC0, this operation is likely to hit GitHub API limits. The snippet below set the optional `--token` arg, which can be obtained from [GitHub Settings > Developer Settings > Personal access tokens > Fine-grained tokens](https://github.com/settings/tokens?type=beta).

```bash
# Run following with the stable release as base, and your rc.0 version
npx @rnx-kit/rn-changelog-generator --base v[LATEST_STABLE] --compare v[YOUR_RC_0] \
--repo ~/react-native --changelog ~/react-native/CHANGELOG.md --token [GITHUB_TOKEN]

# example against 0.68.2 and 0.69.0-rc.0
npx @rnx-kit/rn-changelog-generator --base v0.68.2 --compare v0.69.0-rc.0 \
--repo ~/react-native --changelog ~/react-native/CHANGELOG.md --token [GITHUB_TOKEN]
```

Create a pull request of this change to `react-native` repo and add the `Changelog` label.

#### Manually Adjust the Changelog

At the end of the generated Changelog, there could be two additional sections: the **Failed to Parse** section and the **Unknown** section.

The **Failed to Parse** section contains commits that has a `## Changelog:` entry in their summary but, due to typos or other problems, the tool was not able to parse and automatically attribute them to the right section.

The **Unknown** section is populated with commit that landed without the `## Changelog:` entry in the summary.

For both these categories, we have to manually go through the listed commits and move them to the right section, based on the actual change they introduce. The following are a set of heuristic we follow to manually update the changelog:

- Commit of internal changes can be **deleted** from the Changelog.
  - Examples: commit on BUCK files or code refactoring that do not change behaviours or interfaces
- Commit which bumps dependencies should be **moved to the `Changed`** section
  - For each dependency, there should be a single entry with the most recent bump. Commits that bumps the dependencies to lower versions can be **removed**

### 7. Create a GitHub Release

- Create a [GitHub Release](https://github.com/facebook/react-native/releases) with this template and **check "Pre-Release" checkbox**.

```markdown
- <!-- TODO List out notable picks for this patch -->

---

To test it, run:

<!-- TODO Update with your version -->

npx react-native init RN069RC0 --version 0.69.0-rc.0

---

- You can participate in the conversation on the status of this release in the [working group](https://github.com/reactwg/react-native-releases/discussions).

- To help you upgrade to this version, you can use the [upgrade helper](https://react-native-community.github.io/upgrade-helper/) ⚛️

- See changes from this release in the [changelog PR](https://github.com/facebook/react-native/labels/%F0%9F%93%9D%20Changelog)

---

### Help us testing 🧪

<!-- TODO Add the call to action for something specific that we want folks to test -->

Let us know how it went by posting a comment in the [working group discussion](https://github.com/reactwg/react-native-releases/discussions)! Please specify with system you tried it on (ex. macos, windows).

**Bonus points:** It would be even better if you could swap things around: instead of using a fresh new app, use a more complex one - or use a different library that is already leveraging the new architecture!
```

<figure>
  <img
    width="400"
    alt="Creating a GitHub Release"
    src="https://user-images.githubusercontent.com/1309636/133348648-c33f82b8-b8d2-474a-a06e-35a1fb8d18de.png"
  />
  <figcaption>Creating a GitHub Release.</figcaption>
</figure>

### 8. Create a tracking discussion post

Create a "Road to [YOUR_MINOR_VERSION]" discussion post in the [`react-native-releases`](https://github.com/reactwg/react-native-releases/discussions) working group:


```markdown
<!-- Title: Road to <YOUR_VERSION> -->

The branch cut has happened.

## Notice

<!-- TODO update the version -->

- [Current release candidate: 0.69.0-rc.0][current-release]
- Have an issue with current release candidate? [File an issue][issue-form] and we will triage.
- Have a pick request for this release? Does it fall under our [pick request qualifications][release-faq]? If so please create a PR against the release branch and comment with the PR link
- If you are release testing, copy and fill a [test checklist](/contributing/release-testing#test-checklist).

#### Highlighted Changes in this release

<!-- Add stand-out changes in this release, and link to changelog PR.  -->

- Checkout this [Changelog PR][changelog-pr]

## [Release Process][release-processes]

#### Checklist

- [ ] [Changelog PR][changelog-pr]
- [ ] Start a Google doc of blog post for release ([start from this skeleton](https://docs.google.com/document/d/1MP6AT-SX_qBrngOKRDbDoUIc_U2qhWq5L4dqgkLkd5Y/edit?usp=sharing)) and invite contributors of release highlights to expand
- [ ] Follow up on [release dependencies][release-dependencies]
  > When ready to publish stable
- [ ] Ship changelog
- [ ] Ship blog post
- [ ] Prepare typescript PR (see https://github.com/DefinitelyTyped/DefinitelyTyped/pull/60929)
- [ ] Make PR to `react-native-website` with the new version cut ([see docs](https://github.com/facebook/react-native-website#cutting-a-new-version))

#### Retrospective Topics

<!-- List out pain points, issues to investigate that are not release-blocking to follow up on -->

-

## Release Status

### Tracking 0.69.0-rc.1

#### Blocking issues for releasing 0.69.0-rc.1

-

#### Picks for 0.69.0-rc.1

-

<!--
once an RC is released, wrap this section like so

<details>
<summary>
Tracking 0.69.0-rc.1 (released ✅)
</summary>
#### Blocking issues for releasing 0.69.0-rc.1

-

#### Picks for 0.69.0-rc.1

-
</details>
-->

[changelog-pr]: https://github.com/facebook/react-native/labels/%F0%9F%93%9D%20Changelog
[current-release]: https://github.com/facebook/react-native/releases
[changelog-wiki]: https://reactnative.dev/contributing/changelogs-in-pull-requests
[release-dependencies]: https://reactnative.dev/contributing/release-dependencies
[release-faq]: https://reactnative.dev/contributing/release-faq
[issue-form]: https://github.com/facebook/react-native/issues/new?assignees=&labels=Needs%3A+Triage+%3Amag%3A%2Cpre-release&template=release_blocker_form.yml
[releases]: https://github.com/facebook/react-native/releases
[release-processes]: https://reactnative.dev/contributing/overview
[upgrade-helper]: https://reactnative.dev/contributing/updating-upgrade-helper
```

After creating it, make sure to link it in the relevant GitHub Release you created above, and to pin it in the discussion repo.

### 9. Verify that Upgrade Helper GitHub action has fired

- You should see a [new publish job here](https://github.com/react-native-community/rn-diff-purge/actions).
- Once it has finished, you should be able to see that the [Upgrade Helper](https://react-native-community.github.io/upgrade-helper/) presents the option to target the new RC0.
- If not, check out the guide on [how to update Upgrade Helper](/contributing/updating-upgrade-helper).

### 10. Broadcast that release candidate is out

Once all the steps above have been completed, it's time to signal to the community that RC0 is available for testing! Do so in the following channels:

- [@reactnative](https://twitter.com/reactnative) on twitter
- RN Discord `#releases-coordination`

### 11. Bump minor version of all monorepo packages in `main`

Now we've cut a stable release branch, let's update the versions of each package on `main`. This is in the format `0.[next-major].0-main`.

```sh
node scripts/releases/set-version 0.75.0-main --skip-react-native-version
git commit -a -m "Bump packages for next major release"
```

After running, push your changes to a new branch and submit a PR to `main`.

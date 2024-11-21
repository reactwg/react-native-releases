# Release Process (0.75 and later)

> [!Note]
> This documents the steps to releasing a stable React Native release.
>
> Release candidates will generally follow the same steps but have some pre and post work, depending on if you're cutting, doing a patch, or promoting a release candidate to stable.
>
> Follow the dedicated release candidate [guide](./guide-release-candidate.md) for more detail.

## Release steps

These steps apply when making a patch release or an incremental release candidate.  Typically we like to keep the *#release-crew* Discord channel up to date with progress.  You're free to do this however you'd like.  One method is it keep a progress message up-to-date (⌛ started, ✅ complete, 🚨 problem).  Here is the template used for the 0.76.1 release:

```md
# 0.76.1: Releasing

Testing: @blakefuk + @frankcalise 

- Waiting for `build_npm_package` to complete: @frankcalise ready to test https://github.com/facebook/react-native/actions/runs/11556038238
- Publish release job.
- Verify release: npx @react-native-community/cli init + build for iOS + Android
- Manually trigger template publication for 0.76.1 → iOS + Android → mostly worked from publish job
- Init a new template
- Manually trigger rn-diff-purge → upgrade-helper
- Verify Upgrade helper → https://react-native-community.github.io/upgrade-helper/?from=0.76.0&to=0.76.1
- Verify Maven assets
- Generate Changelog PR → https://github.com/facebook/react-native/pull/47288
- Create GitHub Release → Draft, publish when we release.
- Communicate Release → Discord
- Update Podfile.lock
- Update GitHub Project
```

### Step 1: Check out release branch locally

From your local `facebook/react-native` clone, check out the relevant [release branch](./glossary.md#release-branch). Make sure your system is set up with the right [tooling dependencies](./support.md#external-dependencies-supported) for the release. e.g. you may need to switch Node versions.

```sh
# Fetch new commits and tags (to prep for any cherry-picks)
git fetch --all --tags

# Check out release branch
git switch <release-branch> # e.g. 0.75-stable

# OR, if checking out a release branch for the first time
git switch -c <release-branch> upstream/<release-branch>
```

### Step 2: Action cherry-picks and pull requests

New changes targeting a given release need to be replicated from `main` onto the release branch, via either a cherry-pick or pull request. See also [Releases Support Policy](./support.md#release-issues-and-pick-request-escalation).

```bash
# Make sure to update the release branch
git pull

# Cherry-pick relevant commits
git cherry-pick <commit-on-main>
```

> [!Warning]
> For any pick requests or merge requests for Hermes, notify a Meta Release Crew member. They'll need to publish and pick the [Hermes release](./guide-hermes-release.md) into the release branch. Do not proceed past step 3 until the the branch has been updated with the Hermes release.

### Step 3: Wait for Github Actions artifacts to build

Once all picks are complete, push your changes to the remote release branch.

```
git push
```

This will kick off a Github Action workflow called [Test All](https://github.com/facebook/react-native/actions/workflows/test-all.yml) that will build relevant artifacts (Hermes prebuilts, `RNTester.apk`) that will expedite local testing.

[Navigate to Github Actions](https://github.com/facebook/react-native/actions/workflows/test-all.yml) and wait for the `build_npm_package` job to complete successfully (~30min into the `test-all` workflow). If the job fails, try and fix the issue so that the artifacts build.

<img src="https://github.com/user-attachments/assets/d1226a8d-2215-4580-aa98-3c9d3b630059" width="600" />


> [!Important]
> Release testing will only use the artifacts from the last workflow that ran on your release branch! This means that if you push more changes to your release branch, you must wait for it to complete the `build_npm_package` job again to use those artifacts in testing.
>
> The takeaway here is to try and **avoid pushing more commits to CI at this point**. Otherwise, you'll have to wait for CI to build the assets again to use them in your testing.
>
> See [Github Actions Artifacts](./gotchas.md#github-artifacts) for more details.

### Step 4: Test the release

Follow the [Release Testing guide](./guide-release-testing.md). Ideally, we should have 2 Release Crew members test the release. Coordinate with another Release Crew member to do a second pass.

There may be exceptional cases where we can bypass 2 release tests or only do selective tests, based on circumstances. **Ensure a Meta Release Crew member is aware and approves**.

### Step 5. Create release
Starting from React Native 0.75, a new release is created using a Github Action workflow called [Create Release](https://github.com/facebook/react-native/actions/workflows/create-release.yml).

<img src="../assets/create_release.png" width="600" />

The workflow requires 4 parameters:
1. The `branch` we need to use to cut the release. Make sure to set it to your stable branch. e.g.: `0.75-stable`
1. The `version` we want to publish. For example, `0.75.0-rc.0`.
1. Check the `latest` checkbox, if you are publishing a patch on the [latest version](./glossary.md#latest-version).
1. The last checkbox is for a dry-run. If you need to run a release, keep it unchecked.

This runs the *Create Release* workflow.  It'll sync package versions ([publish-bumped-packages.yml](https://github.com/facebook/react-native/blob/main/.github/workflows/publish-bumped-packages.yml)), commit and publish a tag ([create-release.yml](https://github.com/facebook/react-native/blob/main/.github/workflows/create-release.yml)):

<img src="https://github.com/user-attachments/assets/d39492bf-0cc3-40da-befd-d1e81855e328" width="600" />

The new tag will then launch a **Publish Release** ([publish-release.yml](https://github.com/facebook/react-native/blob/main/.github/workflows/publish-release.yml#L2-L6)) workflow which builds and publishes the `react-native` npm package artifact:

<img src="../assets/release_process_jobs_gha.png" width="600" />

### Step 6: Verify Release

Once all workflows above are complete, verify the following:

#### Verify npm publishes

Verify that `react-native` is published on npm with the correct tag.

```sh
npm view react-native

# Also verify that one or more subpackages are published
npm view @react-native/codegen
```

#### Init a new template app

Sanity check by initializing a new project and running for Android and iOS.  We suggest setting the version as an environmental variable, having a [GitHub personal token](https://github.com/settings/tokens/new?description=React%20Native%20Releases&scopes=repo) and the [Github CLI tools](https://cli.github.com/) installed to make it easy to copy-pasta these verifications:

```
export NEW_VERSION="v0.76.0-rc.3" # Should be prefixed with a 'v'
export GITHUB_TOKEN=<your token>
```

Verify the `template`:

```
export VERSION=${NEW_VERSION#v}
npx @react-native-community/cli@latest init "ReactNative${VERSION//./_}" --version "$VERSION"
```

> [!Tip]
> Keep this project around somewhere incase you need to repro something on this version.

<details>
  <summary><b>Backup:</b> How do I manually create a template for this version?</summary>

Run the [Release](https://github.com/react-native-community/template/actions/workflows/release.yaml) workflow, making sure you use the correct branch.  For example with the `0.76.*` releases you would use the [0.76-stable](https://github.com/react-native-community/template/tree/0.76-stable) branch:

<img src="https://github.com/user-attachments/assets/b97f2dcb-430f-4b4d-88d6-ef7e482c01c5" width="600" />

You will need separate additional permissions to do this, reach out to the **release crew** on Discord for help.

</details>

#### Verify Upgrade Helper is updated

The `publish_release` job should also trigger the `rn-diff-purge` GitHub action ([link](https://github.com/react-native-community/rn-diff-purge/actions/workflows/new_release.yml)). This action will update the [Upgrade Helper](https://react-native-community.github.io/upgrade-helper/) with a diff of your latest release patch. Verify your release is visible in the dropdown.

<img alt="Upgrade helper" src="../assets/upgrade_helper.png" width="600" />

**Common Issues:**
<details>
  <Summary>Why can't I see the upgrade helper diff between last set of releases, e.g. 0.75.4 → 0.76.0-rc.3?</Summary>
  
  ### Cause:
  <code>rn-diff-purge</code> has to be run in order.  That means 0.75.4 must be run before 0.76.0-rc.3.  Sometimes during releases this can happen out of order when people don't anticipate having to coordinate.
  
  ### Fix:
  I'm going to use the above versions as examples, replace with your affected versions.
  1. Delete the tags:
  
  ```bash
  git push --delete origin 0.75.4
  git push --delete origin 0.76.0-rc.3
  ```
  
  2. Delete the versions from [RELEASES](https://github.com/react-native-community/rn-diff-purge/commit/1a42eedbd830ca3c2e0ae62247ad992df69bf16f)
  3. Manually <em>publish</em> by calling the Github action in order: 0.75.4 first then 0.76.0-rc.3
  4. Confirm this is fixed: [https://react-native-community.github.io/upgrade-helper/?from=0.75.4&to=0.76.0-rc.3](https://react-native-community.github.io/upgrade-helper/?from=0.75.4&to=0.76.0-rc.3)
</details>

<details>
  <summary><b>Manually Publish:</b> How do I add an entry in the Upgrade Helper for this version?</summary>
  If there is a failure and you manually want to add your new tag to the `upgrade helper`, use:

```bash
curl -X POST https://api.github.com/repos/react-native-community/rn-diff-purge/dispatches \
            -H "Accept: application/vnd.github.v3+json" \
            -H "Authorization: Bearer $GITHUB_TOKEN" \
            -d "{\"event_type\": \"publish\", \"client_payload\": { \"version\": \"$NEW_VERSION\" }}"
```
</details>

#### Verify assets have been uploaded to Maven

Verify release assets are uploaded to [Maven](https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts) for your release.

Note, this may take a moment to update. Later, we will link to some of these artifacts in the release notes.

```bash
export VERSION=${NEW_VERSION#v}
curl -I https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/$VERSION/react-native-artifacts-$VERSION-hermes-framework-dSYM-debug.tar.gz
curl -I https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/$VERSION/react-native-artifacts-$VERSION-hermes-framework-dSYM-release.tar.gz
```

### Step 7: Generate the changelog PR

Now we need to update the [`CHANGELOG.md`](https://github.com/facebook/react-native/blob/main/CHANGELOG.md) file at the `react-native` repo root.

> [!Note]
> Changelog commits must be submitted to the `main` branch.

```bash
# Check out `main` branch
git switch main

# Pull new tags
git fetch --all --tags
git pull

BASE_VERSION=$(git tag --sort=-creatordate  | grep -E '^v0\.' | head -n2 | tail -n1)

# Generate the changelog
npx @rnx-kit/rn-changelog-generator \
  --base $BASE_VERSION
  --compare $NEW_VERSION \
  --repo . \
  --changelog ./CHANGELOG.md
  --token $GITHUB_TOKEN
```

You'll likely need to reformat the generated `CHANGELOG.md` changes and reorder the heading to keep the latest release ordering. Once done, create a PR with your changes against `main`.

### Step 8: Create the GitHub Release

Create a new [GitHub release](https://github.com/facebook/react-native/releases).

- Set the release tag to the newly created tag.
- Set the title to the release version (without preceding "v").
- Set release type:
  - Select "Set as a pre-release" if you releasing a release candidate.
  - Select "Set as the latest release" if you releasing a patch for the [latest version](./glossary.md#latest-version).
- Run the below template generation from the changelog commit, pasting it in the release description:

```bash

cat <<EOF | pbcopy
<!-- TODO Copy and paste your formatted Changelog generated here. -->
$(git show --patch | grep '^+[^+]' | sed 's/^\+//')

---

<!-- TODO Update these links for your release version -->
Hermes dSYMS:
- [Debug](https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/$VERSION/react-native-artifacts-$VERSION-hermes-framework-dSYM-debug.tar.gz)
- [Release](https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/$VERSION/react-native-artifacts-$VERSION-hermes-framework-dSYM-release.tar.gz)

---

You can file issues or pick requests against this release [here](https://github.com/reactwg/react-native-releases/issues/new/choose).

---

To help you upgrade to this version, you can use the [Upgrade Helper](https://react-native-community.github.io/upgrade-helper/) ⚛️.

---

View the whole changelog in the [CHANGELOG.md file](https://github.com/facebook/react-native/blob/main/CHANGELOG.md).
EOF
```

### Step 9: Communicate Release

Send a message in the Core Contributors Discord `#release-coordination` channel about the new release.

```bash
PULL_REQUEST=$(gh pr view --json url --jq '.url')
cat <<EOF | pbcopy
📢 $VERSION release is out!

📦 https://github.com/facebook/react-native/releases/tag/v$VERSION
📝 https://github.com/facebook/react-native/pull/$PULL_REQUEST
EOF
```

### Step 10: Update Podfile.lock on the release branch

Everytime we release a new version, there is a new `hermes-engine` version published. We need to update `packages/rn-tester` to use this new version. This is in preparation for the next release from this branch.

```bash
# Check out release branch
git switch <release-branch>

# Pull new changes (should include release commit from CI)
git reset --hard origin/<release-branch>

# Head to rn-tester package and update pods
rm -rf packages/react-native-codegen/lib
(cd packages/rn-tester && bundle exec pod update hermes-engine --no-repo-update)

# Commit only changes to packages/rn-tester/Podfile.lock
git add packages/rn-tester/Podfile.lock
git commit -m "Update Podfile.lock" -m "Changelog: [Internal]"
git push
```

### Step 11: Update GitHub Project

Make sure you've updated the status of completed and ongoing tasks in the relevant [GitHub project](https://github.com/reactwg/react-native-releases/projects?query=is%3Aopen). Unresolved items can be assigned to the following release.

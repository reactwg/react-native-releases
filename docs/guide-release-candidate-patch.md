# Releasing a Patch

> [!Note]
> Documents in this section go over steps to run different types of React Native release updates. Its intended audience is those in [relevant release roles](./roles-and-responsibilities.md).

### Pre-requisites

- You have some pick requests that qualify for a new Release Candidate (RC) patch in the "road to 0.XX.0" [discussion](https://github.com/reactwg/react-native-releases/discussions).
- Write access to [react-native](https://github.com/facebook/react-native) repository.
- Write access to [releases](https://github.com/reactwg/react-native-releases) repository.
- One CircleCI personal API token - see [here](https://circleci.com/docs/2.0/managing-api-tokens/#creating-a-personal-api-token) how to set one.

### 1. Check out the latest version from release branch

```bash
# Be on relevant release branch
# update the stable branch with tags
git pull origin <release-branch> --tags
git checkout -b <release-branch>

# cherry pick relevant commits
git cherry-pick <commit-hash>
```

### 2. Bump monorepo packages

Update all packages in the monorepo that were modified by the cherry picks. You can do it by running:

```sh
yarn bump-all-updated-packages # All the package bumps should be on the patch level
git push origin 0.XX-stable
```

After pushing, the CI will take care to publish the new packages automatically.

### 3. Test the current changes

Before continuing further, follow the [testing guide](./guide-release-testing.md) to ensure the source code doesn't have any major issues.

> [!Note]
> Since testing is a time consuming activity (>1 hrs) it is recommended that the release crew coordinates on the steps above then do testing on at least two separate systems in an async way.


### 4. Run `trigger-react-native-release` script

```bash
# once verified all the cherry-picked commits, we can push them to remote
git push

# run a script to bump the version
# You **do not** want this release marked as "latest"!
yarn trigger-react-native-release --to-version 0.y.0-rc.x --token <YOUR_CIRCLE_CI_TOKEN>
```

### 5. Watch CircleCI to ensure right jobs are being triggered

- Once you have run the bump script script, head to CircleCI and you should see under the releases workflow, a `prepare-package-for-release` job.

  <figure>
    <img width="400" alt="CircleCI showing publish release" src="https://user-images.githubusercontent.com/1309636/150040711-cfbc2fe3-91eb-42b9-bd06-de2aa7fb94ea.png"/>
    <figcaption>CircleCI showing publish release.</figcaption>
  </figure>

- Once complete you should be able to run `npm view react-native` and verify that under the `next` tag, the version is the expected release version.

  ```bash
  npm view react-native
  ...
  dist-tags:
  latest: 0.(y-1).1            next: 0.y.0-rc.x         nightly: 0.0.0-f617e022c
  ```

### 6. Create a GitHub Release

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


### 7. Update the relevant discussion post with the latest RC

Go back to the "road to 0.XX.0" [discussion](https://github.com/reactwg/react-native-releases/discussions) and update the "Current release candidate" line with the new version you published.

### 8. Broadcast that release candidate is out

Once all the steps above have been completed, it's time to signal to the community that the new RC is available for testing! Do so in the following channels:

- RN Discord `#releases-coordination`

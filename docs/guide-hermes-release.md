# Publish and Pick a Hermes Release

> [!Important]
> Only Meta release crew should publish Hermes releases. If you are a community releaser that is picking a Hermes pick request, ping a Meta release crew member to publish the Hermes release.

Prerequisites: You'll need access to the [Hermes repo](https://github.com/facebook/hermes). You can give yourself permission via the Meta Internal OSS dashboard.

## Step 1: Check-out or create the Hermes release branch

### If you are cutting a release candidate
Create a Hermes release branch of the form `rn/<major>.<minor>-stable` from latest `main`.

Make sure your branch is pushed to the remote.

```
# Run this in the Hermes repo:
git checkout main
git pull origin main
git checkout -b rn/0.76-stable
git push origin HEAD
```

### For stable patch releases

Check out the Hermes release branch for your minor. It should be of the form `rn/<major>.<minor>-stable`.

> [!Tip]
> If one doesn't exist and you are not releasing a release candidate, use the [latest tag](https://github.com/facebook/hermes/tags) for your minor. Check out that tag, and create the branch of the form `rn/<major>.<minor>-stable`. We should be creating these during release candidate cuts.

## Step 2: Cherry-pick

> [!Important]
> If you cutting a release candidate, skip this step

Pick the relevant commits onto that branch. The pick requests should be from `main` and no other branch on Hermes.

Push the picks to the remote branch.

## Step 3: Publish Tag

Head to the [Publish Tag workflow](https://github.com/facebook/hermes/actions/workflows/create-tag.yml) in the Hermes repo.

Click the "Run Workflow" button. Run the workflow from `main`, input the React Native version you are releasing (ex. 0.78.1), and the SHA of the head of your Hermes release branch.

<figure>
<img src="../assets/hermes_publish_tag.png" width="400" />
</figure>

Once the workflow is complete, it will create a new tag with the release you inputed and SHA. See [Hermes tags](https://github.com/facebook/hermes/tags)


## Step 4: Bump the Hermes version on the React Native release branch

Using the newly generated Hermes tag run the following script on the React Native release branch:

```bash
# Replace <the_hermes_tag> with the tag that will look like 'hermes-2022-07-20-RNv0.70.0-bc97c5399e0789c0a323f8e1431986e207a9e8ba'
./packages/react-native/scripts/hermes/bump-hermes-version.js -t <the_hermes_tag>
```

Add and commit the extra file that got created at packages/react-native/sdks/hermes/.hermesversion. Now you can continue with the rest of your React Native release.

# To do

Work the copilot still needs, in order. Remove an item when it lands, git keeps the history.

## Land the removal of the generated changelog PR

The copilot's `changelog` step now opens the changelog PR itself (`scripts/generate-changelog.mjs`) and defers to the bot wherever the release branch's publish workflow still has the `generate_changelog` job. What is left:

- Land the `react/react-native` PR that removes the job from `.github/workflows/publish-npm.yml` on `main`, with `generate-changelog.yml`, `generateChangelog.js` and its test. It also drops the job from `create_draft_release`'s `needs` and `if`, which would otherwise stop the draft release being created.
- It takes effect from the first branch cut after it lands, since the publish workflow runs from the tag's branch. 0.88.x keeps the bot PR unless the removal is picked onto `0.88-stable`. Decide whether to pick it or let 0.88 age out.
- Once no supported branch has the job, delete the deferral to it in `generate-changelog.mjs` and the "close the empty bot PR" note in the `changelog` step.

# To do

Work the copilot still needs, in order. Remove an item when it lands, git keeps the history.

## Drop the generated changelog PR from the publish workflow

**When:** after 0.88.0 ships, not during it.

`publish-npm.yml` calls `generate-changelog.yml` (job `generate_changelog`) on every release publish. It opens a PR with every section present, empty or not, an `Unknown` bucket and no scope prefixes, and every one gets curated by hand (`changelog.md`). The copilot already produces the curated section itself: prefixes, sorting, no empty sections and the combined `.0` section from `combine-changelog.mjs`.

Before removing the job:

- The copilot has to **create** the changelog change, not just curate one. This is already true of a `.0`, where the bot opens nothing and the consolidation is done by hand ([#59122](https://github.com/react/react-native/pull/59122) for 0.88), so start there. Today the `changelog` step edits the bot's PR after importing it, so taking the bot away leaves that step with nothing to edit. Give it an action that writes the curated section to `CHANGELOG.md` on `main` and opens the change for review, declared with its impact like every other mutating step.
- Remove the `generate_changelog` job from `react/react-native` `.github/workflows/publish-npm.yml` on `main`, and `generate-changelog.yml` plus `.github/workflow-scripts/generateChangelog.js` if nothing else calls them.
- The publish workflow runs from the release branch, so existing `*-stable` branches keep opening the bot PR until the removal is picked onto them. Decide whether to pick it or let those branches age out.
- Update `changelog.md`, the `changelog` step note in `scripts/phases.mjs` and the "triggers ... the changelog PR" impact line on the publish action, which all describe the bot PR.

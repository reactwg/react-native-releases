## release-copilot evals

15/15 scenarios pass.

### Scenarios

| Scenario | Phase | Result | What it proves |
| --- | --- | --- | --- |
| `branch-cut-rc0-clean` | branch-cut | pass | The once-per-8-weeks flow. Exercises the steps no other scenario reaches: external deps, branch creation, the Hermes gate and the main version bump. |
| `rc-incremental-clean` | rc | pass | The weekly flow. Must reach publish with the right arguments and must NOT re-run branch-cut work. |
| `rc-blocked-breaking-change` | rc | pass | 0.88 shipped three of these. The sweep must hard-stop before publish, not warn. |
| `rc-blocked-truncated-scan` | rc | pass | The compare API caps at 250 commits over a 554-commit range. A partial scan must refuse to judge rather than report clean. |
| `rc-blocked-red-ci` | rc | pass | Never publish on red. The stop must come before the artifacts step, since release testing uses artifacts from the last run. |
| `rc-blocked-hermes-mismatch` | rc | pass | 0.88 needed a Hermes pick mid-cycle, at rc.1, not at the branch cut. A mismatch means the branch consumes a different Hermes than it claims. |
| `rc-blocked-open-pick` | rc | pass | An unactioned pick means the release ships without a change someone asked for or with an undecided one. |
| `rc-blocked-prerelease-taking-latest` | rc | pass | Would point every `npm install react-native` at an RC. The single most damaging mistake available in this flow. |
| `rc-blocked-workflow-dryrun-default` | rc | pass | create-release defaults dry-run to true. Forgetting it produces a GREEN run that published nothing, indistinguishable from success. |
| `rc-blocked-tag-exists` | rc | pass | create-release guards on tag absence and SKIPS silently, producing a green run that did nothing. |
| `promote-to-stable` | promote | pass | The only flow where the npm latest tag legitimately moves and the only one with post-promotion follow-ups. |
| `rc-blocked-hermes-behind` | rc | pass | A consistency check between the two pin files cannot see this. Two unreleased Hermes commits sat on the 0.88 branch unnoticed, one re-landing a change backed out for a SIGSEGV. |
| `picks-blocked-breaking-candidate` | rc | pass | noBreakingChanges only sees what is already on the branch, so alone it catches a breaking change after it has been picked and pushed. This stops it at the candidate stage. |
| `picks-blocked-unassessed` | rc | pass | An unassessed candidate must block rather than pass. Absence of evidence is not evidence of safety. |
| `rc-blocked-offtip-red` | rc | pass | Filtering CI to the tip SHA hid a red "Validate C++ API Snapshots" on the very commit that shipped 0.88.0-rc.2, because a Podfile.lock-only tip did not re-trigger it. |

### Agenda coverage

Every step the release docs prescribe, the phase step implementing it and the scenarios that reach it.

| Documented step | Source | Implemented by | Exercised by |
| --- | --- | --- | --- |
| Check out release branch locally | guide-release-process.md Step 1 | `checkout` | `rc-incremental-clean`, `rc-blocked-breaking-change`, `rc-blocked-truncated-scan`, `rc-blocked-red-ci`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `rc-blocked-hermes-behind`, `picks-blocked-breaking-candidate`, `picks-blocked-unassessed`, `rc-blocked-offtip-red` |
| Update external dependencies table | guide-release-candidate.md 0 | `external-deps` | `branch-cut-rc0-clean` |
| Create release branch + template branch | guide-release-candidate.md 1 | `create-branches` | `branch-cut-rc0-clean` |
| Create a Hermes release and pin it | guide-release-candidate.md 2 | `hermes` | `branch-cut-rc0-clean` |
| Trigger a nightly | guide-release-candidate.md 3 | `nightly` | `branch-cut-rc0-clean` |
| Action cherry-picks and pull requests | guide-release-process.md Step 2 | `picks` | `rc-incremental-clean`, `rc-blocked-breaking-change`, `rc-blocked-truncated-scan`, `rc-blocked-red-ci`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `rc-blocked-hermes-behind`, `picks-blocked-breaking-candidate`, `picks-blocked-unassessed`, `rc-blocked-offtip-red` |
| Sweep for breaking changes (non-breaking series) | release-cadence.md gating | `breaking-sweep` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `rc-blocked-breaking-change`, `rc-blocked-truncated-scan`, `rc-blocked-red-ci`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `rc-blocked-hermes-behind`, `rc-blocked-offtip-red` |
| Wait for Github Actions artifacts to build | guide-release-process.md Step 3 | `artifacts` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `rc-blocked-red-ci`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `rc-blocked-hermes-behind`, `rc-blocked-offtip-red` |
| Test the release | guide-release-process.md Step 4 | `test` | `rc-incremental-clean`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `rc-blocked-hermes-behind` |
| Pre-flight checks before publishing | guide-release-process.md Step 5 | `pre-flight` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `rc-blocked-hermes-mismatch`, `rc-blocked-open-pick`, `rc-blocked-prerelease-taking-latest`, `rc-blocked-workflow-dryrun-default`, `rc-blocked-tag-exists`, `promote-to-stable`, `rc-blocked-hermes-behind` |
| Create release | guide-release-process.md Step 5 | `publish` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Verify release | guide-release-process.md Step 6 | `verify-publish` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Update CHANGELOG.md | guide-release-process.md Step 7 | `changelog` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Create the GitHub release | guide-release-process.md Step 8 | `github-release` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Communicate release | guide-release-process.md Step 9 | `announce` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Keep the release-crew status message current | guide-release-process.md intro | `status-message` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Ensure Podfile.lock is updated | guide-release-process.md Step 10 | `verify-publish` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Update GitHub project | guide-release-process.md Step 11 | `board` | `branch-cut-rc0-clean`, `rc-incremental-clean`, `promote-to-stable` |
| Bump main to the next minor | guide-release-candidate.md 12 | `bump-main` | `branch-cut-rc0-clean` |
| Update the support policy table | guide-release-candidate.md promote 2 | `support-table` | `promote-to-stable` |
| Ship blog post | guide-release-candidate.md promote 3 | `blog` | `promote-to-stable` |
| Cut a new website version | guide-release-candidate.md promote 4 | `website-version` | `promote-to-stable` |

Every documented step is implemented and exercised.

# Release CLI (`rn-release-automator`)

> [!TIP]
> `rn-release-automator` is the **recommended** way to run a React Native release. It walks you through every phase of a release with interactive prompts, pre-flight checks, and GitHub API integrations — so you don't have to remember each manual step.
>
> Every guide in this repo now leads with the relevant CLI command and keeps the manual steps available in collapsible **Manual steps** sections for reference or fallback.

## Quick start

Run the interactive menu — no install required:

```sh
npx rn-release-automator@latest
```

Pick what you want to do from the menu, or invoke a command directly:

```sh
npx rn-release-automator@latest status
npx rn-release-automator@latest prepare-release --series 0.85
npx rn-release-automator@latest publish --version 0.85.0-rc.1
```

Use `--help` on the CLI or any command to see the available flags:

```sh
npx rn-release-automator@latest --help
npx rn-release-automator@latest cut-branch --help
```

## Always dry-run first

> [!CAUTION]
> Before any command that **creates branches, comments on issues, triggers workflows, or otherwise mutates remote state**, run it once with `--dry-run`.
>
> Dry-run skips all mutations but still runs the read-only checks (CI status, npm queries, pick analysis, branch checks), so you can preview exactly what the command *would* do. Every interactive prompt shows a red `DRY RUN` badge while it's active.

```sh
# Preview, then run for real
npx rn-release-automator@latest cut-branch --series 0.85 --dry-run
npx rn-release-automator@latest cut-branch --series 0.85
```

The commands that mutate remote state — and therefore should always be dry-run first — are:

- `cut-branch` — creates the stable branch, template branch, and commits/pushes the Hermes bump
- `create-github-project` — clones a GitHub Project and deletes copied items
- `prepare-release` — comments `@react-native-bot merge …` and can close pick requests
- `publish` — triggers the `create-release.yml` workflow

`--dry-run` can also be passed globally, before the command, and it applies to the whole run:

```sh
npx rn-release-automator@latest --dry-run
```

## Prerequisites

- **Node.js** >= 18
- **[GitHub CLI](https://cli.github.com/) (`gh`)** authenticated — `gh auth login`
- **Git** with push access to `facebook/react-native`
- For GitHub Projects (`create-github-project`, `verify-release`): `gh auth refresh -s read:project,project`

The CLI auto-discovers your GitHub token from the `GITHUB_TOKEN` environment variable, falling back to `gh auth token`. Run `init` to verify everything is set up:

```sh
npx rn-release-automator@latest init
```

`init` checks your tools, tokens, and access to the four repositories the CLI touches, and tells you whether your GitHub user is on the [`@react-native-bot` allow-list](https://github.com/reactwg/react-native-releases/blob/main/.github/workflows/react-native-bot-merger.yml) (needed to use bot merges during `prepare-release`).

## Command reference

Commands are either **series-scoped** (`--series 0.85`) or **version-specific** (`--version 0.85.0-rc.1`).

| Command | Input | What it does | Guide |
|---------|-------|--------------|-------|
| `init` | — | Validate environment — tools, tokens, repo access, bot merger list | [Onboarding](./roles-and-responsibilities.md#onboarding-to-release-crew) |
| `status` | `--series` or none | Overview of all release series, or details for one | — |
| `cut-branch` | `--series` | RC0 branch cut — CI check, create stable & template branches, notify #cli, trigger nightly, Hermes bump | [Release Candidate](./guide-release-candidate.md#cut-a-release-candidate) |
| `create-github-project` | `--series` | Clone and configure a GitHub Project for the release | [Project Setup](./guide-release-project-setup.md) |
| `prepare-release` | `--series` | Analyze pick requests, determine the next version (RC / stable / patch), process picks via bot | [Release Process](./guide-release-process.md#step-2-action-cherry-picks-and-pull-requests) |
| `publish` | `--version` | Pre-flight checks, trigger `create-release.yml`, monitor | [Release Process](./guide-release-process.md#step-5-create-release) |
| `test-release` | `--version` | Verify repo/branch, clean env, download prebuilds, print the test matrix | [Release Testing](./guide-release-testing.md) |
| `verify-release` | `--series` | 8-step post-release verification (npm, template, upgrade helper, Maven, changelog, GitHub release, communicate, project) | [Release Process](./guide-release-process.md#step-6-verify-release) |
| `post-promotion` | `--series` | Update support policy table, ship blog post, cut a new website version | [Promote to stable](./guide-release-candidate.md#promote-release-candidate-to-stable) |
| `communicate` | `--version` | Generate announcement templates (status tracker, Discord, GitHub release body) | [Release Process](./guide-release-process.md#step-9-communicate-release) |

## Typical workflow

A full release-candidate cycle, in order:

```sh
# 1. Verify your environment
npx rn-release-automator@latest init

# 2. Cut the stable branch (RC0 only) — dry-run first!
npx rn-release-automator@latest cut-branch --series 0.85 --dry-run
npx rn-release-automator@latest cut-branch --series 0.85

# 3. Set up the tracking project (new minor only) — dry-run first!
npx rn-release-automator@latest create-github-project --series 0.85 --dry-run
npx rn-release-automator@latest create-github-project --series 0.85

# 4. Cherry-pick fixes and choose the next version — dry-run first!
npx rn-release-automator@latest prepare-release --series 0.85 --dry-run
npx rn-release-automator@latest prepare-release --series 0.85

# 5. Trigger the release — dry-run first!
npx rn-release-automator@latest publish --version 0.85.0-rc.0 --dry-run
npx rn-release-automator@latest publish --version 0.85.0-rc.0

# 6. Test the release (RC0, RC1, RC4, stable)
npx rn-release-automator@latest test-release --version 0.85.0-rc.0

# 7. Verify the published release
npx rn-release-automator@latest verify-release --series 0.85

# 8. Announce it
npx rn-release-automator@latest communicate --version 0.85.0-rc.0
```

For a **patch release** on an existing stable series, skip steps 2–3 and start at `prepare-release` (it will offer the next patch version automatically).

For **promoting an RC to stable**, run `prepare-release` and choose *Promote to stable*, then `publish`, `verify-release`, and finally `post-promotion`.

> [!NOTE]
> The CLI covers the React-Native-side of the [Hermes release](./guide-hermes-release.md) (it prompts you through the version bump during `cut-branch`), but **publishing the Hermes tags themselves is still a manual, Meta-only step**. Follow the Hermes guide when prompted.

# Creating a New Release's Project

For every MINOR release, we create a Github Project to manage pick requests.  You will need to:
- create a project
- give the release crew access
- update the status
- enable the `auto-add to project` workflow to make sure picks are visible to the correct project version
- make the project publicly visible

> [!TIP]
> This is automated by `create-github-project`. It clones an existing project, renames it (`React Native 0.<minor>`), sets the description from the release schedule, makes it public, clears the copied items, and opens the pages where the remaining manual bits (crew access, status, auto-add workflow) are configured.
>
> **Preview with `--dry-run` first**, then run it for real:
>
> ```sh
> npx rn-release-automator@latest create-github-project --series 0.85 --dry-run
> npx rn-release-automator@latest create-github-project --series 0.85
> ```
>
> GitHub Projects need the `project` scope — the CLI offers to run `gh auth refresh -s read:project,project` if it's missing.

<details>
  <summary><b>Manual steps</b> — set up the project from the GitHub UI</summary>

Navigate to the **reactwg** projects page: https://github.com/orgs/reactwg/projects

## Copy the current release

### Clone
<img src="https://github.com/user-attachments/assets/6f06d1ad-4e32-4367-96c1-eab78c955f16" width="600px" />

### Update the name 
<img src="https://github.com/user-attachments/assets/453f81d4-8313-4dea-80b9-e56454ad551c" width="600px" />

### Give the release crew access
<img src="https://github.com/user-attachments/assets/e6bfaef6-d77c-4a54-880f-33fb5a7bb739" width="600px" />

## Update the status and project details
The format should be similar to the previous version.  You will have to know:
1. The release crew + github profile links
2. Target dates for: branch cut, release candidates, golden release and stable release.  Keep the status up to date throughout the release.

<img src="https://github.com/user-attachments/assets/8809efb1-52c8-4f35-9b70-e09062d3ba76" width="600px" />

## Add a `auto-add to project` workflow
Github need to have this workflow manually enabled:

https://github.com/user-attachments/assets/6adca6be-0abc-407d-9efc-26da693c5b3b

## Set project visibility to **public**
https://github.com/user-attachments/assets/ad6720e3-24d0-436f-9f53-0a1a7863d61b

</details>

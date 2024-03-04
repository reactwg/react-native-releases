# Release Roles & Responsibilities

Here we set guidelines to apply the "dividi et impera" approach to React Native releases: it is an involved process and we need to clarify the work to allow for easier rotations of folks in various positions.

In a standard situation, we expect that the Release Crew is composed of 2+2 releasers (two people from the community, two from Meta).

---

## Role Durations

- Release Crew shifts change at the scheduled retrospective and planning for the next release candidate.
- These roles are multi-month commitments
    - The intention is to prepare a new release candidate every 3 months.

## Role: Primary Meta Releaser

Owner for release coordination

### Role Responsibilities

- Drives weekly release status sync
    - Responsible for communicating status and keeping communication up to date
    - Triage/answer incoming concerns
    - If public holiday for the primary releaser, may cancel the meeting or delegate to another release crew member to run
- Responsible for coordinating out-of-office coverage with secondary Meta Releaser
- Responsible for all releases in the support window. See [supported versions](https://github.com/reactwg/react-native-releases#which-versions-are-currently-supported)
    - Owns decisions for the release candidate
        - Decides the cut and intended release date
        - Ensures release communication is completed (blog post, documentation updates)
    - Final call on release decisions
        - Ex. Decide when to release a patch on stable
        - Ex. Ambiguous calls on whether something should be picked
    - Ensures blocking issues have owners
- Coordinate with release crew to delegate work
- Responsible for scheduling the retrospective and kick-off for next release crew
- Finalizes the next release crew members

## Role: Secondary Meta Releaser

Back-up for Primary Meta Releaser

### Role Responsibilities

- Takeover as Primary Releaser when needed. Coordinate with Primary Releaser to get necessary context
- Attend release weekly release sync meetings
- Support with release decisions as with protocol, communicate and defer to Primary when unclear
    - Help decide when to promote pre-release to stable
    - Help decide when to release a patch on stable
    - Help decide which commits are part of which release
- Support in release work like Community Releaser


## Role: Community Releaser

Member of the React Native Core Contributor community. There are usually 2 Community Releasers per release.

### Role Responsibilities
- Attends 30 minute weekly release sync meeting
- Communicate when out-of-office / unavailable
- Commits at least 3 hours/week in release work like the following:
    - Release testing
    - Triage release issues and escalate to release crew
        - Ex. sources of release issues
            - Issues in react-native repo
            - Issues in releases repo
            - Issues reported in Community Contributor Discord
            - Online discussion
    - Perform a release
        - Complete picks (within protocol or as discussed with Primary releaser)
        - Ensures blocking issues have owners
        - Updates status of release work in relevant Github Projects and communication channels
        - Escalate to Primary Meta releaser when blocked
    - Support with release decisions, communicate and defer to Primary when unclear
        - Help decide when to promote pre-release to stable
        - Help decide when to release a patch on stable
        - Help decide which commits are part of which release
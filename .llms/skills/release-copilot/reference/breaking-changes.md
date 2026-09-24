# Breaking changes in a non-breaking release

Roughly every other release is **non-breaking**. A breaking change must not ship in
one. There are two ways to handle that, and the cheap one is the proactive sweep.

## Why this document exists

0.88 is non-breaking. [#57879](https://github.com/react/react-native/pull/57879)
changed the ObjC TurboModule ArrayBuffer type and shipped in rc.0 anyway, and was only
reverted a fortnight later after a user hit it.

It was **correctly annotated the whole time**:

```
## Changelog:
[IOS] [BREAKING] - Add `RCTArrayBuffer`, the ObjC representation of a JS `ArrayBuffer`...
```

and it appeared in the published rc.0 changelog under `### Breaking`, saying in plain
words that affected modules stop compiling. Nothing was hidden. No step in the process
ever compared the `Breaking` section against the fact that the release is non-breaking.

The lesson is not "annotate better". It is **read the annotations you already have.**

## The proactive sweep

Run at branch cut, and again before each RC, since picks can introduce one. Cheapest
signal first.

### 0. Pick the right baseline

"New in this series" means **not already shipped on the previous line**. The baseline
is the latest *published* version of the previous series, not its `.0`:

```
0.88 sweep baseline = v0.87.1   (the newest 0.87.x), NOT v0.87.0
```

A breaking change already in 0.87.1 went out on the breaking 0.87 line. 0.88 is not
introducing it, and anyone upgrading from 0.87.1 already has it. Using `.0` as the
baseline reports those as 0.88 regressions and sends you reverting things that are
not yours to revert.

Also **exclude anything already reverted on the branch**. A revert does not remove the
original commit from the range, so a naive scan keeps reporting a problem you fixed.
Match on `This reverts commit <sha>`.

### 1. The changelog Breaking section

Cheap, and worth running, but **not sufficient**. Measured on 0.88: the published rc.0
`Breaking` section listed **one** entry while the branch carried **three**
`[BREAKING]`-annotated commits. Curation drops things.

```sh
git show <tag>:CHANGELOG.md | sed -n '/^## v<version>/,/^## v/p' | sed -n '/^### Breaking/,/^### /p'
```

Anything there is either a mistake to revert, or a deliberate exception someone has to
sign off in writing. An empty section does **not** mean the release is clean.

### 2. Commit annotations, which are the source of truth

This is the reliable signal. On 0.88 it found all three; the changelog found one.

```sh
gh api repos/react/react-native/compare/v0.87.1...0.88-stable \
  --jq '.commits[] | select(.commit.message | test("\\[BREAKING\\]"; "i")) | "\(.sha[0:11]) \(.commit.message | split("\n")[0])"'
```

Then subtract anything reverted on the branch. The `noBreakingChanges` gate does both.

> [!CAUTION]
> **The compare endpoint caps at 250 commits** while still reporting the true size in
> `total_commits`. An unpaginated read of the 554-commit `v0.87.1...0.88-stable` range
> returned 250 and produced a confidently clean "3 breaking commits" when there were
> ten. Always paginate, compare the count against `total_commits`, and **fail rather
> than judge on a partial range**. A scan that cannot see the whole range must not
> return a verdict.

### 2b. Membership by content, not by SHA

Meta's import rewrites SHAs, so the same change exists on `main` and on a release
branch as two different objects. `git merge-base --is-ancestor` therefore reports a
false negative and makes changes that already shipped look new. Seven 0.87 changes
looked like 0.88 regressions this way.

Two reliable signals instead:

- **The CHANGELOG cites the main-side SHA** of everything each version shipped. Read it
  from `main`, not from the previous tag: changelog entries land on `main`, so a copy
  read at `v0.87.1` is stale. Sections are newest-first, so everything after the
  current series' earliest heading belongs to older releases.
- **Match subjects too, to catch re-lands.** A change can land twice under different
  PR numbers (#57420 then #57476, same subject) with the changelog citing only one.
  Normalise away the trailing `(#12345)` before comparing.

When still unsure, test by content: diff the actual public surface between the two
refs. The second Touchable commit looked like a new removal until the diff showed the
only change between 0.87.1 and 0.88 was line wrapping.

### 3. The codegen output contract

This catches the class that annotations miss: changes to what RN **emits for
third-party modules**. A consumer's own code stops compiling without RN's exported
symbols changing at all.

```sh
diff <(git show <prev-tag>:packages/react-native-codegen/src/generators/modules/__tests__/__snapshots__/GenerateModuleHObjCpp-test.js.snap) \
     <(git show <tag>:packages/react-native-codegen/src/generators/modules/__tests__/__snapshots__/GenerateModuleHObjCpp-test.js.snap)
```

Removed or changed signature lines are breaking candidates. On 0.88 this produced
exactly the right answer:

```
< - (void)voidArrayBuffer:(NSMutableData *)arg;
> - (void)voidArrayBuffer:(RCTArrayBuffer *)arg;
```

Do the same for the other generator snapshots (`GenerateModuleMm`, the Java and C++
generators) for Android and cross-platform equivalents.

### 4. The public API snapshots

```sh
diff <(git show <prev-tag>:scripts/cxx-api/api-snapshots/ReactAppleDebugCxx.api) \
     <(git show <tag>:scripts/cxx-api/api-snapshots/ReactAppleDebugCxx.api) | grep "^<"
```

Removed lines are candidates. Additions are safe.

**Known blind spot, measured:** this check would **not** have caught #57879. The
RCTArrayBuffer entries appear only as *additions*, because the breaking part was the
emitted contract, not RN's own surface. Run it, but never treat it as sufficient on its
own. Step 3 is the one that catches "your module stops compiling".

### 5. Surfaces with no snapshot

Judgement, not diffing. See the `breaking-change-detection` skill for the full method:

- Removed or renamed JS/TS exports, props or type fields
- Minimum version bumps: Node, Hermes, Metro, CLI, iOS deployment target, `minSdk`
- Changed defaults, event ordering or payload shape
- Stricter validation that now throws on previously accepted input

## The reactive path

Sometimes it surfaces after the cut, when someone integrates and hits it. Then:

1. **Confirm it is really breaking** before agreeing to anything. Use the
   `breaking-change-detection` skill and try to falsify the report with a concrete
   downstream snippet. Reverting on a mistaken report costs more than the report did.
2. **Check whether it is already documented.** If it is in the `Breaking` section, the
   question is not "is it breaking" but "why did we ship it", and the answer changes
   who decides.
3. **Scope the revert properly.** See `reverts.md`. The reported commit is often only
   part of it.
4. **Weigh it.** Late in a cycle, reverting has its own risk. A narrow, well-understood
   break with a documented migration may be the better outcome than a broad revert the
   day before the golden RC. Say which you are choosing and why.

## Where this is enforced

The `noBreakingChanges` gate automates signal 2 for a non-breaking series, with the
correct baseline and revert exclusion. Signals 1 and 3 to 5 need a human reading
diffs, so they are a step in the branch-cut and rc phases rather than a gate.

## Two different exemptions, do not conflate them

A `[BREAKING]` hit can be harmless for either of two unrelated reasons. They look
similar in a summary line and mean completely different things.

**1. The commit already shipped on the previous line.** It is in `v0.87.1`, so it went
out on the breaking 0.87 line and 0.88 is not introducing it. Handled by the baseline,
so it never reaches you.

**2. The commit is new, but the API it affects is also new.** It is absent from
`v0.87.1`, so it *is* new in 0.88, but the thing it constrains did not exist in the
previous release either. No consumer could have depended on it, so nothing breaks.

Case 2 is the one that needs a human. `#57982` is exactly it: annotated
`[Android][Breaking]`, genuinely new in 0.88, and harmless because the whole Java
ArrayBuffer TurboModule API is 0.88-only.

**Do not reason about this from dates.** `d84c13d5111` was authored 2026-08-17, nine
days *before* `v0.87.1` was tagged on 08-26, and is still not in it: it landed on
`main` after the 0.87 branch cut, so it never reached that line. Use ancestry:

```sh
git merge-base --is-ancestor <sha> v0.87.1 && echo "already shipped" || echo "new in this series"
```

## The reachability test

For a commit in case 2, the question is: **was the affected API reachable by a consumer
of the previous release?**

Check **per generator target**, because they disagree. `#58063` rejects
`EventEmitter<ArrayBuffer>`; on 0.87 `GenerateModuleObjCpp` already threw on it but
`GenerateModuleH` (`modulesCxx`) generated working code. Sampling one target and
generalising gives the wrong verdict, in either direction.

The reliable method is to run the spec through both branches' codegen and compare, not
to read the source:

```sh
# in a worktree of the previous release, and again on the branch
parser.parseString(SPEC, 'NativeSample.js')   // accepted or rejected?
generateModuleH.generate(...)                  // succeeded or threw?
```

If it generated on the previous release, check the output is functional rather than
placeholder, and that any `static_assert` it emits would actually pass. `#58063`
emitted a real `AsyncEventEmitter` plus a `static_assert` that holds, because
`Bridging<jsi::ArrayBuffer>` exists in 0.87 and is exported through the umbrella. That
is what made it a real break rather than a better error message.

## Other legitimate reasons a hit may stay

- **Already reverted.** Excluded automatically.
- **Mis-annotated.** Someone tagged `[BREAKING]` for something that breaks nothing.
  Confirm rather than trusting the label, in either direction.
- **A reviewed exception.** Rare, and it needs a written decision plus a prominent
  release-note entry. "We noticed late" is not an exception, it is a decision someone
  has to actually make.

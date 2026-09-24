# Reverting from a release branch

A revert is not "undo the commit named in the bug report". Scoping it wrongly ships a
second, quieter breaking change while everyone believes it was fixed.

## Scope it before you touch anything

The headline commit is rarely the whole story. Work out the full set first.

**1. Define the surface.** The files that carry the thing you are reverting, including
the generated public-API snapshots. For an ObjC TurboModule type that was:

```
packages/react-native-codegen/src/generators/modules/GenerateModuleObjCpp
packages/react-native/React/Base/RCTArrayBuffer.*
packages/react-native/ReactCommon/react/nativemodule/core/platform/ios/ReactCommon
packages/react-native/ReactCommon/react/nativemodule/core/iostests
scripts/cxx-api/api-snapshots
```

**2. List every commit on that surface that is not in the previous release.** Anything
already in the previous release is the baseline you are reverting *to*, so it stays.

```sh
for c in $(git log --format="%H" origin/0.88-stable -- $PATHS); do
  git merge-base --is-ancestor $c origin/0.87-stable 2>/dev/null && continue
  echo "$c $(git log -1 --format='%s' $c)"
done
```

**3. Filter to commits that actually change the thing.** Touching the directory is not
enough. Test the added and removed lines:

```sh
git show $c -- $PATHS | grep -E "^[+-]" | grep -v "^[+-][+-]" | grep -cE "<the symbols>"
```

**4. Blame the public API snapshot.** The generated `.api` files are the exported
surface. Every line mentioning the symbol should trace to a commit in your set. One
that does not is a commit you missed.

## The trap: a value can move more than once

The reason step 2 exists. On 0.88 the ObjC ArrayBuffer type moved **twice**, both
inside the same release:

| Point | Argument | Return |
| --- | --- | --- |
| 0.87 baseline | `NSMutableData *` | `NSMutableData *` |
| #57596 (0.88) | `NSMutableData *` | **`NSData *`** |
| #57879 (0.88) | `RCTArrayBuffer *` | `RCTArrayBuffer *` |

Only #57879 was reported. Reverting it alone leaves the return type as `NSData *`.
`NSMutableData` is a subclass of `NSData`, so any 0.87 caller that mutates the result
still fails to compile. You would ship the fix and the break at once.

**Always compare the end state against the previous release, not against the commit
you reverted.**

## Conflicts: adjacency is not dependency

Later commits will conflict. Before assuming they must be reverted too, check whether
they actually depend on what you are removing:

```sh
git show $c | grep -E "^[+-].*<the symbol>"
```

If the symbol appears **only in context lines**, never in a `+` or `-`, the commit
merely sits next to the code. Resolve by hand and keep it. Dropping useful fixes
because git could not separate them is a self-inflicted regression.

On 0.88, #58264 and #58190 both conflicted and both were kept on exactly this test.

## Resolving

- **Generated snapshots: regenerate, do not hand-edit.** `yarn jest <path> -u`. Then
  diff the result against the previous release and be able to explain every remaining
  difference. On 0.88 one line differed (`promiseArrayBuffer`), because a separate
  validation guard now rejects it. Known and deliberate is fine; unexplained is not.
- **Check default arguments before believing a signature mismatch.** A restored call
  site with three arguments against a four-parameter function looks broken but
  compiles when the header defaults the last one.
- **Grep for stragglers.** After resolving, the reverted symbols should appear
  nowhere: `grep -rn "RCTArrayBuffer\|mustCopyBytes" <surface>`.

## Verify against the previous release

The property worth checking is not "the revert applied" but "the surface matches the
release we are reverting to":

```sh
diff <(git show origin/0.87-stable:<file> | grep -E "<symbols>") \
     <(grep -E "<symbols>" <file>)
```

Do this for the codegen, the generated snapshot and any test file the revert touched.
A test file that ends up byte-identical to the previous release, plus known additive
commits, is strong evidence without needing a full native build.

## Order of operations

1. Confirm the scope, with the evidence above.
2. **Open the pick request first**, with the scope analysis in the body. It is the
   record of why this set and not another, and it is much harder to reconstruct later.
3. Revert, resolve, verify locally.
4. Push.
5. Comment with the resulting SHAs and close.

## What local verification cannot cover

JS and codegen tests run locally. The native build and the ObjC or Java unit tests do
not, so branch CI is the real gate for a revert touching native code. Say so plainly
rather than implying the change is fully verified.

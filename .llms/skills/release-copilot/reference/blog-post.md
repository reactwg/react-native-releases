# The release blog post

Every minor gets an announcement post in
[react/react-native-website](https://github.com/react/react-native-website) under
`website/blog/`. It is a collaborative document and the crew will rewrite much of it,
but **the first draft is the release captain's job**. Nobody else can start it, because
nobody else knows what actually went into the release.

## When

Start it **once the golden RC is the next release**. For a series where rc.5 is golden,
that means as soon as rc.4 is out.

Earlier is too speculative, since the content is still moving. Later does not leave the
crew time to iterate: the draft has to be reviewed, rewritten and turned into a PR
before `.0` ships and that is one week.

## Draft it

```sh
node scripts/draft-blog-post.mjs 0.88.0 --date <projected .0 date>
```

This reads the **most recent release post from the website repo** and follows its shape,
rather than carrying a copy of the template that would rot. When the team changes the
format, the next draft picks the change up on its own.

It fills in the parts nobody should count by hand:

- the commit total for `v<prev>.0...<series>-stable`,
- the contributor count, bots excluded,
- a ranked list of community contributors to choose the acknowledgements from.

Everything editorial is left as a marked `TODO`: the headline, the highlights, breaking
changes, deprecations and which contributors to thank and for what. Those are
judgement and a generated guess at them is worse than a blank.

The boilerplate tail, from `## Acknowledgements` onwards, is carried over from the live
post with the versions and counts substituted, so the support-policy wording and the
upgrade instructions stay whatever the team last shipped.

The ranked list is **candidates, not the answer**, for two reasons. It is ordered by raw
commit count, so the top of it is mostly Meta staff, while that section thanks community
members. And volume is not significance: the thank-you is for shipping something that
mattered, which is why each line carries a `for TODO` that has to be filled in or the
line deleted.

## Get it reviewed

The draft is reviewed as a **Google Doc**, not as a PR. Comment threads on a doc are how
the crew iterates on wording and a PR at this stage collects review on the wrong thing.

**At Meta:** the copilot creates the doc for you.

```sh
meta google.docs create --title "React Native 0.88 release post (draft)"
```

Then share it with the release crew and post the link in the crew channel.

**Outside Meta:** the copilot will ask whether you want the markdown to paste. You still
need to **create the Google Doc yourself and share it with the release crew for
feedback**. The doc is the review surface either way, so skipping it means the post
arrives as a PR nobody has read.

## Then open the PR

Once the doc has been reviewed and iterated on, open a PR against
`react/react-native-website` with the post at:

```
website/blog/<YYYY-MM-DD>-react-native-<series>.mdx
```

The date is the **actual `.0` publish date**, not the planning target from the schedule.
Those have drifted by up to six days.

**Final review happens on the PR.** The doc is for shaping the content, the PR is for
the last pass on the real file, including the things only the repo can show: links that
resolve, images that exist under `website/static/blog/assets/` and the site building.

## What stays the same every release

From the current template, the sections and the order:

```
frontmatter: title, authors, tags [announcement, release], date
# <same text as the title>
<intro: "Today we are excited to release React Native <series>!">
<one paragraph on what the release is>
### Highlights          (anchor links into the sections below)
{/* truncate */}
## Highlights           (one ### per highlight)
## Breaking Changes
## Deprecations
## Acknowledgements      (counts, then the thank-you list)
## Upgrade to <series>   (support-policy note, Upgrading, Create a new project, Expo)
```

Two details that are easy to get wrong:

- The support note retires **series minus three**. 0.88 shipping puts 0.85.x out of
  support, the same way 0.87 retired 0.84.x.
- `{/* truncate */}` controls the blog index excerpt. Everything above it is the preview,
  so the highlights list belongs above it and the detail below.

A non-breaking release still carries a `## Breaking Changes` heading. 0.86 did, with
nothing substantive under it. Anything that does appear there in a non-breaking release
needs a reason it shipped at all.

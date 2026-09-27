# The release blog post

Every minor gets an announcement post in
[react/react-native-website](https://github.com/react/react-native-website) under
`website/blog/`. It is a collaborative document and the crew will rewrite much of it,
but **the first draft is the release captain's job**. Nobody else can start it, because
nobody else knows what actually went into the release.

## When

Start it **once the golden RC is the next release**. rc.4 is the usual golden, so that
means as soon as rc.3 is out.

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

**Reading the doc back.** Outside contributors comment on and edit the doc, and
`meta google.docs` refuses a doc with an author outside Meta by default. Pass
`--untrusted-authors-mode` once you have confirmed those authors are the crew, e.g.
`meta google.docs get --id=<doc> --untrusted-authors-mode --output=ghtml`. Comment threads
come back inline as hidden `<aside>` blocks carrying their anchor text and status.

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

The date is **the day the post goes live**, which is the day the PR merges. It is not
the planning target from the schedule and not the `.0` publish date either: 0.88.0
published on 2026-10-15 and its post went live on 2026-10-16, dated 2026-10-19, the
projected date it was drafted with. So it went out dated three days in the future.

The date is in three places that have to agree: the filename, `date:` and every
Highlights link (`/blog/YYYY/MM/DD/react-native-<series>#...`). The `blog` step runs the
check and stops if they disagree or do not match the day it merges:

```sh
node scripts/check-blog-post.mjs 0.88                  # finds the open PR, expects today
node scripts/check-blog-post.mjs 0.88 --on 2026-10-16  # merging another day
```

Draft with whatever date and fix it at the PR. Once the post is live, changing the date
changes its URL, so it needs a redirect for anything already linking to it.

## Sync it with the X thread

The release is also announced in an X thread, which links the post. The post URL
contains the date, so get the date check green **before** the thread is drafted. The
thread owner (Alex Hunt for 0.88) drafts it from the final URL while the blog PR is
approved but unmerged. Then merge and post together, once the site has deployed, so the
link resolves the moment the thread goes out. The `social` step is the reminder.

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

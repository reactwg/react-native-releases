#!/usr/bin/env node
/**
 * Release blog post draft.
 *
 * Every minor gets an announcement post in react/react-native-website. It is a
 * collaborative document, but the first draft is the release captain's job, and
 * it has to exist early enough that the crew can iterate on it before `.0`.
 *
 * This writes that first draft. It reads the MOST RECENT release post from the
 * website repo and follows its shape, rather than carrying a copy of the
 * template here that would quietly rot: when the team changes the format, the
 * next draft picks the change up on its own.
 *
 * The parts nobody should type by hand are filled in from the actual range:
 * commit count, contributor count and a ranked list of community contributors
 * to pick the acknowledgements from. The editorial parts (title, highlights,
 * breaking changes) are left as marked TODOs, because those are judgement.
 *
 *   node scripts/draft-blog-post.mjs 0.88.0
 *   node scripts/draft-blog-post.mjs 0.88.0 --date 2026-10-19
 *   node scripts/draft-blog-post.mjs 0.88.0 --out /tmp/draft.mdx
 *
 * Prints the draft and where it was written. Creates nothing remote.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec = promisify(execFile);

const RN = 'react/react-native';
const SITE = 'react/react-native-website';
const BLOG_DIR = 'website/blog';

// Commits nobody wants to see thanked and the bots that make most of them.
const BOTS = /\[bot\]$|^react-native-bot$|^facebook-github-bot$|^meta-codesync/i;

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 64 * 1024 * 1024});
  return stdout;
}

function parseJSON(raw, fallback) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/** The most recent release post, which is the template to follow. */
async function latestReleasePost() {
  const names = parseJSON(await gh(['api', `repos/${SITE}/contents/${BLOG_DIR}`, '--jq', '[.[].name]']), []);
  const releases = names
    .filter(n => /^\d{4}-\d{2}-\d{2}-react-native-\d+\.\d+\.mdx$/.test(n))
    .sort();
  const name = releases[releases.length - 1];
  if (!name) {
    throw new Error(`no release post found in ${SITE}/${BLOG_DIR}, so there is no template to follow`);
  }
  // `--jq .content` prints the base64 as a RAW string, not as JSON. Parsing it
  // returned the empty fallback and the draft silently lost the template while
  // still reporting the right filename.
  const b64 = (await gh(['api', `repos/${SITE}/contents/${BLOG_DIR}/${name}`, '--jq', '.content'])).trim();
  const body = Buffer.from(b64, 'base64').toString('utf8');
  if (!/^authors:/m.test(body)) {
    throw new Error(`fetched ${name} but it does not look like a post, so the template cannot be trusted`);
  }
  return {name, body};
}

/** The series the template post announced, e.g. "0.87". */
function templateSeries(name) {
  return /react-native-(\d+\.\d+)\.mdx$/.exec(name)?.[1] ?? null;
}

/**
 * The boilerplate tail, carried over from the live template.
 *
 * Acknowledgements onwards is near-identical every release, so it is taken from
 * the real post rather than reproduced here, with the versions and counts
 * substituted. The editorial sections above it stay TODO.
 */
function tailFrom(template, {series, stats, contributors}) {
  const from = template.body.indexOf('## Acknowledgements');
  if (from < 0) {
    return null;
  }
  const prev = templateSeries(template.name);
  let tail = template.body.slice(from).trimEnd();

  if (prev) {
    const [major, minor] = prev.split('.').map(Number);
    // Retire series-minus-three, before the general substitution rewrites it.
    tail = tail.replaceAll(`${major}.${minor - 3}.x`, `${unsupportedSeries(series)}.x`);
    tail = tail.replaceAll(prev, series);
  }
  tail = tail.replace(
    /React Native [\d.]+ contains [\d,]+ commits from \d+ contributors/,
    `React Native ${series} contains ${stats.total} commits from ${contributors.length} contributors`,
  );
  // The thank-you list is per release and never carries over.
  return tail.replace(
    /(We want to send a special thank you[^\n]*\n)[\s\S]*?(?=\n## )/,
    (_m, lead) => `${lead}\n${contributorBlock(contributors)}\n`,
  );
}

function contributorBlock(contributors) {
  const top = contributors.slice(0, 8);
  return top.length
    ? top.map(c => `- [${c.name ?? c.login}](https://github.com/${c.login}) for TODO (${c.count} commits)`).join('\n')
    : '- TODO';
}

/**
 * Commits in the range, with their authors.
 *
 * Paginated and checked against total_commits: a truncated range would
 * undercount the contributors and an undercount here is a person left out of
 * the acknowledgements.
 */
async function commitsWithAuthors(base, head) {
  const commits = [];
  let total = 0;
  for (let page = 1; page <= 40; page++) {
    const res = parseJSON(
      await gh(['api', `repos/${RN}/compare/${base}...${head}?per_page=250&page=${page}`]),
      {},
    );
    total = res.total_commits ?? total;
    const batch = res.commits ?? [];
    if (batch.length === 0) {
      break;
    }
    commits.push(
      ...batch.map(c => ({
        login: c.author?.login ?? null,
        name: c.commit?.author?.name ?? null,
        subject: (c.commit?.message ?? '').split('\n')[0],
      })),
    );
    if (commits.length >= total) {
      break;
    }
  }
  return {commits, total, complete: commits.length >= total};
}

function rankContributors(commits) {
  const byLogin = new Map();
  for (const c of commits) {
    if (!c.login || BOTS.test(c.login)) {
      continue;
    }
    const seen = byLogin.get(c.login) ?? {login: c.login, name: c.name, count: 0};
    seen.count += 1;
    byLogin.set(c.login, seen);
  }
  return [...byLogin.values()].sort((a, b) => b.count - a.count || a.login.localeCompare(b.login));
}

/** The series that drops out of support when this one ships. 0.88 retires 0.85. */
function unsupportedSeries(series) {
  const [major, minor] = series.split('.').map(Number);
  return `${major}.${minor - 3}`;
}

function frontmatterAuthors(templateBody) {
  return /^authors:\s*(\[.*\])\s*$/m.exec(templateBody)?.[1] ?? '[TODO]';
}

function draft({series, date, stats, contributors, template}) {
  const tail = tailFrom(template, {series, stats, contributors});
  if (!tail) {
    throw new Error(
      `${template.name} has no "## Acknowledgements" section, so the boilerplate tail cannot be carried over`,
    );
  }

  return `---
title: 'React Native ${series} - TODO headline, see the highlights below'
authors: ${frontmatterAuthors(template.body)}
tags: [announcement, release]
date: ${date}
---

# React Native ${series} - TODO headline, see the highlights below

Today we are excited to release React Native ${series}!

TODO one paragraph on what this release is about. ${series} is a non-breaking
release, so lead with what it improves rather than what it changes.

### Highlights

- [TODO highlight one](/blog/${date.replace(/-/g, '/')}/react-native-${series}#todo-highlight-one)
- [TODO highlight two](/blog/${date.replace(/-/g, '/')}/react-native-${series}#todo-highlight-two)

{/* truncate */}

## Highlights

### TODO highlight one

TODO.

### TODO highlight two

TODO.

## Breaking Changes

TODO. ${series} is non-breaking, so this should be empty or near-empty. Anything
listed here needs a reason it shipped in a non-breaking release.

## Deprecations

TODO.

${tail}
`;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find(a => !a.startsWith('-'));
  if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
    console.error('usage: node scripts/draft-blog-post.mjs <x.y.0> [--date YYYY-MM-DD] [--out <path>]');
    process.exit(1);
  }
  const flag = name => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const series = version.split('.').slice(0, 2).join('.');
  const [major, minor] = series.split('.').map(Number);
  const prevSeries = `${major}.${minor - 1}`;
  const date = flag('--date') ?? new Date().toISOString().slice(0, 10);

  console.log(`Drafting the ${series} release post\n`);

  const template = await latestReleasePost();
  console.log(`  template   ${template.name} (most recent release post)`);

  // The branch, not a tag: .0 does not exist yet when the draft is written.
  const base = `v${prevSeries}.0`;
  const head = `${series}-stable`;
  const {commits, total, complete} = await commitsWithAuthors(base, head);
  if (!complete) {
    console.log(`  WARNING    range truncated at ${commits.length} of ${total}, counts below are low`);
  }
  const contributors = rankContributors(commits);
  console.log(`  range      ${base}...${head}`);
  console.log(`  commits    ${total}`);
  console.log(`  people     ${contributors.length} (excluding bots)`);
  console.log(`  top        ${contributors.slice(0, 5).map(c => `${c.login}(${c.count})`).join(' ')}`);

  const body = draft({series, date, stats: {total}, contributors, template});

  const out = flag('--out') ?? join(tmpdir(), `${date}-react-native-${series}.mdx`);
  writeFileSync(out, body, 'utf8');

  console.log('\n  The acknowledgements list is ranked by raw commit count, so it includes Meta');
  console.log('  staff. That section thanks COMMUNITY members for significant work, so filter it');
  console.log('  down by hand and say what each person actually did.');
  console.log(`\n  draft      ${out}`);
  console.log(`  filename   ${date}-react-native-${series}.mdx  (${SITE}/${BLOG_DIR}/)`);
  console.log(`\nEvery TODO is a judgement call and none of them are optional.`);
  console.log(`See reference/blog-post.md for where this goes next.`);
}

main().catch(err => {
  console.error(`\nFailed: ${err.message}`);
  process.exit(1);
});

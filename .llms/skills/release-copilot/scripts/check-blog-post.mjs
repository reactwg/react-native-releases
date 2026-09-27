#!/usr/bin/env node
/**
 * Check the release blog post is dated the day it goes live.
 *
 * The date appears three times: in the filename, in `date:` and inside every
 * Highlights link (`/blog/YYYY/MM/DD/react-native-x.y#...`). Docusaurus builds
 * the URL from it and the X thread links to that URL, so it has to be final
 * before the thread is drafted and it has to be the day the post is merged.
 * The 0.88 post shipped on 2026-10-16 dated 2026-10-19, the projected date it
 * was drafted with.
 *
 *   node scripts/check-blog-post.mjs 0.88                     find it on the website repo
 *   node scripts/check-blog-post.mjs 0.88 --file <path.mdx>   check a local file
 *   node scripts/check-blog-post.mjs 0.88 --on 2026-10-16     the day it will go live
 *
 * Exits 1 on any mismatch, so the blog step stops.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync} from 'node:fs';
import {basename} from 'node:path';

const exec = promisify(execFile);
const SITE = 'react/react-native-website';

export function checkBlogPostDates({filename, content, series, expected}) {
  const problems = [];
  const fileDate = /^(\d{4}-\d{2}-\d{2})-react-native-/.exec(basename(filename))?.[1] ?? null;
  const frontDate = /^date:\s*['"]?(\d{4}-\d{2}-\d{2})/m.exec(content)?.[1] ?? null;
  const linkRe = new RegExp(`/blog/(\\d{4})/(\\d{2})/(\\d{2})/react-native-${series.replace('.', '\\.')}\\b`, 'g');
  const linkDates = [...content.matchAll(linkRe)].map(m => `${m[1]}-${m[2]}-${m[3]}`);

  if (!fileDate) {
    problems.push(`filename "${basename(filename)}" does not start with a YYYY-MM-DD date`);
  }
  if (!frontDate) {
    problems.push('no `date:` in the front matter');
  }
  if (fileDate && frontDate && fileDate !== frontDate) {
    problems.push(`filename says ${fileDate} but \`date:\` says ${frontDate}`);
  }
  const ref = frontDate ?? fileDate;
  const stray = [...new Set(linkDates.filter(d => d !== ref))];
  if (ref && stray.length) {
    problems.push(`${linkDates.filter(d => d !== ref).length} link(s) to this post use ${stray.join(', ')}, not ${ref}`);
  }
  if (ref && expected && ref !== expected) {
    problems.push(
      ref > expected
        ? `dated ${ref}, in the future: it goes live on ${expected}`
        : `dated ${ref}, but it goes live on ${expected}`,
    );
  }

  const fix = expected
    ? [
        `rename to ${expected}-react-native-${series}.mdx`,
        `set \`date: ${expected}\``,
        `point the ${linkDates.length} Highlights link(s) at /blog/${expected.replace(/-/g, '/')}/react-native-${series}`,
      ]
    : [];
  return {ok: problems.length === 0, date: ref, links: linkDates.length, problems, fix};
}

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 16 * 1024 * 1024});
  return stdout;
}

/** The post in an open PR wins over main: that is the one about to go live. */
async function findPost(series) {
  const wanted = new RegExp(`^website/blog/\\d{4}-\\d{2}-\\d{2}-react-native-${series.replace('.', '\\.')}\\.mdx$`);
  const prs = JSON.parse(
    await gh(['pr', 'list', '--repo', SITE, '--state', 'open', '--limit', '50', '--json', 'number,headRefName,files']),
  );
  for (const pr of prs) {
    const f = (pr.files ?? []).find(x => wanted.test(x.path));
    if (f) {
      return {path: f.path, ref: pr.headRefName, where: `PR #${pr.number}`};
    }
  }
  const tree = JSON.parse(await gh(['api', `repos/${SITE}/contents/website/blog?ref=main`]));
  const f = tree.find(x => wanted.test(`website/blog/${x.name}`));
  return f ? {path: `website/blog/${f.name}`, ref: 'main', where: 'main (already live)'} : null;
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function main() {
  const args = process.argv.slice(2);
  const series = args.find(a => /^\d+\.\d+$/.test(a));
  const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (!series) {
    console.error('usage: node scripts/check-blog-post.mjs <x.y> [--file <path.mdx>] [--on YYYY-MM-DD]');
    process.exit(2);
  }
  const expected = flag('--on') ?? today();

  let filename;
  let content;
  let where;
  if (flag('--file')) {
    filename = flag('--file');
    content = readFileSync(filename, 'utf8');
    where = 'local file';
  } else {
    const post = await findPost(series);
    if (!post) {
      console.log(`No ${series} post found in an open PR on ${SITE} or on main.`);
      process.exit(1);
    }
    filename = post.path;
    content = await gh([
      'api',
      `repos/${SITE}/contents/${post.path}?ref=${encodeURIComponent(post.ref)}`,
      '-H',
      'Accept: application/vnd.github.raw',
    ]);
    where = post.where;
  }

  const r = checkBlogPostDates({filename, content, series, expected});
  console.log(`${basename(filename)} (${where}), goes live ${expected}`);
  if (r.ok) {
    console.log(`  ok  dated ${r.date}, filename, \`date:\` and ${r.links} link(s) agree`);
    return;
  }
  for (const p of r.problems) {
    console.log(`  FAIL ${p}`);
  }
  console.log('  fix:');
  for (const f of r.fix) {
    console.log(`    - ${f}`);
  }
  if (where.startsWith('main')) {
    console.log('  It is already live, so renaming changes its URL: add a redirect for anything that links to the old one.');
  }
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

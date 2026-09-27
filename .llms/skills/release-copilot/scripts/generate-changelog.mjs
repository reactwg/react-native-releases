#!/usr/bin/env node
/**
 * Open the changelog PR for a release on react/react-native main.
 *
 * This replaces the publish workflow's `generate_changelog` job. That job ran
 * the generator and opened a PR with every section present, empty or not, an
 * Unknown bucket and entries in generator order, which then got curated by
 * hand. This runs the same generator, applies the mechanical curation and
 * opens the PR on the same `changelog/v<version>` branch, so everything that
 * looks for that branch keeps working.
 *
 *   node scripts/generate-changelog.mjs 0.89.0-rc.2      generate, curate, open the PR
 *   node scripts/generate-changelog.mjs 0.89.0           combine the 0.89 RC sections
 *   node scripts/generate-changelog.mjs 0.89.0 --dry-run print the section, push nothing
 *
 * A `.0` gets no generated entries: its changelog is the RC sections combined
 * into one, the change made by hand for 0.88 in #59122.
 *
 * It opens nothing when the branch's own publish workflow still has the job,
 * because the bot opens the PR there. A second branch of the same name would
 * make the bot's push fail. The draft release job depends on that one.
 */

import {execFileSync} from 'node:child_process';
import {readFileSync, writeFileSync, mkdtempSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {resolveCheckout} from './doctor.mjs';
import {
  parseEntries,
  renderSection,
  combine,
  revertedShas,
  latestTagForSeries,
} from './combine-changelog.mjs';
import {changelogSection} from './fill-release-notes.mjs';
import {curateEntries, curationContext, formatReport} from './curate-changelog.mjs';

const RN = 'react/react-native';
const RN_URL = `https://github.com/${RN}.git`;

const VERSION = /^0\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/;

/**
 * The version the changelog is generated against, the same rule the workflow
 * used. `null` for a `.0`, which is combined from its RCs instead.
 */
export function previousVersion(version, latest) {
  const m = VERSION.exec(version);
  if (!m) {
    throw new Error(`not a release version: ${version}`);
  }
  const [, minor, patch, rc] = m;
  if (rc != null) {
    return Number(rc) > 0 ? `0.${minor}.${patch}-rc.${Number(rc) - 1}` : latest;
  }
  return Number(patch) === 0 ? null : `0.${minor}.${Number(patch) - 1}`;
}

export const branchFor = version => `changelog/v${version}`;

/** True when this workflow file still opens the changelog PR itself. */
export function workflowGeneratesChangelog(publishWorkflowYaml) {
  return /^\s{2}generate_changelog:\s*$/m.test(publishWorkflowYaml ?? '');
}

/** Swap the body of `## v<version>` for `section`, which carries its own heading. */
export function replaceSection(changelog, version, section) {
  const lines = changelog.split('\n');
  const start = lines.findIndex(l => l.trim() === `## v${version}`);
  if (start === -1) {
    return null;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## v\d/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...section.trimEnd().split('\n'), '', ...lines.slice(end)].join('\n');
}

/** Replace every `## v<series>.0-rc.N` section with one combined section. */
export function replaceRcSections(changelog, series, section) {
  const lines = changelog.split('\n');
  const isRc = l => new RegExp(`^## v${series.replace('.', '\\.')}\\.0-rc\\.\\d+\\s*$`).test(l);
  const first = lines.findIndex(isRc);
  if (first === -1) {
    return null;
  }
  const out = [];
  let i = 0;
  let inserted = false;
  while (i < lines.length) {
    if (isRc(lines[i])) {
      if (!inserted) {
        out.push(...section.trimEnd().split('\n'), '');
        inserted = true;
      }
      i++;
      while (i < lines.length && !/^## v\d/.test(lines[i])) i++;
      continue;
    }
    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

/**
 * The release machinery's own commits. The generator files them under
 * Unknown: 0.88.0-rc.6's section came out as two "Release" lines and a
 * Podfile.lock bump. They are never changelog material.
 */
export function isMachinery(entry) {
  const text = entry.text.replace(/^- (\*\*[^*]+\*\*:?\s*)?/, '');
  return /^(Release \d+\.\d+\.\d+|\[LOCAL\]|Bump Podfile\.lock)/.test(text);
}

/** Prefix and check entries against the changelog's own history in `repo`. */
function curate(repo, changelog, entries) {
  const ctx = curationContext(repo, changelog, entries);
  return curateEntries(entries, ctx);
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts});
}

function gh(args, opts = {}) {
  return execFileSync('gh', args, {encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts});
}

function existingPr(version) {
  const prs = JSON.parse(
    gh(['pr', 'list', '--repo', RN, '--state', 'all', '--head', branchFor(version), '--json', 'number,state,url']),
  );
  return prs[0] ?? null;
}

function prBody(version, {dotZero, entries, prev, report}) {
  const what = dotZero
    ? `Replaces the per-RC headings with the single \`## v${version}\` section the stable release publishes.`
    : `Adds the \`## v${version}\` section, generated against v${prev}.`;
  return [
    '## Summary',
    '',
    `${what} ${entries.length} entries, sorted by scope within each section, empty sections omitted, release machinery commits dropped.`,
    '',
    'Opened by the release copilot. Every prefix it added and every flag it raised is listed below for a human to confirm.',
    '',
    formatReport(report),
    'Also still for a human: drop internal entries and promote genuinely user-facing ones.',
    '',
    '## Changelog:',
    '',
    `[INTERNAL] - Add changelog for v${version}`,
    '',
    '## Test Plan:',
    '',
    'N/A',
    '',
  ].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const version = args.find(a => VERSION.test(a));
  const dryRun = args.includes('--dry-run');
  const flag = name => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
  if (!version) {
    console.error('usage: node scripts/generate-changelog.mjs <version> [--dry-run] [--checkout <path>]');
    process.exit(2);
  }
  const series = version.split('.').slice(0, 2).join('.');
  const dotZero = previousVersion(version, 'unused') === null;
  const branch = branchFor(version);

  const pr = existingPr(version);
  if (pr) {
    console.log(`The changelog PR for ${version} already exists: ${pr.url} (${pr.state}). Curate that one.`);
    if (!dryRun) return;
    console.log('Dry run: generating anyway to show what it would contain.\n');
  }

  let workflow;
  try {
    workflow = gh(['api', `repos/${RN}/contents/.github/workflows/publish-npm.yml?ref=v${version}`, '-H', 'Accept: application/vnd.github.raw']);
  } catch {
    console.log(`No v${version} tag on ${RN}. Publish the release first.`);
    process.exit(1);
  }
  if (!dotZero && workflowGeneratesChangelog(workflow)) {
    console.log(`The publish workflow at v${version} still has its generate_changelog job, so the bot opens`);
    console.log(`${branch} itself. Not opening a second one: curate the bot's PR once it appears.`);
    if (!dryRun) return;
    console.log('Dry run: generating anyway to show what it would contain.\n');
  }

  const checkout = resolveCheckout(flag('--checkout'));
  git(checkout, ['fetch', '-q', 'origin', 'main', `${series}-stable`, '--tags', '--force']);
  // A shared clone borrows the checkout's objects but has its own refs. The
  // generator runs `git log main`, so it needs a local `main`. Creating one in
  // the captain's checkout is not this script's business.
  const work = mkdtempSync(join(tmpdir(), `rn-changelog-${version}-`));
  const tree = join(work, 'react-native');
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', checkout, tree]);
  git(tree, ['fetch', '-q', RN_URL, `+refs/heads/main:refs/remotes/upstream/main`, `+refs/heads/${series}-stable:refs/remotes/upstream/${series}-stable`, '--tags', '--force']);
  git(tree, ['checkout', '-q', '-B', 'main', 'upstream/main']);

  try {
    const path = join(tree, 'CHANGELOG.md');
    let entries;
    let report;
    let prev = null;

    if (dotZero) {
      const before = readFileSync(path, 'utf8');
      const [maj, min] = series.split('.').map(Number);
      const prevSeries = `${maj}.${min - 1}`;
      const base = latestTagForSeries(checkout, prevSeries) ?? `v${prevSeries}.0`;
      const rev = revertedShas(checkout, `${base}..origin/${series}-stable`);
      let r;
      try {
        r = combine(before, series, {reverted: rev.shas});
      } catch {
        console.log(`CHANGELOG.md on main has no ${series}.0-rc.N sections. Nothing to combine.`);
        return;
      }
      ({entries, report} = curate(tree, before, parseEntries(r.markdown)));
      writeFileSync(path, replaceRcSections(before, series, renderSection(`${series}.0`, entries)));
      console.log(`Combined ${r.rcs.join(', ')}: ${r.total} entries in, ${r.kept} out.`);
      if (r.reverted.length) console.log(`Dropped ${r.reverted.length} entr(ies) for changes reverted before release.`);
      if (rev.unpaired?.length) console.log(`!! ${rev.unpaired.length} revert(s) name no target sha. Check them on the PR.`);
    } else {
      const latest = execFileSync('npm', ['view', 'react-native@latest', 'version'], {encoding: 'utf8'}).trim();
      prev = previousVersion(version, latest);
      // The generator only takes the token on its command line. A failed
      // execFileSync puts that whole line in its error, which printed a live
      // token on the first run, so the error is replaced, never passed on.
      const token = gh(['auth', 'token']).trim();
      try {
        execFileSync(
          'npx',
          ['--yes', '@rnx-kit/rn-changelog-generator', '--base', `v${prev}`, '--compare', `v${version}`, '--repo', '.', '--changelog', './CHANGELOG.md', '--token', token],
          {cwd: tree, stdio: ['ignore', 'inherit', 'inherit']},
        );
      } catch {
        throw new Error('the changelog generator failed, its output is above');
      }
      const generated = readFileSync(path, 'utf8');
      const raw = changelogSection(generated, version);
      entries = (raw ? parseEntries(raw) : []).filter(e => !isMachinery(e));
      if (!entries.length) {
        console.log(`${version} has no user-facing entries against v${prev}. No changelog change, no PR.`);
        return;
      }
      ({entries, report} = curate(tree, generated, entries));
      writeFileSync(path, replaceSection(generated, version, renderSection(version, entries)));
    }

    const diff = git(tree, ['diff', '--stat']);
    if (!diff.trim()) {
      console.log('CHANGELOG.md is unchanged. Nothing to open.');
      return;
    }
    console.log(changelogSection(readFileSync(path, 'utf8'), version));
    console.log('');
    console.log(formatReport(report));

    if (dryRun) {
      console.log(`\nDry run: nothing committed or pushed. ${branch} would be opened against main.`);
      return;
    }

    const title = dotZero
      ? `[RN][Changelog] Combine the ${series} RC sections into v${version}`
      : `[RN][Changelog] Add changelog for v${version}`;
    git(tree, ['switch', '-q', '-c', branch]);
    git(tree, ['config', 'user.name', git(checkout, ['config', 'user.name']).trim()]);
    git(tree, ['config', 'user.email', git(checkout, ['config', 'user.email']).trim()]);
    git(tree, ['add', 'CHANGELOG.md']);
    git(tree, ['commit', '-q', '-m', title]);
    git(tree, ['push', '-q', RN_URL, `HEAD:refs/heads/${branch}`]);
    const bodyFile = join(work, 'body.md');
    writeFileSync(bodyFile, prBody(version, {dotZero, entries, prev, report}));
    const url = gh(['pr', 'create', '--repo', RN, '--base', 'main', '--head', branch, '--title', title, '--body-file', bodyFile]).trim();
    console.log(`\nOpened ${url}`);
    console.log('Import it and finish the curation on the diff, in "Changes Planned" while you iterate.');
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (err) {
    // Never echo a command line: one of them carries a token.
    console.error(`error: ${err.message.split('\n')[0].replace(/gh[opsu]_[A-Za-z0-9]+/g, '<redacted>')}`);
    process.exit(1);
  }
}

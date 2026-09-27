#!/usr/bin/env node
/**
 * Fill a draft GitHub release's notes from CHANGELOG.md on main.
 *
 * The publish workflow creates the draft with the dSYM links and the
 * boilerplate but no notes. The notes used to be pasted by hand. They are
 * the `## v<version>` section of CHANGELOG.md, so read that and put it above
 * the generated part.
 *
 * Two traps this exists for:
 * - Every update sends `tag_name`. A body-only PATCH on the 0.88.0 draft
 *   detached it from `v0.88.0`. `gh release view v0.88.0` then stopped finding it.
 * - It refuses to overwrite notes that are already there and differ, so an
 *   edit someone made on the draft is not silently replaced.
 *
 *   node scripts/fill-release-notes.mjs 0.88.0
 *   node scripts/fill-release-notes.mjs 0.88.0 --dry-run
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync, mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec = promisify(execFile);
const RN = 'react/react-native';

/** The body of `## v<version>`, up to the next version heading. */
export function changelogSection(changelog, version) {
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
  const body = lines.slice(start + 1, end).join('\n').trim();
  return body || null;
}

// GitHub stores the six-character escape for NUL (backslash, u, 0000) as `\^@`,
// so compare the two spellings as equal.
const NUL_ESCAPE = '\\' + 'u' + '0000';
const normalize = t => t.split(NUL_ESCAPE).join('\\^@').trim();

/**
 * The generated draft starts with `---`. Anything above the first rule is the
 * notes. Returns {body, status}: `filled`, `unchanged` or `conflict`.
 */
export function buildReleaseBody(section, draftBody) {
  const current = draftBody ?? '';
  const idx = current.search(/^---\s*$/m);
  const notes = (idx === -1 ? current : current.slice(0, idx)).trim();
  const rest = idx === -1 ? '' : current.slice(idx).replace(/^\n+/, '');
  if (notes && normalize(notes) === normalize(section)) {
    return {body: current, status: 'unchanged'};
  }
  if (notes) {
    return {body: current, status: 'conflict', existing: notes};
  }
  return {body: rest ? `${section}\n\n${rest}` : `${section}\n`, status: 'filled'};
}

export function releasePatch(version, body, draft) {
  return {tag_name: `v${version}`, body, draft};
}

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
  return stdout;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find(a => /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(a));
  const dryRun = args.includes('--dry-run');
  if (!version) {
    console.error('usage: node scripts/fill-release-notes.mjs <version> [--dry-run]');
    process.exit(2);
  }

  const changelog = await gh([
    'api',
    `repos/${RN}/contents/CHANGELOG.md?ref=main`,
    '-H',
    'Accept: application/vnd.github.raw',
  ]);
  const section = changelogSection(changelog, version);
  if (!section) {
    console.log(`CHANGELOG.md on main has no "## v${version}" section yet. Land the changelog first.`);
    process.exit(1);
  }

  // A draft is not reachable through releases/tags/<tag>, so list and match.
  const releases = JSON.parse(await gh(['api', `repos/${RN}/releases?per_page=50`]));
  const release = releases.find(r => r.tag_name === `v${version}` || r.name === version);
  if (!release) {
    console.log(`No GitHub release for ${version}. The publish workflow creates the draft.`);
    process.exit(1);
  }
  if (!release.draft) {
    console.log(`The ${version} release is already published. Edit its notes by hand if they need changing.`);
    process.exit(1);
  }

  const r = buildReleaseBody(section, release.body);
  const entries = section.split('\n').filter(l => l.startsWith('- ')).length;
  if (r.status === 'unchanged') {
    console.log(`The ${version} draft already carries the changelog (${entries} entries). Nothing to do.`);
    return;
  }
  if (r.status === 'conflict') {
    console.log(`The ${version} draft already has notes that differ from CHANGELOG.md. Not overwriting them.`);
    console.log('Reconcile by hand on the draft. Or clear its notes and re-run.');
    process.exit(1);
  }
  if (dryRun) {
    console.log(`Would write ${entries} entries above the generated part of the ${version} draft.`);
    return;
  }

  const file = join(mkdtempSync(join(tmpdir(), 'release-notes-')), 'patch.json');
  writeFileSync(file, JSON.stringify(releasePatch(version, r.body, true)));
  const updated = JSON.parse(
    await gh(['api', '-X', 'PATCH', `repos/${RN}/releases/${release.id}`, '--input', file]),
  );
  if (updated.tag_name !== `v${version}` || !updated.draft) {
    console.log(`!! The update returned tag ${updated.tag_name}, draft=${updated.draft}. Check the release.`);
    process.exit(1);
  }
  console.log(`Filled the ${version} draft with ${entries} entries. Still a draft on v${version}, review and publish it.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

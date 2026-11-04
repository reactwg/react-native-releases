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
 *   node scripts/fill-release-notes.mjs 0.89.0-rc.0 --ref changelog/v0.89.0-rc.0
 *
 * --ref reads CHANGELOG.md from another ref, such as the changelog PR's branch
 * when the release goes out before that PR lands. Edits made while curating
 * the PR then do not reach the release by themselves: once it lands,
 *
 *   node scripts/fill-release-notes.mjs 0.89.0-rc.0 --update-published --was changelog/v0.89.0-rc.0@<sha>
 *
 * replaces a published release's notes with the section on main. It refuses
 * unless the notes on the release are exactly the section at --was, so a hand
 * edit made on the release is never overwritten. It keeps everything from the
 * first `---` on, saves the old body first and reads the release back.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFileSync, mkdtempSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
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

/**
 * The body a published release gets: `section` above its first `---`, the
 * rest kept byte for byte. Refuses unless its current notes are `was`.
 */
export function republishBody(section, current, was) {
  const idx = (current ?? '').search(/^---\s*$/m);
  if (idx === -1) {
    return {status: 'no-separator'};
  }
  const notes = current.slice(0, idx).trim();
  const tail = current.slice(idx);
  if (normalize(notes) === normalize(section)) {
    return {status: 'unchanged'};
  }
  if (normalize(notes) !== normalize(was ?? '')) {
    return {status: 'edited', existing: notes};
  }
  return {status: 'replace', body: `${section}\n\n${tail}`, tail};
}

/** What must still hold after the update. Returns the failures. */
export function verifyRepublished(before, after, {body, tail}) {
  const norm = t => String(t ?? '').replace(/\r\n/g, '\n').trim();
  const fails = [];
  if (after.id !== before.id) fails.push('a different release came back');
  if (after.tag_name !== before.tag_name) fails.push(`tag moved from ${before.tag_name} to ${after.tag_name}`);
  if (after.draft !== before.draft) fails.push(`draft changed to ${after.draft}`);
  if (after.prerelease !== before.prerelease) fails.push(`prerelease changed to ${after.prerelease}`);
  if (after.name !== before.name) fails.push('the name changed');
  if (norm(after.body) !== norm(body)) fails.push('the body is not what was sent');
  if (!norm(after.body).endsWith(norm(tail))) fails.push('the part from --- on changed');
  return fails;
}

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
  return stdout;
}

async function main() {
  const args = process.argv.slice(2);
  const version = args.find(a => /^\d+\.\d+\.\d+(-rc\.\d+)?$/.test(a));
  const dryRun = args.includes('--dry-run');
  const ref = args.includes('--ref') ? args[args.indexOf('--ref') + 1] : 'main';
  const republish = args.includes('--update-published');
  const was = args.includes('--was') ? args[args.indexOf('--was') + 1] : null;
  if (!version || !ref) {
    console.error('usage: node scripts/fill-release-notes.mjs <version> [--ref <ref>] [--dry-run]');
    process.exit(2);
  }

  const changelog = await gh([
    'api',
    `repos/${RN}/contents/CHANGELOG.md?ref=${encodeURIComponent(ref)}`,
    '-H',
    'Accept: application/vnd.github.raw',
  ]);
  const section = changelogSection(changelog, version);
  if (!section) {
    console.log(`CHANGELOG.md on ${ref} has no "## v${version}" section yet.${ref === 'main' ? ' Land the changelog first, or pass --ref changelog/v' + version + ' to use the open PR.' : ''}`);
    process.exit(1);
  }

  // A draft is not reachable through releases/tags/<tag>, so list and match.
  const releases = JSON.parse(await gh(['api', `repos/${RN}/releases?per_page=50`]));
  const release = releases.find(r => r.tag_name === `v${version}` || r.name === version);
  if (!release) {
    console.log(`No GitHub release for ${version}. The publish workflow creates the draft.`);
    process.exit(1);
  }
  if (!release.draft && !republish) {
    console.log(`The ${version} release is already published. To replace its notes, use --update-published --was <ref>, where <ref> is what they came from.`);
    process.exit(1);
  }
  if (republish) {
    if (release.draft) {
      console.log(`The ${version} release is still a draft. Run without --update-published.`);
      process.exit(1);
    }
    if (!was) {
      console.log('--update-published needs --was <ref>: the ref the notes on the release came from, so a hand edit is not overwritten.');
      process.exit(2);
    }
    const old = changelogSection(
      await gh(['api', `repos/${RN}/contents/CHANGELOG.md?ref=${encodeURIComponent(was)}`, '-H', 'Accept: application/vnd.github.raw']),
      version,
    );
    const r = republishBody(section, release.body, old);
    const entries = section.split('\n').filter(l => l.startsWith('- ')).length;
    if (r.status === 'unchanged') {
      console.log(`The ${version} release already carries the section on ${ref}. Nothing to do.`);
      return;
    }
    if (r.status === 'no-separator') {
      console.log(`The ${version} release body has no --- line, so the generated part cannot be told from the notes. Not touching it.`);
      process.exit(1);
    }
    if (r.status === 'edited') {
      console.log(`The notes on the ${version} release are not the section at ${was}: someone edited them on the release. Not overwriting. Reconcile by hand.`);
      process.exit(1);
    }
    if (dryRun) {
      console.log(`Would replace the ${version} release notes with ${entries} entries from ${ref}, keeping the ${r.tail.split('\n').length} lines from --- on.`);
      return;
    }
    const dir = join(homedir(), 'Library', 'Caches', 'release-copilot', 'release-edit');
    mkdirSync(dir, {recursive: true});
    const backup = join(dir, `${version}-${Date.now()}.json`);
    writeFileSync(backup, JSON.stringify(release, null, 2));
    const file = join(mkdtempSync(join(tmpdir(), 'release-notes-')), 'patch.json');
    // Not `draft`: it is unchanged. make_latest=false so a prerelease or an older line never takes latest.
    writeFileSync(file, JSON.stringify({tag_name: `v${version}`, body: r.body, make_latest: 'false'}));
    const after = JSON.parse(await gh(['api', '-X', 'PATCH', `repos/${RN}/releases/${release.id}`, '--input', file]));
    const fails = verifyRepublished(release, after, r);
    if (fails.length) {
      console.log(`!! The ${version} release came back changed: ${fails.join('; ')}. The old body is in ${backup}.`);
      process.exit(1);
    }
    console.log(`Replaced the ${version} release notes with ${entries} entries from ${ref}. Old body saved in ${backup}.`);
    return;
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
    console.log(`Would write ${entries} entries from CHANGELOG.md on ${ref} above the generated part of the ${version} draft.`);
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
  console.log(`Filled the ${version} draft with ${entries} entries from ${ref}. Still a draft on v${version}, review and publish it.`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(err => {
    console.error(`error: ${err.message}`);
    process.exit(1);
  });
}

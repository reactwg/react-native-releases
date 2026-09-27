#!/usr/bin/env node
// Combine a series' RC changelog sections into one `.0` section.
//
// Every stable release needs this: the RCs each got their own `## vX.Y.0-rc.N`
// heading and the published `.0` carries a single `## vX.Y.0` holding all of
// them. Doing it by hand across 40+ entries invites dropped lines and
// duplicate dependency bumps.
//
// This does the mechanical part only: parse, merge, dedupe, order. The
// judgement calls it CANNOT make are reported as TODOs for the captain:
// scope prefixes it could not infer, entries that look internal, and
// dependency bumps that may supersede one another.
//
//   node scripts/combine-changelog.mjs 0.88 [--changelog <path>]
//
// Reads CHANGELOG.md from origin/main in the react-native checkout by default:
// changelog entries land on main, so the working tree can be days stale.

import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {resolveCheckout} from './doctor.mjs';

const SECTIONS = ['Breaking', 'Added', 'Changed', 'Deprecated', 'Removed', 'Fixed', 'Security', 'Unknown'];
const SUBSECTIONS = ['', 'Android specific', 'iOS specific'];

/** Every `## vX.Y.0-rc.N` block, newest first as the file stores them. */
export function parseRcSections(text, series) {
  const re = new RegExp(`^## v(${series.replace('.', '\\.')}\\.0-rc\\.(\\d+))\\s*$`, 'gm');
  const found = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    found.push({version: m[1], rc: Number(m[2]), start: m.index, bodyFrom: re.lastIndex});
  }
  // Bound each body at the next `## ` heading of ANY version, not just the
  // next RC. The oldest RC is last in the file, so stopping at "next match"
  // made it swallow every earlier series in the changelog.
  const nextHeading = from => {
    const m = /^## /m.exec(text.slice(from));
    return m ? from + m.index : text.length;
  };
  return found.map(f => ({...f, body: text.slice(f.bodyFrom, nextHeading(f.bodyFrom))}));
}

/** Entries of one body, keyed by `Section` and `Section/Subsection`. */
export function parseEntries(body) {
  const out = [];
  let section = null;
  let subsection = '';
  for (const line of body.split('\n')) {
    const h3 = /^### (.+?)\s*$/.exec(line);
    if (h3) {
      section = h3[1];
      subsection = '';
      continue;
    }
    const h4 = /^#### (.+?)\s*$/.exec(line);
    if (h4) {
      subsection = h4[1];
      continue;
    }
    if (/^- /.test(line) && section) {
      out.push({section, subsection, text: line});
    }
  }
  return out;
}

/**
 * The commit sha an entry points at.
 *
 * Dedupe key of choice: the same change picked into two RCs keeps one sha in
 * the link even when the prose was reworded between them.
 */
export function shaOf(entry) {
  const m = /\/commit\/([0-9a-f]{7,40})/.exec(entry.text);
  return m ? m[1].slice(0, 10) : null;
}

/** `**Scope**: rest` leading bold or null when the entry has no prefix. */
export function scopeOf(entry) {
  // Both forms appear in published changelogs: `**Scope**: text` and
  // `**Scope:** text`. Treating the second as unprefixed reported 611 false
  // positives on 0.88.
  const m = /^- \*\*(.+?):?\*\*:?\s/.exec(entry.text);
  return m ? m[1].replace(/:$/, '') : null;
}

/** Sort text: the scope when there is one, else the bare description. */
function sortKey(entry) {
  const scope = scopeOf(entry);
  if (scope) {
    return `${scope.toLowerCase()} ${entry.text.replace(/^- \*\*.+?\*\*:?\s*/, '').toLowerCase()}`;
  }
  return entry.text.replace(/^- /, '').toLowerCase();
}

/** Dependency bumps that may supersede one another, by package name. */
export function supersededBumps(entries) {
  const byPkg = new Map();
  for (const e of entries) {
    const m = /(?:bump|update|upgrade)\s+(?:the\s+)?([@a-z0-9._/-]+?)\s+(?:to|from)\s/i.exec(e.text);
    if (!m) continue;
    const pkg = m[1].toLowerCase();
    if (!byPkg.has(pkg)) byPkg.set(pkg, []);
    byPkg.get(pkg).push(e);
  }
  return [...byPkg.entries()].filter(([, v]) => v.length > 1);
}

/**
 * Commits reverted on the branch, by the sha they reverted.
 *
 * A change that landed in an early RC and was reverted before release still
 * has its forward entry in that RC's changelog section and the revert
 * usually adds no entry of its own. Merging naively therefore ADVERTISES A
 * CHANGE THAT IS NOT IN THE RELEASE. 0.88 hit exactly this: the combined
 * section carried "Codegen now emits `RCTArrayBuffer *` ... modules stop
 * compiling" for a change reverted by 639cdedb506 and absent from the branch.
 *
 * `sl`/`git` revert bodies carry `This reverts commit <sha>`, which is the
 * pairing signal. Returns an empty set when git is unavailable rather than
 * pretending nothing was reverted and the caller reports which it was.
 */
export function revertedShas(checkout, range) {
  try {
    // --grep first: fetching 2000 full commit bodies overflows the default
    // 1MB maxBuffer and fails as ENOBUFS, which the catch below would have
    // reported as "git unavailable". Only revert commits are of interest.
    const log = execFileSync(
      'git',
      ['log', range, '--grep=^Revert', '--grep=This reverts commit', '--format=%H%x00%s%x00%b%x01'],
      {cwd: checkout, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']},
    );
    const out = new Set();
    const unpaired = [];
    for (const entry of log.split('\x01')) {
      const [sha, subject, body] = entry.split('\x00');
      if (!sha || !subject) continue;
      const m = /This reverts commit ([0-9a-f]{40})/.exec(body ?? '');
      if (m) {
        out.add(m[1].slice(0, 10));
      } else if (/^Revert\b/i.test(subject.trim())) {
        // A hand-written revert names no sha. 0.88 had one
        // (adde1e58884, "Revert: Automatically set acessible prop..."), whose
        // target differs in PR number AND carries two typos, so no title or
        // number match is safe. Report it and let a human pair it rather than
        // guessing or dropping the wrong entry.
        unpaired.push({sha: sha.slice(0, 11), subject: subject.trim()});
      }
    }
    return {ok: true, shas: out, unpaired};
  } catch (err) {
    return {ok: false, shas: new Set(), unpaired: [], why: err.message.split('\n')[0]};
  }
}

const INTERNAL = /\[internal\]|^- \*\*BUCK|buck file|^\s*- .*\brefactor\b.*\(no behaviou?r change\)/i;

/**
 * One `## v<version>` section: entries grouped by section and platform, sorted by
 * scope, empty sections and subsections omitted.
 */
export function renderSection(version, entries) {
  const buckets = new Map();
  for (const e of entries) {
    const key = `${e.section}\u0000${e.subsection}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(e);
  }

  const lines = [`## v${version}`, ''];
  for (const section of SECTIONS) {
    const present = SUBSECTIONS.map(sub => ({
      sub,
      items: (buckets.get(`${section}\u0000${sub}`) ?? []).sort((a, b) =>
        sortKey(a).localeCompare(sortKey(b)),
      ),
    })).filter(x => x.items.length);
    if (!present.length) continue;

    lines.push(`### ${section}`);
    for (const {sub, items} of present) {
      if (sub) lines.push('', `#### ${sub}`);
      for (const it of items) lines.push(it.text);
    }
    lines.push('');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

export function combine(text, series, {reverted = new Set()} = {}) {
  const sections = parseRcSections(text, series);
  if (!sections.length) {
    throw new Error(`no ${series}.0-rc.N sections found in the changelog`);
  }

  // Oldest RC first so the earliest wording of a repeated entry wins and the
  // reader sees the series in the order it actually happened.
  const ordered = [...sections].sort((a, b) => a.rc - b.rc);

  const all = [];
  for (const s of ordered) {
    for (const e of parseEntries(s.body)) {
      all.push({...e, fromRc: s.rc});
    }
  }

  const seenSha = new Map();
  const seenText = new Set();
  const kept = [];
  const dupes = [];
  const revertedOut = [];
  for (const e of all) {
    const sha = shaOf(e);
    if (sha && reverted.has(sha)) {
      revertedOut.push(e);
      continue;
    }
    const norm = e.text.replace(/\s+/g, ' ').trim();
    if (sha && seenSha.has(sha)) {
      dupes.push({entry: e, first: seenSha.get(sha)});
      continue;
    }
    if (!sha && seenText.has(norm)) {
      dupes.push({entry: e, first: null});
      continue;
    }
    if (sha) seenSha.set(sha, e);
    seenText.add(norm);
    kept.push(e);
  }

  const markdown = renderSection(`${series}.0`, kept);

  return {
    markdown,
    rcs: ordered.map(s => s.version),
    total: all.length,
    kept: kept.length,
    dupes,
    reverted: revertedOut,
    noScope: kept.filter(e => !scopeOf(e)),
    internal: kept.filter(e => INTERNAL.test(e.text)),
    bumps: supersededBumps(kept),
    unknown: kept.filter(e => e.section === 'Unknown'),
  };
}

/** Newest published tag of a series, used as the revert-scan baseline. */
export function latestTagForSeries(checkout, series) {
  try {
    const out = execFileSync('git', ['tag', '--list', `v${series}.*`, '--sort=-v:refname'], {
      cwd: checkout,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map(x => x.trim()).filter(x => /^v\d+\.\d+\.\d+$/.test(x))[0] ?? null;
  } catch {
    return null;
  }
}

function changelogFromMain(checkout, fallbackPath) {
  try {
    execFileSync('git', ['-C', checkout, 'fetch', '-q', 'origin', 'main'], {stdio: 'ignore'});
    return execFileSync('git', ['-C', checkout, 'show', 'origin/main:CHANGELOG.md'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    console.error(`!! could not read origin/main:CHANGELOG.md in ${checkout}, using ${fallbackPath}`);
    return readFileSync(fallbackPath, 'utf8');
  }
}

function main() {
  const args = process.argv.slice(2);
  const series = args.find(a => /^\d+\.\d+$/.test(a));
  if (!series) {
    console.error('usage: combine-changelog.mjs <series>   e.g. 0.88');
    process.exit(2);
  }
  const explicit = args.includes('--changelog') ? args[args.indexOf('--changelog') + 1] : null;
  const checkout = resolveCheckout();
  const path = explicit ?? join(checkout, 'CHANGELOG.md');
  const text = explicit ? readFileSync(explicit, 'utf8') : changelogFromMain(checkout, path);

  // On 0.88 the consolidation landed before the run reached this step. The
  // script then threw "no rc sections" at a release whose changelog was done.
  if (!parseRcSections(text, series).length && text.split('\n').some(l => l.trim() === `## v${series}.0`)) {
    console.log(`CHANGELOG.md on main already has a single ## v${series}.0 section and no ${series}.0-rc.N`);
    console.log('sections. Nothing to combine.');
    return;
  }
  // Scope to THIS release's commits. Scanning the whole branch history reported
  // 512 unpaired reverts from years of unrelated releases, which buries the one
  // that matters. The baseline is the previous series' newest patch.
  const prevSeries = (() => {
    const [maj, min] = series.split('.').map(Number);
    return `${maj}.${min - 1}`;
  })();
  const base = latestTagForSeries(checkout, prevSeries) ?? `v${prevSeries}.0`;
  const rev = revertedShas(checkout, `${base}..origin/${series}-stable`);
  const r = combine(text, series, {reverted: rev.shas});

  console.log(r.markdown);
  console.log('-'.repeat(72));
  console.log(`Combined ${r.rcs.join(', ')}`);
  console.log(`${r.total} entries in, ${r.kept} out, ${r.dupes.length} duplicate(s) dropped.`);
  console.log('');
  if (!rev.ok) {
    console.log(`!! Could not read git history from ${checkout} (${rev.why}), so NOTHING`);
    console.log('   was checked for');
    console.log('   reverts. A change reverted before release still has its forward entry in');
    console.log('   the RC section it landed in. Verify by hand or re-run with a checkout.');
    console.log('');
  } else if (r.reverted.length) {
    console.log(`Dropped ${r.reverted.length} entry(s) for changes REVERTED before release:`);
    for (const e of r.reverted) console.log(`  - ${e.text.slice(0, 100)}`);
    console.log('');
  }
  if (rev.unpaired?.length) {
    console.log(`!! ${rev.unpaired.length} revert commit(s) name no target sha, so their forward entry`);
    console.log('   could NOT be dropped automatically. Check each and remove the entry by hand:');
    for (const u of rev.unpaired) console.log(`     ${u.sha}  ${u.subject.slice(0, 92)}`);
    console.log('');
  }
  console.log('STILL NEEDS A HUMAN. This did the mechanical merge only:');
  if (r.dupes.length) {
    console.log(`  - ${r.dupes.length} entry(s) deduped by commit sha. Confirm none was a`);
    console.log('    genuinely separate change that happens to share a sha prefix.');
  }
  if (r.noScope.length) {
    console.log(`  - ${r.noScope.length} entry(s) have no **Scope**: prefix. Add one:`);
    for (const e of r.noScope.slice(0, 6)) console.log(`      ${e.text.slice(0, 96)}`);
    if (r.noScope.length > 6) console.log(`      ... and ${r.noScope.length - 6} more`);
  }
  if (r.internal.length) {
    console.log(`  - ${r.internal.length} entry(s) look internal. Read before dropping:`);
    for (const e of r.internal.slice(0, 6)) console.log(`      ${e.text.slice(0, 96)}`);
  }
  if (r.bumps.length) {
    console.log(`  - ${r.bumps.length} package(s) bumped more than once. Keep only the last:`);
    for (const [pkg, es] of r.bumps) console.log(`      ${pkg} x${es.length}`);
  }
  if (r.unknown.length) {
    console.log(`  - ${r.unknown.length} entry(s) in the Unknown bucket. Triage each into a real`);
    console.log('    section, do not delete the bucket wholesale.');
  }
  console.log('');
  console.log('Then replace the per-RC sections with the block above. See');
  console.log('reference/changelog.md for the import-and-edit commands.');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

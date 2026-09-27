#!/usr/bin/env node
/**
 * Curate changelog entries before a human sees them.
 *
 * Three jobs, each kept to what can be decided from data:
 *
 * 1. Empty sections are dropped by renderSection in combine-changelog.mjs.
 * 2. A missing `**Scope**:` prefix is added when two independent signals
 *    agree. The entry's text names a scope the changelog already uses. The
 *    commit's files sit where entries with that scope have historically lived.
 *    The mapping is learned from CHANGELOG.md itself, so it follows the team's
 *    own naming. Measured on 0.88: 90% of the prefixes it added matched what
 *    the crew chose (40 of 44, on the generator's raw text). The rest are
 *    left unprefixed and listed, never guessed.
 * 3. Consistency flags, for a human to settle:
 *    - the commit removes or narrows a public API symbol (ReactNativeApi.d.ts,
 *      ReactAndroid.api, the C++ API snapshots) but the entry is not under
 *      Breaking, Removed or Deprecated
 *    - the commit message carries [BREAKING] but the entry is filed elsewhere
 *    - the entry is under Breaking but its commit removes no API symbol and
 *      carries no [BREAKING] tag
 *    - an entry describes a removal but sits under Added, Changed or Fixed
 *    - an entry's platform subsection disagrees with the code it touches
 *    On 0.88.0's curated section the API check raised 10 flags, several real.
 *    It is a signal: only 12 of 0.87.0's 30 breaking entries touched an API
 *    snapshot, because packaging and behaviour changes never do.
 *
 *   node scripts/curate-changelog.mjs --evaluate 0.88.0    reproduce the numbers above
 */

import {execFileSync} from 'node:child_process';
import {hasBreakingTag} from './gates.mjs';
import {resolveCheckout} from './doctor.mjs';

const TEST_FILE = /(__tests__|__snapshots__|\/test\/|\/androidTest\/|Test\.(kt|java|mm|m|cpp)$|-test\.js$|-itest\.js$)/;
const API_PATHS = [
  'packages/react-native/ReactNativeApi.d.ts',
  'packages/react-native/ReactAndroid/api',
  'scripts/cxx-api/api-snapshots',
];
const NOT_BREAKING_SECTIONS = new Set(['Breaking', 'Removed', 'Deprecated']);

const shaIn = text => /\/commit\/([0-9a-f]{40})/.exec(text)?.[1] ?? null;
const scopeIn = text => /^- \*\*(.+?):?\*\*:?\s/.exec(text)?.[1]?.replace(/:$/, '') ?? null;
/** The entry's prose, without the bullet, the prefix and the commit link. */
export const proseOf = text => text.replace(/^- (\*\*.+?\*\*:?\s*)?/, '').split(' ([')[0];

function dirsOf(file) {
  const parts = file.split('/');
  const out = [file];
  for (let i = parts.length - 1; i > 0; i--) out.push(parts.slice(0, i).join('/'));
  return out;
}

const productionFiles = files => {
  const prod = files.filter(f => !TEST_FILE.test(f));
  return prod.length ? prod : files;
};

/**
 * Where each scope's commits have lived, from entries that already carry one.
 * `filesOf(sha)` returns the commit's paths. It returns [] when it cannot find one.
 */
export function learnScopes(changelog, filesOf, {exclude = () => false} = {}) {
  const byDir = new Map();
  const vocab = new Map();
  let version = null;
  for (const line of changelog.split('\n')) {
    const h = /^## v(\S+)/.exec(line);
    if (h) {
      version = h[1];
      continue;
    }
    if (!line.startsWith('- ') || exclude(version)) continue;
    const scope = scopeIn(line);
    const sha = shaIn(line);
    if (!scope || !sha) continue;
    vocab.set(scope, (vocab.get(scope) ?? 0) + 1);
    for (const f of productionFiles(filesOf(sha))) {
      for (const d of dirsOf(f)) {
        if (!byDir.has(d)) byDir.set(d, new Map());
        const c = byDir.get(d);
        c.set(scope, (c.get(scope) ?? 0) + 1);
      }
    }
  }
  return {byDir, vocab};
}

/** Scopes the commit's files point at: the deepest directory with history. */
function fileCandidates(model, files) {
  const out = new Set();
  for (const f of productionFiles(files)) {
    for (const d of dirsOf(f)) {
      const c = model.byDir.get(d);
      if (!c) continue;
      const total = [...c.values()].reduce((a, b) => a + b, 0);
      if (total < 2) continue;
      [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).forEach(([s]) => out.add(s));
      break;
    }
  }
  return out;
}

/** The most specific known scope the prose names, if any. */
function textScope(model, prose) {
  const hits = [];
  for (const [s, n] of model.vocab) {
    if (n < 2 || s.length < 3) continue;
    const re = new RegExp(`(?<![A-Za-z])\`?${s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?(?![A-Za-z])`);
    if (re.test(prose)) hits.push(s);
  }
  hits.sort((a, b) => b.length - a.length || model.vocab.get(b) - model.vocab.get(a));
  return hits[0] ?? null;
}

/** A prefix only when the text and the files agree. */
export function inferScope(model, prose, files) {
  const named = textScope(model, prose);
  return named && fileCandidates(model, files).has(named) ? named : null;
}

/** Symbols a snapshot diff removes and string unions it narrows. */
export function apiRemovals(diff) {
  const clean = s => s.replace(/\s*\/\/\s*[0-9a-f]{8}\s*$/, '').replace(/\s+/g, ' ').trim().replace(/[;,]$/, '');
  const ident = raw => {
    const s = clean(raw);
    if (!s || /^(\*|\/\/|\/\*|\}|\{|\)|\]|>)/.test(s)) return null;
    let m = /^(?:export\s+)?(?:declare\s+)?(?:readonly\s+)?(?:static\s+)?(?:abstract\s+)?(?:function|const|let|var|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/.exec(s);
    if (m) return m[1];
    m = /^(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:/.exec(s);
    if (m) return m[1];
    m = /^([A-Za-z_$][\w$]*)$/.exec(s);
    if (m) return m[1];
    m = /([A-Za-z_$~][\w$]*)\s*\(/.exec(s);
    if (m) return `${m[1]}(${(s.match(/,/g) ?? []).length})`;
    return s;
  };
  const union = raw => {
    const m = /:\s*((?:"[^"]*"\s*\|\s*)+"[^"]*")/.exec(clean(raw));
    return m ? new Set(m[1].match(/"[^"]*"/g)) : null;
  };

  const files = new Map();
  let file = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ b/')) {
      file = line.slice(6);
      files.set(file, {removed: [], added: []});
      continue;
    }
    if (line.startsWith('--- ') || !file || !line) continue;
    if (line[0] === '-') files.get(file).removed.push(line.slice(1));
    if (line[0] === '+') files.get(file).added.push(line.slice(1));
  }

  const out = [];
  for (const {removed, added} of files.values()) {
    const kept = new Map();
    for (const a of added) {
      const i = ident(a);
      if (i) kept.set(i, a);
    }
    for (const r of removed) {
      const i = ident(r);
      if (!i) continue;
      if (!kept.has(i)) {
        out.push({kind: 'removed', symbol: i});
        continue;
      }
      const before = union(r);
      const after = union(kept.get(i));
      if (before && after && [...before].some(v => !after.has(v))) out.push({kind: 'narrowed', symbol: i});
    }
  }
  return out;
}

export function platformOf(files) {
  let android = 0;
  let ios = 0;
  let other = 0;
  for (const f of productionFiles(files)) {
    if (/(ReactAndroid\/|\/android\/|\.kt$|\.java$|\.gradle(\.kts)?$)/.test(f)) android++;
    else if (/(^packages\/react-native\/React\/|\/ReactApple\/|\/ios\/|\.mm$|\.m$|\.swift$|\.podspec$|Podfile)/.test(f)) ios++;
    else other++;
  }
  if (!other && android && !ios) return 'android';
  if (!other && ios && !android) return 'ios';
  return 'mixed';
}

/** The things a human should look at for one entry, as short sentences. */
export function consistencyFlags(entry, facts) {
  const flags = [];
  if (!facts) return flags;
  const prose = proseOf(entry.text);
  const api = facts.api ?? [];
  if (api.length && !NOT_BREAKING_SECTIONS.has(entry.section)) {
    const names = [...new Set(api.map(a => `${a.kind} ${a.symbol}`))].slice(0, 3).join(', ');
    flags.push(`changes public API (${names}) but is under ${entry.section}: breaking, removal or a safe signature change?`);
  }
  if (hasBreakingTag(facts.message) && entry.section !== 'Breaking') {
    flags.push(`its commit is tagged [BREAKING] but it is under ${entry.section}`);
  }
  if (entry.section === 'Breaking' && !api.length && !hasBreakingTag(facts.message)) {
    flags.push('under Breaking, but its commit removes no API symbol and carries no [BREAKING] tag: confirm it breaks a consumer');
  }
  if (/^(Remove|Removed|Removes|Delete|Deleted|Deletes)\b/.test(prose) && ['Added', 'Changed', 'Fixed'].includes(entry.section)) {
    flags.push(`describes a removal but is under ${entry.section}`);
  }
  const platform = platformOf(facts.files ?? []);
  if (entry.subsection === 'Android specific' && platform === 'ios') flags.push('under Android specific but only touches iOS code');
  if (entry.subsection === 'iOS specific' && platform === 'android') flags.push('under iOS specific but only touches Android code');
  if (!entry.subsection && platform !== 'mixed') flags.push(`only touches ${platform === 'ios' ? 'iOS' : 'Android'} code: belongs under ${platform === 'ios' ? 'iOS' : 'Android'} specific?`);
  return flags;
}

/**
 * Prefix and check every entry. `factsOf(sha)` returns {files, message, api}.
 * Returns the entries with prefixes applied and a report for the PR.
 */
export function curateEntries(entries, {model, factsOf}) {
  const out = [];
  const prefixed = [];
  const unprefixed = [];
  const flagged = [];
  for (const e of entries) {
    const sha = shaIn(e.text);
    const facts = sha ? factsOf(sha) : null;
    let text = e.text;
    if (!scopeIn(text)) {
      const scope = facts ? inferScope(model, proseOf(text), facts.files ?? []) : null;
      if (scope) {
        text = text.replace(/^- /, `- **${scope}**: `);
        prefixed.push({scope, prose: proseOf(e.text)});
      } else {
        unprefixed.push(proseOf(e.text));
      }
    }
    const next = {...e, text};
    const flags = consistencyFlags(next, facts);
    if (flags.length) flagged.push({prose: proseOf(next.text), section: next.section, subsection: next.subsection, flags});
    out.push(next);
  }
  return {entries: out, report: {prefixed, unprefixed, flagged}};
}

export function formatReport({prefixed, unprefixed, flagged}) {
  const L = [];
  if (prefixed.length) {
    L.push(`**Prefixes added (${prefixed.length}).** The entry names the scope and its files sit where that scope's commits have lived. Confirm each:`, '');
    for (const p of prefixed) L.push(`- \`${p.scope}\`: ${p.prose}`);
    L.push('');
  }
  if (unprefixed.length) {
    L.push(`**Still without a prefix (${unprefixed.length}).** The text and the files did not agree on one:`, '');
    for (const p of unprefixed) L.push(`- ${p}`);
    L.push('');
  }
  if (flagged.length) {
    L.push(`**Consistency flags (${flagged.length}).** Signals, not verdicts:`, '');
    for (const f of flagged) L.push(`- ${f.prose} (${f.section}${f.subsection ? `, ${f.subsection}` : ''}): ${f.flags.join('; ')}`);
    L.push('');
  }
  return L.join('\n');
}

/** Commit facts from a local repo, batched: files, message and API removals. */
export function gitFacts(repo, shas) {
  const present = execFileSync('git', ['-C', repo, 'cat-file', '--batch-check'], {
    input: `${shas.join('\n')}\n`,
    encoding: 'utf8',
  })
    .split('\n')
    .filter(l => / commit /.test(l))
    .map(l => l.split(' ')[0]);
  const facts = new Map();
  if (!present.length) return facts;
  const out = execFileSync(
    'git',
    ['-C', repo, 'show', '--no-renames', '--name-only', '--format=%x01%H%x02%B%x03', ...present],
    {encoding: 'utf8', maxBuffer: 256 * 1024 * 1024},
  );
  for (const chunk of out.split('\x01').slice(1)) {
    const [sha, rest = ''] = chunk.split('\x02');
    const [message = '', names = ''] = rest.split('\x03');
    facts.set(sha, {message, files: names.split('\n').map(s => s.trim()).filter(Boolean), api: []});
  }
  return facts;
}

/** Add API removals for the commits that touch a snapshot at all. */
export function addApiFacts(repo, facts) {
  for (const [sha, f] of facts) {
    if (!f.files.some(p => API_PATHS.some(a => p === a || p.startsWith(`${a}/`)))) continue;
    const diff = execFileSync('git', ['-C', repo, 'show', '--format=', '--unified=0', '--no-renames', sha, '--', ...API_PATHS], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    f.api = apiRemovals(diff);
  }
  return facts;
}

/** Everything curation needs for a set of entries, from one repo. */
export function curationContext(repo, changelog, entries, {exclude} = {}) {
  const shas = [...new Set([...changelog.matchAll(/\/commit\/([0-9a-f]{40})/g)].map(m => m[1]))];
  const entryShas = entries.map(e => shaIn(e.text)).filter(Boolean);
  const facts = gitFacts(repo, [...new Set([...shas, ...entryShas])]);
  addApiFacts(repo, new Map(entryShas.filter(s => facts.has(s)).map(s => [s, facts.get(s)])));
  const model = learnScopes(changelog, sha => facts.get(sha)?.files ?? [], {exclude});
  return {model, factsOf: sha => facts.get(sha) ?? null};
}

function evaluate(version) {
  const repo = resolveCheckout();
  execFileSync('git', ['-C', repo, 'fetch', '-q', 'origin', 'main']);
  const changelog = execFileSync('git', ['-C', repo, 'show', 'origin/main:CHANGELOG.md'], {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  const series = version.split('.').slice(0, 2).join('.');
  const lines = changelog.split('\n');
  const start = lines.findIndex(l => l.trim() === `## v${version}`);
  if (start === -1) {
    console.log(`No ## v${version} section on main.`);
    process.exit(1);
  }
  const target = [];
  let section = null;
  let subsection = '';
  for (let i = start + 1; i < lines.length && !/^## v\d/.test(lines[i]); i++) {
    const l = lines[i];
    const h3 = /^### (.+?)\s*$/.exec(l);
    if (h3) {
      section = h3[1];
      subsection = '';
      continue;
    }
    const h4 = /^#### (.+?)\s*$/.exec(l);
    if (h4) {
      subsection = h4[1];
      continue;
    }
    if (l.startsWith('- ')) target.push({section, subsection, text: l});
  }
  // Train on everything except this series, so the score is out of sample.
  const ctx = curationContext(repo, changelog, target, {exclude: v => v?.startsWith(series)});
  let made = 0;
  let right = 0;
  const misses = [];
  for (const e of target) {
    const truth = scopeIn(e.text);
    const sha = shaIn(e.text);
    if (!truth || !sha) continue;
    const guess = inferScope(ctx.model, proseOf(e.text), ctx.factsOf(sha)?.files ?? []);
    if (!guess) continue;
    made++;
    if (guess === truth) right++;
    else misses.push(`${truth} -> ${guess}: ${proseOf(e.text).slice(0, 70)}`);
  }
  const flagged = target.filter(e => consistencyFlags(e, ctx.factsOf(shaIn(e.text) ?? '')).length);
  console.log(`${version}: ${target.length} curated entries, model trained without ${series}`);
  console.log(`  prefixes: inferred ${made} (${Math.round((made * 100) / target.length)}%), ${right} match the curated prefix (${Math.round((right * 100) / Math.max(1, made))}%)`);
  for (const m of misses) console.log(`    miss  ${m}`);
  console.log(`  consistency flags on the curated section: ${flagged.length}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const i = args.indexOf('--evaluate');
  if (i === -1 || !args[i + 1]) {
    console.error('usage: node scripts/curate-changelog.mjs --evaluate <x.y.z>');
    process.exit(2);
  }
  evaluate(args[i + 1]);
}

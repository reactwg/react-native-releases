#!/usr/bin/env node
/**
 * Curate changelog entries before a human sees them. Every decision is listed
 * in the report for the curator to confirm or undo.
 *
 * 1. Internal entries are dropped: CI, Fantom, test or RNTester-only changes,
 *    translation syncs, Flow upgrades and bot commits titled with a file path.
 *    On 0.89.0-rc.0 that was 26 of the 29 the crew dropped, and it would drop
 *    nothing the crew kept in 0.88.0.
 * 2. A repeat of the same change (a re-land, the same PR landed twice) keeps
 *    one entry.
 * 3. Unknown entries are filed by their leading verb and their files' platform.
 * 4. A missing `**Scope**:` is added from the author's own label, or when the
 *    text names a scope the changelog uses and the commit's files sit where
 *    that scope's entries have lived. Against the crew's prefixes, trained
 *    without the series, that is right 85% of the time on 0.88.0 and 78% on
 *    0.87.0. A label repeating the scope ("SwiftPM: SwiftPM: ...") is dropped.
 * 5. Paths that always mean one scope, or a scope dominating the files'
 *    history, are only suggested. They were right 45 to 67% of the time, too
 *    often wrong to write but a quick start for the curator.
 * 6. Consistency flags, for a human to settle:
 *    - the commit removes or narrows a public API symbol (ReactNativeApi.d.ts,
 *      ReactAndroid.api, the C++ API snapshots) but the entry is not under
 *      Breaking, Removed or Deprecated
 *    - the commit message carries [BREAKING] but the entry is filed elsewhere
 *    - the entry is under Breaking but its commit removes no API symbol and
 *      carries no [BREAKING] tag
 *    - an entry describes a removal but sits under Added, Changed or Fixed
 *    - an entry's platform subsection disagrees with the code it touches
 *
 *   node scripts/curate-changelog.mjs --evaluate 0.88.0                reproduce the prefix numbers
 *   node scripts/curate-changelog.mjs --evaluate 0.88.0 --suggestions  score the suggestions too
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

/**
 * Paths that always belong to one scope, whatever else a release named. Kept
 * to directories that hold one feature each: a shared directory such as
 * React/Fabric/Mounting covers every component and is left to the history.
 */
export const PATH_SCOPES = [
  [/ReactCommon\/yoga\/|\/com\/facebook\/yoga\//, 'Yoga'],
  [/^packages\/(react-native-codegen|babel-plugin-codegen)\/|\/scripts\/codegen\//, 'Codegen'],
  [/^packages\/react-native-babel-(preset|transformer)\//, 'Babel'],
  [/^packages\/(dev-middleware|debugger-frontend|debugger-shell)\//, 'React Native DevTools'],
  [/^packages\/eslint-(plugin-react-native|config-react-native)\//, 'ESLint'],
  [/^packages\/virtualized-lists\//, 'VirtualizedList'],
  [/^packages\/gradle-plugin\//, 'Gradle'],
  [/^packages\/jest-preset\//, 'Jest'],
  [/^packages\/community-cli-plugin\//, 'CLI'],
  [/^packages\/normalize-color\/|\/Libraries\/StyleSheet\/|\/renderer\/css\//, 'Styles'],
  [/\/scripts\/cocoapods\//, 'CocoaPods'],
  [/\/scripts\/spm\/|\/scripts\/setup-apple-spm/, 'SwiftPM'],
  [/\/Libraries\/Animated\/|\/renderer\/animated\/|\/Libraries\/NativeAnimation\//, 'Animated'],
  [/\/Libraries\/Components\/TextInput\/|\/Libraries\/Text\/TextInput\/|\/views\/textinput\//, 'TextInput'],
  [/\/views\/text\/|\/renderer\/textlayoutmanager\/|\/renderer\/attributedstring\//, 'Text'],
  [/\/views\/scroll\/|\/Libraries\/Components\/ScrollView\//, 'ScrollView'],
  [/\/views\/image\/|\/views\/imagehelper\/|\/Libraries\/Image\/|\/renderer\/imagemanager\//, 'Image'],
  [/\/views\/virtual\//, 'VirtualView'],
  [/\/react\/nativemodule\//, 'TurboModules'],
  [/\/Libraries\/Pressability\//, 'Touch Handling'],
  [/\/modules\/websocket\/|\/Libraries\/WebSocket\/|\/Libraries\/Network\//, 'Networking'],
  [/\/Libraries\/LayoutAnimation\//, 'LayoutAnimation'],
  [/\/modules\/i18nmanager\//, 'i18n'],
  [/\/views\/switchview\/|\/Libraries\/Components\/Switch\//, 'Switch'],
  [/\/views\/modal\/|\/Libraries\/Modal\//, 'Modal'],
  [/\/uimanager\/drawable\/|\/uimanager\/style\//, 'View'],
  [/\/renderer\/mounting\/|\/renderer\/runtimescheduler\//, 'Renderer'],
];

// Files that ride along with a change of any kind, so they say nothing about its scope.
const INCIDENTAL = /(featureflags|\/api-snapshots\/|ReactNativeApi\.d\.ts$|ReactAndroid\.api$|index\.js\.flow$|\.podspec$|build\.gradle\.kts$|CMakeLists\.txt$|headers-config\.js$|Package\.swift$|\.pbxproj$|package\.json$|yarn\.lock$)/;

const scopeFiles = files => {
  const prod = productionFiles(files).filter(f => !INCIDENTAL.test(f));
  return prod.length ? prod : productionFiles(files);
};

/** The scope every scoped file points at through PATH_SCOPES, when they agree and cover most of the change. */
function pathScope(files) {
  const fs = scopeFiles(files);
  const hits = fs.map(f => PATH_SCOPES.find(([re]) => re.test(f))?.[1] ?? null);
  const named = [...new Set(hits.filter(Boolean))];
  return named.length === 1 && hits.filter(Boolean).length * 2 >= fs.length ? named[0] : null;
}

/** A scope that dominates the history of every file the commit touches. */
function dominantScope(model, files) {
  let pick = null;
  for (const f of scopeFiles(files)) {
    let found = null;
    for (const d of dirsOf(f)) {
      const c = model.byDir.get(d);
      if (!c) continue;
      const total = [...c.values()].reduce((a, b) => a + b, 0);
      if (total < 3) continue;
      const [top, n] = [...c.entries()].sort((a, b) => b[1] - a[1])[0];
      found = n / total >= 0.7 ? top : 'none';
      break;
    }
    if (!found || found === 'none') return null;
    if (pick && pick !== found) return null;
    pick = found;
  }
  return pick;
}

/** A scope the author wrote as the prose's own label, "SwiftPM: ...". */
function labelScope(model, prose) {
  const m = /^([A-Z][\w .+/-]{1,30}?)(?:\([^)]*\))?:\s/.exec(prose);
  if (!m) return null;
  const label = m[1].trim().toLowerCase();
  for (const s of model.vocab.keys()) if (s.toLowerCase() === label) return s;
  return null;
}

/**
 * A scope to apply: the author's own label, or the text and the files
 * agreeing. Returns {scope, why} or null. Measured against the crew's own
 * prefixes (--evaluate, trained without the series): text and files agreeing
 * was right 85% of the time on 0.88.0 and 78% on 0.87.0.
 */
export function inferScope(model, prose, files) {
  const label = labelScope(model, prose);
  if (label) return {scope: label, why: 'label'};
  const named = textScope(model, prose);
  if (named && fileCandidates(model, files).has(named)) return {scope: named, why: 'text+files'};
  return null;
}

/**
 * A scope to suggest, never to apply: a path that always means one scope, or
 * one that dominates the files' history. On the same measurement these were
 * right 67% and 50% of the time on 0.88.0, 45% and 33% on 0.87.0, too often
 * wrong to write into the changelog but a cheap starting point for a curator.
 */
export function suggestScope(model, files) {
  const path = pathScope(files);
  if (path) return {scope: path, why: 'path'};
  const dominant = dominantScope(model, files);
  return dominant ? {scope: dominant, why: 'history'} : null;
}

/** Leading labels that repeat the scope or the platform subsection. */
export function stripRedundantLabel(prose, scope) {
  let out = prose;
  const label = /^([A-Za-z][\w .+/-]{1,30}?)(?:\([^)]*\))?:\s+/.exec(out);
  if (label) {
    const l = label[1].trim().toLowerCase();
    if (l === String(scope).toLowerCase() || ['android', 'ios', 'fix', 'pull model'].includes(l) || String(scope).toLowerCase().startsWith(l.split(' ')[0]) && l.split(' ')[0].length > 3) {
      out = out.slice(label[0].length);
      return out ? out[0].toUpperCase() + out.slice(1) : out;
    }
  }
  return out;
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
 * Why an entry is not changelog material, or null. Only what the commit itself
 * shows: where its files are and what its subject is. The 0.89.0-rc.0 section
 * carried CI edits, Fantom, test-only changes, translation syncs, Flow upgrades
 * and bot commits titled with a file path.
 */
export function internalReason(prose, facts) {
  const files = facts?.files ?? [];
  const subject = String(facts?.message ?? '').split('\n')[0];
  if (/^xplat\//i.test(prose) || /^xplat\//i.test(subject)) return 'a bot commit titled with a file path';
  if (/^Translation auto-update\b/i.test(prose)) return 'a translation sync';
  if (/^Upgrade Flow\b/i.test(prose)) return 'a Flow upgrade';
  // Reviewers removed "Bump Hermes to 260318099.0.7" and "Bump Metro to 0.88.0"
  // from 0.89.0-rc.1: the version is in package.json and the release notes of
  // the dependency itself. A bump that says what it changes for users stays.
  if (BARE_BUMP.test(prose)) return 'a bare Hermes or Metro version bump';
  if (!files.length) return null;
  if (files.every(f => f === 'CHANGELOG.md')) return 'a changelog edit';
  if (files.every(f => f.startsWith('.github/'))) return 'CI only';
  if (files.every(f => f.startsWith('private/react-native-fantom/') || f.startsWith('.github/'))) return 'Fantom only';
  if (files.every(f => TEST_FILE.test(f) || f.startsWith('packages/rn-tester/'))) return 'tests or RNTester only';
  return null;
}

const BARE_BUMP = /^(?:Bump|Update|Upgrade)\s+(?:the\s+)?(?:minimum\s+)?(?:Hermes(?:\s+V1)?|hermes-v1|hermes-compiler|Metro)(?:\s+minimum)?(?:\s+(?:version|dependency))?(?:\s+to\s+v?\^?[\w.~-]+)?\.?$/i;

/**
 * The PR a release-branch commit stands for. A backport PR says "Picks #58584
 * to 0.89." in its body; a cherry-pick keeps the original title's "(#59682)".
 */
export function originalPr(message) {
  const m = String(message ?? '');
  const picks = /^Picks #(\d+)\b/m.exec(m);
  if (picks) return {number: Number(picks[1]), backport: true};
  // Only a pick: a commit straight from main already carries its own line.
  if (!/\(cherry picked from commit [0-9a-f]{7,40}\)/.test(m)) return null;
  const title = /\(#(\d+)\)\s*$/m.exec(m.split('\n')[0]);
  return title ? {number: Number(title[1]), backport: false} : null;
}

const CL_SECTIONS = {added: 'Added', changed: 'Changed', fixed: 'Fixed', removed: 'Removed', deprecated: 'Deprecated', breaking: 'Breaking', security: 'Security'};
const CL_PLATFORMS = {general: '', android: 'Android specific', ios: 'iOS specific'};

/** The author's own line from a PR body: `[General][Added] - **Scope**: text`. */
export function parseChangelogLine(body) {
  const line = String(body ?? '')
    .split('\n')
    .map(l => l.trim())
    .find(l => /^\[[A-Za-z]+\]\s*(\[[A-Za-z]+\])?\s*-\s+\S/.test(l));
  if (!line) return null;
  const [, a, b, text] = /^\[([A-Za-z]+)\]\s*(?:\[([A-Za-z]+)\])?\s*-\s+(.+)$/.exec(line);
  if (a.toLowerCase() === 'internal') return {internal: true};
  const platform = CL_PLATFORMS[a.toLowerCase()];
  const section = CL_SECTIONS[String(b ?? '').toLowerCase()];
  if (platform === undefined || !section) return null;
  return {section, subsection: platform, text: text.trim()};
}

/**
 * Credit and wording from the original PR. Reviewers fixed both by hand on
 * 0.89.0-rc.1: the Metro cache change was credited to the backport's author
 * instead of @janicduplessis, and two picks lost their authors' changelog
 * lines, so the generator filed them by title.
 */
export function applyOriginal(entry, original) {
  if (!original) return entry;
  let {text, section, subsection} = entry;
  if (original.backport && original.author) {
    text = text.replace(/ by \[@[^\]]+\]\(https:\/\/github\.com\/[^)]+\)\)$/, ` by [@${original.author}](https://github.com/${original.author}))`);
  }
  const cl = original.changelog;
  if (cl && !cl.internal) {
    const tail = / \(\[[0-9a-f]{10}\]\(https:\/\/github\.com\/[^)]+\) by .*\)$/.exec(text)?.[0] ?? '';
    text = `- ${cl.text}${tail}`;
    section = cl.section;
    subsection = cl.subsection;
  }
  return {...entry, text, section, subsection, internal: cl?.internal === true};
}

const SECTION_FROM_VERB = [
  [/^(Fix|Fixed|Fixes|Prevent|Avoid|Correct|Restore|Handle)\b/, 'Fixed'],
  [/^(Remove|Removed|Removes|Delete|Deleted|Deletes|Drop)\b/, 'Removed'],
  [/^(Deprecate|Deprecated|Mark .* as deprecated)\b/, 'Deprecated'],
  [/^(Add|Added|Adds|Introduce|Expose|Support)\b/, 'Added'],
];

/** Where an Unknown entry belongs: its leading verb picks the section, its files the platform. */
export function placeUnknown(prose, files) {
  const section = SECTION_FROM_VERB.find(([re]) => re.test(prose))?.[1] ?? 'Changed';
  const platform = platformOf(scopeFiles(files));
  return {section, subsection: platform === 'android' ? 'Android specific' : platform === 'ios' ? 'iOS specific' : ''};
}

const dedupeKey = (section, prose) => `${section}|${prose.toLowerCase().replace(/[`.\s]+/g, ' ').trim()}`;

/**
 * Prefix, clean and check every entry. `factsOf(sha)` returns {files, message, api}.
 * Internal entries and repeats of the same change are dropped. Unknown entries
 * are filed by their verb and files. Everything decided is in the report.
 */
export function curateEntries(entries, {model, factsOf, originalOf = () => null}) {
  const out = [];
  const prefixed = [];
  const unprefixed = [];
  const flagged = [];
  const dropped = [];
  const moved = [];
  const seen = new Set();
  for (const raw of entries) {
    const sha = shaIn(raw.text);
    const facts = sha ? factsOf(sha) : null;
    const e = applyOriginal(raw, sha ? originalOf(sha) : null);
    const prose = proseOf(e.text);
    const why = e.internal ? "its PR's changelog line says [INTERNAL]" : internalReason(prose, facts);
    if (why) {
      dropped.push({prose, why});
      continue;
    }
    let text = e.text;
    let scope = scopeIn(text);
    if (!scope) {
      const inferred = facts ? inferScope(model, prose, facts.files ?? []) : null;
      if (inferred) {
        scope = inferred.scope;
        text = text.replace(/^- /, `- **${scope}**: `);
        prefixed.push({scope, prose, why: inferred.why});
      } else {
        const hint = facts ? suggestScope(model, facts.files ?? []) : null;
        unprefixed.push(hint ? {prose, suggest: hint.scope} : {prose});
      }
    }
    if (scope) {
      const clean = stripRedundantLabel(proseOf(text), scope);
      text = text.replace(/^(- \*\*.+?\*\*:\s*).*?( \(\[|$)/, (m, head, tail) => `${head}${clean}${tail}`);
    }
    let next = {...e, text};
    if (e.section === 'Unknown') {
      const place = placeUnknown(prose, facts?.files ?? []);
      next = {...next, ...place};
      moved.push({prose, to: place.subsection ? `${place.section}, ${place.subsection}` : place.section});
    }
    const key = dedupeKey(next.section, proseOf(next.text));
    if (seen.has(key)) {
      dropped.push({prose, why: 'a repeat of the same change'});
      continue;
    }
    seen.add(key);
    const flags = consistencyFlags(next, facts);
    if (flags.length) flagged.push({prose: proseOf(next.text), section: next.section, subsection: next.subsection, flags});
    out.push(next);
  }
  return {entries: out, report: {prefixed, unprefixed, flagged, dropped, moved}};
}

/**
 * The curation decisions for a human to confirm. `collapsed` folds each list
 * into a <details> block, for a PR description: the 0.89.0-rc.0 one ran to
 * nearly 400 lines with all three lists open.
 */
export function formatReport({prefixed, unprefixed, flagged, dropped = [], moved = []}, {collapsed = false} = {}) {
  const L = [];
  const block = (title, lines) => {
    if (collapsed) {
      L.push(`<details><summary>${title}</summary>`, '', ...lines, '', '</details>', '');
    } else {
      L.push(`**${title}.**`, '', ...lines, '');
    }
  };
  if (prefixed.length) {
    block(`Prefixes added (${prefixed.length})`, prefixed.map(p => `- \`${p.scope}\`${p.why && p.why !== 'text+files' ? ` (${p.why})` : ''}: ${p.prose}`));
  }
  if (dropped.length) {
    block(`Dropped (${dropped.length})`, dropped.map(d => `- ${d.prose}: ${d.why}`));
  }
  if (moved.length) {
    block(`Moved out of Unknown (${moved.length})`, moved.map(m => `- ${m.prose} -> ${m.to}`));
  }
  const rows = unprefixed.map(p => (typeof p === 'string' ? {prose: p} : p));
  const hinted = rows.filter(p => p.suggest);
  const bare = rows.filter(p => !p.suggest);
  if (hinted.length) {
    block(`Suggested prefixes (${hinted.length}), not applied`, hinted.map(p => `- \`${p.suggest}\`?: ${p.prose}`));
  }
  if (bare.length) {
    block(`Still without a prefix (${bare.length})`, bare.map(p => `- ${p.prose}`));
  }
  if (flagged.length) {
    block(`Consistency flags (${flagged.length})`, flagged.map(f => `- ${f.prose} (${f.section}${f.subsection ? `, ${f.subsection}` : ''}): ${f.flags.join('; ')}`));
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

function evaluate(version, {suggest = false} = {}) {
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
  const bySignal = {};
  for (const e of target) {
    const truth = scopeIn(e.text);
    const sha = shaIn(e.text);
    if (!truth || !sha) continue;
    const files = ctx.factsOf(sha)?.files ?? [];
    const inferred = inferScope(ctx.model, proseOf(e.text), files) ?? (suggest ? suggestScope(ctx.model, files) : null);
    if (!inferred) continue;
    const guess = inferred.scope;
    made++;
    bySignal[inferred.why] ??= {made: 0, right: 0};
    bySignal[inferred.why].made++;
    if (guess === truth) {
      right++;
      bySignal[inferred.why].right++;
    } else misses.push(`${truth} -> ${guess} (${inferred.why}): ${proseOf(e.text).slice(0, 70)}`);
  }
  const flagged = target.filter(e => consistencyFlags(e, ctx.factsOf(shaIn(e.text) ?? '')).length);
  console.log(`${version}: ${target.length} curated entries, model trained without ${series}`);
  console.log(`  prefixes: inferred ${made} (${Math.round((made * 100) / target.length)}%), ${right} match the curated prefix (${Math.round((right * 100) / Math.max(1, made))}%)`);
  for (const [why, n] of Object.entries(bySignal)) console.log(`    ${why}: ${n.right} of ${n.made} right`);
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
  evaluate(args[i + 1], {suggest: args.includes('--suggestions')});
}

#!/usr/bin/env node
/**
 * Does each pick do what its request says it does.
 *
 * The request makes claims: it is a fix, it landed on main, the port is the
 * same change, it only touches an opt-in feature, it needs no migration. Each
 * claim is checked against evidence gathered in evidence.mjs and comes back
 * CONFIRMED, CONTRADICTED or UNVERIFIED with what it rests on. FLAG marks a
 * fact the captain has to weigh that is not anyone's claim, such as two days
 * on main or a change to every app's build flags. INFO is context.
 *
 * This produces evidence, not the verdict. The agent running the copilot digs
 * into whatever is not CONFIRMED and drafts PICK or DROP for the captain, who
 * decides. See "Investigating picks" in SKILL.md.
 *
 *   node scripts/investigate-pick.mjs 0.88 [--pick 1457]
 */

import {assess, stackSummary} from './assess-picks.mjs';
import {breakingSurfaces, hasBreakingTag} from './gates.mjs';
import {pickDeferralHistory, notPickedFor} from './release-state.mjs';
import {surfaceOf, loadSurfaces} from './evidence.mjs';

export const CONFIRMED = 'CONFIRMED';
export const CONTRADICTED = 'CONTRADICTED';
export const UNVERIFIED = 'UNVERIFIED';
export const FLAG = 'FLAG';
export const INFO = 'INFO';

/** Below this, a change has not been on main long enough to trust in a patch. */
export const SOAK_DAYS = 7;

const DAY_MS = 86400000;
const daysBetween = (a, b) => Math.floor((Date.parse(b) - Date.parse(a)) / DAY_MS);
const short = sha => String(sha ?? '').slice(0, 11);
const subject = m => String(m ?? '').split('\n')[0];
const quote = (text, re) => {
  const m = re.exec(text ?? '');
  if (!m) {
    return null;
  }
  const start = Math.max(0, text.lastIndexOf('\n', m.index) + 1);
  const end = text.indexOf('\n', m.index);
  return text.slice(start, end === -1 ? undefined : end).trim().slice(0, 200);
};

/** What the request says the change is. Regression first: it is the strongest claim. */
export function claimedKind(text) {
  if (/\bregress(ion|ed)?\b/i.test(text)) {
    return 'regression';
  }
  if (/^\W*\[[\d.]+\]\s*docs?\b|\bdocs?(\(|:)|\bdocumentation\b/i.test(text)) {
    return 'docs';
  }
  if (/\b(fix|fixes|fixed|bug|crash|broken|fails?|failing|wrong|incorrect|stale|leak)\b/i.test(text)) {
    return 'fix';
  }
  if (/\b(perf|performance|faster|optimi[sz](e|ed|ation))\b|(^|\s)-O[0-3sz]\b/i.test(text)) {
    return 'performance';
  }
  if (/\bbump(s|ed)?\b[^.\n]{0,40}\b(to|from)\s+v?\d/i.test(text)) {
    return 'dependency';
  }
  if (/\b(adds?|added|introduces?|new (api|feature|option|prop|method)|support for)\b/i.test(text)) {
    return 'feature';
  }
  return 'unknown';
}

/**
 * The changelog categories a commit declares. RN commits carry
 * `[PLATFORM] [CATEGORY] - text`; the template's `[A|B|C]` placeholders do not count.
 */
export function changelogCategories(message) {
  const cats = [];
  for (const m of String(message ?? '').matchAll(/\[(ANDROID|IOS|GENERAL|INTERNAL)\]\s*\[([A-Z]+)\]/gi)) {
    cats.push({platform: m[1].toUpperCase(), category: m[2].toUpperCase()});
  }
  return cats;
}

const FITS = {
  regression: ['FIXED', 'SECURITY'],
  fix: ['FIXED', 'SECURITY'],
  performance: ['FIXED', 'CHANGED'],
  docs: [],
  dependency: ['CHANGED', 'FIXED'],
  feature: ['ADDED', 'CHANGED'],
};
const CONTRADICTS = {
  regression: ['ADDED', 'BREAKING', 'REMOVED', 'DEPRECATED'],
  fix: ['ADDED', 'BREAKING', 'REMOVED', 'DEPRECATED'],
  performance: ['ADDED', 'BREAKING', 'REMOVED'],
  docs: ['ADDED', 'BREAKING', 'REMOVED', 'CHANGED', 'FIXED'],
  dependency: ['ADDED', 'BREAKING', 'REMOVED'],
  feature: [],
};

const ADMITS_DIVERGENCE =
  /not a plain cherry-pick|differs? from (the commit on )?main|adapted (for|to)|reviewed version of|instead of the commit on main|without .{0,40} from main/i;
const CLAIMS_LANDED = /\b(landed|merged)\b[^.\n]{0,40}\b(in|into|to|on)\s+`?main\b|already landed|merged to `?main/i;
const CLAIMS_TEST = /\b(adds?|added|with|includes?)\s+(a\s+|new\s+)*(regression\s+|unit\s+)?tests?\b/i;
const ASKS_CONSUMERS =
  /\bmust (now|add|update|change|include|migrate)\b|\bno longer (works?|supported)\b|\bmigrat(e|ion) (to|guide)\b/i;
const NAMES_VERSION = /\b0\.\d{2,3}(\.\d+)?\b[^.\n]{0,80}\b(work(s|ed)?|regress(ed|ion)?|broke|since|introduced)\b|\b(since|in|from|after)\s+0\.\d{2,3}(\.\d+)?\b/i;

/** Every claim about one pick, checked. Pure: evidence in, findings out. */
export function checkPick(c, ev, state, {today, trial} = {}) {
  const findings = [];
  const add = (id, status, text) => findings.push({id, status, text});
  const todayStr = today ?? new Date().toISOString().slice(0, 10);
  const surfaces = loadSurfaces();
  const requestText = [c.title, c.description, ev?.request?.body].join('\n');
  const commits = ev?.commits ?? [];
  const mains = ev?.mainCommits ?? [];

  // What it brings.
  if (!commits.length) {
    add('identity', UNVERIFIED, 'could not resolve the request to commits, so nothing below could be checked');
    return {number: c.number, title: c.title, findings, firstRead: assess(c, state)};
  }
  add(
    'identity',
    CONFIRMED,
    `brings ${commits.length} commit(s): ${commits.map(x => `${short(x.sha)} ${subject(x.message).slice(0, 70)}`).join('; ')}` +
      (ev.backportPr ? `, from backport PR #${ev.backportPr} against ${state.branch}` : ''),
  );

  // Landed on main, still there, long enough.
  const claimsLanded = CLAIMS_LANDED.test(requestText) || Boolean(ev.backportPr);
  for (const [i, m] of mains.entries()) {
    const own = short(commits[i]?.sha);
    if (m.missing) {
      add(
        'on-main',
        claimsLanded ? CONTRADICTED : UNVERIFIED,
        `no commit on main found for ${own}` + (claimsLanded ? ', though the request says it landed there' : ''),
      );
      continue;
    }
    if (!m.onMain) {
      add('on-main', CONTRADICTED, `${short(m.sha)} is not on main`);
      continue;
    }
    for (const r of m.reverts ?? []) {
      add('on-main', CONTRADICTED, `${short(m.sha)} was reverted on main by ${r.sha} "${r.subject}"`);
    }
    const days = daysBetween(m.date.slice(0, 10), todayStr);
    add(
      'soak',
      days < SOAK_DAYS ? FLAG : CONFIRMED,
      `on main as ${short(m.sha)} since ${m.date.slice(0, 10)}, ${days} day(s)` +
        (days < SOAK_DAYS ? `, under the ${SOAK_DAYS} days a patch pick should have had there` : ''),
    );
    const mine = [...commits, ...mains].map(x => short(x.sha));
    const later = (m.followUps ?? []).filter(f => !mine.some(x => x.startsWith(f.sha) || f.sha.startsWith(x)));
    if (later.length) {
      add(
        'follow-ups',
        FLAG,
        `later main commits touch the same files, check none is a follow-up fix this pick needs: ` +
          later.slice(0, 5).map(f => `${f.sha} ${f.date} ${f.subject.slice(0, 60)}`).join('; '),
      );
    }
  }

  // The port is the change that landed on main.
  for (const f of ev.fidelity ?? []) {
    if (f.same) {
      add('fidelity', CONFIRMED, `${short(f.own)} is the same change as ${short(f.main)} on main (patch-id)`);
      continue;
    }
    const diffs = [
      ...f.onlyOwn.map(x => `only in the port: ${x}`),
      ...f.onlyMain.map(x => `only on main: ${x}`),
      ...f.differing.map(x => `${x.f} ${x.own} vs ${x.main} on main`),
    ];
    const admitted =
      quote(requestText, ADMITS_DIVERGENCE) ??
      commits.map(x => quote(x.message, ADMITS_DIVERGENCE)).find(Boolean);
    add(
      'fidelity',
      admitted ? CONFIRMED : CONTRADICTED,
      `${short(f.own)} differs from ${short(f.main)} on main` +
        (diffs.length ? ` (${diffs.slice(0, 4).join('; ')}${diffs.length > 4 ? '; ...' : ''})` : '') +
        (admitted ? `, and says so: "${admitted}"` : ' and the request does not say why'),
    );
  }

  // It is the kind of change it says it is.
  const kind = claimedKind(`${c.title}\n${c.description ?? ''}`);
  const prodFiles = (ev.files ?? []).filter(x => surfaceOf(x.f, surfaces).reach !== 'none');
  const cats = [...commits, ...mains].flatMap(x => changelogCategories(x.message));
  const catNames = [...new Set(cats.map(x => x.category))];
  if (kind === 'docs') {
    add(
      'kind',
      prodFiles.length ? CONTRADICTED : CONFIRMED,
      prodFiles.length
        ? `says docs, but changes ${prodFiles.length} production file(s): ${prodFiles.slice(0, 3).map(x => x.f).join(', ')}`
        : 'says docs and touches only docs and tests',
    );
  } else if (kind === 'unknown') {
    add(
      'kind',
      UNVERIFIED,
      'the request never says what kind of change it is' +
        (catNames.length ? `; its changelog says ${catNames.map(x => `[${x}]`).join(' ')}` : ''),
    );
  } else if (!catNames.length) {
    add('kind', UNVERIFIED, `says ${kind}, and no commit carries a changelog line to compare with`);
  } else if (catNames.some(x => (CONTRADICTS[kind] ?? []).includes(x))) {
    add('kind', CONTRADICTED, `says ${kind}, but its changelog says ${catNames.map(x => `[${x}]`).join(' ')}`);
  } else if (catNames.some(x => (FITS[kind] ?? []).includes(x))) {
    add('kind', CONFIRMED, `says ${kind} and its changelog agrees: ${catNames.map(x => `[${x}]`).join(' ')}`);
  } else {
    add('kind', FLAG, `says ${kind}, its changelog says ${catNames.map(x => `[${x}]`).join(' ')}`);
  }

  if (kind === 'regression') {
    const where = [requestText, ...(ev.issues ?? []).map(i => i.body)].map(t => quote(t, NAMES_VERSION)).find(Boolean);
    add(
      'regression',
      where ? CONFIRMED : UNVERIFIED,
      where ? `names the version it regressed in: "${where}"` : 'calls itself a regression but nothing names a version where it worked',
    );
  }

  // Who it can reach.
  const bySurface = new Map();
  for (const x of ev.files ?? []) {
    const s = surfaceOf(x.f, surfaces);
    bySurface.set(s.id, {surface: s, files: [...(bySurface.get(s.id)?.files ?? []), x.f]});
  }
  const reaching = [...bySurface.values()].filter(x => x.surface.reach !== 'none');
  if (!reaching.length) {
    add('reach', CONFIRMED, 'ships nothing to apps: only docs, tests or CI');
  }
  for (const {surface: s, files} of reaching) {
    const leaks = files.flatMap(f => (ev.importers?.[f] ?? []).map(p => `${f} <- ${p}`));
    if (leaks.length) {
      add('reach', CONTRADICTED, `${s.label} files are used from outside it: ${leaks.slice(0, 4).join('; ')}`);
      continue;
    }
    if (s.reach === 'opt-in-preview') {
      const m = ev.markers?.[s.id];
      add(
        'reach',
        m ? CONFIRMED : CONTRADICTED,
        m
          ? `${files.length} file(s) reach only ${s.label}, an opt-in preview behind \`${s.entry}\`. Nothing outside it uses them and the branch says so at ${m.path}:${m.line}: "${m.text.slice(0, 160)}"`
          : `${s.label} is listed as a preview but ${s.marker.path} on ${state.branch} no longer says so`,
      );
    } else if (s.reach === 'build-config') {
      add('reach', FLAG, `changes ${s.label}, which reaches ${s.entry}: ${files.slice(0, 3).join(', ')}`);
    } else {
      add('reach', INFO, `reaches ${s.label}: ${files.length} production file(s), e.g. ${files.slice(0, 3).join(', ')}`);
    }
  }
  const previewOnly =
    reaching.length > 0 &&
    reaching.every(x => x.surface.reach === 'opt-in-preview' && ev.markers?.[x.surface.id]) &&
    !findings.some(f => f.id === 'reach' && f.status === CONTRADICTED);

  // Breaking in a non-breaking series.
  const nonBreaking = state.schedule?.isNonBreaking;
  const tagged = [...commits, ...mains].filter(x => hasBreakingTag(x.message ?? ''));
  if (tagged.length) {
    add('breaking', nonBreaking ? CONTRADICTED : FLAG, `annotated [BREAKING]: ${tagged.map(x => short(x.sha)).join(', ')}`);
  }
  const watched = breakingSurfaces(commits.flatMap(x => x.files));
  if (watched.length) {
    add('breaking', FLAG, `touches ${watched.map(w => w.id).join(', ')}, where a break would not be annotated`);
  }
  const asks = quote(requestText, ASKS_CONSUMERS) ?? commits.map(x => quote(x.message, ASKS_CONSUMERS)).find(Boolean);
  if (asks) {
    add(
      'breaking',
      previewOnly ? CONFIRMED : nonBreaking ? CONTRADICTED : FLAG,
      previewOnly
        ? `asks users to change their setup ("${asks}"), which only reaches an opt-in preview that reserves the right to change`
        : `asks users to change their setup ("${asks}")` +
            (nonBreaking ? `, which breaks a non-breaking ${state.series}` : ''),
    );
  }

  // Reviewed and green.
  const reviews = ev.pr?.reviews ?? [];
  // Meta's import lands a main commit carrying who accepted it on Phabricator.
  const phab = mains
    .map(m => ({by: /^Reviewed By:\s*(.+)$/m.exec(m.message ?? '')?.[1]?.trim(), diff: /^Differential Revision:\s*(\S+)/m.exec(m.message ?? '')?.[1]}))
    .filter(x => x.by);
  const diverges = (ev.fidelity ?? []).some(f => !f.same);
  const phabText = phab.length
    ? `reviewed by ${[...new Set(phab.map(x => x.by))].join(', ')} on Phabricator (${phab.map(x => x.diff).filter(Boolean).join(', ')})`
    : null;
  if (!reviews.some(r => r.state === 'APPROVED') && phabText) {
    add(
      'review',
      diverges ? FLAG : CONFIRMED,
      diverges
        ? `the main commit was ${phabText}, but the port differs from it and has no review of its own`
        : `${phabText}` + (ev.backportPr ? ', and the port is that same change' : ''),
    );
  } else if (!ev.pr) {
    add('review', UNVERIFIED, 'no PR or Phabricator review found');
  } else if (!reviews.length) {
    add('review', UNVERIFIED, `no review on #${ev.pr.number}`);
  } else {
    const last = new Map();
    for (const r of reviews) {
      if (r.state !== 'COMMENTED') {
        last.set(r.author, r.state);
      }
    }
    const blocking = [...last].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([a]) => a);
    const resolved = [...new Set(reviews.filter(r => r.state === 'CHANGES_REQUESTED').map(r => r.author))].filter(
      a => last.get(a) === 'APPROVED',
    );
    const approvers = [...last].filter(([, s]) => s === 'APPROVED').map(([a]) => a);
    add(
      'review',
      blocking.length ? CONTRADICTED : approvers.length ? CONFIRMED : UNVERIFIED,
      blocking.length
        ? `changes still requested by ${blocking.join(', ')} on #${ev.pr.number}`
        : approvers.length
          ? `approved by ${approvers.join(', ')} on #${ev.pr.number}` +
            (resolved.length ? `, after ${resolved.join(', ')} first requested changes` : '')
          : `#${ev.pr.number} has comments but no approval`,
    );
  }
  if (ev.pr) {
    // Meta's internal checks report on imported PRs and say nothing about a pick.
    const failed = ev.pr.checks
      .filter(x => ['FAILURE', 'ERROR', 'TIMED_OUT', 'CANCELLED'].includes(x.conclusion))
      .filter(x => !/^Facebook Internal/i.test(x.name));
    const notes = [
      c.stackedOn && 'The PR carries the picks below it in the stack, so this CI covers them too',
      !reaching.length && 'This pick ships nothing to apps, so its own commits cannot cause them',
      'Read the logs and decide whether this change can reach them',
    ].filter(Boolean);
    add(
      'ci',
      failed.length ? FLAG : CONFIRMED,
      failed.length
        ? `${failed.length} of ${ev.pr.checks.length} checks on #${ev.pr.number} failed: ${failed.map(x => x.name).slice(0, 5).join(', ').replace(/\.$/, '')}. ${notes.join('. ')}`
        : `${ev.pr.checks.length} checks on #${ev.pr.number}, none failing`,
    );
  }

  // Tests.
  const testFiles = (ev.files ?? []).filter(x => surfaceOf(x.f, surfaces).id === 'tests');
  if (CLAIMS_TEST.test(requestText) && !testFiles.length) {
    add('tests', CONTRADICTED, 'says it adds a test, but no test file changes');
  } else {
    add(
      'tests',
      testFiles.length ? CONFIRMED : INFO,
      testFiles.length ? `${testFiles.length} test file(s) changed` : 'no test changes',
    );
  }

  // Applies on the branch.
  const t = trial?.[c.number];
  if (!t) {
    add('applies', UNVERIFIED, 'no trial cherry-pick was run');
  } else if (t.status === 'clean') {
    add('applies', CONFIRMED, `cherry-picks cleanly onto the ${state.branch} tip` + (c.stackedOn ? `, after #${c.stackedOn}` : ''));
  } else if (t.status === 'empty') {
    add('applies', FLAG, `cherry-picking it changes nothing, so it is already on ${state.branch}`);
  } else if (t.status === 'conflict') {
    add('applies', CONTRADICTED, `${t.sha} conflicts on ${state.branch}: ${t.files.join(', ') || 'see git status'}`);
  } else if (t.status === 'blocked') {
    add('applies', FLAG, `not tried, because #${t.by} below it in the stack does not apply`);
  } else {
    add('applies', UNVERIFIED, 'the trial cherry-pick could not run');
  }

  for (const h of pickDeferralHistory(state.series, c.number)) {
    add('history', FLAG, `deferred from ${h.from} to ${h.to} on ${h.reviewedOn}`);
  }

  return {number: c.number, title: c.title, findings, firstRead: assess(c, state)};
}

const ORDER = [CONTRADICTED, FLAG, UNVERIFIED, CONFIRMED, INFO];
const MARK = {[CONTRADICTED]: '!!', [FLAG]: '! ', [UNVERIFIED]: '? ', [CONFIRMED]: 'ok', [INFO]: '  '};

export function formatPick(result) {
  const L = [`  #${result.number}  ${result.title}   (first read: ${result.firstRead.verdict})`];
  const sorted = [...result.findings].sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  for (const f of sorted) {
    L.push(`    ${MARK[f.status]} ${f.status.padEnd(12)} ${f.id.padEnd(10)} ${f.text}`);
  }
  return L.join('\n');
}

/** The picks step: every open pick, its checked claims and where it stands. */
export function formatInvestigation(state, evidence, {today} = {}) {
  const cands = state.pickCandidates ?? [];
  const pending = cands.filter(c => !c.landed);
  const results = pending.map(c =>
    checkPick(c, evidence?.picks?.[c.number], state, {today, trial: evidence?.trial}),
  );
  const L = [`Pick investigation for ${state.proposedNext}: ${pending.length} pick(s) to decide`];
  if (evidence?.error) {
    L.push(`  evidence could not be gathered: ${evidence.error}`);
  }
  for (const r of results) {
    L.push('');
    L.push(formatPick(r));
  }
  const stacks = stackSummary(results.map(r => ({number: r.number, title: r.title, verdict: r.firstRead.verdict})), cands);
  if (stacks) {
    L.push('');
    L.push(stacks);
  }
  const landed = cands.filter(c => c.landed);
  if (landed.length) {
    L.push('');
    L.push(`Already on ${state.branch}, only closing is left: ${landed.map(c => `#${c.number}`).join(', ')}`);
  }
  const dropped = (state.openPicks ?? []).filter(p => p.notPicked);
  if (dropped.length) {
    L.push('');
    L.push(`Not picked for ${state.proposedNext}:`);
    for (const p of dropped) {
      L.push(`  #${p.number} -> ${p.notPicked.to}  ${p.title}  ${p.notPicked.url ?? ''}`.trimEnd());
    }
  }
  L.push('');
  L.push(
    'The checks are evidence, not a verdict. Dig into everything not CONFIRMED, draft PICK or DROP for each, ' +
      'then act on the captain\'s decision:',
  );
  L.push(`  node scripts/cli.mjs pick --series ${state.series} --pick <n>`);
  L.push(`  node scripts/cli.mjs drop --series ${state.series} --pick <n> --to <version|never> --reason <file>`);
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const series = process.argv[2];
  const at = process.argv.indexOf('--pick');
  const only = at > -1 ? Number(process.argv[at + 1]) : null;
  if (!series) {
    console.error('usage: node scripts/investigate-pick.mjs <series> [--pick <n>]');
    process.exitCode = 1;
  } else {
    const {liveSources} = await import('./sources.mjs');
    const {deriveState} = await import('./release-state.mjs');
    const {gatherPickEvidence} = await import('./evidence.mjs');
    const {resolveCheckout} = await import('./doctor.mjs');
    const state = await deriveState(liveSources(), {series});
    if (only) {
      const byNum = new Map((state.pickCandidates ?? []).map(c => [c.number, c]));
      const keep = new Set();
      for (let n = only; n != null && byNum.has(n); n = byNum.get(n).stackedOn) {
        keep.add(n);
      }
      state.pickCandidates = (state.pickCandidates ?? []).filter(c => keep.has(c.number));
    }
    const evidence = await gatherPickEvidence(state, {checkout: resolveCheckout(), log: m => console.error(m)});
    console.log(formatInvestigation(state, evidence));
  }
}

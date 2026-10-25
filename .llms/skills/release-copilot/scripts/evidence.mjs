/**
 * Evidence for judging a pick or a Hermes commit, gathered live from GitHub and
 * the local checkouts.
 *
 * Kept out of sources.mjs on purpose: it runs git in the checkouts (fetches, a
 * throwaway worktree for the trial cherry-pick) and is only needed by plan, run
 * and investigate-pick, never by status. What it returns is plain data, so the
 * checks in investigate-pick.mjs stay pure and testable offline.
 */

import {spawnSync, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, dirname, basename} from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SURFACES_PATH = join(HERE, '..', 'reference', 'surfaces.json');

const RN_REPO = 'react/react-native';
const RN_URL = `https://github.com/${RN_REPO}.git`;
const HERMES_URL = 'https://github.com/facebook/hermes.git';
const RELEASES_REPO = 'reactwg/react-native-releases';

function git(cwd, args, {input} = {}) {
  const r = spawnSync('git', args, {cwd, input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  return {ok: r.status === 0, out: (r.stdout ?? '').replace(/\s+$/, ''), err: (r.stderr ?? '').trim()};
}

async function gh(args) {
  try {
    const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
    return stdout;
  } catch {
    return '';
  }
}

function json(raw, fallback) {
  try {
    return raw && raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

const unique = xs => [...new Set(xs)];

/** Fetch by URL so nothing depends on what the checkout calls its remotes. */
function fetchSha(cwd, url, ref) {
  if (!git(cwd, ['fetch', '-q', url, ref]).ok) {
    return null;
  }
  const r = git(cwd, ['rev-parse', 'FETCH_HEAD']);
  return r.ok ? r.out : null;
}

// ----------------------------------------------------------------- surfaces

export function loadSurfaces() {
  return JSON.parse(readFileSync(SURFACES_PATH, 'utf8')).surfaces;
}

function globToRegex(glob) {
  const re = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '\u0001')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
    .replace(/\u0001/g, '.*');
  return new RegExp(`^${re}$`);
}

export const DEFAULT_SURFACE = {
  id: 'default',
  reach: 'default',
  label: 'the default build',
  entry: 'every app on this version',
};

export function surfaceOf(path, surfaces = loadSurfaces()) {
  return surfaces.find(s => s.globs.some(g => globToRegex(g).test(path))) ?? DEFAULT_SURFACE;
}

// ------------------------------------------------------------------ commits

/** The commits a pick ADDS: a stacked PR also carries everything below it. */
export function ownCommits(candidate) {
  const r = candidate.resolved?.[0];
  if (!r) {
    return [];
  }
  if (r.ownCommits?.length) {
    return r.ownCommits;
  }
  if (r.prCommits?.length) {
    return r.prCommits;
  }
  return candidate.resolved.map(x => x.sha);
}

/** Where a release-branch commit says it came from on main. */
export function mainReferences(message = '') {
  const port = /\bPort of ([0-9a-f]{7,40})\b/i.exec(message)?.[1];
  const trailer = /cherry picked from commit ([0-9a-f]{7,40})/.exec(message)?.[1];
  const pr = /\(#(\d+)\)\s*$/.exec(message.split('\n')[0])?.[1];
  return {sha: port ?? trailer ?? null, pr: pr ? Number(pr) : null};
}

function numstat(cwd, sha) {
  const r = git(cwd, ['show', '--format=', '--numstat', sha]);
  if (!r.ok) {
    return null;
  }
  return r.out
    .split('\n')
    .filter(Boolean)
    .map(l => {
      const [a, d, ...f] = l.split('\t');
      return {f: f.join('\t'), a: Number(a) || 0, d: Number(d) || 0};
    });
}

function commitInfo(cwd, sha) {
  const meta = git(cwd, ['show', '-s', '--format=%H%x00%an <%ae>%x00%cI%x00%B', sha]);
  const files = numstat(cwd, sha);
  if (!meta.ok || !files) {
    return null;
  }
  const [full, author, date, ...body] = meta.out.split('\u0000');
  return {sha: full, author, date, message: body.join('\u0000').trim(), files};
}

function patchId(cwd, sha) {
  const d = git(cwd, ['show', '--format=', sha]);
  if (!d.ok || !d.out) {
    return null;
  }
  const p = git(cwd, ['patch-id', '--stable'], {input: `${d.out}\n`});
  return p.ok && p.out ? p.out.split(' ')[0] : null;
}

const PRODUCTION = f => surfaceOf(f).reach !== 'none';

/**
 * A main commit and what happened to it after it landed. A revert or a quick
 * follow-up on the same files is the strongest sign a pick is not done yet.
 */
function mainInfo(cwd, sha, mainSha) {
  const c = commitInfo(cwd, sha);
  if (!c) {
    return {sha, missing: true};
  }
  const onMain = git(cwd, ['merge-base', '--is-ancestor', c.sha, mainSha]).ok;
  const subject = c.message.split('\n')[0];
  const revertsBySha = git(cwd, ['log', `${c.sha}..${mainSha}`, '--format=%h%x09%s', '-F', `--grep=${c.sha.slice(0, 10)}`]);
  const revertsBySubject = git(cwd, ['log', `${c.sha}..${mainSha}`, '--format=%h%x09%s', '-F', `--grep=Revert "${subject.replace(/\s*\(#\d+\)$/, '')}`]);
  const reverts = unique(
    [revertsBySha, revertsBySubject]
      .filter(r => r.ok)
      .flatMap(r => r.out.split('\n').filter(Boolean)),
  )
    .map(l => {
      const [s, ...t] = l.split('\t');
      return {sha: s, subject: t.join('\t')};
    })
    .filter(r => /revert|back out/i.test(r.subject));
  const prod = c.files.map(f => f.f).filter(PRODUCTION).slice(0, 20);
  const later = onMain && prod.length
    ? git(cwd, ['log', `${c.sha}..${mainSha}`, '-n', '8', '--format=%h%x09%cs%x09%s', '--', ...prod])
    : {ok: false, out: ''};
  const followUps = later.ok
    ? later.out
        .split('\n')
        .filter(Boolean)
        .map(l => {
          const [s, date, ...t] = l.split('\t');
          return {sha: s, date, subject: t.join('\t')};
        })
        .filter(f => !reverts.some(r => r.sha === f.sha))
    : [];
  return {...c, onMain, pr: mainReferences(c.message).pr, reverts, followUps};
}

async function searchMainByPr(pr) {
  const raw = await gh([
    'api',
    `search/commits?q=repo:${RN_REPO}+%22(%23${pr})%22`,
    '--jq',
    '[.items[] | .sha] | .[0]',
  ]);
  return raw.trim().replace(/"/g, '') || null;
}

/**
 * Is the backport the same change as the main commit it ports. patch-id is
 * the exact answer; per-file line counts say WHERE they differ.
 */
function fidelity(cwd, own, main) {
  if (!own || !main || main.missing) {
    return null;
  }
  const same = (() => {
    const a = patchId(cwd, own.sha);
    const b = patchId(cwd, main.sha);
    return a != null && a === b;
  })();
  if (same) {
    return {own: own.sha, main: main.sha, same: true};
  }
  const byFile = files => new Map(files.map(f => [f.f, f]));
  const o = byFile(own.files);
  const m = byFile(main.files);
  return {
    own: own.sha,
    main: main.sha,
    same: false,
    onlyOwn: [...o.keys()].filter(f => !m.has(f)),
    onlyMain: [...m.keys()].filter(f => !o.has(f)),
    differing: [...o.keys()]
      .filter(f => m.has(f))
      .filter(f => o.get(f).a !== m.get(f).a || o.get(f).d !== m.get(f).d)
      .map(f => ({f, own: `+${o.get(f).a}/-${o.get(f).d}`, main: `+${m.get(f).a}/-${m.get(f).d}`})),
  };
}

const GENERIC_STEMS = new Set(['index', 'utils', 'types', 'constants', 'config', 'helpers', 'README']);

/**
 * Does anything OUTSIDE a file's surface import it. This is what makes "it
 * only affects SwiftPM" a checked fact instead of the author's word.
 */
function outsideImporters(cwd, file, surface, branchSha, surfaces) {
  const stem = basename(file).replace(/\.[^.]+$/, '');
  if (stem.length < 6 || GENERIC_STEMS.has(stem)) {
    return null;
  }
  const g = git(cwd, ['grep', '-n', '-F', '-e', stem, branchSha, '--', 'packages']);
  // A comment naming the file ("AUTO-GENERATED by scripts/setup-apple-spm.js")
  // is not a use of it.
  const COMMENT = /^\s*(\/\/|#|\*|\/\*|<!--)/;
  const paths = g.ok
    ? [
        ...new Set(
          g.out
            .split('\n')
            .filter(Boolean)
            .map(l => /^[0-9a-f]+:([^:]+):\d+:(.*)$/.exec(l))
            .filter(m => m && !COMMENT.test(m[2]))
            .map(m => m[1]),
        ),
      ]
    : [];
  return paths
    .filter(p => p !== file)
    // A publish manifest or ignore file lists a path, it does not run it.
    .filter(p => !/(^|\/)(package\.json|\.gitignore|\.npmignore)$/.test(p))
    .filter(p => {
      const s = surfaceOf(p, surfaces);
      return s.id !== surface.id && s.reach !== 'none';
    })
    .slice(0, 10);
}

function readMarker(cwd, surface, branchSha) {
  const g = git(cwd, ['grep', '-n', '-E', '-e', surface.marker.pattern, branchSha, '--', surface.marker.path]);
  const first = g.ok ? g.out.split('\n')[0] : '';
  const m = /^[0-9a-f]+:([^:]+):(\d+):(.*)$/.exec(first);
  return m ? {path: m[1], line: Number(m[2]), text: m[3].trim()} : null;
}

const ISSUE_LINK = /github\.com\/(?:react|facebook)\/react-native\/issues\/(\d+)|\b(?:Fixes|Closes|Resolves)\s+#(\d+)/gi;

async function pickEvidence(c, {checkout, branchSha, mainSha}) {
  const ev = {number: c.number};
  const req = json(
    await gh(['issue', 'view', String(c.number), '--repo', RELEASES_REPO, '--json', 'body,comments']),
    {},
  );
  ev.request = {
    body: req.body ?? '',
    comments: (req.comments ?? []).map(x => ({
      author: x.author?.login,
      association: x.authorAssociation,
      body: x.body,
      createdAt: x.createdAt,
      url: x.url,
    })),
  };
  const r = c.resolved?.[0];
  if (!r) {
    return ev;
  }

  if (r.backportPr) {
    fetchSha(checkout, RN_URL, `pull/${r.backportPr}/head`);
  }
  ev.backportPr = r.backportPr ?? null;
  ev.commits = ownCommits(c)
    .map(sha => commitInfo(checkout, sha))
    .filter(Boolean);

  // The main commit each pick commit corresponds to. For a pick that cites a
  // main commit, that IS the commit; a backport names it in its message.
  ev.mainCommits = [];
  for (const own of ev.commits) {
    let sha = own.sha;
    if (r.backportPr) {
      const ref = mainReferences(own.message);
      sha = ref.sha ?? (ref.pr ? await searchMainByPr(ref.pr) : null);
    }
    const info = sha ? mainInfo(checkout, sha, mainSha) : {missing: true, pr: mainReferences(own.message).pr};
    ev.mainCommits.push(info);
  }
  ev.fidelity = r.backportPr
    ? ev.commits.map((own, i) => fidelity(checkout, own, ev.mainCommits[i])).filter(Boolean)
    : [];

  const prNumber = r.backportPr ?? ev.mainCommits.find(m => m.pr)?.pr ?? null;
  if (prNumber) {
    const pr = json(
      await gh([
        'pr',
        'view',
        String(prNumber),
        '--repo',
        RN_REPO,
        '--json',
        'number,baseRefName,state,reviews,statusCheckRollup',
      ]),
      null,
    );
    ev.pr = pr && {
      number: pr.number,
      base: pr.baseRefName,
      state: pr.state,
      reviews: (pr.reviews ?? []).map(x => ({author: x.author?.login, state: x.state, at: x.submittedAt})),
      checks: (pr.statusCheckRollup ?? [])
        .map(x => ({name: x.name ?? x.context, conclusion: x.conclusion ?? x.state}))
        .filter(x => x.name),
    };
  }

  const linkText = [ev.request.body, ...ev.commits.map(x => x.message), ...ev.mainCommits.map(x => x.message ?? '')].join('\n');
  const issueNumbers = unique([...linkText.matchAll(ISSUE_LINK)].map(m => Number(m[1] ?? m[2])))
    .filter(n => n >= 1000)
    .slice(0, 2);
  ev.issues = [];
  for (const n of issueNumbers) {
    const issue = json(
      await gh(['issue', 'view', String(n), '--repo', RN_REPO, '--json', 'number,title,body,state,url']),
      null,
    );
    if (issue && !/\/pull\//.test(issue.url ?? '')) {
      ev.issues.push({number: issue.number, title: issue.title, state: issue.state, body: (issue.body ?? '').slice(0, 3000)});
    }
  }

  const surfaces = loadSurfaces();
  const files = unique(ev.commits.flatMap(x => x.files.map(f => f.f)));
  ev.files = files.map(f => ({f, surface: surfaceOf(f, surfaces).id}));
  ev.importers = {};
  ev.markers = {};
  for (const f of files) {
    const s = surfaceOf(f, surfaces);
    // Only a narrow surface makes a reach claim worth checking: build config
    // and the default build are used from everywhere by design.
    if (s.reach !== 'opt-in-preview') {
      continue;
    }
    const outside = outsideImporters(checkout, f, s, branchSha, surfaces);
    if (outside) {
      ev.importers[f] = outside;
    }
    if (s.marker && !(s.id in ev.markers)) {
      ev.markers[s.id] = readMarker(checkout, s, branchSha);
    }
  }
  return ev;
}

/** Bottom-up order: a stack is one group, every other pick its own. */
export function pickGroups(cands) {
  const byNum = new Map(cands.map(c => [c.number, c]));
  const below = new Set(cands.map(c => c.stackedOn).filter(Boolean));
  const groups = [];
  for (const c of cands) {
    if (below.has(c.number)) {
      continue;
    }
    const chain = [c];
    while (chain[0].stackedOn && byNum.has(chain[0].stackedOn)) {
      chain.unshift(byNum.get(chain[0].stackedOn));
    }
    groups.push(chain);
  }
  return groups;
}

/**
 * Cherry-pick each candidate onto the branch tip in a throwaway worktree, in
 * stack order, and report whether it applies. Independent picks each start
 * from the tip, so a conflict is against the branch rather than another pick.
 */
function trialPicks(cands, picks, {checkout, branchSha}) {
  const dir = mkdtempSync(join(tmpdir(), 'rn-trial-pick-'));
  const add = git(checkout, ['worktree', 'add', '-q', '--detach', dir, branchSha]);
  if (!add.ok) {
    rmSync(dir, {recursive: true, force: true});
    return {error: add.err};
  }
  const results = {};
  const commit = sha =>
    git(dir, ['-c', 'user.name=release-copilot', '-c', 'user.email=release-copilot@localhost', 'commit', '-q', '--no-verify', '-m', `trial ${sha}`]);
  try {
    for (const group of pickGroups(cands)) {
      git(dir, ['reset', '-q', '--hard', branchSha]);
      let blockedBy = null;
      for (const c of group) {
        if (blockedBy) {
          results[c.number] = {status: 'blocked', by: blockedBy};
          continue;
        }
        const shas = (picks[c.number]?.commits ?? []).map(x => x.sha);
        if (!shas.length) {
          results[c.number] = {status: 'unknown'};
          blockedBy = c.number;
          continue;
        }
        let res = {status: 'clean'};
        let applied = 0;
        for (const sha of shas) {
          if (!git(dir, ['cherry-pick', '--no-commit', sha]).ok) {
            const u = git(dir, ['diff', '--name-only', '--diff-filter=U']);
            res = {status: 'conflict', sha: sha.slice(0, 11), files: u.out.split('\n').filter(Boolean)};
            git(dir, ['cherry-pick', '--abort']);
            git(dir, ['reset', '-q', '--hard', 'HEAD']);
            break;
          }
          if (git(dir, ['diff', '--cached', '--quiet']).ok) {
            continue;
          }
          commit(sha);
          applied++;
        }
        if (res.status === 'clean' && applied === 0) {
          res = {status: 'empty'};
        }
        results[c.number] = res;
        if (res.status === 'conflict') {
          blockedBy = c.number;
        }
      }
    }
  } finally {
    git(checkout, ['worktree', 'remove', '--force', dir]);
    rmSync(dir, {recursive: true, force: true});
    git(checkout, ['worktree', 'prune']);
  }
  return results;
}

export async function gatherPickEvidence(state, {checkout, log = () => {}} = {}) {
  const cands = (state.pickCandidates ?? []).filter(c => !c.landed);
  if (!cands.length || !checkout) {
    return {picks: {}, trial: {}};
  }
  const branchSha = fetchSha(checkout, RN_URL, state.branch);
  const mainSha = fetchSha(checkout, RN_URL, 'main');
  if (!branchSha || !mainSha) {
    return {picks: {}, trial: {}, error: `could not fetch ${state.branch} and main into ${checkout}`};
  }
  const picks = {};
  for (const c of cands) {
    log(`  gathering evidence for #${c.number}`);
    picks[c.number] = await pickEvidence(c, {checkout, branchSha, mainSha});
  }
  return {branchSha, mainSha, picks, trial: trialPicks(cands, picks, {checkout, branchSha})};
}

// ------------------------------------------------------------------- Hermes

const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'sizeof', 'defined', 'static_assert', 'decltype']);

/** A definition or declaration of `name` on an added line, as opposed to a use. */
export function isDefinitionLine(line, name) {
  const m = new RegExp(`^\\+\\s*(.*?)\\b${name}\\s*\\(`).exec(line);
  if (!m) {
    return false;
  }
  const prefix = m[1].trim();
  return (
    prefix.length > 0 &&
    /^[\w:<>*&\s[\]@,]+$/.test(prefix) &&
    !/\b(return|new|throw|else|case|await|co_await|co_return)\b/.test(prefix)
  );
}

/** Functions an added hunk defines. Declarations ending in `;` do not count. */
export function definedNames(addedLines) {
  const names = [];
  for (const line of addedLines) {
    if (/^\+\s*(\*|\/\/|\/\*|#)/.test(line)) {
      continue;
    }
    const m = /^\+\s*(.*?)\b(\w+)\s*\([^;]*$/.exec(line);
    if (m && !NOT_NAMES.has(m[2]) && isDefinitionLine(line, m[2])) {
      names.push(m[2]);
    }
  }
  return unique(names);
}

const PLATFORM_WORDS = {
  Android: /\bandroid\b/i,
  Apple: /\b(ios|macos|apple|darwin|corefoundation)\b/i,
  Linux: /\blinux\b/i,
  Windows: /\bwindows\b/i,
};
const PLATFORM_PATHS = {
  Android: /(\/java\/|android|\/jni\/|\.java$|\.kt$)/i,
  Apple: /(CF\.|apple|darwin|\/ios\/|macos|\.mm$|\.m$)/i,
  Linux: /(linux|ICU)/i,
  Windows: /(windows|win32|ICU)/i,
};

/**
 * Does the message describe more than the diff does. A graft can carry only
 * part of the original: a94df18620e describes Linux and Windows behaviour and
 * on the stable branch touches one Android file.
 */
export function platformClaims(message, files) {
  const named = Object.keys(PLATFORM_WORDS).filter(p => PLATFORM_WORDS[p].test(message));
  const hinted = files.map(f => Object.keys(PLATFORM_PATHS).filter(p => PLATFORM_PATHS[p].test(f)));
  const touched = unique(hinted.flat());
  const allPlatformSpecific = hinted.length > 0 && hinted.every(h => h.length > 0);
  return {
    named,
    touched,
    claimsMore: named.length > 0 && allPlatformSpecific && named.some(p => !touched.includes(p)),
  };
}

function hermesCommitEvidence(cwd, c, branchSha) {
  const files = numstat(cwd, c.sha);
  const patch = git(cwd, ['show', '--format=', '-U0', c.sha]);
  const message = git(cwd, ['show', '-s', '--format=%B', c.sha]);
  if (!files || !patch.ok) {
    return null;
  }
  const added = patch.out.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  const defs = definedNames(added).map(name => {
    const hits = git(cwd, ['grep', '-n', '-w', '-e', name, branchSha]);
    const onBranch = hits.ok ? hits.out.split('\n').filter(Boolean).length : 0;
    const mentions = added.filter(l => new RegExp(`\\b${name}\\b`).test(l));
    const callsInCommit = mentions.filter(l => !isDefinitionLine(l, name)).length;
    return {name, called: callsInCommit > 0 || onBranch > mentions.length};
  });
  const deletions = files.reduce((n, f) => n + f.d, 0);
  return {
    files,
    defs,
    platforms: platformClaims(message.out, files.map(f => f.f)),
    // Nothing removed and every function it adds is uncalled: shipping it
    // changes no behaviour on this branch.
    inert: deletions === 0 && defs.length > 0 && defs.every(d => !d.called),
  };
}

export function gatherHermesEvidence(hu, {checkout} = {}) {
  const payload = (hu?.commits ?? []).filter(c => !c.versionBump);
  if (!hu?.resolved || !payload.length || !checkout) {
    return null;
  }
  const branchSha = fetchSha(checkout, HERMES_URL, hu.branch);
  if (!branchSha) {
    return null;
  }
  const commits = {};
  for (const c of payload) {
    commits[c.sha] = hermesCommitEvidence(checkout, c, branchSha);
  }
  return {branch: hu.branch, branchSha, commits};
}

/**
 * Environment check for the release captain.
 *
 * Run before a release, not during one. A missing `project` scope or no push
 * access to the template repo is cheap to fix beforehand and expensive to
 * discover halfway through a cut.
 *
 * Every check reports how to fix itself. A check that can only say "broken" is
 * not worth running.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

const exec = promisify(execFile);

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';

async function run(cmd, args) {
  try {
    const {stdout} = await exec(cmd, args, {maxBuffer: 8 * 1024 * 1024});
    return {ok: true, out: stdout.trim()};
  } catch (err) {
    return {ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? err.message)};
  }
}

/** Repos a release touches. Push access to all four is required for a branch cut. */
export const REPOS = [
  {slug: 'react/react-native', why: 'the release branch and tags'},
  {slug: 'react-native-community/template', why: 'the matching template branch (branch cut)'},
  {slug: 'facebook/hermes', why: 'Hermes release branches and tags'},
  {slug: 'reactwg/react-native-releases', why: 'pick requests, test reports, the project board'},
];

async function checkNode() {
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 18) {
    return {
      status: FAIL,
      detail: `node ${process.versions.node} is too old`,
      fix: 'Install Node 22.11 or newer. The release scripts need 18 and RN itself needs 22.11.',
    };
  }
  // The scripts run on 18, but the 0.88 template and the website both refuse
  // anything below 22.11, so the template-check step fails on an older Node.
  return major > 22 || (major === 22 && minor >= 11)
    ? {status: OK, detail: `node ${process.versions.node}`}
    : {
        status: WARN,
        detail: `node ${process.versions.node}: the template check and the website need 22.11+`,
        fix: 'Switch before the release, e.g. `nvm use 22`.',
      };
}

async function checkGh() {
  const v = await run('gh', ['--version']);
  if (!v.ok) {
    return {
      status: FAIL,
      detail: 'gh not found on PATH',
      fix: 'Install the GitHub CLI: https://cli.github.com/',
    };
  }
  const auth = await run('gh', ['auth', 'status']);
  return auth.ok
    ? {status: OK, detail: v.out.split('\n')[0]}
    : {status: FAIL, detail: 'gh is installed but not authenticated', fix: 'Run: gh auth login'};
}

/**
 * The board is Projects v2 at the ORG level. Without these scopes the board
 * reads come back empty rather than erroring, which looks like "no pick
 * requests" and is the worst possible failure mode before a release.
 */
async function checkProjectScope() {
  const r = await run('gh', ['project', 'list', '--owner', 'reactwg', '--limit', '1']);
  return r.ok
    ? {status: OK, detail: 'can read reactwg Projects v2'}
    : {
        status: FAIL,
        detail: 'cannot read the org project board',
        fix: 'Run: gh auth refresh -s read:project,project',
      };
}

async function checkRepoAccess() {
  const results = [];
  for (const {slug, why} of REPOS) {
    const r = await run('gh', ['api', `repos/${slug}`, '--jq', '.permissions.push']);
    const canPush = r.ok && r.out.trim() === 'true';
    results.push({
      name: `push access: ${slug}`,
      status: canPush ? OK : FAIL,
      detail: canPush ? why : `no push access (${why})`,
      fix: canPush ? undefined : `Ask the release crew for write access to ${slug}.`,
    });
  }
  return results;
}

/**
 * Picks are cherry-picked locally and pushed, so a real checkout is required.
 * A shallow clone silently breaks `git merge-base --is-ancestor`, which the
 * hand-run commands in reference/ use.
 */
async function checkCheckout(path, {repo = 'react/react-native', env = 'RN_CHECKOUT', flag = '--checkout'} = {}) {
  if (!path || !existsSync(join(path, '.git'))) {
    return {
      status: FAIL,
      detail: `no ${repo.split('/')[1]} checkout at ${path ?? '(unset)'}`,
      fix: `Clone ${repo} and pass ${flag} <path> or set ${env}.`,
    };
  }
  const shallow = await run('git', ['-C', path, 'rev-parse', '--is-shallow-repository']);
  if (shallow.ok && shallow.out.trim() === 'true') {
    return {
      status: FAIL,
      detail: 'the checkout is SHALLOW',
      fix: `Run: git -C ${path} fetch --unshallow. Ancestry checks silently give wrong answers on a shallow clone.`,
    };
  }
  const count = await run('git', ['-C', path, 'rev-list', '--count', 'HEAD']);
  return {status: OK, detail: `full checkout, ${count.out || '?'} commits`};
}

/** Meta-only. A community captain can run a release without these. */
async function checkMetaTooling() {
  const sl = await run('sl', ['--version']);
  const jf = await run('jf', ['--version']);
  const both = sl.ok && jf.ok;
  return {
    status: both ? OK : WARN,
    detail: both
      ? 'sl and jf available'
      : 'sl/jf not available, Meta-only steps cannot run here',
    fix: both
      ? undefined
      : 'Only needed for js1 publish and importing the changelog diff. A community captain delegates these.',
  };
}

/**
 * Whether this machine can run the Meta-only steps.
 *
 * Same probe the doctor check uses, exported so callers branch on one
 * definition rather than inventing a second answer to the same question.
 */
export async function atMeta() {
  const [sl, jf] = await Promise.all([run('sl', ['--version']), run('jf', ['--version'])]);
  return sl.ok && jf.ok;
}

/**
 * The identity a cherry-pick will record as committer. Every 0.88.1 pick went
 * onto the release branch as `t <t@t>`, permanently, because nothing looked.
 * Git refuses to commit with no identity at all, so a placeholder like that is
 * always something someone set to get past that refusal.
 */
const PLACEHOLDER_NAMES = new Set(['t', 'root', 'user', 'test', 'unknown', 'nobody', 'you', 'your name', 'name']);
const PLACEHOLDER_DOMAINS = /(^|\.)(example\.(com|org|net)|localhost|local|invalid|test|t)$/i;

export function validateIdentity({name, email} = {}) {
  const problems = [];
  const n = String(name ?? '').trim();
  const e = String(email ?? '').trim();
  if (n.length < 2 || PLACEHOLDER_NAMES.has(n.toLowerCase())) {
    problems.push(`name "${n}" is not a real name`);
  }
  const m = /^[^@\s]+@([^@\s]+\.[a-z]{2,})$/i.exec(e);
  if (!m || PLACEHOLDER_DOMAINS.test(m[1])) {
    problems.push(`email "${e}" is not a real address`);
  }
  return problems;
}

export function parseIdent(ident) {
  const m = /^(.*?)\s*<([^>]*)>/.exec(String(ident ?? ''));
  return m ? {name: m[1], email: m[2]} : null;
}

async function checkGitIdentity(checkout) {
  const r = await run('git', ['-C', checkout, 'var', 'GIT_COMMITTER_IDENT']);
  const ident = r.ok ? parseIdent(r.out) : null;
  const fix =
    'Set your own identity, the one your GitHub account knows: git config --global user.name "Your Name" and ' +
    'git config --global user.email you@example.org. Never pass -c user.name or user.email to get past this: a pick ' +
    'records the committer on the release branch forever.';
  if (!ident) {
    return {status: FAIL, detail: 'git has no committer identity for this checkout', fix};
  }
  const problems = validateIdentity(ident);
  return problems.length
    ? {status: FAIL, detail: `picks would be committed as "${ident.name} <${ident.email}>": ${problems.join(', ')}`, fix}
    : {status: OK, detail: `picks are committed as ${ident.name} <${ident.email}>`};
}

/**
 * The react-native checkout git actions run in.
 *
 * One resolver, because doctor and the runner disagreeing is worse than either
 * being wrong: doctor validated the default while the runner fell back to
 * process.cwd(), so a passing doctor sat next to `git switch` running in the
 * wrong repository.
 */
export function resolveCheckout(explicit) {
  return (
    (typeof explicit === 'string' ? explicit : undefined) ??
    process.env.RN_CHECKOUT ??
    join(homedir(), 'git', 'react-native')
  );
}

/**
 * The Hermes checkout pick and Hermes evidence is traced in. GitHub code search
 * only indexes Hermes main, so whether anything on a stable branch calls a
 * function needs a local grep.
 */
export function resolveHermesCheckout(explicit) {
  return (
    (typeof explicit === 'string' ? explicit : undefined) ??
    process.env.HERMES_CHECKOUT ??
    join(homedir(), 'git', 'hermes')
  );
}

export async function runDoctor({checkout, hermesCheckout} = {}) {
  const rnCheckout = resolveCheckout(checkout);
  const hermes = resolveHermesCheckout(hermesCheckout);

  const checks = [
    {name: 'node >= 22.11', ...(await checkNode())},
    {name: 'gh authenticated', ...(await checkGh())},
    {name: 'gh project scope', ...(await checkProjectScope())},
    ...(await checkRepoAccess()),
    {name: `react-native checkout`, ...(await checkCheckout(rnCheckout))},
    {
      name: 'hermes checkout',
      ...(await checkCheckout(hermes, {repo: 'facebook/hermes', env: 'HERMES_CHECKOUT', flag: '--hermes-checkout'})),
    },
    {name: 'Meta-only tooling', ...(await checkMetaTooling())},
  ];

  // The committer every pick records, which is permanent on the release branch.
  if (existsSync(join(rnCheckout, '.git'))) {
    checks.push({name: 'git committer identity', ...(await checkGitIdentity(rnCheckout))});
  }

  const failed = checks.filter(c => c.status === FAIL);
  const warned = checks.filter(c => c.status === WARN);

  return {
    checks,
    ready: failed.length === 0,
    failed: failed.length,
    warned: warned.length,
    checkout: rnCheckout,
    hermesCheckout: hermes,
  };
}

export function formatDoctor(result) {
  const icon = s => (s === OK ? 'ok  ' : s === WARN ? 'warn' : 'FAIL');
  const L = ['Release captain environment check', ''];
  for (const c of result.checks) {
    L.push(`  ${icon(c.status)}  ${c.name.padEnd(42)} ${c.detail}`);
    if (c.fix) {
      L.push(`        -> ${c.fix}`);
    }
  }
  L.push('');
  L.push(
    result.ready
      ? `Ready. ${result.warned} warning(s), none blocking.`
      : `NOT ready: ${result.failed} blocking problem(s). Fix them before starting a release.`,
  );
  return L.join('\n');
}

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
  const major = Number(process.versions.node.split('.')[0]);
  return major >= 18
    ? {status: OK, detail: `node ${process.versions.node}`}
    : {
        status: FAIL,
        detail: `node ${process.versions.node} is too old`,
        fix: 'Install Node 18 or newer. The release scripts and RN itself assume it.',
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
 * A shallow clone silently breaks `git merge-base --is-ancestor`, which every
 * pick-ordering and breaking-change check depends on.
 */
async function checkCheckout(path) {
  if (!path || !existsSync(join(path, '.git'))) {
    return {
      status: FAIL,
      detail: `no react-native checkout at ${path ?? '(unset)'}`,
      fix: 'Clone react/react-native and pass --checkout <path>, or set RN_CHECKOUT.',
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
      : 'Only needed for js1 publish, the Hermes tag cut and importing the changelog diff. A community captain delegates these.',
  };
}

export async function runDoctor({checkout} = {}) {
  const rnCheckout = checkout ?? process.env.RN_CHECKOUT ?? join(homedir(), 'git', 'react-native');

  const checks = [
    {name: 'node >= 18', ...(await checkNode())},
    {name: 'gh authenticated', ...(await checkGh())},
    {name: 'gh project scope', ...(await checkProjectScope())},
    ...(await checkRepoAccess()),
    {name: `react-native checkout`, ...(await checkCheckout(rnCheckout))},
    {name: 'Meta-only tooling', ...(await checkMetaTooling())},
  ];

  const failed = checks.filter(c => c.status === FAIL);
  const warned = checks.filter(c => c.status === WARN);

  return {
    checks,
    ready: failed.length === 0,
    failed: failed.length,
    warned: warned.length,
    checkout: rnCheckout,
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

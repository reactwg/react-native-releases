#!/usr/bin/env node
/**
 * The parts of a Hermes release that the 0.89 cut did by hand or too early.
 *
 *   node scripts/hermes-release.mjs wait <version> --branch <hermes-branch>
 *   node scripts/hermes-release.mjs verify <version> [--wait <minutes>] [--no-latest-v1]
 *   node scripts/hermes-release.mjs pin <rn-branch> <version>
 *   node scripts/hermes-release.mjs push <rn-branch> <version>
 *   node scripts/hermes-release.mjs next-bump <hermes-branch> <cut> <next>
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';

import {resolveCheckout} from './doctor.mjs';

const exec = promisify(execFile);
export const HERMES_REPO = 'meta/hermes';
const RN_REPO = 'react/react-native';
const WORKFLOW = 'RN Build Static Hermes';
const PIN_ROOT = join(homedir(), 'Library', 'Caches', 'release-copilot', 'hermes-pin');

/** The jobs that tag and publish. A run where any of them was skipped published nothing. */
export const PUBLISHING_JOBS = ['set_release_type', 'create-tag', 'build_android', 'publish'];

export const PIN_FILES = {
  properties: 'packages/react-native/sdks/hermes-engine/version.properties',
  packageJson: 'packages/react-native/package.json',
  tag: 'packages/react-native/sdks/.hermesv1version',
};

async function run(cmd, args, opts = {}) {
  try {
    const {stdout} = await exec(cmd, args, {maxBuffer: 64 * 1024 * 1024, ...opts});
    return {ok: true, out: stdout};
  } catch (err) {
    return {ok: false, out: `${err.stdout ?? ''}${err.stderr ?? err.message}`};
  }
}

async function must(cmd, args, opts) {
  const r = await run(cmd, args, opts);
  if (!r.ok) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${r.out.trim().split('\n').slice(-8).join('\n')}`);
  }
  return r.out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Judges a finished run: green is not enough, the publishing jobs must have run. */
export function judgeRun(run) {
  if (run.status !== 'completed') {
    return {ok: false, done: false, detail: `run ${run.databaseId} is ${run.status}`};
  }
  if (run.conclusion !== 'success') {
    return {ok: false, done: true, detail: `run ${run.databaseId} concluded ${run.conclusion}: ${run.url}`};
  }
  // Jobs that call a reusable workflow are listed as "<id> / <inner>" when they
  // run and as the bare id when skipped.
  const conclusion = id => {
    const js = (run.jobs ?? []).filter(j => j.name === id || j.name.startsWith(`${id} / `));
    if (!js.length) {
      return 'missing';
    }
    return js.every(j => j.conclusion === 'success') ? 'success' : js.map(j => j.conclusion).join('/');
  };
  const notRun = PUBLISHING_JOBS.filter(j => conclusion(j) !== 'success');
  if (notRun.length) {
    return {
      ok: false,
      done: true,
      detail:
        `run ${run.databaseId} is green but published nothing: ${notRun.map(j => `${j}=${conclusion(j)}`).join(', ')}. ` +
        "Usually the workflow's repository guard names another repo, or release-type was left at dry-run.",
    };
  }
  return {ok: true, done: true, detail: `run ${run.databaseId} tagged and published: ${run.url}`};
}

/** The newest dispatch on the branch from the last `sinceMinutes`, or null. */
export function recentDispatch(list, {sinceMinutes = 120, now = Date.now()} = {}) {
  return (list ?? []).find(r => now - Date.parse(r.createdAt) < sinceMinutes * 60000) ?? null;
}

export async function waitForRun(version, {branch, sinceMinutes = 120, appearMinutes = 5, log = console.log} = {}) {
  // A run is not listed until a few seconds after its dispatch returns. On
  // 260318099.0.7 the wait asked straight after the cut, found nothing and
  // stopped the phase while the run was building.
  let recent = null;
  const until = Date.now() + appearMinutes * 60000;
  for (;;) {
    const list = JSON.parse(
      await must('gh', ['run', 'list', '--repo', HERMES_REPO, '--workflow', WORKFLOW, '--branch', branch, '--event', 'workflow_dispatch', '--limit', '5', '--json', 'databaseId,createdAt,url,status']),
    );
    recent = recentDispatch(list, {sinceMinutes});
    if (recent || Date.now() >= until) {
      break;
    }
    await sleep(10000);
  }
  if (!recent) {
    throw new Error(`no ${WORKFLOW} dispatch on ${branch} in the last ${sinceMinutes} minutes, after waiting ${appearMinutes} for one to appear. Did the cut step run?`);
  }
  log(`Watching ${recent.url} for ${version}`);
  for (;;) {
    const r = JSON.parse(await must('gh', ['run', 'view', String(recent.databaseId), '--repo', HERMES_REPO, '--json', 'databaseId,status,conclusion,url,jobs,headSha']));
    const v = judgeRun(r);
    if (v.done) {
      log(v.detail);
      if (v.ok) {
        // hermes-v260318099.0.2 was tagged hours before a crash fix was backed
        // out. The tag must be the commit this run built, nothing else.
        const refs = (await run('git', ['ls-remote', '--tags', `https://github.com/${HERMES_REPO}.git`, `refs/tags/hermes-v${version}*`])).out.trim().split('\n').map(l => l.split('\t'));
        // An annotated tag lists the tag object first and the commit as ^{}.
        const tagSha = (refs.find(([, r]) => r === `refs/tags/hermes-v${version}^{}`) ?? refs.find(([, r]) => r === `refs/tags/hermes-v${version}`))?.[0];
        if (tagSha !== r.headSha) {
          log(`but hermes-v${version} is at ${String(tagSha ?? 'nothing').slice(0, 11)}, not the ${r.headSha.slice(0, 11)} this run built`);
          return {...v, ok: false};
        }
        log(`hermes-v${version} is the commit the run built, ${r.headSha.slice(0, 11)}`);
      }
      return v;
    }
    await sleep(60000);
  }
}

async function httpCode(url) {
  const r = await run('curl', ['-s', '-L', '-o', '/dev/null', '-w', '%{http_code}', url]);
  return r.out.trim();
}

/** The iOS prebuild downloads these from repo.reactnative.dev, which lags Maven Central. */
export function iosTarballUrls(version) {
  const base = `https://repo.reactnative.dev/maven2/com/facebook/hermes/hermes-ios/${version}`;
  return ['debug', 'release'].map(b => `${base}/hermes-ios-${version}-hermes-ios-${b}.tar.gz`);
}

/**
 * A 200 is not enough: on .0.6 the CDN served an error page for a while and its
 * checksum did not match the published .sha1. Compare the bytes.
 */
async function tarballMatches(url) {
  const code = await httpCode(url);
  if (code !== '200') {
    return {ok: false, detail: `${url.split('/').pop()}: HTTP ${code}`};
  }
  const expected = (await run('curl', ['-s', '-L', `${url}.sha1`])).out.trim().split(/\s+/)[0];
  const body = await exec('curl', ['-s', '-L', url], {encoding: 'buffer', maxBuffer: 512 * 1024 * 1024}).then(r => r.stdout).catch(() => Buffer.alloc(0));
  const actual = createHash('sha1').update(body).digest('hex');
  return actual === expected
    ? {ok: true, detail: `${url.split('/').pop()}: ${body.length} bytes, sha1 matches`}
    : {ok: false, detail: `${url.split('/').pop()}: sha1 ${actual.slice(0, 12)} does not match the published ${expected.slice(0, 12) || 'none'}, the CDN may still be serving an error page`};
}

export async function verifyRelease(version, {latestV1 = true, branch} = {}) {
  const checks = [];
  const tag = `hermes-v${version}`;
  const tagRef = (await run('git', ['ls-remote', '--tags', `https://github.com/${HERMES_REPO}.git`, `refs/tags/${tag}`])).out.trim();
  checks.push({what: 'tag', ok: Boolean(tagRef), detail: tagRef ? `${tag} at ${tagRef.slice(0, 11)}` : `${tag} does not exist`});
  if (tagRef && branch) {
    const cmp = JSON.parse((await run('gh', ['api', `repos/${HERMES_REPO}/compare/${tag}...${branch}`, '--jq', '{ahead: .ahead_by, subjects: [.commits[].commit.message | split("\n")[0]]}'])).out || '{}');
    const extra = (cmp.subjects ?? []).filter(s => !/^Bump hermes-compiler version to /i.test(s));
    // Commits can land after the cut, so this is for the captain to read, not a failure.
    checks.push({what: 'since the tag', ok: true, detail: extra.length ? `${branch} has ${extra.length} later commit(s), not in this release: ${extra.join('; ')}` : `nothing on ${branch} beyond ${tag}`});
  }
  const npm = await httpCode(`https://registry.npmjs.org/hermes-compiler/${version}?t=${Date.now()}`);
  checks.push({what: 'npm', ok: npm === '200', detail: `hermes-compiler@${version}: HTTP ${npm}`});
  if (latestV1) {
    const tags = JSON.parse((await run('curl', ['-s', `https://registry.npmjs.org/-/package/hermes-compiler/dist-tags?t=${Date.now()}`])).out || '{}');
    checks.push({what: 'latest-v1', ok: tags['latest-v1'] === version, detail: `latest-v1 is ${tags['latest-v1'] ?? 'unset'}`});
  }
  for (const url of iosTarballUrls(version)) {
    checks.push({what: 'iOS tarball', ...(await tarballMatches(url))});
  }
  return {ok: checks.every(c => c.ok), checks};
}

/** The exact pin, as committed for 260318099.0.6 (4eb4d2e795c). */
export function pinContents(files, version) {
  return {
    properties: files.properties.replace(/^HERMES_VERSION_NAME=.*$/m, `HERMES_VERSION_NAME=${version}`),
    packageJson: files.packageJson.replace(/("hermes-compiler":\s*")[^"]*(")/, `$1${version}$2`),
    // No trailing newline: it is read as a git ref.
    tag: `hermes-v${version}`,
  };
}

function pinDir(branch, version) {
  return join(PIN_ROOT, `${branch}-${version}`);
}

export async function pin(branch, version, {log = console.log} = {}) {
  const checkout = resolveCheckout();
  const dir = pinDir(branch, version);
  await must('git', ['-C', checkout, 'fetch', '-q', `https://github.com/${RN_REPO}.git`, branch]);
  const tip = (await must('git', ['-C', checkout, 'rev-parse', 'FETCH_HEAD'])).trim();
  if (existsSync(dir)) {
    await must('git', ['-C', checkout, 'worktree', 'remove', '--force', dir]);
  }
  mkdirSync(PIN_ROOT, {recursive: true});
  await must('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', dir, tip]);
  const read = f => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : '');
  const next = pinContents({properties: read(PIN_FILES.properties), packageJson: read(PIN_FILES.packageJson)}, version);
  for (const [k, f] of Object.entries(PIN_FILES)) {
    writeFileSync(join(dir, f), next[k]);
  }
  await must('git', ['-C', dir, 'add', ...Object.values(PIN_FILES)]);
  await must('git', ['-C', dir, 'commit', '-q', '-m', `Bump Hermes to ${version}`]);
  const sha = (await must('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
  log(`Committed the pin as ${sha.slice(0, 11)} on top of ${branch} at ${tip.slice(0, 11)}, in ${dir}`);
  log((await must('git', ['-C', dir, 'show', '--stat', '--format=%h %an <%ae>%n%s', 'HEAD'])).trim());
  return {dir, sha, tip};
}

/**
 * What the push step checks before pushing. The 0.89 run would have pushed
 * whatever was committed in the captain's checkout, pin or not.
 */
export function judgePin({parent, remoteTip, changed, contents, version}) {
  const problems = [];
  if (parent !== remoteTip) {
    problems.push(`the pin commit sits on ${parent.slice(0, 11)} but the branch is now at ${remoteTip.slice(0, 11)}. Re-run the pin step`);
  }
  const expected = Object.values(PIN_FILES).sort();
  if (JSON.stringify([...changed].sort()) !== JSON.stringify(expected)) {
    problems.push(`the commit changes ${changed.join(', ') || 'nothing'}, not exactly the three pin files`);
  }
  if (!/^HERMES_VERSION_NAME=(.*)$/m.test(contents.properties) || /^HERMES_VERSION_NAME=(.*)$/m.exec(contents.properties)[1].trim() !== version) {
    problems.push(`version.properties does not name ${version}`);
  }
  if (!new RegExp(`"hermes-compiler":\\s*"${version.replace(/\./g, '\\.')}"`).test(contents.packageJson)) {
    problems.push(`package.json does not depend on hermes-compiler ${version}`);
  }
  if (contents.tag !== `hermes-v${version}`) {
    problems.push(`.hermesv1version is ${JSON.stringify(contents.tag)}, not "hermes-v${version}" without a newline`);
  }
  return problems;
}

export async function push(branch, version, {log = console.log} = {}) {
  const dir = pinDir(branch, version);
  if (!existsSync(dir)) {
    throw new Error(`no pin commit for ${version}. Run the pin step first`);
  }
  const remoteTip = (await must('git', ['ls-remote', `https://github.com/${RN_REPO}.git`, `refs/heads/${branch}`])).split('\t')[0].trim();
  const parent = (await must('git', ['-C', dir, 'rev-parse', 'HEAD^'])).trim();
  const changed = (await must('git', ['-C', dir, 'diff', '--name-only', 'HEAD^', 'HEAD'])).trim().split('\n').filter(Boolean);
  const show = f => run('git', ['-C', dir, 'show', `HEAD:${f}`]).then(r => r.out);
  const contents = {properties: await show(PIN_FILES.properties), packageJson: await show(PIN_FILES.packageJson), tag: await show(PIN_FILES.tag)};
  const problems = judgePin({parent, remoteTip, changed, contents, version});
  if (problems.length) {
    throw new Error(`not pushing:\n- ${problems.join('\n- ')}`);
  }
  await must('git', ['-C', dir, 'push', `https://github.com/${RN_REPO}.git`, `HEAD:refs/heads/${branch}`]);
  log(`Pushed ${(await must('git', ['-C', dir, 'rev-parse', '--short=11', 'HEAD'])).trim()} to ${branch}. Its CI rebuilds the artifacts.`);
}

/** Opens the PR that makes the Hermes branch name the next version, without a local checkout. */
export async function nextBump(hermesBranch, cut, next, {log = console.log} = {}) {
  const file = 'npm/hermes-compiler/package.json';
  const head = `bump-hermes-compiler-${next}`;
  const existing = JSON.parse(await must('gh', ['pr', 'list', '--repo', HERMES_REPO, '--base', hermesBranch, '--head', head, '--state', 'all', '--json', 'number,url,state']));
  if (existing.length) {
    log(`Already open: ${existing[0].url} (${existing[0].state})`);
    return existing[0].url;
  }
  const baseSha = (await must('gh', ['api', `repos/${HERMES_REPO}/git/ref/heads/${hermesBranch}`, '--jq', '.object.sha'])).trim();
  const cur = JSON.parse(await must('gh', ['api', `repos/${HERMES_REPO}/contents/${file}?ref=${hermesBranch}`]));
  const text = Buffer.from(cur.content, 'base64').toString('utf8');
  if (!text.includes(`"version": "${cut}"`)) {
    throw new Error(`${file} on ${hermesBranch} does not name ${cut}, so it is not the file this bump expects`);
  }
  const bumped = text.replace(`"version": "${cut}"`, `"version": "${next}"`);
  const title = `Bump hermes-compiler version to ${next}`;
  await must('gh', ['api', `repos/${HERMES_REPO}/git/refs`, '-f', `ref=refs/heads/${head}`, '-f', `sha=${baseSha}`]);
  await must('gh', ['api', '-X', 'PUT', `repos/${HERMES_REPO}/contents/${file}`, '-f', `message=${title}`, '-f', `content=${Buffer.from(bumped).toString('base64')}`, '-f', `sha=${cur.sha}`, '-f', `branch=${head}`]);
  const url = (await must('gh', ['pr', 'create', '--repo', HERMES_REPO, '--base', hermesBranch, '--head', head, '--title', title, '--body', `${cut} is released. RN Build Static Hermes reads this file verbatim, so it has to name ${next} before the next cut.`])).trim().split('\n').at(-1);
  log(`Opened ${url}. Import it so rn-oss and Hermes can review it.`);
  return url;
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  const pos = rest.filter((a, i) => !a.startsWith('--') && !(rest[i - 1] ?? '').startsWith('--wait') && !(rest[i - 1] ?? '').startsWith('--branch'));
  try {
    if (cmd === 'wait') {
      const v = await waitForRun(pos[0], {branch: flag(rest, 'branch')});
      process.exitCode = v.ok ? 0 : 1;
    } else if (cmd === 'verify') {
      const minutes = Number(flag(rest, 'wait') ?? 0);
      const end = Date.now() + minutes * 60000;
      for (;;) {
        const r = await verifyRelease(pos[0], {latestV1: !rest.includes('--no-latest-v1'), branch: flag(rest, 'branch')});
        for (const c of r.checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'}  ${c.what.padEnd(13)} ${c.detail}`);
        if (r.ok || Date.now() >= end) {
          if (!r.ok) {
            console.log(`\nNot ready. Do not pin yet. Re-run later: node scripts/hermes-release.mjs verify ${pos[0]} --wait 60`);
          }
          process.exitCode = r.ok ? 0 : 1;
          break;
        }
        console.log('  not ready, checking again in 5 minutes');
        await sleep(5 * 60000);
      }
    } else if (cmd === 'pin') {
      await pin(pos[0], pos[1]);
    } else if (cmd === 'push') {
      await push(pos[0], pos[1]);
    } else if (cmd === 'next-bump') {
      await nextBump(pos[0], pos[1], pos[2]);
    } else {
      throw new Error('usage: hermes-release.mjs wait|verify|pin|push|next-bump ...');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

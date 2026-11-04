#!/usr/bin/env node
/**
 * Waits for the npm publish of a react-native release and checks it happened.
 *
 *   node scripts/publish-run.mjs wait <version> [--latest]
 *
 * The publish is the publish-npm.yml run triggered by the release tag, not the
 * run on the release branch. The branch run for the bot's "Release <version>"
 * commit goes green with publish_react_native skipped: on 0.89.0-rc.0 that one
 * read as the publish for half an hour while npm still answered 404.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {classifyFailure} from './ci-failures.mjs';

const exec = promisify(execFile);
const RN = 'react/react-native';

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
  return stdout;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The publish run is the one on the tag ref. */
export function pickPublishRun(runs, version) {
  return runs.find(r => r.headBranch === `v${version}`) ?? null;
}

export function judgePublishRun(run) {
  if (run.status !== 'completed') {
    return {done: false, ok: false, detail: `publish run ${run.databaseId} is ${run.status}: ${run.url}`};
  }
  const job = (run.jobs ?? []).find(j => j.name === 'publish_react_native' || j.name.startsWith('publish_react_native '));
  if (!job || job.conclusion !== 'success') {
    return {done: true, ok: false, detail: `publish run ${run.databaseId} finished ${run.conclusion} but publish_react_native was ${job?.conclusion ?? 'missing'}: ${run.url}`};
  }
  // post_publish waits on npm and the template with short timeouts and fails
  // often while the publish itself worked, so it does not fail the release.
  const post = (run.jobs ?? []).find(j => j.name === 'post_publish');
  return {
    done: true,
    ok: true,
    detail: `publish_react_native succeeded in run ${run.databaseId}` + (post && post.conclusion !== 'success' ? `. post_publish was ${post.conclusion}, check its waits before trusting the template and upgrade helper` : ''),
  };
}

async function npmState(version) {
  const code = (await exec('curl', ['-s', '-o', '/dev/null', '-w', '%{http_code}', `https://registry.npmjs.org/react-native/${version}?t=${Date.now()}`]).catch(() => ({stdout: '000'}))).stdout.trim();
  const tags = JSON.parse((await exec('curl', ['-s', `https://registry.npmjs.org/-/package/react-native/dist-tags?t=${Date.now()}`]).catch(() => ({stdout: '{}'}))).stdout || '{}');
  return {published: code === '200', tags};
}

/**
 * bump_podfile_lock runs after the publish and commits [LOCAL] Bump Podfile.lock
 * to the release branch. Rerun only that job: rerunning post_publish
 * republishes the template. Nothing depends on bump_podfile_lock.
 */
export function podfileLockAdvice(runId, jobs, failedLog) {
  const job = (jobs ?? []).find(j => j.name === 'bump_podfile_lock' || j.name.startsWith('bump_podfile_lock '));
  if (!job || job.conclusion !== 'failure') {
    return null;
  }
  const c = classifyFailure(failedLog ?? '');
  const rerun = `gh run rerun ${runId} --repo ${RN} --job ${job.databaseId}`;
  return c.kind === 'flake'
    ? `bump_podfile_lock failed: ${c.reason}. Rerun only that job, not post_publish (which republishes the template): ${rerun}`
    : `bump_podfile_lock failed for an unknown reason, so [LOCAL] Bump Podfile.lock is not on the branch. Read its log before rerunning it alone: ${rerun}`;
}

// build_android took up to 2h17 on the 0.88 publishes, so two hours timed out.
export async function waitForPublish(version, {latest = false, log = console.log, timeoutMinutes = 180} = {}) {
  const end = Date.now() + timeoutMinutes * 60000;
  let run = null;
  while (!run && Date.now() < end) {
    run = pickPublishRun(JSON.parse(await gh(['run', 'list', '--repo', RN, '--workflow', 'publish-npm.yml', '--limit', '20', '--json', 'databaseId,headBranch,status,conclusion,url'])), version);
    if (!run) {
      await sleep(30000);
    }
  }
  if (!run) {
    throw new Error(`no publish-npm.yml run on v${version}. Did Create release push the tag?`);
  }
  log(`Publish run for ${version}: ${run.url}`);
  let verdict;
  for (;;) {
    verdict = judgePublishRun(JSON.parse(await gh(['run', 'view', String(run.databaseId), '--repo', RN, '--json', 'databaseId,status,conclusion,url,jobs'])));
    if (verdict.done || Date.now() >= end) {
      break;
    }
    await sleep(60000);
  }
  log(verdict.detail);
  if (!verdict.ok) {
    return {ok: false, url: run.url};
  }
  const done = JSON.parse(await gh(['run', 'view', String(run.databaseId), '--repo', RN, '--json', 'jobs']));
  if ((done.jobs ?? []).some(j => j.name.startsWith('bump_podfile_lock') && j.conclusion === 'failure')) {
    const failedLog = await gh(['run', 'view', String(run.databaseId), '--repo', RN, '--log-failed']).catch(() => '');
    const advice = podfileLockAdvice(run.databaseId, done.jobs, failedLog.split('\n').filter(l => l.startsWith('bump_podfile_lock')).join('\n'));
    if (advice) {
      log(advice);
    }
  }
  const want = latest ? 'latest' : 'next';
  let npm = await npmState(version);
  for (let i = 0; i < 20 && !(npm.published && npm.tags[want] === version); i++) {
    await sleep(30000);
    npm = await npmState(version);
  }
  log(`npm: react-native@${version} ${npm.published ? 'published' : 'NOT published'}, ${want} is ${npm.tags[want] ?? 'unset'}`);
  return {ok: npm.published && npm.tags[want] === version, url: run.url};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, version, ...rest] = process.argv.slice(2);
  try {
    if (cmd !== 'wait' || !version) {
      throw new Error('usage: publish-run.mjs wait <version> [--latest]');
    }
    const r = await waitForPublish(version, {latest: rest.includes('--latest')});
    process.exitCode = r.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

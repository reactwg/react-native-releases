#!/usr/bin/env node
/**
 * The release test pass, run by the copilot instead of a crew member.
 *
 * Builds and launches RNTester and a fresh RNTestProject on iOS and Android from
 * the release branch's own CI artifacts, runs the cases in
 * reference/release-tests.json, takes a screenshot per case and files the
 * `[<version>] Test Report` issue. The copilot reads every screenshot itself and
 * records its verdict with `confirm`, so a case passes only when the scripted
 * checks and the copilot's look at the screen both say so.
 *
 *   node scripts/release-test.mjs run 0.89.0-rc.0 [--only rntester-ios,...]
 *   node scripts/release-test.mjs confirm 0.89.0-rc.0 --case rntester-ios/launch --pass "why"
 *   node scripts/release-test.mjs report 0.89.0-rc.0
 *   node scripts/release-test.mjs file 0.89.0-rc.0
 *
 * Nothing it creates touches the captain's own setup: a worktree of the release
 * branch, a dedicated "RN Release Test" simulator and "RN_Release_Test" AVD, all
 * under ~/Library/Caches/release-copilot/release-test/. The simulator and the
 * emulator are left running at the end so a failure can be looked at.
 */

import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, openSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

import {childEnv, findJdk, androidSdk} from './verify-template.mjs';
import {resolveCheckout} from './doctor.mjs';

const exec = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const SKILL = resolve(HERE, '..');
const RN_REPO = 'react/react-native';
const RELEASES_REPO = 'reactwg/react-native-releases';
const MARKER = 'release-copilot:test-report';
const SIM_NAME = 'RN Release Test';
const AVD_NAME = 'RN_Release_Test';
const EMULATOR_PORT = 5580;
const METRO_PORT = 8081;
const FAST_REFRESH_TEXT = 'Fast Refresh release check';

export const RUN_ROOT = join(homedir(), 'Library', 'Caches', 'release-copilot', 'release-test');

export function loadSpec(path = join(SKILL, 'reference', 'release-tests.json')) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function casesFor(spec, dimension) {
  return spec.cases.filter(c => c.apps.includes(dimension.app));
}

export function branchFor(version) {
  const m = /^(\d+)\.(\d+)\.\d+(?:-rc\.\d+)?$/.exec(version ?? '');
  return m ? `${m[1]}.${m[2]}-stable` : null;
}

/**
 * micromatch, which codegen's build uses to pick files to compile, does not let
 * `**` cross a dot directory. Under one, codegen's build copies raw Flow into
 * lib/ and still prints OK, and every app built from that checkout fails in
 * codegen with "SyntaxError: Unexpected token '{'". Found on 0.89.0-rc.0 with a
 * worktree under ~/.cache.
 */
export function dotDirectoryIn(path) {
  return resolve(path).split('/').find(seg => seg.startsWith('.') && seg.length > 1) ?? null;
}

/** pass, fail, pending (a screenshot still needs the copilot's verdict) or skipped. */
export function caseStatus(c) {
  if (!c || c.skipped) {
    return 'skipped';
  }
  if (c.checks.some(k => k.ok === false)) {
    return 'fail';
  }
  if (c.checks.some(k => k.ok == null)) {
    return 'pending';
  }
  return 'pass';
}

export function summarizeResults(results, spec) {
  const out = {pass: [], fail: [], pending: [], skipped: []};
  for (const d of spec.dimensions) {
    const dim = results.dimensions?.[d.id];
    for (const c of casesFor(spec, d)) {
      const status = dim?.skipped ? 'skipped' : caseStatus(dim?.cases?.[c.id]);
      out[status].push(`${d.id}/${c.id}`);
    }
  }
  return out;
}

const ICON = {pass: 'pass', fail: 'FAIL', pending: 'pending', skipped: 'skipped'};

export function renderReportBody(results, spec) {
  const s = summarizeResults(results, spec);
  const series = /^(\d+\.\d+)\./.exec(results.version)?.[1] ?? '';
  const L = [];
  L.push('### Target Minor', '', series, '');
  L.push('### Under what system configuration was the test run?', '');
  for (const [k, v] of Object.entries(results.system ?? {})) {
    L.push(`- ${k}: ${v}`);
  }
  L.push(
    `- Branch: \`${results.branch}\` at \`${String(results.sha).slice(0, 11)}\`, artifacts from Test All run ${results.runId}`,
    '- Run by the release copilot. It reads every screenshot itself and records whether the screen shows what the case expects.',
    '',
  );
  L.push('### Tested configurations', '', 'Test cases: the copilot\'s list in `.llms/skills/release-copilot/reference/release-tests.json`.', '');
  for (const d of spec.dimensions) {
    const dim = results.dimensions?.[d.id];
    const ids = casesFor(spec, d).map(c => `${d.id}/${c.id}`);
    const done = !dim?.skipped && ids.every(id => s.pass.includes(id));
    L.push(`- [${done ? 'x' : ' '}] ${d.label}${dim?.skipped ? ` (skipped: ${dim.reason})` : ''}`);
  }
  L.push('', '| Case | ' + spec.dimensions.map(d => d.label.replace(' + Hermes', '')).join(' | ') + ' |');
  L.push('| --- | ' + spec.dimensions.map(() => '---').join(' | ') + ' |');
  for (const c of spec.cases) {
    const cells = spec.dimensions.map(d => {
      if (!c.apps.includes(d.app)) {
        return '-';
      }
      const dim = results.dimensions?.[d.id];
      return ICON[dim?.skipped ? 'skipped' : caseStatus(dim?.cases?.[c.id])];
    });
    L.push(`| ${c.title} | ${cells.join(' | ')} |`);
  }
  L.push('', 'Close this issue if there are no blocking issues.', '', '### Blocking Issues?', '');
  const blocking = [];
  for (const id of s.fail) {
    const [dimId, caseId] = id.split('/');
    const c = results.dimensions[dimId].cases[caseId];
    for (const k of c.checks.filter(x => x.ok === false)) {
      blocking.push(`- ${id} (${k.kind}): ${k.detail}`);
    }
  }
  for (const id of s.pending) blocking.push(`- ${id}: not confirmed yet`);
  for (const id of s.skipped) blocking.push(`- ${id}: not run`);
  L.push(...(blocking.length ? blocking : ['None.']));
  const warnings = Object.entries(results.dimensions ?? {}).flatMap(([id, d]) => (d.warnings ?? []).map(w => `- ${id}: ${w}`));
  if (warnings.length) {
    L.push('', '### Console warnings and errors seen at launch', '', ...[...new Set(warnings)]);
  }
  const marker = {version: results.version, sha: results.sha, summary: s};
  L.push('', `<!-- ${MARKER} ${JSON.stringify(marker)} -->`);
  return L.join('\n');
}

export function parseReportMarker(body) {
  const m = new RegExp(`<!-- ${MARKER} (\\{.*\\}) -->`).exec(String(body ?? ''));
  if (!m) {
    return null;
  }
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/** Every case ran and passed: nothing failing, pending or skipped. */
export function reportPassed(marker) {
  const s = marker?.summary;
  return Boolean(s) && s.pass.length > 0 && s.fail.length === 0 && s.pending.length === 0 && s.skipped.length === 0;
}

export function runDir(version, sha) {
  return join(RUN_ROOT, `${version}-${String(sha).slice(0, 11)}`);
}

export function loadResults(dir) {
  const p = join(dir, 'results.json');
  return existsSync(p) ? JSON.parse(readFileSync(p, 'utf8')) : null;
}

function saveResults(dir, results, spec) {
  writeFileSync(join(dir, 'results.json'), JSON.stringify(results, null, 2) + '\n');
  writeFileSync(join(dir, 'report.md'), renderReportBody(results, spec) + '\n');
}

/** Record the copilot's verdict on a screenshot. */
export function confirmCase(results, ref, {pass, why}) {
  const [dimId, caseId] = String(ref).split('/');
  const c = results.dimensions?.[dimId]?.cases?.[caseId];
  if (!c) {
    throw new Error(`no case ${ref} in this run`);
  }
  const agent = c.checks.find(k => k.kind === 'agent');
  if (!agent) {
    throw new Error(`${ref} has no screenshot to confirm`);
  }
  if (!why || !String(why).trim()) {
    throw new Error('say what the screenshot shows');
  }
  agent.ok = Boolean(pass);
  agent.detail = String(why).trim();
  return results;
}

async function run(cmd, args, opts = {}) {
  try {
    const {stdout, stderr} = await exec(cmd, args, {maxBuffer: 64 * 1024 * 1024, ...opts, env: childEnv(opts.env ?? process.env)});
    return {ok: true, out: stdout + stderr};
  } catch (err) {
    return {ok: false, out: String(err.stdout ?? '') + String(err.stderr ?? err.message)};
  }
}

async function must(cmd, args, opts = {}, what = `${cmd} ${args.join(' ')}`) {
  const r = await run(cmd, args, opts);
  if (!r.ok) {
    throw new Error(`${what} failed:\n${r.out.trim().split('\n').slice(-15).join('\n')}`);
  }
  return r.out;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(what, fn, {timeoutMs = 120000, everyMs = 2000} = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) {
      return;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Node on PATH must be the one running this, or yarn refuses on engines. */
function nodeEnv(extra = {}) {
  return {...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH}`, ...extra};
}

async function portFree(port) {
  const r = await run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN']);
  return !r.ok || r.out.trim().split('\n').length < 2;
}

async function testAllRun(branch, sha) {
  const out = await must('gh', ['run', 'list', '--repo', RN_REPO, '--branch', branch, '--workflow', 'Test All', '--limit', '20', '--json', 'databaseId,headSha,conclusion,status']);
  return JSON.parse(out).find(r => r.headSha === sha && r.status === 'completed' && r.conclusion === 'success') ?? null;
}

async function downloadArtifacts(runId, dir, names) {
  const out = await must('gh', ['api', '--paginate', `repos/${RN_REPO}/actions/runs/${runId}/artifacts?per_page=100`, '--jq', '.artifacts[] | [.id, .name, .expired] | @tsv']);
  const byName = Object.fromEntries(out.trim().split('\n').map(l => l.split('\t')).map(([id, name, expired]) => [name, {id, expired: expired === 'true'}]));
  const paths = {};
  for (const name of names) {
    const a = byName[name];
    if (!a || a.expired) {
      throw new Error(`artifact ${name} is missing or expired on Test All run ${runId}`);
    }
    const zip = join(dir, `${name}.zip`);
    const target = join(dir, name);
    if (!existsSync(target)) {
      await must('sh', ['-c', `gh api repos/${RN_REPO}/actions/artifacts/${a.id}/zip > "${zip}"`]);
      mkdirSync(target, {recursive: true});
      await must('unzip', ['-q', '-o', zip, '-d', target]);
    }
    paths[name] = target;
  }
  return paths;
}

async function prepareWorktree(dir, branch, sha, log) {
  const wt = join(dir, 'rn');
  const checkout = resolveCheckout();
  if (!existsSync(wt)) {
    await must('git', ['-C', checkout, 'fetch', '-q', `https://github.com/${RN_REPO}.git`, branch]);
    const fetched = (await must('git', ['-C', checkout, 'rev-parse', 'FETCH_HEAD'])).trim();
    if (fetched !== sha) {
      throw new Error(`${branch} moved to ${fetched.slice(0, 11)} while starting; re-run against the new tip`);
    }
    await must('git', ['-C', checkout, 'worktree', 'add', '-q', '--detach', wt, sha]);
  }
  log('  installing the release branch dependencies');
  await must('yarn', ['install', '--frozen-lockfile', '--silent'], {cwd: wt, env: nodeEnv()}, 'yarn install in the worktree');
  const codegen = join(wt, 'packages', 'react-native-codegen');
  rmSync(join(codegen, 'lib'), {recursive: true, force: true});
  await must(process.execPath, ['scripts/build.js'], {cwd: codegen, env: nodeEnv()}, 'building @react-native/codegen');
  const flow = await run('grep', ['-rl', '--include=*.js', '^import type', join(codegen, 'lib')]);
  if (flow.ok && flow.out.trim()) {
    throw new Error('@react-native/codegen built with Flow left in lib/, so the apps would fail in codegen');
  }
  return wt;
}

async function iosSimulator(log) {
  const list = JSON.parse(await must('xcrun', ['simctl', 'list', '-j', 'devices', 'runtimes', 'devicetypes']));
  let udid = Object.values(list.devices).flat().find(d => d.name === SIM_NAME && d.isAvailable)?.udid;
  if (!udid) {
    const runtime = list.runtimes.filter(r => r.platform === 'iOS' && r.isAvailable).at(-1);
    const type = list.devicetypes.filter(t => /^iPhone \d+ Pro$/.test(t.name)).at(-1);
    if (!runtime || !type) {
      throw new Error('no iOS simulator runtime or iPhone device type installed');
    }
    udid = (await must('xcrun', ['simctl', 'create', SIM_NAME, type.identifier, runtime.identifier])).trim();
    log(`  created the "${SIM_NAME}" simulator (${type.name}, ${runtime.name})`);
  }
  await run('xcrun', ['simctl', 'boot', udid]);
  await must('xcrun', ['simctl', 'bootstatus', udid, '-b']);
  await run('open', ['-a', 'Simulator', '--args', '-CurrentDeviceUDID', udid]);
  return {platform: 'ios', id: udid, cdpName: SIM_NAME};
}

async function androidEmulator(log) {
  const sdk = androidSdk();
  const jdk = await findJdk();
  if (!sdk || !jdk) {
    throw new Error(!sdk ? 'no Android SDK found (set ANDROID_HOME)' : 'no JDK 17+ found');
  }
  const env = {...process.env, ANDROID_HOME: sdk, JAVA_HOME: jdk.home};
  const avds = (await run(join(sdk, 'emulator', 'emulator'), ['-list-avds'], {env})).out.split('\n').map(s => s.trim());
  if (!avds.includes(AVD_NAME)) {
    const abi = process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
    const root = join(sdk, 'system-images');
    const images = existsSync(root)
      ? readdirSync(root).filter(api => /^android-\d+$/.test(api)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
          .flatMap(api => readdirSync(join(root, api)).filter(tag => existsSync(join(root, api, tag, abi))).map(tag => `system-images;${api};${tag};${abi}`))
      : [];
    if (!images.length) {
      throw new Error(`no ${abi} Android system image installed`);
    }
    const avdmanager = join(sdk, 'cmdline-tools', 'latest', 'bin', 'avdmanager');
    await must('sh', ['-c', `echo no | "${avdmanager}" create avd -n ${AVD_NAME} -k "${images[0]}"`], {env});
    log(`  created the ${AVD_NAME} AVD (${images[0]})`);
  }
  const serial = `emulator-${EMULATOR_PORT}`;
  const adb = join(sdk, 'platform-tools', 'adb');
  const booted = async () => (await run(adb, ['-s', serial, 'shell', 'getprop', 'sys.boot_completed'])).out.trim() === '1';
  if (!(await booted())) {
    const child = spawn(join(sdk, 'emulator', 'emulator'), ['-avd', AVD_NAME, '-port', String(EMULATOR_PORT), '-no-snapshot-save', '-no-boot-anim'], {detached: true, stdio: 'ignore', env});
    child.unref();
    await until('the Android emulator to boot', booted, {timeoutMs: 300000, everyMs: 3000});
  }
  const model = async p => (await run(adb, ['-s', serial, 'shell', 'getprop', p])).out.trim();
  return {platform: 'android', id: serial, adb, env, cdpName: `${await model('ro.product.manufacturer')} ${await model('ro.product.model')}`};
}

const running = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    for (const m of running) m.stop();
    process.exit(130);
  });
}

class Metro {
  constructor(cwd, args, logPath) {
    this.cwd = cwd;
    this.args = args;
    this.logPath = logPath;
  }

  async start() {
    if (!(await portFree(METRO_PORT))) {
      throw new Error(`port ${METRO_PORT} is in use. Stop the Metro (or other server) on it first; the test pass will not kill it for you.`);
    }
    const fd = openSync(this.logPath, 'a');
    this.child = spawn(this.args[0], this.args.slice(1), {cwd: this.cwd, detached: true, stdio: ['ignore', fd, fd], env: nodeEnv()});
    running.add(this);
    await until('Metro to start', async () => {
      try {
        return (await (await fetch(`http://localhost:${METRO_PORT}/status`)).text()) === 'packager-status:running';
      } catch {
        return false;
      }
    }, {timeoutMs: 180000});
  }

  stop() {
    running.delete(this);
    if (this.child?.pid) {
      try {
        process.kill(-this.child.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}

/** A Chrome DevTools Protocol session with one app on one device, nothing else. */
async function cdp(wt, appId, device) {
  const WS = createRequire(join(wt, 'package.json'))('ws');
  let target = null;
  await until(`a debugger target for ${appId} on ${device.cdpName}`, async () => {
    try {
      const list = await (await fetch(`http://localhost:${METRO_PORT}/json/list`)).json();
      target = list.find(t => (t.title ?? '') === `${appId} (${device.cdpName})`) ?? null;
    } catch {
      target = null;
    }
    return target != null;
  }, {timeoutMs: 60000});
  // Metro only accepts DevTools from its own origin.
  const ws = new WS(target.webSocketDebuggerUrl, {origin: `http://localhost:${METRO_PORT}`});
  const pending = new Map();
  const consoleSeen = [];
  let id = 0;
  ws.on('message', d => {
    const m = JSON.parse(d);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    } else if (m.method === 'Runtime.consoleAPICalled' && ['warning', 'error'].includes(m.params.type)) {
      consoleSeen.push(m.params.args.map(a => a.value ?? a.description ?? '').join(' ').replace(/\s+/g, ' ').trim().slice(0, 300));
    } else if (m.method === 'Runtime.exceptionThrown') {
      consoleSeen.push(`exception: ${(m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300)}`);
    }
  });
  await new Promise((res, rej) => {
    ws.on('open', res);
    ws.on('error', rej);
  });
  // The app restarting (a deep link, a reload) drops the session without a
  // close event, so an unanswered call has to give up rather than hang.
  const send = (method, params = {}) => new Promise((res, rej) => {
    const i = ++id;
    const timer = setTimeout(() => {
      pending.delete(i);
      rej(new Error(`${method} got no answer in 15s; the app may have restarted`));
    }, 15000);
    pending.set(i, m => {
      clearTimeout(timer);
      res(m);
    });
    ws.send(JSON.stringify({id: i, method, params}));
  });
  await send('Runtime.enable');
  return {
    async evaluate(expression) {
      const r = await send('Runtime.evaluate', {expression, returnByValue: true});
      if (r.result?.exceptionDetails) {
        throw new Error(r.result.exceptionDetails.exception?.description ?? 'evaluation threw');
      }
      return r.result?.result?.value;
    },
    consoleSeen,
    close: () => ws.close(),
  };
}

async function maestro(device, flow, env, logPath) {
  const args = ['--device', device.id, 'test', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), join(SKILL, 'maestro', flow)];
  const r = await run(join(homedir(), '.maestro', 'bin', 'maestro'), args, {env: {...process.env, ...(device.env ?? {})}});
  writeFileSync(logPath, r.out);
  const failed = r.out.split('\n').find(l => /\.\.\. FAILED/.test(l));
  return {ok: r.ok, detail: r.ok ? `${flow} passed` : `${flow}: ${failed?.trim() ?? 'failed'} (log: ${logPath})`};
}

async function install(device, app, appId) {
  if (device.platform === 'ios') {
    await run('xcrun', ['simctl', 'terminate', device.id, appId]);
    await must('xcrun', ['simctl', 'install', device.id, app]);
  } else {
    await must(device.adb, ['-s', device.id, 'install', '-r', app]);
    await must(device.adb, ['-s', device.id, 'reverse', `tcp:${METRO_PORT}`, `tcp:${METRO_PORT}`]);
  }
}

async function stopApps(device, appIds) {
  for (const id of appIds) {
    if (device.platform === 'ios') {
      await run('xcrun', ['simctl', 'terminate', device.id, id]);
    } else {
      await run(device.adb, ['-s', device.id, 'shell', 'am', 'force-stop', id]);
    }
  }
}

/** Runs every case for one app on one device. Returns {cases, warnings}. */
async function runDimension({dim, spec, device, wt, appPath, edit, shotsDir, log}) {
  const appId = spec.apps[dim.app][dim.platform];
  const landmark = dim.app === 'rntester' ? 'Components' : 'Welcome to React Native';
  const other = Object.values(spec.apps).map(a => a[dim.platform]).filter(id => id !== appId);
  mkdirSync(shotsDir, {recursive: true});
  await stopApps(device, other);
  await install(device, appPath, appId);
  const env = {APP_ID: appId, SHOTS: shotsDir, LANDMARK: landmark};
  const cases = {};
  const flowLog = name => join(shotsDir, `${name}.log`);
  const want = new Set(casesFor(spec, dim).map(c => c.id));
  const record = (id, checks, shot) => {
    cases[id] = {checks: checks.map(k => ({...k})), screenshot: shot ? join(shotsDir, `${shot}.png`) : null};
    log(`    ${caseStatus(cases[id]).padEnd(7)} ${id}`);
  };
  const agentCheck = id => ({kind: 'agent', ok: null, look: spec.cases.find(c => c.id === id).checks.find(k => k.kind === 'agent')?.look});

  const launched = await maestro(device, 'launch.yaml', env, flowLog('launch'));
  // Any flow can restart the app (a deep link, a reload), which drops the
  // debugger session, so every script check talks to a session opened for it.
  let session = null;
  const fresh = async () => {
    session?.close();
    session = await cdp(wt, appId, device);
    return session;
  };
  let warnings = [];
  try {
    await fresh();
    await sleep(3000);
    warnings = [...session.consoleSeen];
  } catch (err) {
    warnings = [`no debugger session: ${err.message}`];
  }
  record('launch', [{kind: 'maestro', ...launched}, agentCheck('launch')], 'launch');

  if (want.has('debugger')) {
    let check;
    try {
      const s = await fresh();
      const sum = await s.evaluate('6*7');
      const hermes = await s.evaluate('typeof HermesInternal');
      check = {kind: 'script', ok: sum === 42 && hermes === 'object', detail: `evaluated 6*7 = ${sum}, HermesInternal is ${hermes}`};
    } catch (err) {
      check = {kind: 'script', ok: false, detail: `debugger: ${err.message}`};
    }
    record('debugger', [check]);
  }

  for (const id of ['textinput', 'keyboard', 'lists']) {
    if (want.has(id)) {
      const flow = {textinput: 'textinput.yaml', keyboard: 'keyboard.yaml', lists: 'flatlist.yaml'}[id];
      record(id, [{kind: 'maestro', ...(await maestro(device, flow, env, flowLog(id)))}, agentCheck(id)], id);
    }
  }

  const openDevMenu = async () => {
    try {
      await (await fresh()).evaluate('nativeModuleProxy.DevMenu.show()');
      return {kind: 'script', ok: true, detail: 'opened the dev menu through the DevMenu module'};
    } catch (err) {
      return {kind: 'script', ok: false, detail: `could not open the dev menu: ${err.message}`};
    }
  };
  if (want.has('dev-menu')) {
    const opened = await openDevMenu();
    record('dev-menu', [opened, {kind: 'maestro', ...(await maestro(device, 'dev-menu.yaml', env, flowLog('dev-menu')))}, agentCheck('dev-menu')], 'dev-menu');
  }
  if (want.has('reload')) {
    const opened = await openDevMenu();
    record('reload', [opened, {kind: 'maestro', ...(await maestro(device, 'reload.yaml', env, flowLog('reload')))}]);
  }

  if (want.has('fast-refresh')) {
    const checks = [];
    if (dim.app === 'rntester') {
      checks.push({kind: 'maestro', ...(await maestro(device, 'playground.yaml', env, flowLog('playground')))});
    }
    const original = readFileSync(edit.file, 'utf8');
    try {
      // The marker lives in the JS runtime: a hot update keeps it, a full
      // reload starts a new runtime without it.
      await (await fresh()).evaluate("globalThis.__releaseCheckMarker = 'kept'");
      writeFileSync(edit.file, original.replace(edit.from, edit.to));
      checks.push({kind: 'maestro', ...(await maestro(device, 'fast-refresh.yaml', env, flowLog('fast-refresh')))});
      const kept = await (await fresh()).evaluate("globalThis.__releaseCheckMarker ?? 'gone'");
      checks.push({kind: 'script', ok: kept === 'kept', detail: kept === 'kept' ? 'hot update, JS state kept' : 'the edit caused a full reload, not a Fast Refresh'});
    } catch (err) {
      checks.push({kind: 'script', ok: false, detail: `fast refresh: ${err.message}`});
    } finally {
      writeFileSync(edit.file, original);
    }
    checks.push(agentCheck('fast-refresh'));
    record('fast-refresh', checks, 'fast-refresh');
  }

  session?.close();
  return {cases, warnings: [...new Set(warnings)]};
}

async function buildProject(project, device, wt, mavenLocal, log) {
  if (device.platform === 'ios') {
    const ios = join(project, 'ios');
    const bundled = (await run('bundle', ['install'], {cwd: ios, env: nodeEnv()})).ok && (await run('bundle', ['exec', 'pod', 'install'], {cwd: ios, env: nodeEnv({USE_HERMES: '1'})})).ok;
    if (!bundled) {
      // A broken local gemset is not a broken release; the CocoaPods on PATH is
      // what verify-template.mjs falls back to as well.
      log('  bundler unusable here, using the CocoaPods on PATH');
      await must('pod', ['install'], {cwd: ios, env: nodeEnv({USE_HERMES: '1'})}, 'pod install for RNTestProject');
    }
    const dd = join(project, '..', 'dd-rntestproject');
    await must('xcodebuild', ['-workspace', 'RNTestProject.xcworkspace', '-scheme', 'RNTestProject', '-configuration', 'Debug', '-sdk', 'iphonesimulator', '-destination', `id=${device.id}`, '-derivedDataPath', dd, 'build'], {cwd: ios, env: nodeEnv()}, 'building RNTestProject for iOS');
    return join(dd, 'Build', 'Products', 'Debug-iphonesimulator', 'RNTestProject.app');
  }
  const props = join(project, 'android', 'gradle.properties');
  let p = readFileSync(props, 'utf8');
  if (!p.includes('react.internal.mavenLocalRepo')) {
    p = p.replace(/^reactNativeArchitectures=.*$/m, 'reactNativeArchitectures=arm64-v8a') + `\nreact.internal.mavenLocalRepo=${mavenLocal}\n`;
    writeFileSync(props, p);
  }
  await must('./gradlew', ['assembleDebug', '--no-daemon'], {cwd: join(project, 'android'), env: {...nodeEnv(), ...device.env}}, 'building RNTestProject for Android');
  return join(project, 'android', 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk');
}

async function systemInfo(devices) {
  const first = async (cmd, args) => (await run(cmd, args)).out.trim().split('\n')[0];
  const info = {
    macOS: `${await first('sw_vers', ['-productVersion'])}`,
    Xcode: (await run('xcodebuild', ['-version'])).out.trim().split('\n').join(', '),
    Node: process.versions.node,
    Maestro: await first(join(homedir(), '.maestro', 'bin', 'maestro'), ['--version']),
  };
  const jdk = await findJdk();
  if (jdk) info.JDK = jdk.version;
  for (const d of devices) {
    if (d.platform === 'ios') {
      const list = JSON.parse((await run('xcrun', ['simctl', 'list', '-j', 'devices'])).out || '{"devices":{}}');
      const rt = Object.entries(list.devices).find(([, ds]) => ds.some(x => x.udid === d.id))?.[0] ?? '';
      info['iOS simulator'] = `${SIM_NAME}, ${rt.split('.').pop().replace(/-/g, ' ').replace(/^iOS (\d+) (\d+)/, 'iOS $1.$2')}`;
    } else {
      info['Android emulator'] = `${AVD_NAME}, ${d.cdpName}, API ${(await run(d.adb, ['-s', d.id, 'shell', 'getprop', 'ro.build.version.sdk'])).out.trim()}`;
    }
  }
  return info;
}

export async function runTestPass(version, {only = null, log = console.log} = {}) {
  const spec = loadSpec();
  const branch = branchFor(version);
  if (!branch) {
    throw new Error(`not a release version: ${version}`);
  }
  if (dotDirectoryIn(RUN_ROOT)) {
    throw new Error(`the run directory ${RUN_ROOT} is under a dot directory, which breaks the codegen build`);
  }
  const sha = (await must('git', ['ls-remote', `https://github.com/${RN_REPO}.git`, `refs/heads/${branch}`])).split('\t')[0].trim();
  if (!sha) {
    throw new Error(`${branch} does not exist`);
  }
  const ci = await testAllRun(branch, sha);
  if (!ci) {
    throw new Error(`no successful Test All run on ${branch} at ${sha.slice(0, 11)} yet, so there are no artifacts to test. Wait for CI.`);
  }
  const dir = runDir(version, sha);
  mkdirSync(dir, {recursive: true});
  const selected = spec.dimensions.filter(d => !only || only.includes(d.id));
  const results = loadResults(dir) ?? {version, branch, sha, runId: ci.databaseId, dimensions: {}};
  for (const d of spec.dimensions) {
    if (!selected.includes(d)) {
      results.dimensions[d.id] ??= {skipped: true, reason: 'not selected for this run'};
    }
  }
  log(`Release test pass for ${version}: ${branch} at ${sha.slice(0, 11)}, Test All run ${ci.databaseId}`);
  log(`Working in ${dir}`);

  const wt = await prepareWorktree(dir, branch, sha, log);
  const art = await downloadArtifacts(ci.databaseId, dir, [
    ...(selected.some(d => d.app === 'rntester' && d.platform === 'ios') ? ['RNTesterApp-NewArch-Debug'] : []),
    ...(selected.some(d => d.app === 'rntester' && d.platform === 'android') ? ['rntester-debug'] : []),
    ...(selected.some(d => d.app === 'rntestproject') ? ['react-native-package', 'maven-local'] : []),
  ]);
  const devices = {};
  for (const [platform, boot] of [['ios', iosSimulator], ['android', androidEmulator]]) {
    if (!selected.some(d => d.platform === platform)) {
      continue;
    }
    try {
      devices[platform] = await boot(log);
    } catch (err) {
      for (const d of selected.filter(x => x.platform === platform)) {
        results.dimensions[d.id] = {skipped: true, reason: `no ${platform} device: ${err.message.split('\n')[0]}`, error: err.message};
      }
      log(`  no ${platform} device: ${err.message}`);
    }
  }
  results.system = await systemInfo(Object.values(devices));
  const runnable = d => devices[d.platform] != null;

  const go = async (dim, appPath, edit) => {
    log(`  ${dim.label}`);
    try {
      const out = await runDimension({dim, spec, device: devices[dim.platform], wt, appPath, edit, shotsDir: join(dir, 'shots', dim.id), log});
      results.dimensions[dim.id] = out;
    } catch (err) {
      results.dimensions[dim.id] = {skipped: true, reason: `could not run: ${err.message.split('\n')[0]}`, error: err.message};
      log(`    could not run: ${err.message}`);
    }
    saveResults(dir, results, spec);
  };

  const rnTester = selected.filter(d => d.app === 'rntester' && runnable(d));
  if (rnTester.length) {
    const metro = new Metro(join(wt, 'packages', 'rn-tester'), ['yarn', 'start', '--port', String(METRO_PORT)], join(dir, 'metro-rntester.log'));
    await metro.start();
    try {
      const edit = {file: join(wt, 'packages', 'rn-tester', 'js', 'examples', 'Playground', 'RNTesterPlayground.js'), from: 'Edit "RNTesterPlayground.js" to change this file', to: FAST_REFRESH_TEXT};
      for (const dim of rnTester) {
        let app = join(art['rntester-debug'] ?? '', 'app-arm64-v8a-debug.apk');
        if (dim.platform === 'ios') {
          // The artifact zip holds the bundle's contents; simctl wants a *.app.
          app = join(dir, 'RNTester.app');
          if (!existsSync(app)) {
            await must('cp', ['-R', art['RNTesterApp-NewArch-Debug'], app]);
          }
        }
        await go(dim, app, edit);
      }
    } finally {
      metro.stop();
    }
  }

  const projectDims = selected.filter(d => d.app === 'rntestproject' && runnable(d));
  if (projectDims.length) {
    const project = join(dir, 'RNTestProject');
    const tgz = readdirSync(art['react-native-package']).find(f => f.endsWith('.tgz'));
    if (!existsSync(join(project, 'package.json'))) {
      if (!(await portFree(4873))) {
        throw new Error('port 4873 is in use; RNTestProject is generated through a local Verdaccio on it');
      }
      log('  generating RNTestProject from the release branch template');
      await must(process.execPath, ['./scripts/e2e/init-project-e2e.js', '--projectName', 'RNTestProject', '--currentBranch', branch, '--directory', project, '--pathToLocalReactNative', join(art['react-native-package'], tgz)], {cwd: wt, env: nodeEnv()}, 'generating RNTestProject');
    }
    const built = {};
    for (const dim of projectDims) {
      try {
        log(`  building RNTestProject for ${dim.platform}`);
        built[dim.id] = await buildProject(project, devices[dim.platform], wt, art['maven-local'], log);
      } catch (err) {
        results.dimensions[dim.id] = {skipped: true, reason: `build failed: ${err.message.split('\n')[0]}`, error: err.message};
        saveResults(dir, results, spec);
      }
    }
    const metro = new Metro(project, ['npx', 'react-native', 'start', '--port', String(METRO_PORT)], join(dir, 'metro-rntestproject.log'));
    await metro.start();
    try {
      const edit = {file: join(project, 'App.tsx'), from: 'templateFileName="App.tsx"', to: `templateFileName="${FAST_REFRESH_TEXT}"`};
      for (const dim of projectDims.filter(d => built[d.id])) {
        await go(dim, built[dim.id], edit);
      }
    } finally {
      metro.stop();
    }
  }

  saveResults(dir, results, spec);
  return {dir, results, summary: summarizeResults(results, spec)};
}

async function existingReport(version) {
  const out = await must('gh', ['issue', 'list', '--repo', RELEASES_REPO, '--state', 'all', '--search', `"[${version}] Test Report" in:title`, '--limit', '5', '--json', 'number,title,state,url']);
  return JSON.parse(out).find(i => i.title.trim() === `[${version}] Test Report`) ?? null;
}

/** Creates or updates the Test Report issue, closing it only when everything passed. */
export async function fileReport(version, {log = console.log} = {}) {
  const spec = loadSpec();
  const branch = branchFor(version);
  const sha = (await must('git', ['ls-remote', `https://github.com/${RN_REPO}.git`, `refs/heads/${branch}`])).split('\t')[0].trim();
  const dir = runDir(version, sha);
  const results = loadResults(dir);
  if (!results) {
    throw new Error(`no test pass for ${version} at ${sha.slice(0, 11)}. Run: node scripts/release-test.mjs run ${version}`);
  }
  const s = summarizeResults(results, spec);
  if (s.pending.length) {
    throw new Error(`confirm every screenshot first, still pending: ${s.pending.join(', ')}`);
  }
  saveResults(dir, results, spec);
  const body = join(dir, 'report.md');
  const issue = await existingReport(version);
  let url;
  if (issue) {
    await must('gh', ['issue', 'edit', String(issue.number), '--repo', RELEASES_REPO, '--body-file', body]);
    url = issue.url;
  } else {
    url = (await must('gh', ['issue', 'create', '--repo', RELEASES_REPO, '--title', `[${version}] Test Report`, '--label', 'Type Release Crew', '--body-file', body])).trim().split('\n').at(-1);
  }
  const passed = reportPassed({summary: s});
  const number = issue?.number ?? url.split('/').pop();
  if (passed) {
    await must('gh', ['issue', 'close', String(number), '--repo', RELEASES_REPO, '--comment', `Passed: every case ran and passed on ${branch} at ${sha.slice(0, 11)}.`]);
  } else if (issue?.state === 'CLOSED') {
    await must('gh', ['issue', 'reopen', String(number), '--repo', RELEASES_REPO]);
  }
  log(`${passed ? 'Filed and closed' : 'Filed, left open with blocking issues:'} ${url}`);
  return {url, passed};
}

function formatSummary(dir, results, spec) {
  const s = summarizeResults(results, spec);
  const L = ['', `pass ${s.pass.length}, FAIL ${s.fail.length}, pending ${s.pending.length}, skipped ${s.skipped.length}`];
  if (s.pending.length) {
    L.push('', 'Look at each screenshot and confirm it:');
    for (const id of s.pending) {
      const [d, c] = id.split('/');
      const kase = results.dimensions[d].cases[c];
      const agent = kase.checks.find(k => k.kind === 'agent');
      L.push(`  ${id}`, `    screenshot: ${kase.screenshot}`, `    expect: ${agent.look}`);
    }
    L.push('', `  node scripts/release-test.mjs confirm ${results.version} --case <id> --pass|--fail "<what the screen shows>"`);
  }
  const warned = Object.entries(results.dimensions).filter(([, d]) => d.warnings?.length);
  if (warned.length) {
    L.push('', 'Console warnings and errors at launch (judge each: a new one on a fresh app is a regression):');
    for (const [id, d] of warned) for (const w of d.warnings) L.push(`  ${id}: ${w}`);
  }
  L.push('', `Report: ${join(dir, 'report.md')}`);
  return L.join('\n');
}

function parseArgs(argv) {
  const args = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const next = argv[i + 1];
      args[a.slice(2)] = next == null || next.startsWith('--') ? true : (i++, next);
    } else {
      args._.push(a);
    }
  }
  return args;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, version] = process.argv.slice(2, 4);
  const args = parseArgs(process.argv.slice(4));
  const usage = 'usage: node scripts/release-test.mjs run|confirm|report|file <version> [--only dims] [--case dim/case --pass|--fail "why"]';
  try {
    if (!version || !branchFor(version)) {
      throw new Error(usage);
    }
    const spec = loadSpec();
    if (cmd === 'run') {
      const {dir, results} = await runTestPass(version, {only: typeof args.only === 'string' ? args.only.split(',') : null});
      console.log(formatSummary(dir, results, spec));
    } else if (cmd === 'confirm' || cmd === 'report') {
      const sha = (await must('git', ['ls-remote', `https://github.com/${RN_REPO}.git`, `refs/heads/${branchFor(version)}`])).split('\t')[0].trim();
      const dir = runDir(version, sha);
      const results = loadResults(dir);
      if (!results) {
        throw new Error(`no test pass for ${version} at ${sha.slice(0, 11)}`);
      }
      if (cmd === 'confirm') {
        const pass = args.pass !== undefined;
        confirmCase(results, args.case, {pass, why: pass ? args.pass : args.fail});
        saveResults(dir, results, spec);
        console.log(formatSummary(dir, results, spec));
      } else {
        console.log(renderReportBody(results, spec));
      }
    } else if (cmd === 'file') {
      await fileReport(version);
    } else {
      throw new Error(usage);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

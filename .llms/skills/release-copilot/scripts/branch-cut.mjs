#!/usr/bin/env node
/**
 * Branch-cut chores the copilot used to leave as notes.
 *
 *   node scripts/branch-cut.mjs template <branch>
 *   node scripts/branch-cut.mjs support-row <series> [--ref <rn-ref>] [--pr]
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const RN = 'react/react-native';
const TEMPLATE = 'react-native-community/template';
const RELEASES = 'reactwg/react-native-releases';
const TABLE = 'docs/support.md';
const WIDTH = 21;

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
  return stdout;
}

async function ghMaybe(args) {
  return gh(args).catch(() => null);
}

export async function templateBranch(branch) {
  const tip = await ghMaybe(['api', `repos/${TEMPLATE}/branches/${branch}`, '--jq', '.commit.sha']);
  return tip ? {exists: true, sha: tip.trim()} : {exists: false};
}

export async function createTemplateBranch(branch, {log = console.log} = {}) {
  const have = await templateBranch(branch);
  if (have.exists) {
    log(`${TEMPLATE} already has ${branch} at ${have.sha.slice(0, 11)}`);
    return have;
  }
  const main = (await gh(['api', `repos/${TEMPLATE}/commits/main`, '--jq', '.sha'])).trim();
  await gh(['api', `repos/${TEMPLATE}/git/refs`, '-f', `ref=refs/heads/${branch}`, '-f', `sha=${main}`]);
  log(`Created ${branch} in ${TEMPLATE} from main at ${main.slice(0, 11)}`);
  return {exists: true, sha: main};
}

const ANDROID = {21: '5.0', 22: '5.1', 23: '6.0', 24: '7.0', 25: '7.1', 26: '8.0', 27: '8.1', 28: '9', 29: '10', 30: '11', 31: '12', 32: '12L', 33: '13', 34: '14', 35: '15', 36: '16'};

/** The lowest version any engines alternative allows: "^22.13.0 || ^24.3.0 || >= 26.0.0" is 22.13.0. */
export function nodeMinimum(engines) {
  const vs = [...String(engines ?? '').matchAll(/(\d+)\.(\d+)\.(\d+)/g)].map(m => m.slice(1).map(Number));
  if (!vs.length) {
    return null;
  }
  vs.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]);
  return vs[0].join('.');
}

export function androidMinimum(toml) {
  const sdk = /^minSdk\s*=\s*"(\d+)"/m.exec(String(toml ?? ''))?.[1];
  return sdk && ANDROID[sdk] ? `Android ${ANDROID[sdk]}` : null;
}

export function parseTable(md) {
  return String(md)
    .split('\n')
    .filter(l => /^\|\s*\d+\.\d+\s*\|/.test(l))
    .map(l => l.split('|').slice(1, -1).map(c => c.trim()));
}

export function formatRow(cells) {
  return `| ${cells.map(c => c.padEnd(WIDTH)).join(' | ')} |`;
}

async function fileAt(ref, path) {
  return ghMaybe(['api', `repos/${RN}/contents/${path}?ref=${ref}`, '-H', 'Accept: application/vnd.github.raw']);
}

/**
 * The row for a new series. Node and the Android minimum come from the code,
 * the rest is policy: copied from the previous series and flagged if the file
 * behind it changed. On 0.89 the Node column was found wrong for three series
 * because it had always been copied.
 */
export async function proposeRow(series, {ref} = {}) {
  const [maj, min] = series.split('.').map(Number);
  const prev = `${maj}.${min - 1}`;
  const table = await gh(['api', `repos/${RELEASES}/contents/${TABLE}`, '-H', 'Accept: application/vnd.github.raw']);
  const rows = parseTable(table);
  const prevRow = rows.find(r => r[0] === prev);
  if (!prevRow) {
    throw new Error(`${TABLE} has no ${prev} row to start from`);
  }
  const at = ref ?? `${series}-stable`;
  const prevRef = `${prev}-stable`;
  const read = async r => ({
    engines: JSON.parse((await fileAt(r, 'packages/react-native/package.json')) ?? '{}').engines?.node,
    toml: await fileAt(r, 'packages/react-native/gradle/libs.versions.toml'),
    gemfile: await fileAt(r, 'Gemfile'),
    helpers: await fileAt(r, 'packages/react-native/scripts/cocoapods/helpers.rb'),
  });
  const [now, before] = [await read(at), await read(prevRef)];
  const notes = [];
  const node = nodeMinimum(now.engines);
  const android = androidMinimum(now.toml);
  const pod = s => /gem 'cocoapods'.*$/m.exec(String(s ?? ''))?.[0];
  const xcode = s => /def self\.min_xcode_version_supported[\s\S]*?'([\d.]+)'/.exec(String(s ?? ''))?.[1];
  if (pod(now.gemfile) !== pod(before.gemfile)) {
    notes.push(`CocoaPods changed since ${prevRef}: ${pod(before.gemfile)} -> ${pod(now.gemfile)}. Decide the column by hand`);
  }
  if (xcode(now.helpers) !== xcode(before.helpers)) {
    notes.push(`the Xcode minimum in helpers.rb changed since ${prevRef}: ${xcode(before.helpers)} -> ${xcode(now.helpers)}. Decide the column by hand`);
  }
  const prevNode = nodeMinimum(before.engines);
  if (prevNode && prevRow[5] !== prevNode) {
    notes.push(`the ${prev} row says Node ${prevRow[5]} but ${prevRef} requires ${prevNode}. Fix it in the same PR`);
  }
  const cells = [series, android ?? prevRow[1], prevRow[2], prevRow[3], prevRow[4], node ?? prevRow[5]];
  const existing = rows.find(r => r[0] === series) ?? null;
  return {series, prev, ref: at, cells, row: formatRow(cells), existing, matches: existing ? existing.join('|') === cells.join('|') : false, notes, table};
}

export async function openSupportPr(p, {log = console.log} = {}) {
  if (p.existing) {
    log(p.matches ? `${TABLE} already has the ${p.series} row` : `${TABLE} has a ${p.series} row that differs: ${formatRow(p.existing)}`);
    return null;
  }
  const lines = p.table.split('\n');
  const at = lines.findIndex(l => new RegExp(`^\\|\\s*${p.prev.replace('.', '\\.')}\\s*\\|`).test(l));
  lines.splice(at, 0, p.row);
  const head = `support-table-${p.series}`;
  const base = (await gh(['api', `repos/${RELEASES}/git/ref/heads/main`, '--jq', '.object.sha'])).trim();
  const fileSha = (await gh(['api', `repos/${RELEASES}/contents/${TABLE}?ref=main`, '--jq', '.sha'])).trim();
  await gh(['api', `repos/${RELEASES}/git/refs`, '-f', `ref=refs/heads/${head}`, '-f', `sha=${base}`]);
  const title = `Add ${p.series} to the external dependencies table`;
  await gh(['api', '-X', 'PUT', `repos/${RELEASES}/contents/${TABLE}`, '-f', `message=${title}`, '-f', `content=${Buffer.from(lines.join('\n')).toString('base64')}`, '-f', `sha=${fileSha}`, '-f', `branch=${head}`]);
  const body = [
    `Adds the ${p.series} row from \`${p.ref}\`: Node from \`engines\` and the Android minimum from \`minSdk\`. JDK, Xcode and CocoaPods are copied from ${p.prev}.`,
    ...(p.notes.length ? ['', ...p.notes.map(n => `- ${n}`)] : []),
  ].join('\n');
  const url = (await gh(['pr', 'create', '--repo', RELEASES, '--base', 'main', '--head', head, '--title', title, '--body', body])).trim().split('\n').at(-1);
  log(`Opened ${url}`);
  return url;
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'template') {
      await createTemplateBranch(rest[0]);
    } else if (cmd === 'support-row') {
      const p = await proposeRow(rest[0], {ref: flag(rest, 'ref')});
      console.log(p.row);
      for (const n of p.notes) console.log(`  note: ${n}`);
      if (p.existing) {
        console.log(p.matches ? `  ${TABLE} already has this row` : `  ${TABLE} has: ${formatRow(p.existing)}`);
      }
      if (rest.includes('--pr')) {
        await openSupportPr(p);
      }
    } else {
      throw new Error('usage: branch-cut.mjs template <branch> | support-row <series> [--ref <ref>] [--pr]');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

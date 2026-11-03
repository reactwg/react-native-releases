#!/usr/bin/env node
/**
 * The series project board on reactwg, through the API calls that built the
 * 0.89 board (#37) by hand.
 *
 *   node scripts/board.mjs create <series> --cut <YYYY-MM-DD> --release <YYYY-MM-DD> [--rcs <n>]
 *   node scripts/board.mjs set-target <series> <issue> <version>
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync, writeFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec = promisify(execFile);
const ORG = 'reactwg';
const RELEASES = 'reactwg/react-native-releases';

async function gh(args) {
  const {stdout} = await exec('gh', args, {maxBuffer: 32 * 1024 * 1024});
  return stdout;
}

/** Variables go in a JSON body: `gh api -F` cannot pass an array of objects. */
async function graphql(query, variables = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'board-'));
  const body = join(dir, 'body.json');
  writeFileSync(body, JSON.stringify({query, variables}));
  try {
    const res = JSON.parse(await gh(['api', 'graphql', '--input', body]));
    if (res.errors?.length) {
      throw new Error(res.errors.map(e => e.message).join('; '));
    }
    return res.data;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

export const boardTitle = series => `React Native ${series} Releases`;

/** rc.0 to one past the expected golden RC, then the .0: what #37 was given. */
export function targetReleaseNames(series, rcs = 6) {
  return [...Array.from({length: rcs}, (_, i) => `${series}.0-rc.${i}`), `${series}.0`];
}

export function previousSeries(series) {
  const [maj, min] = series.split('.').map(Number);
  return `${maj}.${min - 1}`;
}

/** The options after adding the series' values, keeping every existing one as it is. */
export function mergeOptions(existing, names) {
  const have = new Set(existing.map(o => o.name));
  return [
    ...existing.map(o => ({name: o.name, color: o.color, description: o.description ?? ''})),
    ...names.filter(n => !have.has(n)).map(name => ({name, color: 'GRAY', description: ''})),
  ];
}

export async function findBoard(series) {
  const list = JSON.parse(await gh(['project', 'list', '--owner', ORG, '--limit', '100', '--format', 'json']));
  const p = (list.projects ?? []).find(x => !x.closed && x.title === boardTitle(series)) ??
    (list.projects ?? []).find(x => !x.closed && (x.title ?? '').includes(series));
  return p ? {id: p.id, number: p.number, title: p.title, public: p.public, url: p.url} : null;
}

export async function targetReleaseField(number) {
  const d = await graphql(
    `query($n:Int!){ organization(login:"${ORG}"){ projectV2(number:$n){ id fields(first:40){ nodes{ ... on ProjectV2SingleSelectField { id name options { id name color description } } } } } } }`,
    {n: number},
  );
  const p = d.organization.projectV2;
  return {projectId: p.id, field: p.fields.nodes.find(f => f?.name === 'Target Release') ?? null};
}

export async function createBoard(series, {cut, release, rcs = 6, log = console.log} = {}) {
  let board = await findBoard(series);
  if (!board) {
    const prev = await findBoard(previousSeries(series));
    if (!prev) {
      throw new Error(`no ${previousSeries(series)} board to copy from`);
    }
    const org = (await graphql(`query{ organization(login:"${ORG}"){ id } }`)).organization.id;
    const copied = (await graphql(
      'mutation($p:ID!,$o:ID!,$t:String!){ copyProjectV2(input:{projectId:$p, ownerId:$o, title:$t, includeDraftIssues:false}){ projectV2{ id number url title } } }',
      {p: prev.id, o: org, t: boardTitle(series)},
    )).copyProjectV2.projectV2;
    log(`Copied ${prev.title} (#${prev.number}) to ${copied.title} (#${copied.number})`);
    board = {...copied, public: false};
  } else {
    log(`${board.title} (#${board.number}) already exists`);
  }
  await graphql(
    'mutation($p:ID!,$d:String!){ updateProjectV2(input:{projectId:$p, public:true, shortDescription:$d}){ projectV2{ id } } }',
    {p: board.id, d: `React Native ${series} release tracking. Branch cut: ${cut}. Target release: ${release}.`},
  );
  const {field} = await targetReleaseField(board.number);
  if (!field) {
    throw new Error(`#${board.number} has no Target Release field`);
  }
  const wanted = targetReleaseNames(series, rcs);
  const missing = wanted.filter(n => !field.options.some(o => o.name === n));
  if (missing.length) {
    await graphql(
      'mutation($f:ID!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){ updateProjectV2Field(input:{fieldId:$f, singleSelectOptions:$o}){ projectV2Field{ ... on ProjectV2SingleSelectField { id } } } }',
      {f: field.id, o: mergeOptions(field.options, wanted)},
    );
  }
  log(`#${board.number} is public with Target Release ${wanted[0]} to ${wanted.at(-1)}${missing.length ? ` (added ${missing.length})` : ''}`);
  log('');
  log('GitHub has no API for these, do them by hand:');
  log(`  1. Turn on "Auto-add to project" at https://github.com/orgs/${ORG}/projects/${board.number}/workflows for ${RELEASES} issues titled [${series}], or new picks will not reach the board`);
  log(`  2. Give the release crew access at https://github.com/orgs/${ORG}/projects/${board.number}/settings/access, as on the ${previousSeries(series)} board`);
  return board;
}

/** Puts an issue on the series board if needed and sets its Target Release. */
export async function setTarget(series, issue, version, {log = console.log} = {}) {
  const board = await findBoard(series);
  if (!board) {
    throw new Error(`no ${series} board`);
  }
  const {projectId, field} = await targetReleaseField(board.number);
  const option = field?.options.find(o => o.name === version);
  if (!option) {
    throw new Error(`#${board.number} has no Target Release "${version}". Add it first: node scripts/board.mjs create ${series} ...`);
  }
  const nodeId = JSON.parse(await gh(['api', `repos/${RELEASES}/issues/${issue}`, '--jq', '{id: .node_id}'])).id;
  const item = (await graphql(
    'mutation($p:ID!,$c:ID!){ addProjectV2ItemById(input:{projectId:$p, contentId:$c}){ item{ id } } }',
    {p: projectId, c: nodeId},
  )).addProjectV2ItemById.item.id;
  await graphql(
    'mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){ updateProjectV2ItemFieldValue(input:{projectId:$p, itemId:$i, fieldId:$f, value:{singleSelectOptionId:$o}}){ projectV2Item{ id } } }',
    {p: projectId, i: item, f: field.id, o: option.id},
  );
  log(`#${issue}: Target Release ${version} on #${board.number}`);
}

function flag(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    if (cmd === 'create') {
      await createBoard(rest[0], {cut: flag(rest, 'cut'), release: flag(rest, 'release'), rcs: Number(flag(rest, 'rcs') ?? 6)});
    } else if (cmd === 'set-target') {
      await setTarget(rest[0], Number(rest[1]), rest[2]);
    } else {
      throw new Error('usage: board.mjs create <series> --cut <date> --release <date> | set-target <series> <issue> <version>');
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

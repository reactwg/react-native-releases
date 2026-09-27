/**
 * The captain's decision on a pick, as actions.
 *
 * PICK cherry-picks it (a stack from the bottom), checks authorship, pushes and
 * closes the request with the SHA it landed as. DROP says on the request why it
 * is not picked for this version, with a marker the copilot reads back so the
 * pick stops blocking this release and comes back for the one it moved to.
 *
 * Everything goes through declare() and the Runner, so it is described and
 * confirmed like every other mutating step, and a dry run prints it all.
 */

import {declare} from './actions.mjs';
import {hasBreakingTag} from './gates.mjs';
import {notPickedMarker} from './release-state.mjs';
import {parseVersion, seriesOf, compareVersions} from './version.mjs';
import {ownCommits} from './evidence.mjs';

const RN = 'react/react-native';
const RN_URL = `https://github.com/${RN}.git`;
const RELEASES = 'reactwg/react-native-releases';

/** The pick and every pick below it in its stack that has not landed yet. */
export function pickChain(state, number) {
  const cands = state.pickCandidates ?? [];
  const byNum = new Map(cands.map(c => [c.number, c]));
  const target = byNum.get(number);
  if (!target) {
    const open = (state.openPicks ?? []).find(p => p.number === number);
    throw new Error(
      open?.notPicked
        ? `#${number} was not picked for ${state.proposedNext}: ${open.notPicked.url ?? 'see its comments'}`
        : `#${number} is not an open pick candidate for ${state.proposedNext}`,
    );
  }
  const chain = [target];
  while (chain[0].stackedOn) {
    const below = byNum.get(chain[0].stackedOn);
    if (!below) {
      throw new Error(
        `#${chain[0].number} is stacked on #${chain[0].stackedOn}, which is not a candidate for ${state.proposedNext}. ` +
          'It cannot go in without it.',
      );
    }
    chain.unshift(below);
  }
  if (target.landed) {
    throw new Error(`#${number} is already on ${state.branch}, only closing is left`);
  }
  return chain.filter(c => !c.landed);
}

export function dropComment({version, to, reason}) {
  const where =
    to === 'never' ? `It will not be picked into ${seriesOf(parseVersion(version))}.` : `Moving it to ${to}.`;
  return `Not picked for ${version}. ${where}\n\n${String(reason).trim()}\n\n${notPickedMarker(version, to)}`;
}

/** Comment why a pick is not going into this version, and close it if never. */
export function dropActions(state, number, {to, reason}) {
  const open = (state.openPicks ?? []).find(p => p.number === number);
  if (!open) {
    throw new Error(`#${number} is not an open pick request for ${state.series}`);
  }
  if (!reason || !String(reason).trim()) {
    throw new Error('a drop needs a reason: it is what the author reads');
  }
  if (to !== 'never') {
    const target = parseVersion(to);
    const here = parseVersion(state.proposedNext);
    if (!target || !here || compareVersions(target, here) <= 0) {
      throw new Error(`--to must be a later version than ${state.proposedNext} or "never", got "${to}"`);
    }
  }
  const version = state.proposedNext;
  const body = dropComment({version, to, reason});
  const actions = [
    declare({
      step: 'drop',
      why: `say on #${number} why it is not picked for ${version}`,
      cmd: 'gh',
      args: ['issue', 'comment', String(number), '--repo', RELEASES, '--body', body],
      impact: [
        `posts this comment publicly on #${number}, where its author is notified:`,
        ...body.split('\n').map(l => `  | ${l}`),
        to === 'never'
          ? `the copilot stops treating #${number} as a candidate`
          : `the copilot stops treating #${number} as a candidate for ${version} and brings it back for ${to}`,
      ],
      reversible: 'edit or delete the comment on GitHub, which also removes the marker',
    }),
  ];
  if (to === 'never') {
    actions.push(
      declare({
        step: 'drop',
        why: `close #${number}`,
        cmd: 'gh',
        args: ['issue', 'close', String(number), '--repo', RELEASES, '--reason', 'not planned'],
        impact: [`closes #${number} as not planned`],
        reversible: 'reopen the issue',
      }),
    );
  }
  return actions;
}

const authorsOf = out =>
  String(out ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => l.split('\t')[0]);

/**
 * Run a PICK through the runner. Later actions are built from what earlier
 * ones printed (the landed SHAs), which a dry run cannot know, so it shows
 * placeholders there.
 */
export async function runPick(state, number, runner) {
  const chain = pickChain(state, number);
  const nonBreaking = state.schedule?.isNonBreaking;
  const tagged = chain.filter(c => (c.resolved ?? []).some(r => hasBreakingTag(r.message ?? '')));
  if (nonBreaking && tagged.length) {
    throw new Error(
      `${tagged.map(c => `#${c.number}`).join(', ')} carry a [BREAKING] annotation and ${state.series} is non-breaking. ` +
        'Record a reviewed exception first.',
    );
  }
  const shas = chain.flatMap(ownCommits);
  if (!shas.length) {
    throw new Error(`could not resolve #${number} to commits`);
  }
  const prRefs = chain
    .map(c => c.resolved?.[0]?.backportPr)
    .filter(Boolean)
    .map(pr => `pull/${pr}/head`);
  const label = chain.map(c => `#${c.number}`).join(', ');

  await runner.run(
    declare({
      step: 'pick',
      mutates: false,
      why: `fetch ${state.branch}, main and the commits for ${label}`,
      cmd: 'git',
      args: ['fetch', '-q', RN_URL, state.branch, 'main', ...prRefs],
    }),
  );
  const original = await runner.run(
    declare({
      step: 'pick',
      mutates: false,
      why: 'record the original authors, to compare after picking',
      cmd: 'git',
      args: ['log', '--no-walk=unsorted', '--format=%an <%ae>%x09%h %s', ...shas],
    }),
  );
  for (const a of [
    declare({
      step: 'pick',
      why: `switch to ${state.branch}`,
      cmd: 'git',
      args: ['switch', state.branch],
      impact: [`changes your local checkout to ${state.branch}`],
      reversible: 'switch back to the branch you were on',
    }),
    declare({
      step: 'pick',
      why: `bring the local ${state.branch} up to the remote tip`,
      cmd: 'git',
      args: ['pull', '--ff-only', RN_URL, state.branch],
      impact: [`fast-forwards your local ${state.branch}; refuses if it has commits the remote does not`],
      reversible: 'nothing to undo, it only moves forward to what is already published',
    }),
    declare({
      step: 'pick',
      why: `cherry-pick ${label} (${shas.length} commit(s), bottom of the stack first)`,
      cmd: 'git',
      args: ['cherry-pick', '-x', ...shas],
      impact: [`adds ${shas.length} commit(s) to your local ${state.branch}, nothing is pushed yet`],
      reversible: `git cherry-pick --abort while it is in progress, or git reset --hard @{u} afterwards`,
    }),
  ]) {
    const res = await runner.run(a);
    if (res?.skipped === 'declined') {
      return {completed: false, declined: a.why};
    }
  }
  const landed = await runner.run(
    declare({
      step: 'pick',
      mutates: false,
      why: 'check the picked commits kept their original authors',
      cmd: 'git',
      args: ['log', '--reverse', `-${shas.length}`, '--format=%an <%ae>%x09%h %s'],
    }),
  );
  if (!runner.isDryRun) {
    const before = authorsOf(original?.stdout);
    const after = authorsOf(landed?.stdout);
    if (before.join('\n') !== after.join('\n')) {
      throw new Error(
        `authorship changed while picking: ${before.join(', ')} became ${after.join(', ')}. ` +
          `Fix it with git commit --amend --author before pushing; nothing was pushed.`,
      );
    }
  }
  const pushed = await runner.run(
    declare({
      step: 'pick',
      why: `push ${label} to ${state.branch}`,
      cmd: 'git',
      args: ['push', RN_URL, `HEAD:${state.branch}`],
      impact: [
        `publishes ${shas.length} commit(s) to the protected branch ${state.branch}`,
        `${label} ship in ${state.proposedNext}`,
        'triggers full branch CI and invalidates the current test artifacts',
      ],
      reversible: 'not in practice. a bad commit comes out by a follow-up revert',
      confirmToken: state.branch,
    }),
  );
  if (pushed?.skipped === 'declined') {
    return {completed: false, declined: 'push'};
  }

  // Which landed SHAs belong to which pick, in the order they were picked.
  const landedShas = String(landed?.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map(l => l.split('\t')[1]?.split(' ')[0]);
  let at = 0;
  for (const c of chain) {
    const n = ownCommits(c).length;
    const mine = runner.isDryRun ? ['<landed sha>'] : landedShas.slice(at, at + n);
    at += n;
    const res = await runner.run(
      declare({
        step: 'pick',
        why: `close #${c.number} with the SHA it landed as`,
        cmd: 'gh',
        args: [
          'issue',
          'close',
          String(c.number),
          '--repo',
          RELEASES,
          '--comment',
          `Picked into \`${state.branch}\` for ${state.proposedNext} as ${mine.map(s => `\`${s}\``).join(', ')}.`,
        ],
        impact: [`comments on and closes #${c.number}`],
        reversible: 'reopen the issue',
      }),
    );
    if (res?.skipped === 'declined') {
      return {completed: false, declined: `close #${c.number}`};
    }
  }
  return {completed: true, picked: chain.map(c => c.number)};
}

#!/usr/bin/env node
/**
 * Assess open pick requests against the acceptance criteria.
 *
 * This gathers evidence and reasons about it. It does not decide: the criteria
 * turn on intent ("is this a regression?", "is it a nice-to-have?") which a
 * diff cannot settle. So every candidate ends in ACCEPT, REJECT or ASK, and
 * ASK is the honest answer whenever the evidence is thin or points both ways.
 *
 *   node scripts/assess-picks.mjs 0.88
 */

import {liveSources} from './sources.mjs';
import {breakingSurfaces, hasBreakingTag} from './gates.mjs';

export const RELEASE_CREW = ['Nicola', 'Riccardo', 'Fabrizio'];

/** From reference/picks.md. 1-8 accepted, 9-16 not. */
export const ACCEPTED = [
  'regression fix to a core API',
  'bug fix in core React Native',
  'fix to an API used by third-party libraries or out-of-tree platforms',
  'patch-version dependency bump',
  'security fix',
  'fix or revert of an accidental breaking change',
  'performance improvement',
  'anything at all while the release is still on RC0',
];
export const REJECTED = [
  'breaking change',
  'new feature',
  'major or minor dependency bump',
  'pre-release dependency version',
  'change to testing infrastructure',
  'multi-commit pick with several merge conflicts',
  'non-critical improvement',
  'nice-to-have',
];

const TEST_ONLY = /(^|\/)(__tests__|__snapshots__|test|tests)\//;

/**
 * Signals a diff can actually support. Deliberately conservative: each one is
 * evidence for a human judgement, never the judgement itself.
 */
export function readSignals(candidate, state) {
  const r = candidate.resolved[0];
  if (!r) {
    return null;
  }
  const files = r.files ?? [];
  const subject = (r.message ?? '').split('\n')[0];
  const body = r.message ?? '';

  // The criteria turn on intent and the author states intent in the request,
  // not in the commit. #1437's commit reads "Properly enable Pressable after
  // disabled prop reset" while its request says "Fixes a bug which caused...".
  // Reading only the commit subject missed an obvious bug fix.
  const intent = [candidate.title, candidate.description, subject].join(' ');

  const prod = files.filter(f => !TEST_ONLY.test(f.f));
  const tests = files.filter(f => TEST_ONLY.test(f.f));
  const churn = files.reduce((n, f) => n + f.a + f.d, 0);

  return {
    sha: r.sha,
    subject,
    files: files.length,
    productionFiles: prod.length,
    testFiles: tests.length,
    churn,
    testOnly: prod.length === 0 && tests.length > 0,
    annotatedBreaking: hasBreakingTag(body),
    watchedSurfaces: breakingSurfaces(files),
    // A fix says so. Weak on its own, which is why it only ever contributes.
    looksLikeFix: /\b(fix|fixes|fixed|regression|crash|broken|revert)\b/i.test(intent),
    looksLikeFeature: /\b(add|introduce|support for|new)\b/i.test(intent) && !/\bfix/i.test(intent),
    depBump: /\bbump\b/i.test(intent) || files.some(f => /package\.json$|\.lock$|libs\.versions\.toml$/.test(f.f)),
    rc0: /-rc\.0$/.test(state.proposedNext ?? ''),
  };
}

export function assess(candidate, state) {
  const s = readSignals(candidate, state);
  const why = [];

  if (!s) {
    return {
      number: candidate.number,
      title: candidate.title,
      verdict: 'ASK',
      why: ['could not resolve this request to a commit, so there is nothing to assess'],
      ask: 'Ask the author which commit or PR to pick, then re-run.',
    };
  }

  if (candidate.landed) {
    return {
      number: candidate.number,
      title: candidate.title,
      signals: s,
      verdict: 'ACCEPT',
      why: ['already on the release branch, so only the bookkeeping is outstanding'],
      action: 'Close it with the landed SHA and set Target Release.',
    };
  }

  // Hard stops first. A non-breaking series cannot take a breaking change.
  if (s.annotatedBreaking && state.schedule?.isNonBreaking) {
    return {
      number: candidate.number,
      title: candidate.title,
      signals: s,
      verdict: 'REJECT',
      why: [`annotated [BREAKING] and ${state.series} is a non-breaking release (criterion 9)`],
      action: 'Decline or get a reviewed exception recorded first.',
    };
  }

  if (s.rc0) {
    why.push('the release is still on RC0, where criterion 8 accepts anything');
    return {number: candidate.number, title: candidate.title, signals: s, verdict: 'ACCEPT', why};
  }

  // Everything below is a lean, not a verdict.
  let lean = null;

  if (s.testOnly) {
    lean = 'REJECT';
    why.push('touches only tests, which is criterion 13 (testing infrastructure)');
  } else if (s.looksLikeFix && s.productionFiles > 0) {
    lean = 'ACCEPT';
    why.push(`describes a fix and changes ${s.productionFiles} production file(s), which fits criteria 1-3`);
  } else if (s.depBump) {
    lean = 'ASK';
    why.push('looks like a dependency bump: criterion 4 accepts a PATCH bump, criterion 11 rejects major or minor');
  } else if (s.looksLikeFeature) {
    lean = 'REJECT';
    why.push('reads as new functionality rather than a fix, which is criterion 10');
  }

  if (s.watchedSurfaces.length) {
    why.push(
      `touches ${s.watchedSurfaces.map(h => h.id).join(', ')}, where a break would not be annotated, so it needs the reachability test`,
    );
    lean = 'ASK';
  }

  // Criterion 14. Big diffs are not disqualifying, but they are where conflicts
  // and unintended scope live, so they get a human.
  if (s.churn > 400 || s.files > 20) {
    why.push(`large for a pick (${s.files} files, ${s.churn} lines changed), so conflict risk and scope need a look`);
    lean = lean === 'REJECT' ? 'REJECT' : 'ASK';
  }

  if (!lean) {
    lean = 'ASK';
    why.push('the diff does not clearly match an accepted or rejected criterion');
  }

  const out = {number: candidate.number, title: candidate.title, signals: s, verdict: lean, why};
  if (lean === 'ASK') {
    out.ask = `Ask the release crew (${RELEASE_CREW.join(', ')}) to make the call.`;
  }
  return out;
}

/**
 * The closing commands for picks that have landed.
 *
 * Reporting "already landed" inside a gate message is easy to miss: #1437 was
 * closed with no landed SHA on record, which is the one thing picks.md asks
 * for, because nothing put the command in front of the captain.
 */
export function closingActions(results, state) {
  const landed = results.filter(r => r.verdict === 'ACCEPT' && r.why.some(w => /already on the release branch/.test(w)));
  if (!landed.length) {
    return null;
  }
  const L = ['Landed picks still open. Close each with the SHA it landed as:', ''];
  for (const r of landed) {
    L.push(`  #${r.number}  ${r.title}`);
  }
  L.push('');
  L.push('  gh issue close <n> --repo reactwg/react-native-releases --comment "Picked manually into \`' +
    (state.branch ?? '<branch>') + '\` as \`<sha>\`..."');
  L.push(`  then set Target Release to ${state.proposedNext ?? 'the version it ships in'} on the board.`);
  L.push('  Read the SHA off the branch rather than copying it: a cherry-pick creates a new commit.');
  return L.join('\n');
}

export function formatAssessment(results, state) {
  const L = [];
  L.push(`Pick assessment for ${state.series}, ${results.length} open request(s)`);
  L.push('');
  for (const r of results) {
    L.push(`  ${r.verdict.padEnd(6)} #${r.number}  ${r.title}`);
    if (r.signals) {
      const s = r.signals;
      L.push(
        `         ${s.sha}  ${s.files} file(s), ${s.churn} lines, ${s.productionFiles} production, ${s.testFiles} test`,
      );
    }
    for (const w of r.why) {
      L.push(`         - ${w}`);
    }
    if (r.action) {
      L.push(`         -> ${r.action}`);
    }
    if (r.ask) {
      L.push(`         -> ${r.ask}`);
    }
    L.push('');
  }
  const closing = closingActions(results, state);
  if (closing) {
    L.push(closing);
    L.push('');
  }
  const asks = results.filter(r => r.verdict === 'ASK');
  L.push(
    asks.length
      ? `${asks.length} need a human decision: ${asks.map(a => `#${a.number}`).join(', ')}. The signals above are evidence, not a verdict.`
      : 'None need escalation.',
  );
  return L.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const series = process.argv[2];
  if (!series) {
    console.error('usage: node scripts/assess-picks.mjs <series>   e.g. 0.88');
    process.exitCode = 1;
  } else {
    const {deriveState} = await import('./release-state.mjs');
    const state = await deriveState(liveSources(), {series});
    const results = (state.pickCandidates ?? []).map(c => assess(c, state));
    console.log(formatAssessment(results, state));
  }
}

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
import {pickDeferralHistory} from './release-state.mjs';

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

  const docs = files.filter(f => /\.(md|mdx)$/.test(f.f));
  const prod = files.filter(f => !TEST_ONLY.test(f.f) && !docs.includes(f));
  const tests = files.filter(f => TEST_ONLY.test(f.f) && !docs.includes(f));
  const churn = files.reduce((n, f) => n + f.a + f.d, 0);

  return {
    sha: r.sha,
    backportPr: r.backportPr ?? null,
    subject,
    files: files.length,
    productionFiles: prod.length,
    testFiles: tests.length,
    churn,
    testOnly: prod.length === 0 && tests.length > 0,
    docsOnly: files.length > 0 && docs.length === files.length,
    annotatedBreaking: hasBreakingTag(body),
    watchedSurfaces: breakingSurfaces(files),
    // A fix says so. Weak on its own, which is why it only ever contributes.
    // "bug" and "fails" carry as much fix-intent as "fix". #1440 described a
    // silent failure without ever saying "fix" and was rejected as a feature.
    looksLikeFix:
      /\b(fix|fixes|fixed|bug|regression|crash|broken|fails?|failing|revert)\b/i.test(intent),
    // "new" alone is too weak: "installing new packages" is not a feature claim.
    // Require a verb that actually announces added functionality.
    looksLikeFeature:
      /\b(adds?|added|introduces?|new (api|feature|option|prop|method)|support for)\b/i.test(intent) &&
      !/\b(fix|bug|regression|crash|broken|fails?|failing)\b/i.test(intent),
    depBump:
      /\bbump(s|ed)?\b[^.\n]{0,40}\b(to|from)\s+v?\d/i.test(intent) ||
      files.some(f => /package\.json$|\.lock$|libs\.versions\.toml$/.test(f.f)),
    // Criterion 7 accepts these, but a build-flag change reaches every app.
    looksLikePerf: /\b(perf|performance|faster|optimi[sz](e|ed|ation))\b|(^|\s)-O[0-3sz]\b/i.test(intent),
    buildConfig: files.some(f => /\.podspec$|\.xcconfig$|CMakeLists\.txt$|\.gradle(\.kts)?$|\.rb$/.test(f.f)),
    // A change can break consumers with no [BREAKING] tag: #1453's changelog
    // says a custom xcconfig "must now #include the generated file".
    asksConsumersToChange:
      /\bmust (now|add|update|change|include|migrate)\b|\bno longer (works?|supported)\b|\bmigrat(e|ion) (to|guide)\b/i.test(
        `${candidate.description}\n${body}`,
      ),
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

  if (s.backportPr) {
    why.push(
      `a backport PR (#${s.backportPr}) opened against ${state.branch}, so this reads the PR's own diff, not a commit on main`,
    );
  }
  if (candidate.stackedOn) {
    why.push(
      `stacked on #${candidate.stackedOn}: the PR carries that pick's commits too, so it cannot go in without it. The numbers above are only the commits it adds`,
    );
  }

  if (s.rc0) {
    why.push('the release is still on RC0, where criterion 8 accepts anything');
    return {number: candidate.number, title: candidate.title, signals: s, verdict: 'ACCEPT', why};
  }

  // Everything below is a lean, not a verdict.
  let lean = null;

  if (s.docsOnly) {
    lean = 'ACCEPT';
    why.push('touches only docs, so it ships nothing to apps and its size carries no risk');
  } else if (s.testOnly) {
    lean = 'REJECT';
    why.push('touches only tests, which is criterion 13 (testing infrastructure)');
  } else if (s.looksLikeFix && s.productionFiles > 0) {
    lean = 'ACCEPT';
    why.push(`describes a fix and changes ${s.productionFiles} production file(s), which fits criteria 1-3`);
  } else if (s.looksLikePerf && s.productionFiles > 0) {
    lean = 'ACCEPT';
    why.push('reads as a performance improvement, which is criterion 7');
  } else if (s.depBump) {
    lean = 'ASK';
    why.push('looks like a dependency bump: criterion 4 accepts a PATCH bump, criterion 11 rejects major or minor');
  } else if (s.looksLikeFeature) {
    lean = 'REJECT';
    why.push('reads as new functionality rather than a fix, which is criterion 10');
  }

  if (s.buildConfig) {
    why.push('changes build configuration, which reaches every app that builds React Native from source');
    lean = lean === 'REJECT' ? 'REJECT' : 'ASK';
  }

  if (s.asksConsumersToChange) {
    why.push(
      state.schedule?.isNonBreaking
        ? `its description tells users they must change their setup, which breaks a non-breaking ${state.series} unless the feature is opt-in and experimental`
        : 'its description tells users they must change their setup, so it needs a changelog entry saying how',
    );
    lean = lean === 'REJECT' ? 'REJECT' : 'ASK';
  }

  if (s.watchedSurfaces.length) {
    why.push(
      `touches ${s.watchedSurfaces.map(h => h.id).join(', ')}, where a break would not be annotated, so it needs the reachability test`,
    );
    lean = 'ASK';
  }

  // Criterion 14. Big diffs are not disqualifying, but they are where conflicts
  // and unintended scope live, so they get a human.
  if (!s.docsOnly && (s.churn > 400 || s.files > 20)) {
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

/**
 * Stacked picks, bottom first. A stack is not a set of independent requests:
 * the crew decides where to cut it and everything below the cut goes in.
 */
export function stackSummary(results, candidates) {
  const on = new Map((candidates ?? []).filter(c => c.stackedOn).map(c => [c.number, c.stackedOn]));
  if (!on.size) {
    return null;
  }
  const below = new Set(on.values());
  const tops = [...on.keys()].filter(n => !below.has(n));
  const byNumber = new Map(results.map(r => [r.number, r]));
  const L = ['Stacked picks. Each needs every pick below it, so the question for the crew is where to cut the stack:'];
  for (const top of tops) {
    const chain = [top];
    while (on.has(chain[0])) {
      chain.unshift(on.get(chain[0]));
    }
    L.push('');
    for (const [i, n] of chain.entries()) {
      const r = byNumber.get(n);
      L.push(`  ${i + 1}. ${(r?.verdict ?? '?').padEnd(6)} #${n}  ${r?.title ?? ''}`);
    }
  }
  L.push('');
  L.push('  Pick from the bottom and stop at the cut. Picks above the cut wait for the next patch.');
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
        `         ${s.backportPr ? `PR #${s.backportPr} @ ` : ''}${s.sha}  ${s.files} file(s), ${s.churn} lines, ${s.productionFiles} production, ${s.testFiles} test`,
      );
    }
    for (const w of r.why) {
      L.push(`         - ${w}`);
    }
    // The verdict judges the change on its merits. It used to print ACCEPT on
    // picks the captain had already deferred twice, with nothing saying so.
    for (const h of pickDeferralHistory(state.series, r.number)) {
      L.push(`         ! deferred from ${h.from} to ${h.to} on ${h.reviewedOn}`);
    }
    if (r.action) {
      L.push(`         -> ${r.action}`);
    }
    if (r.ask) {
      L.push(`         -> ${r.ask}`);
    }
    L.push('');
  }
  const stacks = stackSummary(results, state.pickCandidates);
  if (stacks) {
    L.push(stacks);
    L.push('');
  }
  const closing = closingActions(results, state);
  if (closing) {
    L.push(closing);
    L.push('');
  }
  const assessed = new Set(results.map(r => r.number));
  const deferred = (state.openPicks ?? []).filter(
    p => !assessed.has(p.number) && p.targetRelease && p.targetRelease !== state.proposedNext,
  );
  if (deferred.length) {
    L.push(`Deferred out of ${state.proposedNext}, not assessed:`);
    for (const p of deferred) {
      L.push(`  #${p.number} -> ${p.targetRelease}  ${p.title}`);
    }
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

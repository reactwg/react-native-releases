#!/usr/bin/env node
/**
 * release-copilot CLI.
 *
 *   status  --series 0.88            derive and print state
 *   status  --series 0.88 --json     machine-readable
 *   record  --series 0.88 --out DIR  snapshot live state into a fixture
 *   status  --fixture DIR            replay a fixture, no network
 */

import {liveSources, fixtureSources, recordingSources} from './sources.mjs';
import {deriveState, summarize} from './release-state.mjs';
import {runPhase, MODES} from './run-phase.mjs';
import {
  buildStatusMessage,
  unverifiable,
  publishCaveat,
  upgradeHelperHint,
  leftoverDrafts,
} from './release-message.mjs';
import {runDoctor, formatDoctor, resolveCheckout, resolveHermesCheckout} from './doctor.mjs';
import {gatherPickEvidence, gatherHermesEvidence} from './evidence.mjs';
import {Runner} from './actions.mjs';
import {runPick, dropActions} from './pick-actions.mjs';
import {readFileSync} from 'node:fs';

/**
 * Confirmation input.
 *
 * On a TTY this prompts. When stdin is a pipe it cannot: readline reaches EOF
 * and closes itself before the later prompts are asked, so a scripted run
 * would die mid-phase with "readline was closed". Non-interactive input is
 * therefore drained up front and served in order.
 *
 * This supplies answers, it does not skip the question. Every answer is still
 * checked and a token confirmation still has to match the version exactly, so
 * a scripted run cannot publish something the script did not name.
 */
let rlPromise = null;
let pipedAnswers = null;

async function readAnswer(prompt) {
  if (process.stdin.isTTY) {
    if (!rlPromise) {
      rlPromise = import('node:readline/promises').then(({createInterface}) =>
        createInterface({input: process.stdin, output: process.stdout}),
      );
    }
    return (await rlPromise).question(prompt);
  }

  if (pipedAnswers == null) {
    const chunks = [];
    for await (const c of process.stdin) {
      chunks.push(c);
    }
    pipedAnswers = Buffer.concat(chunks).toString('utf8').split('\n');
  }
  const answer = pipedAnswers.shift() ?? '';
  process.stdout.write(`${prompt}${answer}\n`);
  return answer;
}

async function closeReadline() {
  if (rlPromise) {
    (await rlPromise).close();
    rlPromise = null;
  }
}
import {parseVersion, formatVersion, latestInSeries} from './version.mjs';

function parseArgs(argv) {
  const out = {_: []};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i++;
      } else {
        out[key] = true;
      }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!cmd || cmd === 'help' || args.help) {
    console.log(`release-copilot

  doctor  [--checkout <path>]          check your environment BEFORE starting a release

  status  --series <x.y> [--json]      derive and print release state
  status  --fixture <dir> [--json]     replay a recorded fixture, no network
  record  --series <x.y> --out <dir>   snapshot live state into a fixture

  message --series <x.y>               release-crew Discord status message, ticks derived live
  message --series <x.y> --run <url>   include the publish run link

  plan    --series <x.y>               dry run: print every command, execute none
  run     --series <x.y>               guided: describe and confirm every mutating step

  pick    --series <x.y> --pick <n>    cherry-pick a pick (its stack from the bottom), push, close it
  drop    --series <x.y> --pick <n> --to <version|never> --reason <file>
                                       say on the request why it is not picked for this version
    both are guided; add --dry-run to print the commands only

  There is no unattended mode. A release publishes irreversible public state, so
  every mutating action is shown in full and confirmed before it runs.

  shared flags:
    --shape <rc|branch-cut|promote|patch>   override the derived shape
    --latest                                take the npm latest tag (stable only)
    --manual-tested                         the manual test pass for this release is done
    --fixture <dir>                         drive from a fixture instead of live
    --checkout <path>                       react-native checkout (default ~/git/react-native)
    --hermes-checkout <path>                hermes checkout (default ~/git/hermes)
    --json                                  emit the structured plan
`);
    process.exit(0);
  }

  if (cmd === 'doctor') {
    const r = await runDoctor({
      checkout: typeof args.checkout === 'string' ? args.checkout : undefined,
      hermesCheckout: typeof args['hermes-checkout'] === 'string' ? args['hermes-checkout'] : undefined,
    });
    console.log(args.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
    process.exit(r.ready ? 0 : 1);
  }

  if (cmd === 'status') {
    const sources = args.fixture ? fixtureSources(args.fixture) : liveSources();
    const state = await deriveState(sources, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
    });
    console.log(args.json ? JSON.stringify(state, null, 2) : summarize(state));
    return;
  }

  if (cmd === 'record') {
    if (!args.out) {
      throw new Error('record needs --out <dir>');
    }
    const rec = recordingSources(liveSources(), args.out);
    const state = await deriveState(rec, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
    });
    const dir = rec.flush();
    console.log(summarize(state));
    console.log(`\nfixture written to ${dir}`);
    return;
  }

  if (cmd === 'message') {
    const sources = args.fixture ? fixtureSources(args.fixture) : liveSources();
    const state = await deriveState(sources, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
    });

    // Default to the version already published, since the message is usually
    // regenerated while that release is in flight rather than before it.
    //
    // `current` comes from npm, which lags the publish by minutes. In that
    // window a tag exists for a version npm has not served yet and defaulting
    // to `current` produced a message titled for the PREVIOUS release carrying
    // THIS release's run link. The tag is the earlier and more reliable signal,
    // so prefer the just-tagged version while npm catches up.
    const justTagged = state.tagExistsForNext ? state.proposedNext : null;
    const version =
      typeof args.version === 'string'
        ? args.version
        : (justTagged ?? state.current ?? state.proposedNext);
    const versions = await sources.npmVersions('react-native');
    const parsed = parseVersion(version);
    const earlier = versions
      .map(parseVersion)
      .filter(v => v != null && formatVersion(v) !== version);
    const prev = parsed
      ? (() => {
          const sameSeries = latestInSeries(
            earlier.map(formatVersion).filter(v => {
              const p = parseVersion(v);
              return p && p.major === parsed.major && p.minor === parsed.minor;
            }),
            `${parsed.major}.${parsed.minor}`,
          );
          return sameSeries ? formatVersion(sameSeries) : state.distTags.latest;
        })()
      : state.distTags.latest;

    const artifacts = await sources.releaseArtifacts(version, prev);
    console.log(
      buildStatusMessage(state, {
        version,
        artifacts,
        publishRunUrl: typeof args.run === 'string' ? args.run : undefined,
      }),
    );

    const caveat = publishCaveat(artifacts);
    console.log('');
    console.log('--- not posted automatically, copy the block above ---');
    for (const extra of [caveat, upgradeHelperHint(version, artifacts), leftoverDrafts(artifacts)]) {
      if (extra) {
        console.log(extra);
        console.log('');
      }
    }
    console.log('Still needs a human to confirm and tick:');
    for (const u of unverifiable()) {
      console.log(`  - ${u}`);
    }
    return;
  }

  const confirm = async action => {
    if (action.confirmToken) {
      const answer = await readAnswer(`    type "${action.confirmToken}" to confirm, anything else to skip: `);
      return answer.trim() === action.confirmToken;
    }
    const answer = await readAnswer('    run this? [y/N] ');
    return answer.trim().toLowerCase() === 'y';
  };

  if (cmd === 'pick' || cmd === 'drop') {
    const number = Number(args.pick);
    if (!number || typeof args.series !== 'string') {
      throw new Error(`${cmd} needs --series <x.y> and --pick <n>`);
    }
    const checkout = resolveCheckout(args.checkout);
    if (!args['skip-doctor']) {
      const d = await runDoctor({checkout, hermesCheckout: args['hermes-checkout']});
      if (!d.ready) {
        console.log(formatDoctor(d));
        console.log('\nFix the above or re-run with --skip-doctor to proceed anyway.');
        process.exit(1);
      }
    }
    const state = await deriveState(liveSources(), {
      series: args.series,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
    });
    const runner = new Runner({
      mode: args['dry-run'] ? MODES.DRY_RUN : MODES.GUIDED,
      confirm,
      cwd: checkout,
    });
    let result;
    if (cmd === 'pick') {
      result = await runPick(state, number, runner);
    } else {
      if (typeof args.to !== 'string' || typeof args.reason !== 'string') {
        throw new Error('drop needs --to <version|never> and --reason <file>');
      }
      const reason = readFileSync(args.reason, 'utf8');
      result = {completed: true};
      for (const a of dropActions(state, number, {to: args.to, reason})) {
        const res = await runner.run(a);
        if (res?.skipped === 'declined') {
          result = {completed: false, declined: a.why};
          break;
        }
      }
    }
    await closeReadline();
    if (!result.completed) {
      console.log(`\nstopped: declined "${result.declined}"`);
    }
    process.exit(result.completed ? 0 : 1);
  }

  if (cmd === 'plan' || cmd === 'run') {
    // Git actions run here, not in whatever directory the CLI was started
    // from. The same resolver doctor uses, so the path it validates is the
    // path git actually runs in.
    const checkout = resolveCheckout(args.checkout);

    // A broken environment fails deep inside a release, where it is most
    // expensive. Catch it here instead, unless replaying a fixture.
    if (!args.fixture && !args['skip-doctor']) {
      const d = await runDoctor({checkout, hermesCheckout: args['hermes-checkout']});
      if (!d.ready) {
        console.log(formatDoctor(d));
        console.log('\nFix the above or re-run with --skip-doctor to proceed anyway.');
        process.exit(1);
      }
    }
    const sources = args.fixture ? fixtureSources(args.fixture) : liveSources();
    const state = await deriveState(sources, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
    });

    // The evidence the picks and Hermes steps judge from. Live only: it fetches
    // into the checkouts and trial-picks in a throwaway worktree, so a fixture
    // replay goes without and the steps say so.
    if (!args.fixture) {
      state.pickEvidence = await gatherPickEvidence(state, {checkout, log: m => console.error(m)});
      state.hermesEvidence = gatherHermesEvidence(state.hermesUnreleased, {
        checkout: resolveHermesCheckout(args['hermes-checkout']),
      });
    }

    const mode = cmd === 'plan' ? MODES.DRY_RUN : MODES.GUIDED;

    const isLatest = args.latest === true;
    const manualTested = args['manual-tested'] === true;
    const result = await runPhase(state, {
      mode,
      cwd: checkout,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
      ctx: {
        isLatest,
        manualTested,
        // The workflow input defaults to true; a real release must set it false.
        workflowDryRun: false,
      },
      confirm,
    });
    await closeReadline();

    if (args.json) {
      console.log(JSON.stringify(result, null, 2));
    }
    process.exit(result.completed ? 0 : 1);
  }

  throw new Error(`unknown command: ${cmd}`);
}

main().catch(err => {
  console.error(`error: ${err.message}`);
  process.exit(1);
});

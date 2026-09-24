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
import {buildStatusMessage, unverifiable, publishCaveat} from './release-message.mjs';
import {runDoctor, formatDoctor} from './doctor.mjs';
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
  run     --series <x.y>               guided: confirm before each mutating step
  run     --series <x.y> --autonomous  execute without prompting

  shared flags:
    --shape <rc|branch-cut|promote|patch>   override the derived shape
    --latest                                take the npm latest tag (stable only)
    --fixture <dir>                         drive from a fixture instead of live
    --json                                  emit the structured plan
`);
    process.exit(0);
  }

  if (cmd === 'doctor') {
    const r = await runDoctor({checkout: typeof args.checkout === 'string' ? args.checkout : undefined});
    console.log(args.json ? JSON.stringify(r, null, 2) : formatDoctor(r));
    process.exit(r.ready ? 0 : 1);
  }

  if (cmd === 'status') {
    const sources = args.fixture ? fixtureSources(args.fixture) : liveSources();
    const state = await deriveState(sources, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
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
    });

    // Default to the version already published, since the message is usually
    // regenerated while that release is in flight rather than before it.
    const version =
      typeof args.version === 'string' ? args.version : (state.current ?? state.proposedNext);
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
        prevVersion: prev,
        artifacts,
        publishRunUrl: typeof args.run === 'string' ? args.run : undefined,
      }),
    );

    const caveat = publishCaveat(artifacts);
    console.log('');
    console.log('--- not posted automatically, copy the block above ---');
    if (caveat) {
      console.log(caveat);
    }
    console.log('Still needs a human to confirm and tick:');
    for (const u of unverifiable()) {
      console.log(`  - ${u}`);
    }
    return;
  }

  if (cmd === 'plan' || cmd === 'run') {
    // A broken environment fails deep inside a release, where it is most
    // expensive. Catch it here instead, unless replaying a fixture.
    if (!args.fixture && !args['skip-doctor']) {
      const d = await runDoctor({checkout: typeof args.checkout === 'string' ? args.checkout : undefined});
      if (!d.ready) {
        console.log(formatDoctor(d));
        console.log('\nFix the above, or re-run with --skip-doctor to proceed anyway.');
        process.exit(1);
      }
    }
    const sources = args.fixture ? fixtureSources(args.fixture) : liveSources();
    const state = await deriveState(sources, {
      series: typeof args.series === 'string' ? args.series : undefined,
      today: typeof args.today === 'string' ? args.today : undefined,
    });

    const mode =
      cmd === 'plan' ? MODES.DRY_RUN : args.autonomous ? MODES.AUTONOMOUS : MODES.GUIDED;

    const isLatest = args.latest === true;
    const result = await runPhase(state, {
      mode,
      shape: typeof args.shape === 'string' ? args.shape : undefined,
      ctx: {
        isLatest,
        // The workflow input defaults to true; a real release must set it false.
        workflowDryRun: false,
        isBreaking: args.breaking === true,
      },
      confirm: async action => {
        const {createInterface} = await import('node:readline/promises');
        const rl = createInterface({input: process.stdin, output: process.stdout});
        const answer = await rl.question(`  run this? [y/N] `);
        rl.close();
        return answer.trim().toLowerCase() === 'y';
      },
    });

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

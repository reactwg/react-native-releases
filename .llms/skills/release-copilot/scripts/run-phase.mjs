/**
 * Phase runner. Walks a phase's steps, evaluating gates then declaring actions.
 * The mode only changes what the Runner does with an action, never which
 * actions get declared, so the dry-run plan is the real plan.
 */

import {Runner, MODES} from './actions.mjs';
import {evaluate, formatGates} from './gates.mjs';
import {phaseFor} from './phases.mjs';
import {summarize} from './release-state.mjs';

export async function runPhase(state, {mode, shape, ctx = {}, confirm, log = console.log} = {}) {
  const phase = phaseFor(shape ?? state.shape);
  const runner = new Runner({mode, confirm, log});

  log('');
  log('='.repeat(72));
  log(`  ${phase.title}`);
  log(`  mode: ${runner.mode}${runner.isDryRun ? '   (nothing will be executed)' : ''}`);
  log('='.repeat(72));
  log('');
  log(summarize(state));
  log('');
  log('Planned steps:');
  for (const [i, s] of phase.steps.entries()) {
    log(`  ${String(i + 1).padStart(2)}. ${s.title}`);
  }
  log('');

  const stopped = [];

  for (const [i, step] of phase.steps.entries()) {
    log('-'.repeat(72));
    log(`Step ${i + 1}/${phase.steps.length}: ${step.title}`);
    if (step.note) {
      log(`  note: ${step.note}`);
    }

    if (step.gates?.length) {
      const ev = await evaluate(step.gates, state, ctx);
      log(formatGates(ev));
      if (!ev.passed) {
        log('');
        log(`STOP: gate failure in "${step.title}". Not proceeding.`);
        stopped.push({step: step.id, failures: ev.results.filter(r => !r.ok)});
        return {phase: phase.id, plan: runner.plan(), stopped, completed: false};
      }
    }

    for (const action of step.actions(state, ctx)) {
      const res = await runner.run(action);

      // Declining is a decision not to do the release, not a decision to skip
      // one command. Later steps assume the earlier ones happened: after
      // declining a Hermes cut, the run offered to pin the release branch to a
      // version that was never published. Stop the phase.
      if (res?.skipped === 'declined') {
        log('');
        log(`STOP: declined "${action.why}". Not proceeding, since the remaining steps assume it happened.`);
        stopped.push({
          step: step.id,
          declined: true,
          failures: [{gate: 'declined', detail: action.why}],
        });
        return {phase: phase.id, plan: runner.plan(), stopped, completed: false};
      }
    }
  }

  log('-'.repeat(72));
  log(runner.isDryRun ? 'Dry run complete. Nothing was executed.' : 'Phase complete.');
  return {phase: phase.id, plan: runner.plan(), stopped, completed: true};
}

export {MODES};

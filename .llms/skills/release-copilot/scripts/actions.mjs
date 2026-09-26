/**
 * The action seam.
 *
 * Nothing in a phase calls out to the world directly. A step *declares* an
 * action; the runner decides whether to execute it, print it or record it.
 * That is what makes dry-run honest: the printed command is rendered from the
 * same record the executor consumes, so the two cannot drift.
 *
 * There is no autonomous mode. A release publishes irreversible public state
 * (an npm version cannot be meaningfully unpublished, a tag is visible the
 * moment it is pushed) so every mutating action is confirmed by a human who has
 * been shown exactly what it will do first.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export const MODES = Object.freeze({
  GUIDED: 'guided',
  DRY_RUN: 'dry-run',
});

/**
 * @param spec.step     which step this belongs to
 * @param spec.why      one line, shown to the human before it runs
 * @param spec.cmd      argv[0]
 * @param spec.args     argv[1..]
 * @param spec.mutates  false for read-only actions, which run in every mode
 * @param spec.impact   what changes if this runs, one line per effect. Required
 *                      for mutating actions: a human cannot consent to
 *                      something the skill refuses to describe.
 * @param spec.reversible  how to undo it or why it cannot be undone
 * @param spec.confirmToken  when set, the human types this exact string rather
 *                      than "y". Used where a typo is the failure mode, e.g.
 *                      publishing the wrong version.
 * @param spec.verify   optional async (state) => {ok, detail}, run after execute
 * @param spec.metaOnly true if it cannot run outside Meta
 */
export function declare(spec) {
  if (!spec.cmd || !Array.isArray(spec.args)) {
    throw new Error(`action needs cmd and args: ${JSON.stringify(spec)}`);
  }
  const mutates = spec.mutates !== false;
  const impact = spec.impact ?? [];
  if (mutates && spec.metaOnly !== true && impact.length === 0) {
    throw new Error(
      `mutating action in step "${spec.step}" declares no impact. ` +
        'Describe what it changes so a human can consent to it.',
    );
  }
  return {
    step: spec.step ?? 'unknown',
    why: spec.why ?? '',
    cmd: spec.cmd,
    args: spec.args,
    mutates,
    impact,
    reversible: spec.reversible ?? null,
    confirmToken: spec.confirmToken ?? null,
    metaOnly: spec.metaOnly === true,
    verify: spec.verify ?? null,
  };
}

/** Single rendering path. Dry-run prints this; the executor runs the same argv. */
export function render(action) {
  const quote = a => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
  return [action.cmd, ...action.args.map(quote)].join(' ');
}

/**
 * The block a human sees before consenting. Everything they need to catch a
 * wrong version or a wrong branch has to be visible here, because this is the
 * last point at which it is cheap to stop.
 */
export function describe(action) {
  const L = [];
  L.push(`  ${action.why}`);
  L.push('');
  L.push(`    command:  ${render(action)}`);
  if (action.impact.length) {
    L.push(`    changes:  ${action.impact[0]}`);
    for (const extra of action.impact.slice(1)) {
      L.push(`              ${extra}`);
    }
  }
  if (action.reversible) {
    L.push(`    undo:     ${action.reversible}`);
  }
  return L.join('\n');
}

export class Runner {
  constructor({mode, confirm, log} = {}) {
    this.mode = mode ?? MODES.DRY_RUN;
    if (this.mode !== MODES.GUIDED && this.mode !== MODES.DRY_RUN) {
      throw new Error(
        `unknown mode "${this.mode}". A release is guided or dry-run, never unattended.`,
      );
    }
    this.confirm = confirm ?? (async () => false);
    this.log = log ?? console.log;
    this.emitted = [];
    this.executed = [];
    this.declined = [];
  }

  get isDryRun() {
    return this.mode === MODES.DRY_RUN;
  }

  /**
   * In dry-run nothing is executed, including reads. Gates still run for real,
   * because they read the derived state rather than these actions, so the
   * stop/go decision is genuine while the run stays free of side effects and
   * of the network.
   */
  async run(action) {
    this.emitted.push(action);

    if (action.metaOnly) {
      this.log(`  [meta-only] ${action.why}`);
      this.log(`              ${render(action)}`);
      this.log(`              cannot run outside Meta, hand this to a Meta release crew member`);
      return {skipped: 'meta-only'};
    }

    if (this.isDryRun) {
      this.log(`  [would run] ${render(action)}`);
      return {skipped: 'dry-run'};
    }

    if (action.mutates) {
      this.log('');
      this.log(describe(action));
      const ok = await this.confirm(action);
      if (!ok) {
        this.log(`  declined, stopping this step.`);
        this.declined.push(action);
        return {skipped: 'declined'};
      }
    }

    this.log(`  [run] ${render(action)}`);
    const {stdout, stderr} = await exec(action.cmd, action.args, {
      maxBuffer: 32 * 1024 * 1024,
    });
    this.executed.push(action);
    return {stdout, stderr};
  }

  /** The plan, as structured data. Tests assert on this, not on stdout. */
  plan() {
    return this.emitted.map(a => ({
      step: a.step,
      why: a.why,
      command: render(a),
      mutates: a.mutates,
      metaOnly: a.metaOnly,
      impact: a.impact,
      confirmToken: a.confirmToken,
    }));
  }
}

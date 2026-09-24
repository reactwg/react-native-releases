/**
 * The action seam.
 *
 * Nothing in a phase calls out to the world directly. A step *declares* an
 * action; the runner decides whether to execute it, print it, or record it.
 * That is what makes dry-run honest: the string printed in dry-run is rendered
 * from the same record the executor consumes, so the two cannot drift.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const exec = promisify(execFile);

export const MODES = Object.freeze({
  GUIDED: 'guided',
  AUTONOMOUS: 'autonomous',
  DRY_RUN: 'dry-run',
});

/**
 * @param spec.step     which step this belongs to
 * @param spec.why      one line, shown to the human before it runs
 * @param spec.cmd      argv[0]
 * @param spec.args     argv[1..]
 * @param spec.mutates  false for read-only actions, which run in every mode
 * @param spec.verify   optional async (state) => {ok, detail}, run after execute
 * @param spec.metaOnly true if it cannot run outside Meta
 */
export function declare(spec) {
  if (!spec.cmd || !Array.isArray(spec.args)) {
    throw new Error(`action needs cmd and args: ${JSON.stringify(spec)}`);
  }
  return {
    step: spec.step ?? 'unknown',
    why: spec.why ?? '',
    cmd: spec.cmd,
    args: spec.args,
    mutates: spec.mutates !== false,
    metaOnly: spec.metaOnly === true,
    verify: spec.verify ?? null,
  };
}

/** Single rendering path. Dry-run prints this; the executor runs the same argv. */
export function render(action) {
  const quote = a => (/[\s"'$`\\]/.test(a) ? `'${a.replace(/'/g, `'\\''`)}'` : a);
  return [action.cmd, ...action.args.map(quote)].join(' ');
}

export class Runner {
  constructor({mode, confirm, log} = {}) {
    this.mode = mode ?? MODES.DRY_RUN;
    this.confirm = confirm ?? (async () => true);
    this.log = log ?? console.log;
    this.emitted = [];
    this.executed = [];
  }

  get isDryRun() {
    return this.mode === MODES.DRY_RUN;
  }

  /**
   * In dry-run nothing is executed, including reads. Gates still run for real,
   * because they read the derived state rather than these actions, so the
   * stop/go decision is genuine while the run stays free of side effects and
   * of the network. An earlier version executed read-only actions here, which
   * made dry-run try to verify a release that had not happened.
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

    if (action.mutates && this.mode === MODES.GUIDED) {
      const ok = await this.confirm(action);
      if (!ok) {
        this.log(`  [declined]  ${render(action)}`);
        return {skipped: 'declined'};
      }
    }

    this.log(`  [run]       ${render(action)}`);
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
    }));
  }
}

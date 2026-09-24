#!/usr/bin/env node
/**
 * Eval runner.
 *
 * Runs every scenario in scenarios.json against the real phase and gate code,
 * then emits two things:
 *
 *   1. Pass/fail per scenario, with the assertion that failed.
 *   2. An AGENDA COVERAGE matrix: every step the release docs prescribe, the
 *      phase step that implements it, and the scenario that exercises it.
 *
 * The matrix is the point. Green tests prove the code does what the code says.
 * The matrix proves the code does what the RELEASE CAPTAIN'S AGENDA says, which
 * is the claim that actually matters when someone reviews this.
 *
 *   node evals/run.mjs            human-readable
 *   node evals/run.mjs --md       markdown, for a PR description
 *   node evals/run.mjs --json     machine-readable
 */

import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

import {runPhase, MODES} from '../scripts/run-phase.mjs';
import {PHASES} from '../scripts/phases.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const scenarios = JSON.parse(readFileSync(join(HERE, 'scenarios.json'), 'utf8')).scenarios;

/**
 * The canonical agenda, from .github/ISSUE_TEMPLATE/release_checklist.yml and the
 * docs/guide-release-*.md headings. Keyed to the phase step that implements it.
 * A row with no implementing step is a gap that blocks retiring the docs.
 */
const AGENDA = [
  {doc: 'Check out release branch locally', guide: 'guide-release-process.md Step 1', step: 'checkout'},
  {doc: 'Update external dependencies table', guide: 'guide-release-candidate.md 0', step: 'external-deps'},
  {doc: 'Create release branch + template branch', guide: 'guide-release-candidate.md 1', step: 'create-branches'},
  {doc: 'Create a Hermes release and pin it', guide: 'guide-release-candidate.md 2', step: 'hermes'},
  {doc: 'Trigger a nightly', guide: 'guide-release-candidate.md 3', step: 'nightly'},
  {doc: 'Action cherry-picks and pull requests', guide: 'guide-release-process.md Step 2', step: 'picks'},
  {doc: 'Sweep for breaking changes (non-breaking series)', guide: 'release-cadence.md gating', step: 'breaking-sweep'},
  {doc: 'Wait for Github Actions artifacts to build', guide: 'guide-release-process.md Step 3', step: 'artifacts'},
  {doc: 'Test the release', guide: 'guide-release-process.md Step 4', step: 'test'},
  {doc: 'Pre-flight checks before publishing', guide: 'guide-release-process.md Step 5', step: 'pre-flight'},
  {doc: 'Create release', guide: 'guide-release-process.md Step 5', step: 'publish'},
  {doc: 'Verify release', guide: 'guide-release-process.md Step 6', step: 'verify-publish'},
  {doc: 'Update CHANGELOG.md', guide: 'guide-release-process.md Step 7', step: 'changelog'},
  {doc: 'Create the GitHub release', guide: 'guide-release-process.md Step 8', step: 'github-release'},
  {doc: 'Communicate release', guide: 'guide-release-process.md Step 9', step: 'announce'},
  {doc: 'Keep the release-crew status message current', guide: 'guide-release-process.md intro', step: 'status-message'},
  {doc: 'Ensure Podfile.lock is updated', guide: 'guide-release-process.md Step 10', step: 'verify-publish'},
  {doc: 'Update GitHub project', guide: 'guide-release-process.md Step 11', step: 'board'},
  {doc: 'Bump main to the next minor', guide: 'guide-release-candidate.md 12', step: 'bump-main'},
  {doc: 'Update the support policy table', guide: 'guide-release-candidate.md promote 2', step: 'support-table'},
  {doc: 'Ship blog post', guide: 'guide-release-candidate.md promote 3', step: 'blog'},
  {doc: 'Cut a new website version', guide: 'guide-release-candidate.md promote 4', step: 'website-version'},
];

function fail(msg) {
  return {ok: false, msg};
}
const PASS = {ok: true};

async function runScenario(s) {
  const result = await runPhase(s.state, {
    mode: MODES.DRY_RUN,
    shape: s.phase,
    ctx: s.ctx ?? {},
    log: () => {},
  });

  const e = s.expect;
  const stepsRun = [...new Set(result.plan.map(p => p.step))];
  const phaseSteps = PHASES[s.phase].steps.map(x => x.id);
  const reachedIdx = result.stopped.length
    ? phaseSteps.indexOf(result.stopped[0].step)
    : phaseSteps.length;
  const reached = phaseSteps.slice(0, reachedIdx + (result.stopped.length ? 1 : 0));

  const checks = [];

  if (e.completes !== undefined) {
    checks.push(
      result.completed === e.completes
        ? PASS
        : fail(`expected completes=${e.completes}, got ${result.completed}`),
    );
  }

  if (e.stopsAt) {
    const at = result.stopped[0]?.step;
    checks.push(at === e.stopsAt ? PASS : fail(`expected stop at "${e.stopsAt}", stopped at "${at ?? 'nowhere'}"`));
  }

  for (const g of e.failingGates ?? []) {
    const hit = result.stopped.some(st => st.failures.some(f => f.gate === g));
    checks.push(hit ? PASS : fail(`expected gate "${g}" to fail, it did not`));
  }

  if (e.failureMentions) {
    const text = result.stopped.flatMap(st => st.failures.map(f => f.detail)).join(' ');
    checks.push(
      text.toLowerCase().includes(e.failureMentions.toLowerCase())
        ? PASS
        : fail(`failure message should mention "${e.failureMentions}"`),
    );
  }

  if (e.neverReaches) {
    checks.push(
      reached.includes(e.neverReaches)
        ? fail(`must NOT reach "${e.neverReaches}" but did`)
        : PASS,
    );
  }

  for (const step of e.stepsInclude ?? []) {
    checks.push(phaseSteps.includes(step) ? PASS : fail(`phase is missing step "${step}"`));
  }
  for (const step of e.stepsExclude ?? []) {
    checks.push(!phaseSteps.includes(step) ? PASS : fail(`phase must not contain step "${step}"`));
  }

  if (e.mutatingCommands) {
    const got = result.plan.filter(p => p.mutates && !p.metaOnly).map(p => p.command);
    for (const want of e.mutatingCommands) {
      checks.push(got.includes(want) ? PASS : fail(`missing command:\n        want: ${want}\n        got:  ${got.join('\n              ') || '(none)'}`));
    }
  }

  for (const step of e.metaOnlySteps ?? []) {
    const any = result.plan.some(p => p.step === step && p.metaOnly);
    checks.push(any ? PASS : fail(`step "${step}" should declare a meta-only action`));
  }

  return {
    id: s.id,
    title: s.title,
    why: s.why,
    phase: s.phase,
    stepsRun,
    reached,
    failures: checks.filter(c => !c.ok).map(c => c.msg),
    ok: checks.every(c => c.ok),
  };
}

function coverage(results) {
  const exercised = new Map();
  for (const r of results) {
    for (const step of r.reached) {
      if (!exercised.has(step)) {
        exercised.set(step, []);
      }
      exercised.get(step).push(r.id);
    }
  }
  return AGENDA.map(a => ({
    ...a,
    implemented: Object.values(PHASES).some(p => p.steps.some(s => s.id === a.step)),
    scenarios: exercised.get(a.step) ?? [],
  }));
}

function renderMarkdown(results, cov) {
  const L = [];
  L.push('## release-copilot evals');
  L.push('');
  L.push(`${results.filter(r => r.ok).length}/${results.length} scenarios pass.`);
  L.push('');
  L.push('### Scenarios');
  L.push('');
  L.push('| Scenario | Phase | Result | What it proves |');
  L.push('| --- | --- | --- | --- |');
  for (const r of results) {
    L.push(`| \`${r.id}\` | ${r.phase} | ${r.ok ? 'pass' : '**FAIL**'} | ${r.why} |`);
  }
  L.push('');
  L.push('### Agenda coverage');
  L.push('');
  L.push('Every step the release docs prescribe, the phase step implementing it, and the scenarios that reach it.');
  L.push('');
  L.push('| Documented step | Source | Implemented by | Exercised by |');
  L.push('| --- | --- | --- | --- |');
  for (const c of cov) {
    const impl = c.implemented ? `\`${c.step}\`` : '**MISSING**';
    const ex = c.scenarios.length ? c.scenarios.map(s => `\`${s}\``).join(', ') : '**none**';
    L.push(`| ${c.doc} | ${c.guide} | ${impl} | ${ex} |`);
  }
  const gaps = cov.filter(c => !c.implemented || c.scenarios.length === 0);
  L.push('');
  L.push(
    gaps.length === 0
      ? 'Every documented step is implemented and exercised.'
      : `${gaps.length} gap(s): ${gaps.map(g => g.doc).join('; ')}`,
  );
  return L.join('\n');
}

const args = process.argv.slice(2);
const results = [];
for (const s of scenarios) {
  results.push(await runScenario(s));
}
const cov = coverage(results);
const allPass = results.every(r => r.ok);
const gaps = cov.filter(c => !c.implemented || c.scenarios.length === 0);

if (args.includes('--json')) {
  console.log(JSON.stringify({results, coverage: cov, allPass, gaps: gaps.length}, null, 2));
} else if (args.includes('--md')) {
  console.log(renderMarkdown(results, cov));
} else {
  console.log('release-copilot evals\n');
  for (const r of results) {
    console.log(`  ${r.ok ? 'pass' : 'FAIL'}  ${r.id.padEnd(38)} ${r.title}`);
    for (const f of r.failures) {
      console.log(`        ${f}`);
    }
  }
  console.log('');
  console.log('Agenda coverage');
  for (const c of cov) {
    const mark = !c.implemented ? 'MISSING ' : c.scenarios.length === 0 ? 'untested' : 'ok      ';
    console.log(`  ${mark}  ${c.doc.padEnd(50)} ${c.step}`);
  }
  console.log('');
  console.log(
    `${results.filter(r => r.ok).length}/${results.length} scenarios pass, ${gaps.length} agenda gap(s).`,
  );
}

// Set exitCode rather than calling process.exit(): an immediate exit truncates
// stdout on a pipe, which silently corrupted the --json output at 8KB.
process.exitCode = allPass && gaps.length === 0 ? 0 : 1;

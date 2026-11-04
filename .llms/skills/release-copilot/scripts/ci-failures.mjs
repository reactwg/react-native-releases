/** Which CI failures are flakes and which are structural, by their text. */

/**
 * Failures we have repeatedly confirmed are unrelated to the change under test.
 * Being on this list makes a failure *retryable*, never ignorable.
 */
export const FLAKE_SIGNATURES = [
  {
    id: 'rubygems-dns',
    match: /UnknownHostError|Could not download gem|rubygems\.org/i,
    reason: 'rubygems.org DNS failure on the runner',
  },
  {
    // 0.89.0-rc.0: test_e2e_ios_templateapp / build (Release) died 51 minutes
    // into the build while every other job on the commit passed.
    id: 'runner-lost',
    match: /The hosted runner lost communication with the server|The runner has received a shutdown signal|The operation was canceled because the runner/i,
    reason: 'GitHub lost the runner mid-job, which says nothing about the change. Re-run the failed job',
  },
  {
    // 0.89.0-rc.0: GitHub answered both the Podfile.lock push and the
    // rn-diff-purge push with a 500 during an incident on Git operations.
    id: 'github-500',
    match: /remote: Internal Server Error|\[remote rejected\][^\n]*\(Internal Server Error\)/i,
    reason: 'GitHub refused the push with a 500, a GitHub-side failure. Re-run the job once githubstatus.com is clear',
  },
  {
    id: 'missing-artifact',
    match: /Artifact not found for name/i,
    reason: 'artifact missing because an upstream build job failed; fix that job, not this one',
  },
];

/**
 * Structural failures: real, reproducible and not fixed by retrying.
 * `cache-key-test` was one of these on every release branch until it was fixed.
 */
export const STRUCTURAL_SIGNATURES = [
  {
    id: 'release-branch-only-test',
    match: /cache-key-test/i,
    reason: 'test asserts main-build behaviour and cannot pass on a release branch',
  },
];

export function classifyFailure(text) {
  for (const s of STRUCTURAL_SIGNATURES) {
    if (s.match.test(text)) {
      return {kind: 'structural', id: s.id, reason: s.reason, retryable: false};
    }
  }
  for (const s of FLAKE_SIGNATURES) {
    if (s.match.test(text)) {
      return {kind: 'flake', id: s.id, reason: s.reason, retryable: true};
    }
  }
  return {kind: 'unknown', id: null, reason: 'not a known signature, investigate before retrying', retryable: false};
}

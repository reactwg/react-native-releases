/**
 * The release-crew status message.
 *
 * The captain posts this in the release-crew Discord channel when an RC is
 * triggered and edits it in place as the release proceeds. Rebuilding it from
 * live state rather than tracking ticks by hand is the whole point: a copied
 * message from the previous RC carries stale links and stale ticks, which is
 * exactly how 0.88.0-rc.2's draft ended up claiming rc.1's upgrade-helper link
 * and four steps that had not happened yet.
 *
 * Steps we cannot verify are reported as in-progress rather than done. Never
 * tick something on the assumption it probably happened.
 */

const DONE = ':white_check_mark:';
const WIP = ':hourglass:';

const RN = 'react/react-native';

function line(done, text) {
  return `${done ? DONE : WIP} ${text}`;
}

/**
 * RC0, RC1, the golden RC and any stable release get a manual test pass.
 *
 * For an in-flight series the golden RC is assumed to be `expectedGoldenRc`
 * (rc.5) unless the captain says otherwise. That is the captain's standing
 * instruction, so it is an answer rather than a refusal. It stays a stated
 * assumption in the output, because measured from tags the real golden landed
 * anywhere from rc.3 to rc.7 across 0.82 to 0.87.
 */
export function requiresManualTesting(state, version) {
  const m = /^\d+\.\d+\.\d+(?:-rc\.(\d+))?$/.exec(version ?? '');
  if (!m) {
    return true; // unknown shape, assume it needs testing rather than skipping it
  }
  const rc = m[1] == null ? null : Number(m[1]);
  if (rc == null) {
    return true; // stable
  }
  const listed = state.schedule?.manualTestingRcs ?? [0, 1];
  if (listed.includes(rc)) {
    return true;
  }
  const golden = state.schedule?.goldenRc;
  if (golden?.source === 'tags' && golden.value != null) {
    return rc === golden.value;
  }
  const expected = state.schedule?.expectedGoldenRc;
  if (expected != null) {
    return rc === expected;
  }
  return null; // no released tags and no standing default
}

/**
 * @param state      derived release state
 * @param version    the version being released, e.g. 0.88.0-rc.2
 * @param artifacts  from sources.releaseArtifacts()
 * @param publishRunUrl  the Create release / Publish to npm run, if known
 */
export function buildStatusMessage(state, {version, prevVersion, artifacts, publishRunUrl}) {
  const a = artifacts ?? {};
  // Once the tag exists the pre-release CI checks are settled, because ciGreen
  // gated the publish. Reading live CI here would report the branch tip, which
  // the "Release <version>" commit has already moved past.
  const ciGreen =
    a.tagged === true || (state.ci.length > 0 && state.ci.every(r => r.conclusion === 'success'));
  const picksClear = state.openPicks.length === 0;

  // Compute the testing requirement for the version being MESSAGED, not for
  // state.proposedNext. Once a release publishes, proposedNext rolls to the next
  // RC and reading its flag reported "not required" for an RC that did require
  // testing.
  const needsTesting = requiresManualTesting(state, version);
  const testReportDone = a.testReport != null;

  const releasePublished = a.release != null && a.release.isDraft === false;
  const releaseUrl = a.release?.url ?? `https://github.com/${RN}/releases/tag/v${version}`;

  const L = [];
  L.push(`# ${version}`);
  L.push('');
  L.push(line(picksClear, 'Merge pick requests and push ' + state.branch));
  L.push(line(ciGreen, 'Wait for test_ios_rntester to complete'));
  L.push(line(ciGreen, 'Verify that E2E tests are green'));

  if (needsTesting === false) {
    L.push(`${DONE} Test release (not required for this RC)`);
  } else if (needsTesting === null) {
    L.push(line(testReportDone, 'Test release (confirm whether this is the golden RC)'));
  } else {
    L.push(line(testReportDone, 'Test release'));
  }

  L.push(
    line(
      a.npmPublished === true,
      'Publish release job' + (publishRunUrl ? `: ${publishRunUrl}` : ''),
    ),
  );

  // No signal for this one; a human runs it.
  L.push(`${WIP} Verify template: npx @react-native-community/cli init + build for iOS+Android`);

  L.push(
    line(
      a.upgradeHelper === true,
      `Verify upgrade helper → https://react-native-community.github.io/upgrade-helper/?from=${prevVersion ?? 'PREV_VERSION'}&to=${version}`,
    ),
  );
  L.push(line(a.maven === true, `Verify Maven assets → ${a.mavenUrl ?? ''}`));
  L.push(
    line(
      a.changelogPr != null,
      'Generate changelog PR' + (a.changelogPr ? ` → ${a.changelogPr.url}` : ''),
    ),
  );
  L.push(line(releasePublished, `Create GitHub release → ${releaseUrl}`));
  L.push(
    `${WIP} Communicate release to ${ANNOUNCE_CHANNELS.join(" + ")}`,
  );
  L.push(`${WIP} Update GitHub project`);

  return L.join('\n');
}

/** The bits a human still has to confirm, so the captain knows what is left. */
export function unverifiable() {
  return [
    'Verify template: run `node scripts/verify-template.mjs <version>` (the template-check step does this), then tick',
    'Communicate: you are posting the message, so tick it once posted',
    'Update GitHub project: tick once the board items carry the right Target Release',
  ];
}

/**
 * post_publish routinely fails on its 3-minute npm-verify timeout while the
 * publish itself succeeded. Anyone opening the run link sees red, so say so.
 */
export function publishCaveat(artifacts) {
  if (artifacts?.npmPublished !== true) {
    return null;
  }
  return 'Note: the publish workflow may show as failed. That is `post_publish -> "Verify Release is on NPM"` timing out after 3 minutes against npm propagation, not a failed release. The package is on npm.';
}

/**
 * The announcement, which is a different artifact from the status checklist.
 *
 * The checklist tracks the captain's own progress. This is the one-liner the
 * community sees, posted once the release is actually out. The announce step
 * used to name the channels and stop there, so the text got improvised each
 * time.
 */
export function buildAnnouncement(version, {changelogPr, releaseUrl} = {}) {
  const tag = releaseUrl ?? `https://github.com/${RN}/releases/tag/v${version}`;
  const L = [`:loudspeaker: ${version} is out!`, ''];
  L.push(`:package: Release tag: ${tag}`);
  if (changelogPr) {
    L.push(`:pencil: Changelog PR: ${changelogPr}`);
  }
  return L.join('\n');
}

/** Where the announcement goes. */
export const ANNOUNCE_CHANNELS = [
  '#releases-coordination on Discord',
  'React Releases on GChat',
];

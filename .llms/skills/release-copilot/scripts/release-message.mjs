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

import {loadPickDeferrals, requiresManualTesting} from './release-state.mjs';

export {requiresManualTesting};

const DONE = ':white_check_mark:';
const WIP = ':hourglass:';

const RN = 'react/react-native';

function line(done, text) {
  return `${done ? DONE : WIP} ${text}`;
}


/**
 * @param state      derived release state
 * @param version    the version being released, e.g. 0.88.0-rc.2
 * @param artifacts  from sources.releaseArtifacts()
 * @param publishRunUrl  the Create release / Publish to npm run, if known
 */
export function buildStatusMessage(state, {version, artifacts, publishRunUrl}) {
  const a = artifacts ?? {};
  // Once the tag exists the pre-release CI checks are settled, because ciGreen
  // gated the publish. Reading live CI here would report the branch tip, which
  // the "Release <version>" commit has already moved past.
  const ciGreen =
    a.tagged === true || (state.ci.length > 0 && state.ci.every(r => r.conclusion === 'success'));
  const picksClear = picksClearFor(state, version);

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
      // PREV_VERSION is literal: that is the crew's link format, not a slot to fill.
      `Verify upgrade helper → https://react-native-community.github.io/upgrade-helper/?from=PREV_VERSION&to=${version}`,
    ),
  );
  L.push(line(a.maven === true, `Verify Maven assets → ${a.mavenUrl ?? ''}`));
  // A .0 gets no generated PR: the workflow skips it because the RCs already
  // carry the entries. Its changelog is the consolidated section on main.
  if (isDotZero(version)) {
    L.push(
      line(
        a.changelogOnMain === true,
        `Consolidate the RC changelog sections into v${version} → https://github.com/${RN}/blob/main/CHANGELOG.md`,
      ),
    );
  } else {
    L.push(
      line(
        a.changelogPr != null,
        'Generate changelog PR' + (a.changelogPr ? ` → ${a.changelogPr.url}` : ''),
      ),
    );
  }
  L.push(line(releasePublished, `Create GitHub release → ${releaseUrl}`));
  L.push(
    `${WIP} Communicate release to ${ANNOUNCE_CHANNELS.join(" + ")}`,
  );
  L.push(`${WIP} Update GitHub project`);

  return L.join('\n');
}

const isDotZero = v => /^\d+\.\d+\.0$/.test(v ?? '');

/**
 * Nothing outstanding for THIS version. A pick aimed elsewhere is a decision,
 * not an open item: 0.88.0 shipped with four picks deferred to 0.88.1 and the
 * tick stayed pending because it only counted open issues.
 */
export function picksClearFor(state, version) {
  const deferred = loadPickDeferrals(state.series, version)?.numbers ?? [];
  return (state.openPicks ?? []).every(p =>
    p.targetOnBoard ? p.targetOnBoard !== version : deferred.includes(p.number),
  );
}

/**
 * The rn-diff-purge dispatch post_publish sends, for when a timeout there
 * skipped it. Without it the upgrade helper has no diff for the release.
 */
export function upgradeHelperHint(version, artifacts) {
  if (artifacts?.npmPublished !== true || artifacts?.upgradeHelper !== false) {
    return null;
  }
  return [
    `The upgrade helper has no diff for ${version}. post_publish dispatches rn-diff-purge after`,
    'its template wait, so a timeout there skips it. Send the same dispatch:',
    '',
    `  echo '{"event_type": "publish", "client_payload": {"version": "v${version}"}}' | \\`,
    '    gh api -X POST repos/react-native-community/rn-diff-purge/dispatches --input -',
  ].join('\n');
}

/** Earlier releases of the series still sitting as drafts. */
export function leftoverDrafts(artifacts) {
  const d = artifacts?.seriesDrafts ?? [];
  if (!d.length) {
    return null;
  }
  return `Still a draft on GitHub, publish as a pre-release: ${d.join(', ')}`;
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
  return 'Note: the publish workflow may show as failed. That is one of the 3-minute waits in `post_publish` ("Wait for template to be published" or "Verify Release is on NPM") timing out against npm propagation, not a failed release. The package is on npm.';
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
  } else if (isDotZero(version)) {
    L.push(`:pencil: Changelog: https://github.com/${RN}/blob/main/CHANGELOG.md`);
  }
  return L.join('\n');
}

/** Where the announcement goes. */
export const ANNOUNCE_CHANNELS = [
  '#releases-coordination on Discord',
  'React Releases on Slack',
];

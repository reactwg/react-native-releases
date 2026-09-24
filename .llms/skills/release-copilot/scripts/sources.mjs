/**
 * Data sources for release state.
 *
 * Everything the deriver reads goes through one of these. `liveSources()` hits
 * the network; `fixtureSources()` replays a recording. Nothing downstream knows
 * which it is talking to, which is what makes the deriver testable and what
 * makes dry-run reproducible.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync, existsSync, mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';

const exec = promisify(execFile);

const RN_REPO = 'react/react-native';
const RELEASES_REPO = 'reactwg/react-native-releases';
const HERMES_REPO = 'facebook/hermes';
const PROJECT_OWNER = 'reactwg';

async function sh(cmd, args, {allowFail = false} = {}) {
  try {
    const {stdout} = await exec(cmd, args, {maxBuffer: 32 * 1024 * 1024});
    return stdout;
  } catch (err) {
    if (allowFail) {
      return '';
    }
    throw new Error(`${cmd} ${args.join(' ')} failed: ${err.message}`);
  }
}

async function gh(args) {
  return sh('gh', args);
}

function parseJSON(raw, fallback) {
  if (!raw || !raw.trim()) {
    return fallback;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * npm's full package document is CDN-cached and served stale for large packages
 * such as react-native. We saw it lag by many minutes during 0.88.0-rc.1, so
 * presence of a specific version is checked against the per-version endpoint,
 * which is authoritative.
 */
async function npmVersionExists(pkg, version) {
  const out = await sh(
    'curl',
    ['-s', '-o', '/dev/null', '-w', '%{http_code}', `https://registry.npmjs.org/${pkg}/${version}`],
    {allowFail: true},
  );
  return out.trim() === '200';
}

export function liveSources() {
  return {
    kind: 'live',

    async npmDistTags(pkg) {
      const raw = await sh('curl', ['-s', `https://registry.npmjs.org/${pkg}`], {allowFail: true});
      const doc = parseJSON(raw, {});
      return doc['dist-tags'] ?? {};
    },

    async npmVersions(pkg) {
      const raw = await sh('curl', ['-s', `https://registry.npmjs.org/${pkg}`], {allowFail: true});
      const doc = parseJSON(raw, {});
      return Object.keys(doc.versions ?? {});
    },

    npmVersionExists,

    async npmPublishTimes(pkg) {
      const raw = await sh('curl', ['-s', `https://registry.npmjs.org/${pkg}`], {allowFail: true});
      const doc = parseJSON(raw, {});
      return doc.time ?? {};
    },

    async gitTags() {
      const raw = await sh('git', ['ls-remote', '--tags', `https://github.com/${RN_REPO}.git`], {
        allowFail: true,
      });
      return raw
        .split('\n')
        .map(l => l.split('refs/tags/')[1])
        .filter(Boolean)
        .filter(t => !t.endsWith('^{}'));
    },

    async branchTip(branch) {
      const raw = await sh(
        'git',
        ['ls-remote', `https://github.com/${RN_REPO}.git`, `refs/heads/${branch}`],
        {allowFail: true},
      );
      const sha = raw.split(/\s+/)[0];
      return sha || null;
    },

    async workflowRuns(branch, limit = 20) {
      const raw = await gh([
        'run',
        'list',
        '--repo',
        RN_REPO,
        '--branch',
        branch,
        '--limit',
        String(limit),
        '--json',
        'databaseId,headSha,workflowName,status,conclusion,createdAt',
      ]);
      return parseJSON(raw, []);
    },

    async workflowJobs(runId) {
      const raw = await gh([
        'run',
        'view',
        String(runId),
        '--repo',
        RN_REPO,
        '--json',
        'jobs',
      ]);
      return parseJSON(raw, {jobs: []}).jobs ?? [];
    },

    async openPicks(series) {
      const raw = await gh([
        'issue',
        'list',
        '--repo',
        RELEASES_REPO,
        '--state',
        'open',
        '--search',
        series,
        '--limit',
        '50',
        '--json',
        'number,title,labels',
      ]);
      return parseJSON(raw, []);
    },

    async projectItems(series) {
      const listRaw = await gh(['project', 'list', '--owner', PROJECT_OWNER, '--limit', '50', '--format', 'json']);
      const projects = parseJSON(listRaw, {projects: []}).projects ?? [];
      const match = projects.find(p => (p.title ?? '').includes(series));
      if (!match) {
        return {project: null, items: []};
      }
      const itemsRaw = await gh([
        'project',
        'item-list',
        String(match.number),
        '--owner',
        PROJECT_OWNER,
        '--limit',
        '200',
        '--format',
        'json',
      ]);
      return {
        project: {number: match.number, title: match.title},
        items: parseJSON(itemsRaw, {items: []}).items ?? [],
      };
    },

    async fileAt(branch, path) {
      const raw = await sh(
        'curl',
        ['-s', `https://raw.githubusercontent.com/${RN_REPO}/${branch}/${path}`],
        {allowFail: true},
      );
      return raw || null;
    },

    async changelogAt(ref) {
      const raw = await sh(
        'curl',
        ['-s', `https://raw.githubusercontent.com/${RN_REPO}/${ref}/CHANGELOG.md`],
        {allowFail: true},
      );
      return raw || null;
    },

    /**
     * Commits sitting on the Hermes stable branch beyond the tag React Native
     * currently pins.
     *
     * Pinning a version that is behind its branch is invisible to a
     * version.properties/package.json consistency check, which is how two
     * unreleased Hermes commits (including a re-landed crash fix) went unnoticed
     * during 0.88.
     */
    async hermesUnreleased(pinnedVersion) {
      const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(pinnedVersion ?? '');
      if (!m) {
        return null;
      }
      const [, line, minor] = m;
      const branch = `${line}.${minor}.0-stable`;
      const tag = `hermes-v${pinnedVersion}`;
      const raw = await gh([
        'api',
        `repos/${HERMES_REPO}/compare/${tag}...${branch}?per_page=100`,
      ]).catch(() => '');
      const cmp = parseJSON(raw, null);
      if (!cmp) {
        return {branch, tag, resolved: false, commits: []};
      }
      return {
        branch,
        tag,
        resolved: true,
        commits: (cmp.commits ?? []).map(c => ({
          sha: c.sha.slice(0, 11),
          subject: c.commit.message.split('\n')[0],
          // A double back-out re-lands something previously reverted, which is
          // exactly the case that needs a human rather than an auto-bump.
          reland: /^Back out "Back out/i.test(c.commit.message),
        })),
      };
    },

    /**
     * Resolve each open pick request to the commit it asks for, so a candidate
     * can be assessed BEFORE it lands rather than after.
     */
    async pickCandidates(picks) {
      const out = [];
      for (const p of picks) {
        const body = await gh([
          'issue',
          'view',
          String(p.number),
          '--repo',
          RELEASES_REPO,
          '--json',
          'body',
          '--jq',
          '.body',
        ]).catch(() => '');

        const shas = [...body.matchAll(/commit\/([0-9a-f]{7,40})/g)].map(m => m[1]);
        const prs = [...body.matchAll(/pull\/(\d+)/g)].map(m => Number(m[1]));

        let resolved = [];
        for (const sha of shas.slice(0, 4)) {
          const raw = await gh(['api', `repos/${RN_REPO}/commits/${sha}`, '--jq', '.commit.message'])
            .catch(() => '');
          if (raw) {
            resolved.push({sha: sha.slice(0, 11), message: raw});
          }
        }
        // A PR-only body cannot be resolved to a commit reliably, since Meta's
        // import rewrites SHAs. Report it unresolved rather than guessing.
        const prOnly = resolved.length === 0 && prs.length > 0;

        out.push({number: p.number, title: p.title, resolved, prOnly});
      }
      return out;
    },

    /**
     * Everything the release-crew status message needs to decide done vs
     * in-progress, checked live. Each field is independently falsifiable so the
     * message reports what is true rather than what the captain remembers.
     */
    async releaseArtifacts(version, prevVersion) {
      const httpOk = async url => {
        const code = await sh(
          'curl',
          ['-sL', '-o', '/dev/null', '-w', '%{http_code}', url],
          {allowFail: true},
        );
        return code.trim() === '200';
      };

      const maven = `https://repo1.maven.org/maven2/com/facebook/react/react-native-artifacts/${version}`;
      const [mavenDebug, mavenRelease] = await Promise.all([
        httpOk(`${maven}/react-native-artifacts-${version}-reactnative-core-dSYM-debug.tar.gz`),
        httpOk(`${maven}/react-native-artifacts-${version}-reactnative-core-dSYM-release.tar.gz`),
      ]);

      const upgradeHelper = prevVersion
        ? await httpOk(
            `https://raw.githubusercontent.com/react-native-community/rn-diff-purge/diffs/diffs/${prevVersion}..${version}.diff`,
          )
        : false;

      const npmPublished = await npmVersionExists('react-native', version);

      const releaseRaw = await gh([
        'release',
        'view',
        `v${version}`,
        '--repo',
        RN_REPO,
        '--json',
        'tagName,isDraft,isPrerelease,url',
      ]).catch(() => '');
      const release = parseJSON(releaseRaw, null);

      const prRaw = await gh([
        'pr',
        'list',
        '--repo',
        RN_REPO,
        '--search',
        `changelog v${version} in:title`,
        '--state',
        'all',
        '--limit',
        '3',
        '--json',
        'number,state,url',
      ]);
      const changelogPr = (parseJSON(prRaw, [])[0]) ?? null;

      const testReportRaw = await gh([
        'issue',
        'list',
        '--repo',
        RELEASES_REPO,
        '--state',
        'all',
        '--search',
        `"[${version}] Test Report" in:title`,
        '--limit',
        '3',
        '--json',
        'number,state,url',
      ]);
      const testReport = (parseJSON(testReportRaw, [])[0]) ?? null;

      return {
        maven: mavenDebug && mavenRelease,
        mavenUrl: maven,
        upgradeHelper,
        npmPublished,
        release,
        changelogPr,
        testReport,
      };
    },

    /**
     * The compare endpoint returns at most 250 commits per page while reporting
     * the true size in `total_commits`. Paginating is mandatory: an unpaginated
     * call against a 554-commit range silently returned 250 and produced a
     * confidently clean breaking-change verdict.
     *
     * Returns {commits, total, complete} so callers can refuse to judge on a
     * partial answer rather than trusting a short list.
     */
    async commitsBetween(base, head) {
      const first = parseJSON(
        await gh(['api', `repos/${RN_REPO}/compare/${base}...${head}?per_page=250`]),
        {},
      );
      const total = first.total_commits ?? 0;
      const commits = [...(first.commits ?? [])];

      for (let page = 2; commits.length < total && page <= 40; page++) {
        const next = parseJSON(
          await gh(['api', `repos/${RN_REPO}/compare/${base}...${head}?per_page=250&page=${page}`]),
          {},
        );
        const batch = next.commits ?? [];
        if (batch.length === 0) {
          break;
        }
        commits.push(...batch);
      }

      return {
        commits: commits.map(c => ({sha: c.sha, message: c.commit.message})),
        total,
        complete: commits.length >= total,
      };
    },
  };
}

/**
 * Replays a recording produced by `record()`. Any source not present in the
 * fixture throws rather than silently falling back to the network, otherwise a
 * test could pass by accidentally reaching the real world.
 */
export function fixtureSources(dir) {
  const load = name => {
    const f = join(dir, `${name}.json`);
    if (!existsSync(f)) {
      throw new Error(`fixture missing: ${f}. Re-record with --record.`);
    }
    return JSON.parse(readFileSync(f, 'utf8'));
  };

  const pick = (name, key) => {
    const data = load(name);
    if (!(key in data)) {
      throw new Error(`fixture ${name}.json has no entry for "${key}"`);
    }
    return data[key];
  };

  return {
    kind: 'fixture',
    async npmDistTags(pkg) {
      return pick('npmDistTags', pkg);
    },
    async npmVersions(pkg) {
      return pick('npmVersions', pkg);
    },
    async npmPublishTimes(pkg) {
      return pick('npmPublishTimes', pkg);
    },
    async npmVersionExists(pkg, version) {
      return (await pick('npmVersions', pkg)).includes(version);
    },
    async gitTags() {
      return load('gitTags');
    },
    async branchTip(branch) {
      return pick('branchTip', branch);
    },
    async workflowRuns(branch) {
      return pick('workflowRuns', branch);
    },
    async workflowJobs(runId) {
      return pick('workflowJobs', String(runId));
    },
    async openPicks(series) {
      return pick('openPicks', series);
    },
    async projectItems(series) {
      return pick('projectItems', series);
    },
    async fileAt(branch, path) {
      return pick('fileAt', `${branch}:${path}`);
    },
    async commitsBetween(base, head) {
      return pick('commitsBetween', `${base}...${head}`);
    },
    async changelogAt(ref) {
      return pick('changelogAt', ref);
    },
    async hermesUnreleased(v) {
      return pick('hermesUnreleased', v);
    },
    async pickCandidates(picks) {
      return pick('pickCandidates', picks.map(p => p.number).join(','));
    },
    async releaseArtifacts(version) {
      return pick('releaseArtifacts', version);
    },
  };
}

/**
 * Wraps a source set so every call is captured, then written to disk. Used to
 * snapshot a real release moment into a replayable fixture.
 */
export function recordingSources(inner, dir) {
  const captured = {};
  const put = (bucket, key, value) => {
    captured[bucket] = captured[bucket] ?? {};
    if (key == null) {
      captured[bucket] = value;
    } else {
      captured[bucket][key] = value;
    }
    return value;
  };

  return {
    kind: 'recording',
    npmDistTags: async p => put('npmDistTags', p, await inner.npmDistTags(p)),
    npmVersions: async p => put('npmVersions', p, await inner.npmVersions(p)),
    npmPublishTimes: async p => put('npmPublishTimes', p, await inner.npmPublishTimes(p)),
    npmVersionExists: async (p, v) => inner.npmVersionExists(p, v),
    gitTags: async () => put('gitTags', null, await inner.gitTags()),
    branchTip: async b => put('branchTip', b, await inner.branchTip(b)),
    workflowRuns: async b => put('workflowRuns', b, await inner.workflowRuns(b)),
    workflowJobs: async r => put('workflowJobs', String(r), await inner.workflowJobs(r)),
    openPicks: async s => put('openPicks', s, await inner.openPicks(s)),
    projectItems: async s => put('projectItems', s, await inner.projectItems(s)),
    fileAt: async (b, p) => put('fileAt', `${b}:${p}`, await inner.fileAt(b, p)),
    /**
     * Commit bodies are recorded trimmed. The deriver only reads the subject
     * line plus whether the body carries a [BREAKING] tag or a revert marker,
     * so keeping full bodies made the fixture 892KB of text nothing reads.
     */
    commitsBetween: async (b, h) => {
      const full = await inner.commitsBetween(b, h);
      const trimmed = {
        ...full,
        commits: full.commits.map(c => {
          const lines = String(c.message).split('\n');
          const keep = [lines[0]];
          for (const l of lines.slice(1)) {
            if (/\[BREAKING\]/i.test(l) || /This reverts commit [0-9a-f]{7,40}/.test(l)) {
              keep.push(l);
            }
          }
          return {sha: c.sha, message: keep.join('\n')};
        }),
      };
      return put('commitsBetween', `${b}...${h}`, trimmed);
    },
    changelogAt: async r => put('changelogAt', r, await inner.changelogAt(r)),
    hermesUnreleased: async v => put('hermesUnreleased', v, await inner.hermesUnreleased(v)),
    pickCandidates: async ps =>
      put('pickCandidates', ps.map(p => p.number).join(','), await inner.pickCandidates(ps)),
    releaseArtifacts: async (v, p) =>
      put('releaseArtifacts', v, await inner.releaseArtifacts(v, p)),
    flush() {
      mkdirSync(dir, {recursive: true});
      for (const [name, data] of Object.entries(captured)) {
        writeFileSync(join(dir, `${name}.json`), JSON.stringify(data, null, 2) + '\n');
      }
      return dir;
    },
  };
}

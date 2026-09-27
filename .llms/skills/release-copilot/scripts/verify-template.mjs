#!/usr/bin/env node
/**
 * Template verification.
 *
 * Creates a fresh app on a published version and builds it for iOS and
 * Android. This is the one release check with no derivable signal: npm having
 * the package says nothing about whether a consumer can actually build with it.
 *
 * It caught nothing on 0.88.0-rc.3, but it is the step that would catch a bad
 * Hermes pin, a broken podspec or a template that does not resolve, none of
 * which any other gate looks at.
 *
 *   node scripts/verify-template.mjs 0.88.0-rc.3
 *   node scripts/verify-template.mjs 0.88.0-rc.3 --ios-only
 *   node scripts/verify-template.mjs 0.88.0-rc.3 --keep     (leave the app behind)
 *
 * Takes about ten minutes and roughly 4GB. Exits non-zero if a build fails.
 */

import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {existsSync, mkdtempSync, rmSync, readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';

const exec = promisify(execFile);

async function run(cmd, args, opts = {}) {
  const started = Date.now();
  try {
    const {stdout, stderr} = await exec(cmd, args, {
      maxBuffer: 64 * 1024 * 1024,
      ...opts,
    });
    return {ok: true, out: stdout + stderr, secs: Math.round((Date.now() - started) / 1000)};
  } catch (err) {
    return {
      ok: false,
      out: String(err.stdout ?? '') + String(err.stderr ?? err.message),
      secs: Math.round((Date.now() - started) / 1000),
    };
  }
}

/**
 * RN needs a JDK 17 or newer and the machine default is often older. Android
 * Studio ships one, which is the likeliest thing to be present already.
 */
async function findJdk() {
  const candidates = [
    process.env.JAVA_HOME,
    '/Applications/Android Studio.app/Contents/jbr/Contents/Home',
    '/opt/homebrew/opt/openjdk@17',
    '/opt/homebrew/opt/openjdk',
  ].filter(Boolean);

  for (const home of candidates) {
    if (!existsSync(join(home, 'bin', 'java'))) {
      continue;
    }
    const v = await run(join(home, 'bin', 'java'), ['-version']);
    const m = /version "(\d+)/.exec(v.out);
    if (m && Number(m[1]) >= 17) {
      return {home, version: m[1]};
    }
  }
  return null;
}

function androidSdk() {
  for (const p of [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    join(process.env.HOME ?? '', 'Library', 'Android', 'sdk'),
  ]) {
    if (p && existsSync(join(p, 'platform-tools'))) {
      return p;
    }
  }
  return null;
}

export async function verifyTemplate(version, {iosOnly = false, androidOnly = false, keep = false, log = console.log} = {}) {
  const root = mkdtempSync(join(tmpdir(), `rn-template-${version}-`));
  const app = join(root, 'TemplateCheck');
  const results = [];
  const note = (step, r, extra = '') =>
    results.push({step, ok: r.ok, secs: r.secs, detail: extra || (r.ok ? '' : lastLines(r.out))});

  log(`Verifying the ${version} template in ${root}`);
  log('');

  try {
    // 1. init on the published version
    let r = await run(
      'npx',
      ['--yes', '@react-native-community/cli@latest', 'init', 'TemplateCheck',
       '--version', version, '--skip-install', '--install-pods', 'false'],
      {cwd: root},
    );
    note('init', r);
    log(`  ${r.ok ? 'ok  ' : 'FAIL'} init (${r.secs}s)`);
    if (!r.ok) {
      return finish();
    }

    // The template must actually pin the version we asked for, not drift to
    // latest. Cheap to check and the whole point of naming a version.
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    const pinned = pkg.dependencies['react-native'];
    const pinOk = pinned === version;
    note('pins the requested version', {ok: pinOk, secs: 0}, `package.json says ${pinned}`);
    log(`  ${pinOk ? 'ok  ' : 'FAIL'} pins ${version} (got ${pinned})`);

    r = await run('yarn', ['install'], {cwd: app});
    note('yarn install', r);
    log(`  ${r.ok ? 'ok  ' : 'FAIL'} yarn install (${r.secs}s)`);
    if (!r.ok) {
      return finish();
    }

    // Report the Hermes the consumer actually resolves, which is the thing a
    // mid-cycle Hermes pick is trying to deliver.
    try {
      const props = readFileSync(
        join(app, 'node_modules/react-native/sdks/hermes-engine/version.properties'),
        'utf8',
      );
      const hv = /HERMES_VERSION_NAME=(.+)/.exec(props)?.[1]?.trim();
      note('resolved Hermes', {ok: true, secs: 0}, hv ?? 'unknown');
      log(`  ok   resolved Hermes ${hv}`);
    } catch {
      /* not fatal */
    }

    if (!androidOnly) {
      r = await run('bundle', ['install'], {cwd: join(app, 'ios')});
      r = await run('bundle', ['exec', 'pod', 'install'], {cwd: join(app, 'ios')});
      note('pod install', r);
      log(`  ${r.ok ? 'ok  ' : 'FAIL'} pod install (${r.secs}s)`);

      if (r.ok) {
        r = await run(
          'xcodebuild',
          ['-workspace', 'TemplateCheck.xcworkspace', '-scheme', 'TemplateCheck',
           '-configuration', 'Debug', '-sdk', 'iphonesimulator',
           '-destination', 'generic/platform=iOS Simulator',
           '-derivedDataPath', join(root, 'dd'), 'build'],
          {cwd: join(app, 'ios')},
        );
        const built = r.ok && /\*\* BUILD SUCCEEDED \*\*/.test(r.out);
        note('iOS build', {ok: built, secs: r.secs}, built ? '' : lastLines(r.out));
        log(`  ${built ? 'ok  ' : 'FAIL'} iOS build (${r.secs}s)`);
      }
    }

    if (!iosOnly) {
      const jdk = await findJdk();
      const sdk = androidSdk();
      if (!jdk || !sdk) {
        const why = !jdk ? 'no JDK 17+ found' : 'no Android SDK found';
        note('Android build', {ok: false, secs: 0}, `skipped: ${why}`);
        log(`  skip Android build (${why})`);
      } else {
        r = await run('./gradlew', ['assembleDebug', '--no-daemon'], {
          cwd: join(app, 'android'),
          env: {...process.env, JAVA_HOME: jdk.home, ANDROID_HOME: sdk},
        });
        const built = r.ok && /BUILD SUCCESSFUL/.test(r.out);
        note('Android build', {ok: built, secs: r.secs}, built ? `JDK ${jdk.version}` : lastLines(r.out));
        log(`  ${built ? 'ok  ' : 'FAIL'} Android build (${r.secs}s, JDK ${jdk.version})`);
      }
    }

    return finish();
  } finally {
    if (!keep) {
      try {
        rmSync(root, {recursive: true, force: true});
      } catch {
        /* best effort */
      }
    }
  }

  function finish() {
    const failed = results.filter(x => !x.ok);
    log('');
    log(
      failed.length === 0
        ? `Template verified for ${version}.`
        : `Template verification FAILED for ${version}: ${failed.map(f => f.step).join(', ')}`,
    );
    if (keep) {
      log(`App left at ${app}`);
    }
    return {version, results, ok: failed.length === 0, dir: keep ? app : null};
  }
}

function lastLines(s, n = 12) {
  return String(s).trim().split('\n').slice(-n).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [version, ...flags] = process.argv.slice(2);
  if (!version) {
    console.error('usage: node scripts/verify-template.mjs <version> [--ios-only|--android-only] [--keep]');
    process.exitCode = 1;
  } else {
    const res = await verifyTemplate(version, {
      iosOnly: flags.includes('--ios-only'),
      androidOnly: flags.includes('--android-only'),
      keep: flags.includes('--keep'),
    });
    process.exitCode = res.ok ? 0 : 1;
  }
}

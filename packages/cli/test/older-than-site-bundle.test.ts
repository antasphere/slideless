import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { updateConfig } from '../src/cli.js';
import { buildProgram } from '../src/index.js';
import { routedHarness } from './harness.js';

// Bundling the CLI takes a few seconds alone, more beside the full gate's other tasks.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

/**
 * PRDCT-5249 from the running file to the update command (the verifier's
 * round 1, finding 6). The CLI is bundled once as the package's `build` script
 * bundles it, copied to where team, a global npm install and nobody would put
 * it, and each copy is run with `node`. A copy reads its own real path (cli.ts
 * `RUNNING_FILE`), so each line names the update command of its own install,
 * or none. The profile's site is a closed loopback port: the line comes before
 * the first request, which then fails without leaving the machine.
 */

/** This CLI's version, as the program declares it (index.ts `VERSION`). */
const VERSION = buildProgram(routedHarness([]).io).version()!;
const SITE = 'http://127.0.0.1:9';
/** Where an npm prefix puts the package's bin. */
const INSTALLED = join('lib', 'node_modules', '@antasphere', 'slideless', 'dist', 'bin.js');
/** The line every copy says, before the update command of its own install. */
const LINE = `This slideless (${VERSION}) is older than ${SITE} (99.0.0).`;

let tmp: string;
/** The config home of every run: team's prefix is in it, and its one saved profile. */
let home: string;
/** The three copies of the one bundle. */
let team: string;
let npm: string;
let plain: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'slideless-bundle-'));
  home = join(tmp, 'home');
  const bundle = join(tmp, 'build', 'bin.js');
  // The options of the package's `build` script, its banner included.
  await build({
    entryPoints: [fileURLToPath(new URL('../src/bin.ts', import.meta.url))],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    outfile: bundle,
    logLevel: 'warning',
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
    }
  });
  team = join(home, 'antasphere', 'prefix', INSTALLED);
  npm = join(tmp, 'npm', INSTALLED);
  plain = join(tmp, 'plain', 'dist', 'bin.js');
  for (const copy of [team, npm, plain]) {
    await mkdir(dirname(copy), { recursive: true });
    await copyFile(bundle, copy);
  }
  // One profile with its own invented key, remembering a site that speaks a newer CLI.
  updateConfig({ XDG_CONFIG_HOME: home }, (config) => {
    config.profiles.x = {
      baseUrl: SITE,
      apiKey: 'slk_x_own_0123456789abcdef',
      site: {
        hub: null,
        federated: false,
        name: 'X',
        cliVersion: '99.0.0',
        seenAt: '2026-11-26T09:00:00.000Z'
      }
    };
    config.activeProfile = 'x';
  });
});

/** `node <copy> --profile x list`, nothing of this machine's environment passed on: its stderr. */
function stderrOf(copy: string): string {
  const result = spawnSync(process.execPath, [copy, '--profile', 'x', 'list'], {
    cwd: tmp,
    env: { XDG_CONFIG_HOME: home, HOME: join(tmp, 'user') },
    encoding: 'utf8',
    timeout: 20_000
  });
  return result.stderr;
}

/** The lines of `stderr` that say this CLI is older than its site. */
const olderLines = (stderr: string): string[] =>
  stderr.split('\n').filter((line) => line.startsWith(`This slideless (${VERSION}) is older than`));

describe('the bundle, run with node, names the update command of the copy that runs', () => {
  it('team’s copy, in team’s prefix: team’s command', () => {
    const stderr = stderrOf(team);
    expect(olderLines(stderr), stderr).toEqual([`${LINE} Update it: team tools update`]);
  });

  it('a global npm install: npm’s command, at the site’s version', () => {
    const stderr = stderrOf(npm);
    expect(olderLines(stderr), stderr).toEqual([
      `${LINE} Update it: npm install -g @antasphere/slideless@99.0.0`
    ]);
  });

  it('any other copy: the line with no update command', () => {
    const stderr = stderrOf(plain);
    expect(olderLines(stderr), stderr).toEqual([LINE]);
  });
});

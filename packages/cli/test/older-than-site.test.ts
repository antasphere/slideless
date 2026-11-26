import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Command } from 'commander';
import type { CliSiteFacts } from '@antasphere/chassis-cli';
import { describe, expect, it } from 'vitest';
import { cli, resolveContext, updateConfig } from '../src/cli.js';
import { buildProgram, run } from '../src/index.js';
import { writeLink } from '../src/manifest.js';
import { cliBehindOf, installedBy, sayIfOlderThanSite } from '../src/older-than-site.js';
import { DECK, routedHarness, tempConfigEnv, type Route } from './harness.js';

/**
 * PRDCT-5249: the command says, once per run and on stderr only, when it is
 * older than the site its profile remembers, with the update command only
 * when it knows who installed the running file. No request of its own.
 */

/** This CLI's version, as the program declares it (index.ts `VERSION`). */
const VERSION = buildProgram(routedHarness([]).io).version()!;
/** A version newer than `version` (its major, plus one), as the chassis suite makes one (`newerThan`). */
const newerThan = (version: string): string => `${Number(version.split('.')[0]) + 1}.0.0`;

const X = 'http://x';
const KEY_X = 'slk_x_own_0123456789abcdef';
const PROJECT = 'aaaaaaaa-2222-4222-8222-222222222222';

/** What a profile remembers of its site, every field the kit requires. */
const facts = (cliVersion: string | null): CliSiteFacts => ({
  hub: null,
  federated: false,
  name: 'X',
  cliVersion,
  seenAt: '2026-11-26T09:00:00.000Z'
});

/** The line, as this CLI says it from a source checkout (no update command: nobody installed it). */
const LINE = `This slideless (${VERSION}) is older than ${X} (99.0.0).\n`;

/** A machine whose default profile `x` is site X with its own key, remembering `site` of it (none when undefined). */
async function machineWith(site: unknown): Promise<Record<string, string>> {
  const env = await tempConfigEnv();
  updateConfig(env, (config) => {
    config.profiles.x = {
      baseUrl: X,
      apiKey: KEY_X,
      ...(site !== undefined ? { site: site as CliSiteFacts } : {})
    };
    config.activeProfile = 'x';
  });
  return env;
}

const getRoute: Route = {
  method: 'GET',
  path: new RegExp(`^/api/v1/presentations/${DECK.id}$`),
  origin: X,
  reply: () => ({ body: { ...DECK, metadata: {} } })
};

/** The `get` command of a fresh program on `io`: a real command, its parent the program. */
const getCommand = (io: Parameters<typeof buildProgram>[0]): Command =>
  buildProgram(io).commands.find((c) => c.name() === 'get')!;

describe('cliBehindOf: the kit’s comparison, copied (chassis-cli src/listing.ts)', () => {
  it('the cases the chassis suite asserts (chassis-cli test/suite/profiles-listing.test.ts, the contract machine)', () => {
    // Sites a and a-twin speak this CLI's version, b a newer one, self a pre-release of it, old none.
    expect(cliBehindOf(VERSION, VERSION)).toBe(false);
    expect(cliBehindOf(VERSION, newerThan(VERSION))).toBe(true);
    expect(cliBehindOf(VERSION, `${VERSION}-beta.1`)).toBe(false);
    expect(cliBehindOf(VERSION, null)).toBeNull();
  });

  it('semver order, each answer the kit’s own function gives (its built listing.js, read on 26 November 2026)', () => {
    const cases: Array<[string, string | null, boolean | null]> = [
      ['1.2.3', '1.2.3', false],
      ['1.2.3', '1.2.4', true],
      ['1.2.3', '1.3.0', true],
      ['1.2.3', '2.0.0', true],
      ['1.2.4', '1.2.3', false],
      ['2.0.0', '1.9.9', false],
      ['1.10.0', '1.9.0', false],
      ['1.9.0', '1.10.0', true],
      ['1.2.3', '1.2.3-beta.1', false],
      ['1.2.3-beta.1', '1.2.3', true],
      ['1.2.3-alpha', '1.2.3-beta', true],
      ['1.2.3-beta.2', '1.2.3-beta.11', true],
      ['1.2.3-beta.11', '1.2.3-beta.2', false],
      ['1.2.3-rc.1', '1.2.3-rc.1.1', true],
      ['1.2.3-1', '1.2.3-alpha', true],
      ['1.2.3-beta', '1.2.3-beta', false],
      ['v1.2.3', '1.2.4', true],
      ['1.2.3+build.5', '1.2.3', false],
      [' 1.2.3 ', '1.2.4', true],
      ['1.2.3', null, null],
      ['1.2.3', 'latest', null],
      ['dev', '1.2.3', null],
      ['1.2', '1.2.3', null],
      ['1.2.3', '', null]
    ];
    for (const [mine, site, behind] of cases)
      expect([mine, site, cliBehindOf(mine, site)]).toEqual([mine, site, behind]);
  });
});

describe('the line, through the runner', () => {
  it('a site that speaks a newer CLI: the line once on stderr, before the first request; stdout as without it', async () => {
    const quiet = routedHarness([getRoute], await machineWith(undefined));
    expect(await run(['get', DECK.id], quiet.io)).toBe(0);
    expect(quiet.err()).toBe('');

    const h = routedHarness([getRoute], await machineWith(facts('99.0.0')));
    const events: string[] = [];
    const fetch = h.io.fetch!;
    const write = h.io.err.write;
    h.io.fetch = (input, init) => {
      events.push('request');
      return fetch(input, init);
    };
    h.io.err = {
      write: (s: string) => {
        events.push('line');
        write(s);
      }
    };
    expect(await run(['get', DECK.id], h.io)).toBe(0);
    expect(h.out()).toBe(quiet.out());
    expect(h.err()).toBe(LINE);
    expect(events).toEqual(['line', 'request']);
    expect(h.wire.every((c) => c.origin === X)).toBe(true);
  });

  it('--json: the same JSON on stdout, the line on stderr', async () => {
    const quiet = routedHarness([getRoute], await machineWith(undefined));
    expect(await run(['get', DECK.id, '--json'], quiet.io)).toBe(0);

    const h = routedHarness([getRoute], await machineWith(facts('99.0.0')));
    expect(await run(['get', DECK.id, '--json'], h.io)).toBe(0);
    expect(h.out()).toBe(quiet.out());
    expect(JSON.parse(h.out())).toMatchObject({ id: DECK.id });
    expect(h.err()).toBe(LINE);
  });

  it('a context resolved twice in one run says it once', async () => {
    const h = routedHarness([], await machineWith(facts('99.0.0')));
    const get = getCommand(h.io);
    resolveContext(get, h.io);
    resolveContext(get, h.io);
    expect(h.err()).toBe(LINE);
    expect(h.calls).toEqual([]);
  });

  it('a folder’s routed command says it too, of the folder’s site', async () => {
    const env = await tempConfigEnv();
    updateConfig(env, (config) => {
      config.profiles.x = { baseUrl: X, apiKey: KEY_X, site: facts('99.0.0') };
      config.profiles.y = { baseUrl: 'http://y', apiKey: 'slk_y_own_0123456789abcdef' };
      config.activeProfile = 'y';
    });
    const dir = await mkdtemp(join(tmpdir(), 'slideless-older-'));
    await writeLink(dir, { presentationId: DECK.id, baseUrl: X });
    const h = routedHarness(
      [
        {
          method: 'PUT',
          path: /^\/api\/v1\/presentations\/[^/]+\/projects\/[^/]+$/,
          origin: X,
          reply: () => ({ body: { ...DECK, projects: [{ id: PROJECT, name: 'Atlas', isBrand: false }] } })
        }
      ],
      env
    );
    expect(await run(['projects', 'link', PROJECT, dir], h.io)).toBe(0);
    expect(h.err()).toBe(LINE);
    expect(h.wire.map((c) => [c.origin, c.auth])).toEqual([[X, `Bearer ${KEY_X}`]]);
  });

  it('no line: the same version, an older one, none announced, no memory, an unreadable memory, no version', async () => {
    const { seenAt: _dropped, ...noSeenAt } = facts('99.0.0');
    for (const site of [facts(VERSION), facts('0.0.1'), facts(null), undefined, noSeenAt, facts('latest')]) {
      const h = routedHarness([getRoute], await machineWith(site));
      expect(await run(['get', DECK.id], h.io)).toBe(0);
      expect([site, h.err()]).toEqual([site, '']);
    }
  });
});

describe('who installed the running file, and the sentence of each', () => {
  it('installedBy: team’s prefix, a global npm install, and nobody', async () => {
    const env = await tempConfigEnv();
    const home = env.XDG_CONFIG_HOME!;
    const bundle = join('lib', 'node_modules', '@antasphere', 'slideless', 'dist', 'bin.js');
    expect(installedBy(join(home, 'antasphere', 'prefix', bundle), env)).toBe('team');
    expect(installedBy('/usr/local/lib/node_modules/@antasphere/slideless/dist/bin.js', env)).toBe('npm');
    expect(
      installedBy(
        '/opt/homebrew/Cellar/slideless/0.13.2/libexec/lib/node_modules/@antasphere/slideless/dist/bin.js',
        env
      )
    ).toBeNull();
    expect(
      installedBy('/Users/someone/project/node_modules/@antasphere/slideless/dist/bin.js', env)
    ).toBeNull();
    expect(installedBy('/Users/someone/src/slideless/packages/cli/dist/bin.js', env)).toBeNull();
  });

  it('installedBy: team’s prefix reached through a linked config home is still team’s', async () => {
    const real = await mkdtemp(join(tmpdir(), 'slideless-home-'));
    await mkdir(join(real, 'antasphere', 'prefix'), { recursive: true });
    const linked = join(await mkdtemp(join(tmpdir(), 'slideless-link-')), 'config');
    await symlink(real, linked);
    // The running file is a real path: the link is resolved in it, not in the environment.
    const file = join(
      await realpath(real),
      'antasphere',
      'prefix',
      'lib',
      'node_modules',
      '@antasphere',
      'slideless',
      'dist',
      'bin.js'
    );
    expect(installedBy(file, { XDG_CONFIG_HOME: linked })).toBe('team');
  });

  it('installedBy: team’s own copy is team’s from its own path, whatever config home the command runs with', async () => {
    // The verifier's repro (round 1, finding 5): team's layout under one home, XDG_CONFIG_HOME naming another.
    const teamHome = await mkdtemp(join(tmpdir(), 'slideless-team-home-'));
    const other = await tempConfigEnv();
    const bundle = join('lib', 'node_modules', '@antasphere', 'slideless', 'dist', 'bin.js');
    expect(installedBy(join(teamHome, 'antasphere', 'prefix', bundle), other)).toBe('team');
    expect(installedBy(join('/Users/someone/.config/antasphere/prefix', bundle), other)).toBe('team');
  });

  it('installedBy: a folder beside team’s prefix is not team’s (npm’s layout in it: npm’s)', async () => {
    const env = await tempConfigEnv();
    const bundle = join('lib', 'node_modules', '@antasphere', 'slideless', 'dist', 'bin.js');
    expect(installedBy(join(env.XDG_CONFIG_HOME!, 'antasphere', 'prefix-other', bundle), env)).toBe('npm');
  });

  it('the sentence, whole, for each kind of install', async () => {
    const env = await machineWith(facts('99.0.0'));
    const teamFile = join(
      env.XDG_CONFIG_HOME!,
      'antasphere',
      'prefix',
      'lib',
      'node_modules',
      '@antasphere',
      'slideless',
      'dist',
      'bin.js'
    );
    const cases: Array<[string | null, string]> = [
      [teamFile, ' Update it: team tools update'],
      [
        '/usr/local/lib/node_modules/@antasphere/slideless/dist/bin.js',
        ' Update it: npm install -g @antasphere/slideless@99.0.0'
      ],
      [
        '/opt/homebrew/Cellar/slideless/0.13.2/libexec/lib/node_modules/@antasphere/slideless/dist/bin.js',
        ''
      ],
      [null, '']
    ];
    for (const [file, update] of cases) {
      const h = routedHarness([], env);
      // The kit's own context (no line of its own), then the line for this file.
      const ctx = cli.resolveContext(getCommand(h.io), h.io);
      sayIfOlderThanSite(ctx, '0.1.0', file);
      expect([file, h.err()]).toEqual([
        file,
        `This slideless (0.1.0) is older than ${X} (99.0.0).${update}\n`
      ]);
      expect(h.calls).toEqual([]);
    }
  });

  it('a site version remembered with spaces: the line and npm’s command name it trimmed', async () => {
    const env = await machineWith(facts('  99.0.0 '));
    const h = routedHarness([], env);
    const ctx = cli.resolveContext(getCommand(h.io), h.io);
    sayIfOlderThanSite(ctx, '0.1.0', '/usr/local/lib/node_modules/@antasphere/slideless/dist/bin.js');
    expect(h.err()).toBe(
      `This slideless (0.1.0) is older than ${X} (99.0.0). ` +
        'Update it: npm install -g @antasphere/slideless@99.0.0\n'
    );
    expect(h.calls).toEqual([]);
  });
});

import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Deck pictures on a self-hosted install (PRDCT-2790): `scripts/images.sh`
 * turns the renderer on only where Chromium's sandbox starts, and a fresh
 * install through setup.sh gets it on by default without ever failing on it.
 * The script is shell, so it runs as shell, against a fake `docker` that
 * answers the pull and the self-check the way each case needs and records
 * every call.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const read = (rel: string) => readFileSync(join(repoRoot, rel), 'utf8');

let work: string;
let bin: string;

const FAKE_DOCKER = `#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$*" in
  *" config --images renderer") echo "\${FAKE_IMAGE:-ghcr.io/antasphere/slideless-renderer:latest}" ;;
  *" pull renderer") exit "\${FAKE_PULL:-0}" ;;
  "image inspect "*) exit "\${FAKE_LOCAL:-0}" ;;
  *"selfcheck.js"*) exit "\${FAKE_SELFCHECK:-0}" ;;
esac
exit 0
`;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'images-sh-'));
  mkdirSync(join(work, 'scripts/lib'), { recursive: true });
  cpSync(join(repoRoot, 'scripts/images.sh'), join(work, 'scripts/images.sh'));
  cpSync(join(repoRoot, 'scripts/lib/dr-lib.sh'), join(work, 'scripts/lib/dr-lib.sh'));
  bin = join(work, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), FAKE_DOCKER);
  chmodSync(join(bin, 'docker'), 0o755);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function env(lines: string[]): void {
  writeFileSync(join(work, '.env'), lines.join('\n') + '\n', { mode: 0o600 });
}
const envFile = () => readFileSync(join(work, '.env'), 'utf8');
const calls = () => {
  try {
    return readFileSync(join(work, 'docker.log'), 'utf8').trim().split('\n');
  } catch {
    return [];
  }
};

function images(
  args: string[],
  fake: { pull?: number; local?: number; selfcheck?: number; image?: string } = {}
) {
  const r = spawnSync('bash', [join(work, 'scripts/images.sh'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      FAKE_LOG: join(work, 'docker.log'),
      FAKE_PULL: String(fake.pull ?? 0),
      FAKE_LOCAL: String(fake.local ?? 0),
      ...(fake.image ? { FAKE_IMAGE: fake.image } : {}),
      FAKE_SELFCHECK: String(fake.selfcheck ?? 0)
    }
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

const BASE = ['POSTGRES_PASSWORD=pw', 'AUTH_SECRET=s'];

describe('images.sh on', () => {
  it('writes the three lines and restarts, once the self-check passes', () => {
    env(BASE);
    const r = images(['on']);
    expect(r.status).toBe(0);
    const e = envFile();
    expect(e).toMatch(/^SLIDELESS_RENDERER_URL=http:\/\/renderer:3100$/m);
    expect(e).toMatch(/^SLIDELESS_RENDERER_SECRET=[0-9a-f]{64}$/m);
    expect(e).toMatch(/^COMPOSE_PROFILES=images$/m);
    expect(e).toContain('AUTH_SECRET=s');
    const c = calls();
    expect(c).toContain('compose --profile images pull renderer');
    expect(c).toContain('compose --profile images run --rm --no-deps -T renderer node dist/selfcheck.js');
    expect(c.at(-1)).toBe('compose up -d --wait --wait-timeout 180');
  });

  it('runs the self-check under the compose file itself, never with a security option of its own', () => {
    env(BASE);
    images(['on']);
    for (const call of calls()) {
      expect(call).not.toMatch(/security-opt|seccomp|unconfined|no-sandbox|cap-add|privileged/);
    }
  });

  it('with --no-start writes the lines and starts nothing (setup.sh starts the stack next)', () => {
    env(BASE);
    expect(images(['on', '--no-start']).status).toBe(0);
    expect(envFile()).toMatch(/^COMPOSE_PROFILES=images$/m);
    expect(calls().some((c) => c.startsWith('compose up'))).toBe(false);
  });

  it('keeps a secret already there, and adds images to the profiles without dropping the others or doubling it', () => {
    env([...BASE, 'SLIDELESS_RENDERER_SECRET=an-existing-secret-of-32-chars-xx', 'COMPOSE_PROFILES=metrics']);
    expect(images(['on', '--no-start']).status).toBe(0);
    expect(envFile()).toMatch(/^SLIDELESS_RENDERER_SECRET=an-existing-secret-of-32-chars-xx$/m);
    expect(envFile()).toMatch(/^COMPOSE_PROFILES=metrics,images$/m);
    expect(images(['on', '--no-start']).status).toBe(0);
    expect(envFile()).toMatch(/^COMPOSE_PROFILES=metrics,images$/m);
    expect(envFile().match(/^SLIDELESS_RENDERER_URL=/gm)).toHaveLength(1);
  });

  it('replaces a secret too short for the renderer', () => {
    env([...BASE, 'SLIDELESS_RENDERER_SECRET=short']);
    images(['on', '--no-start']);
    expect(envFile()).toMatch(/^SLIDELESS_RENDERER_SECRET=[0-9a-f]{64}$/m);
  });

  it('exits 3 and changes nothing when the sandbox cannot start on this host', () => {
    env(BASE);
    const before = envFile();
    const r = images(['on'], { selfcheck: 3 });
    expect(r.status).toBe(3);
    expect(r.out).toContain('cannot start its sandbox');
    expect(envFile()).toBe(before);
    expect(calls().some((c) => c.startsWith('compose up'))).toBe(false);
  });

  it('exits 1 and changes nothing when the self-check fails otherwise', () => {
    env(BASE);
    const before = envFile();
    expect(images(['on'], { selfcheck: 1 }).status).toBe(1);
    expect(envFile()).toBe(before);
  });

  it('exits 4, changes nothing and never runs the check when the image can neither be pulled nor found here (compose would BUILD it from source)', () => {
    env(BASE);
    const before = envFile();
    const r = images(['on'], { pull: 1, local: 1 });
    expect(r.status).toBe(4);
    expect(r.out).toContain('could not be pulled and there is no copy on this host');
    expect(envFile()).toBe(before);
    expect(calls()).toContain('image inspect ghcr.io/antasphere/slideless-renderer:latest');
    expect(calls().some((c) => c.includes(' run '))).toBe(false);
  });

  it('looks on the host for the image the compose file names (RENDERER_IMAGE), never the default name', () => {
    env(BASE);
    const r = images(['on'], { pull: 1, local: 1, image: 'registry.example/renderer:pinned' });
    expect(r.status).toBe(4);
    expect(calls()).toContain('image inspect registry.example/renderer:pinned');
    expect(calls().some((c) => c.includes('slideless-renderer:latest'))).toBe(false);
  });

  it('names the sandbox, not the pull, when the pull failed but a local copy cannot start its sandbox', () => {
    env(BASE);
    const r = images(['on'], { pull: 1, selfcheck: 3 });
    expect(r.status).toBe(3);
    expect(r.out).toContain('cannot start its sandbox');
    expect(r.out).not.toContain('no copy on this host');
  });

  it('uses a copy already on the host when the pull fails but the self-check runs', () => {
    env(BASE);
    expect(images(['on', '--no-start'], { pull: 1 }).status).toBe(0);
    expect(envFile()).toMatch(/^SLIDELESS_RENDERER_URL=/m);
  });

  it('refuses to run without a .env', () => {
    const r = images(['on']);
    expect(r.status).not.toBe(0);
    expect(r.out).toContain('run ./setup.sh first');
    expect(calls()).toEqual([]);
  });
});

describe('images.sh off', () => {
  it('drops images from the profiles and the URL, keeps the secret, stops the renderer and restarts', () => {
    env([
      ...BASE,
      'COMPOSE_PROFILES=metrics,images',
      'SLIDELESS_RENDERER_URL=http://renderer:3100',
      'SLIDELESS_RENDERER_SECRET=kept-secret-of-sixteen'
    ]);
    expect(images(['off']).status).toBe(0);
    const e = envFile();
    expect(e).toMatch(/^COMPOSE_PROFILES=metrics$/m);
    expect(e).not.toMatch(/SLIDELESS_RENDERER_URL/);
    expect(e).toMatch(/^SLIDELESS_RENDERER_SECRET=kept-secret-of-sixteen$/m);
    expect(calls()).toEqual([
      'compose --profile images rm --stop --force renderer',
      'compose up -d --wait --wait-timeout 180'
    ]);
  });

  it('removes COMPOSE_PROFILES when images was the only one', () => {
    env([...BASE, 'COMPOSE_PROFILES=images', 'SLIDELESS_RENDERER_URL=http://renderer:3100']);
    expect(images(['off']).status).toBe(0);
    expect(envFile()).not.toMatch(/COMPOSE_PROFILES/);
  });
});

describe('images.sh status and usage', () => {
  it('says off, then on once both the profile and the URL are there', () => {
    env(BASE);
    expect(images(['status']).out).toContain('deck pictures: off');
    env([...BASE, 'COMPOSE_PROFILES=images']);
    expect(images(['status']).out).toContain('deck pictures: off');
    env([...BASE, 'SLIDELESS_RENDERER_URL=http://renderer:3100']);
    expect(images(['status']).out).toContain('deck pictures: off');
    env([...BASE, 'COMPOSE_PROFILES=images', 'SLIDELESS_RENDERER_URL=http://renderer:3100']);
    expect(images(['status']).out).toContain('deck pictures: on');
  });

  it('refuses an unknown action or flag', () => {
    env(BASE);
    expect(images(['maybe']).status).toBe(2);
    expect(images(['on', '--force']).status).toBe(2);
  });
});

describe('the install path turns pictures on by default, never at the cost of the install', () => {
  const setup = read('setup.sh');
  const install = read('install.sh');

  it('setup.sh runs images.sh on --no-start for a fresh .env only, unless SLIDELESS_IMAGES=off, and a failure there never stops it', () => {
    const fresh = setup.slice(
      setup.indexOf('generating secrets'),
      setup.indexOf('pulling images and starting')
    );
    expect(fresh).toContain('if [ "${SLIDELESS_IMAGES:-on}" != off ]; then');
    expect(fresh).toMatch(/bash \.\/scripts\/images\.sh on --no-start \|\|\s*\n\s*warn /);
    const existing = setup.slice(0, setup.indexOf('generating secrets'));
    expect(existing).not.toContain('images.sh');
  });

  it('install.sh hands SLIDELESS_IMAGES to every setup.sh call, and --no-images turns it off', () => {
    const calls = install.split('\n').filter((l) => /bash "\$INSTALL_DIR\/setup\.sh"/.test(l));
    expect(calls.length).toBe(3);
    for (const l of calls) expect(l).toContain('SLIDELESS_IMAGES="$IMAGES"');
    expect(install).toMatch(/--no-images\) IMAGES=off/);
  });
});

describe('no compose file requires an optional variable', () => {
  it('carries no ${VAR:?} outside comments but the one every install has: compose checks it on every command, profiles on or off', () => {
    for (const file of [
      'docker-compose.yml',
      'docker-compose.dev.yml',
      'deploy/hostinger/docker-compose.yml'
    ]) {
      const required = read(file)
        .split('\n')
        .filter((l) => !/^\s*#/.test(l))
        .flatMap((l) => [...l.matchAll(/\$\{([A-Z0-9_]+):\?/g)].map((m) => m[1]));
      expect(
        required.filter((v) => v !== 'POSTGRES_PASSWORD'),
        file
      ).toEqual([]);
    }
  });
});

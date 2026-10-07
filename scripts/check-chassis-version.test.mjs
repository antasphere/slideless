// node --test scripts/check-chassis-version.test.mjs
//
// The check is proven on scratch trees built here, never on this checkout: a small
// workspace with a root, one app and one package that declare the chassis, the
// lockfile pnpm writes for them, the workspace file and an installed node_modules.
// One tree passes; each other case breaks it one way, the way a hand would go around
// the registry, and reads the reason the check names for it.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, test } from 'node:test';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-chassis-version.mjs');
const PIN = '1.0.0';
const INTEGRITY = `sha512-${'A'.repeat(86)}==`;

const json = (value) => JSON.stringify(value, null, 2) + '\n';

function lockfile({
  serverSpecifier = PIN,
  serverVersion = `${PIN}(hono@4.12.27)`,
  serverResolution = `{integrity: ${INTEGRITY}}`
} = {}) {
  return `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.6.0
        version: 3.9.4

  apps/server:
    dependencies:
      '@antasphere/chassis-contract':
        specifier: ${PIN}
        version: ${PIN}(hono@4.12.27)
      '@antasphere/chassis-server':
        specifier: ${serverSpecifier}
        version: ${serverVersion}

  packages/db:
    devDependencies:
      '@antasphere/chassis-db':
        specifier: ${PIN}
        version: ${PIN}

packages:

  '@antasphere/chassis-contract@${PIN}':
    resolution: {integrity: ${INTEGRITY}}

  '@antasphere/chassis-db@${PIN}':
    resolution: {integrity: ${INTEGRITY}}

  '@antasphere/chassis-server@${PIN}':
    resolution: ${serverResolution}

  prettier@3.9.4:
    resolution: {integrity: ${INTEGRITY}}

snapshots:

  '@antasphere/chassis-contract@${PIN}(hono@4.12.27)': {}

  '@antasphere/chassis-db@${PIN}': {}

  '@antasphere/chassis-server@${PIN}(hono@4.12.27)':
    dependencies:
      '@antasphere/chassis-contract': ${PIN}(hono@4.12.27)
      '@antasphere/chassis-db': ${PIN}

  prettier@3.9.4: {}
`;
}

const WORKSPACE = `packages:
  - apps/*
  - packages/*

overrides:
  nanoid@3: '>=3.3.18'
`;

function fixture({
  server = PIN,
  db = PIN,
  installedServer = PIN,
  lock = lockfile(),
  workspace = WORKSPACE
} = {}) {
  return {
    'package.json': json({ name: 'fixturetool', private: true, devDependencies: { prettier: '^3.6.0' } }),
    'pnpm-workspace.yaml': workspace,
    'pnpm-lock.yaml': lock,
    'apps/server/package.json': json({
      name: '@app/server',
      dependencies: { '@antasphere/chassis-contract': PIN, '@antasphere/chassis-server': server }
    }),
    'packages/db/package.json': json({ name: '@app/db', devDependencies: { '@antasphere/chassis-db': db } }),
    'node_modules/.modules.yaml': 'layoutVersion: 5\n',
    'apps/server/node_modules/@antasphere/chassis-contract/package.json': json({ version: PIN }),
    'apps/server/node_modules/@antasphere/chassis-server/package.json': json({ version: installedServer }),
    'packages/db/node_modules/@antasphere/chassis-db/package.json': json({ version: PIN })
  };
}

const trees = [];

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'chassis-version-'));
  trees.push(root);
  for (const [file, content] of Object.entries(files)) {
    if (content === undefined) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    writeFileSync(join(root, file), content);
  }
  return root;
}

function check(root) {
  return spawnSync('node', [script], {
    encoding: 'utf8',
    env: { ...process.env, CHASSIS_CHECK_ROOT: root }
  });
}

function assertFails(files, reason, text) {
  const result = check(tree(files));
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}${result.stderr}`);
  assert.match(result.stderr, new RegExp(`^chassis: ${reason}: `, 'm'));
  assert.ok(result.stderr.includes(text), `expected "${text}" in:\n${result.stderr}`);
  assert.equal(result.stdout, '');
}

afterEach(() => {
  while (trees.length > 0) rmSync(trees.pop(), { recursive: true, force: true });
});

describe('a tree on the pin passes', () => {
  test('pinned, locked from the registry, installed, nothing patching it', () => {
    const result = check(tree(fixture()));
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      result.stdout,
      'chassis: @antasphere/chassis-* pinned at 1.0.0, installed 1.0.0, nothing patches it\n'
    );
  });

  test('before an install, the pin and the lockfile are still checked', () => {
    const files = fixture();
    for (const file of Object.keys(files)) if (file.includes('node_modules')) delete files[file];
    const result = check(tree(files));
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /pinned at 1\.0\.0, not installed yet/);
  });
});

describe('(a) pin: one exact version in every package.json', () => {
  test('a range', () => {
    assertFails(
      fixture({ server: '^1.0.0' }),
      'pin',
      'apps/server/package.json declares @antasphere/chassis-server as "^1.0.0", not an exact version'
    );
  });

  test('a workspace link', () => {
    assertFails(fixture({ db: 'workspace:*' }), 'pin', 'as "workspace:*", not an exact version');
  });

  test('a file, a link and a git url', () => {
    for (const spec of ['file:../chassis-db', 'link:../chassis-db', 'github:antasphere/chassis#v1.0.0']) {
      assertFails(fixture({ db: spec }), 'pin', `as "${spec}", not an exact version`);
    }
  });

  test('two different versions', () => {
    assertFails(
      fixture({ db: '1.0.1' }),
      'pin',
      'the workspace declares the chassis at 2 versions (1.0.0, 1.0.1)'
    );
  });
});

describe('(b) lockfile: the pinned version, from the registry', () => {
  test('an importer resolved to a link', () => {
    assertFails(
      fixture({ lock: lockfile({ serverVersion: 'link:../../packages/chassis-server' }) }),
      'lockfile',
      'importer apps/server @antasphere/chassis-server resolves to link:../../packages/chassis-server'
    );
  });

  test('an importer whose specifier is not the pin', () => {
    assertFails(
      fixture({ lock: lockfile({ serverSpecifier: '^1.0.0' }) }),
      'lockfile',
      'importer apps/server @antasphere/chassis-server has specifier ^1.0.0, not 1.0.0'
    );
  });

  test('a package entry resolved from a tarball, without integrity', () => {
    assertFails(
      fixture({ lock: lockfile({ serverResolution: '{tarball: file:chassis-server-1.0.0.tgz}' }) }),
      'lockfile',
      "resolves @antasphere/chassis-server@1.0.0 without the registry's integrity"
    );
  });

  test('a package entry resolved from a directory', () => {
    assertFails(
      fixture({
        lock: lockfile({ serverResolution: '{directory: ../chassis/packages/server, type: directory}' })
      }),
      'lockfile',
      "without the registry's integrity"
    );
  });
});

describe('(c) patch: nothing patches or overrides the chassis', () => {
  test('an override in pnpm-workspace.yaml', () => {
    assertFails(
      fixture({ workspace: `${WORKSPACE}  '@antasphere/chassis-server': 1.0.1\n` }),
      'patch',
      "pnpm-workspace.yaml overrides names a chassis package: '@antasphere/chassis-server': 1.0.1"
    );
  });

  test('a patched dependency in pnpm-workspace.yaml', () => {
    assertFails(
      fixture({
        workspace: `${WORKSPACE}\npatchedDependencies:\n  '@antasphere/chassis-server@1.0.0': patches/chassis.patch\n`
      }),
      'patch',
      'pnpm-workspace.yaml patchedDependencies names a chassis package'
    );
  });

  test('a pnpm block in package.json', () => {
    const files = fixture();
    files['package.json'] = json({
      name: 'fixturetool',
      private: true,
      pnpm: { patchedDependencies: { '@antasphere/chassis-db@1.0.0': 'patches/db.patch' } }
    });
    assertFails(files, 'patch', 'package.json pnpm.patchedDependencies names a chassis package');
  });
});

describe('(d) copy: the chassis is never back in the tree', () => {
  test('a packages/chassis-* folder', () => {
    const files = fixture();
    files['packages/chassis-server/src/index.ts'] = 'export {};\n';
    assertFails(files, 'copy', 'packages/chassis-server exists');
  });

  test('chassis-source.json', () => {
    const files = fixture();
    files['chassis-source.json'] = '{ "source": { "repo": "antasphere/chassis" } }\n';
    assertFails(files, 'copy', 'chassis-source.json exists');
  });
});

describe('(e) installed: node_modules holds the pin', () => {
  test('another version installed', () => {
    assertFails(
      fixture({ installedServer: '1.0.1' }),
      'installed',
      'apps/server/node_modules/@antasphere/chassis-server/package.json reports 1.0.1, not the pinned 1.0.0'
    );
  });

  test('a declared package missing from an installed tree', () => {
    const files = fixture();
    delete files['packages/db/node_modules/@antasphere/chassis-db/package.json'];
    assertFails(
      files,
      'installed',
      'packages/db/node_modules/@antasphere/chassis-db/package.json is missing'
    );
  });
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const template = join(root, 'deploy/hostinger/docker-compose.yml');

function config(domain = 'slides.example.com') {
  return spawnSync(
    'docker',
    ['compose', '--env-file', '/dev/null', '-f', template, 'config', '--format', 'json'],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: { PATH: process.env.PATH, SLIDELESS_DOMAIN: domain }
    }
  );
}

test('template renders without a hostname (hPanel runs it with no environment) and exposes only the HTTPS proxy', () => {
  // A `${VAR:?}` refusal at render time leaves hPanel with no project and no
  // readable error; the hostname is enforced by the init container instead.
  const missing = config('');
  assert.equal(missing.status, 0, missing.stderr);
  assert.equal(JSON.parse(missing.stdout).services.init.environment.SLIDELESS_DOMAIN, '');
  const result = config();
  assert.equal(result.status, 0, result.stderr);
  const { services } = JSON.parse(result.stdout);
  assert.equal(services.app.ports, undefined);
  assert.equal(services.db.ports, undefined);
  assert.deepEqual(services.caddy.ports.map((p) => String(p.published)).sort(), ['443', '80']);
  assert.equal(services.app.environment.PUBLIC_BASE_URL, 'https://slides.example.com');
  assert.equal(services.app.environment.TRUST_PROXY, 'true');
  assert.equal(services.app.environment.ALLOW_INSECURE_SETUP, 'false');
  assert.equal(
    services.app.image,
    'ghcr.io/antasphere/slideless:0.7.0@sha256:97f3dbfdaff5004a77a0e29db2ee4ebd351271f6def65bad7813370caa55fb45'
  );
  assert.equal(services.init.image, services.app.image);
  // Every image is digest-pinned: the Pages gate inspects exactly what customers pull.
  for (const service of Object.values(services)) assert.match(service.image, /@sha256:[a-f0-9]{64}$/);
  for (const name of ['app', 'db', 'caddy']) {
    assert.equal(services[name].logging.options['max-size'], '10m', `${name} log rotation`);
  }
  for (const service of Object.values(services)) assert.equal(service.build, undefined);
  assert.equal(services.db.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(services.db.environment.POSTGRES_HOST_AUTH_METHOD, undefined);
  assert.equal(services.app.depends_on.db.condition, 'service_healthy');
  assert.equal(services.db.depends_on.init.condition, 'service_completed_successfully');
});

test('initializer preserves credentials, rejects corruption and validates the hostname', () => {
  const result = config();
  assert.equal(result.status, 0, result.stderr);
  const { command } = JSON.parse(result.stdout).services.init;
  const dir = mkdtempSync(join(tmpdir(), 'slideless-hostinger-'));
  const run = (domain = 'slides.example.com') =>
    spawnSync(process.execPath, [...command.slice(1, -1), dir], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { SLIDELESS_DOMAIN: domain }
    });
  try {
    const unset = run('');
    assert.notEqual(unset.status, 0);
    assert.match(unset.stderr, /SLIDELESS_DOMAIN is not set.*Docker Manager.*redeploy/);
    for (const domain of [
      'http://slides.example.com',
      'localhost',
      '127.0.0.1',
      'slides.example.com/path',
      'a.example.com\n:80',
      '-bad.example.com',
      'Slides.Example.com'
    ]) {
      const invalid = run(domain);
      assert.notEqual(invalid.status, 0, domain);
      assert.match(invalid.stderr, /SLIDELESS_DOMAIN/);
    }
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const passwordPath = join(dir, 'postgres-password');
    const password = readFileSync(passwordPath, 'utf8');
    assert.match(password, /^[a-f0-9]{64}\n$/);
    assert.equal(statSync(passwordPath).mode & 0o777, 0o600);
    assert.equal(first.stdout.includes(password.trim()), false);
    assert.equal(first.stderr.includes(password.trim()), false);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(passwordPath, 'utf8'), password);
    writeFileSync(passwordPath, 'broken');
    const corrupt = run();
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /restore/);
    assert.equal(readFileSync(passwordPath, 'utf8'), 'broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('every distribution path that publishes the template is ignored by the release workflow', () => {
  // Two workflows read the same set of files from opposite sides:
  // hostinger-pages.yml TRIGGERS on the self-hosting distribution, release.yml
  // must SKIP on it (a template bump builds no image and rolls no fleet). The
  // lists were maintained by hand and silently disagreed about the two scripts,
  // so a pin bump would have promoted an unchanged version as a release and
  // died on the version guard (2026-09-21). Neither workflow can state the set
  // for both, so the agreement is asserted here instead of trusted.
  const read = (name) => readFileSync(join(root, '.github/workflows', name), 'utf8');
  const paths = (yaml, key) => {
    const block = yaml.match(new RegExp(`^ {4}${key}:\\n((?: {6}- .*\\n)+)`, 'm'));
    assert.ok(block, `${key} block not found`);
    return block[1]
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(/^ {6}- '?/, '').replace(/'?$/, ''));
  };

  const triggers = paths(read('hostinger-pages.yml'), 'paths');
  const ignored = paths(read('release.yml'), 'paths-ignore');

  // Its own workflow file is each side's business, not the other's.
  const distribution = triggers.filter((p) => p !== '.github/workflows/hostinger-pages.yml');
  assert.ok(distribution.length >= 3, 'expected the distribution trigger list');

  const covered = (file) =>
    ignored.some((pattern) =>
      pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : pattern === file
    );

  for (const path of distribution) {
    assert.ok(
      covered(path),
      `${path} publishes the Hostinger template but release.yml would still build an image for it — add it to paths-ignore`
    );
  }
});

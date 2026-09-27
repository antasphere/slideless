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
  for (const name of ['app', 'db', 'caddy', 'renderer']) {
    assert.equal(services[name].logging.options['max-size'], '10m', `${name} log rotation`);
  }
  for (const service of Object.values(services)) assert.equal(service.build, undefined);
  assert.equal(services.db.environment.POSTGRES_PASSWORD, undefined);
  assert.equal(services.db.environment.POSTGRES_HOST_AUTH_METHOD, undefined);
  assert.equal(services.app.depends_on.db.condition, 'service_healthy');
  assert.equal(services.db.depends_on.init.condition, 'service_completed_successfully');
});

test('the renderer keeps Chromium sandboxed with Docker defaults, holds no capability to use, and never sees the database', () => {
  // PRDCT-2790, Romain's ruling of 27 September 2026: a one-file template cannot carry
  // the seccomp profile, so the renderer keeps Docker's DEFAULT profile and holds only
  // the two capabilities that profile ties the namespace calls to, as a non-root user
  // with no-new-privileges. Anything that weakens a layer is refused here.
  const result = config();
  assert.equal(result.status, 0, result.stderr);
  const { services, volumes } = JSON.parse(result.stdout);
  const renderer = services.renderer;
  assert.deepEqual(renderer.cap_drop, ['ALL']);
  assert.deepEqual([...renderer.cap_add].sort(), ['SYS_ADMIN', 'SYS_CHROOT']);
  assert.deepEqual(renderer.security_opt, ['no-new-privileges:true']);
  assert.equal(renderer.privileged, undefined);
  assert.equal(renderer.user, undefined, 'the image runs as its non-root node user');
  assert.equal(renderer.read_only, true);
  assert.equal(renderer.ports, undefined);
  assert.equal(renderer.network_mode, undefined);
  assert.equal(JSON.stringify(renderer).includes('no-sandbox'), false);
  assert.equal(JSON.stringify(renderer).includes('unconfined'), false);
  assert.deepEqual(
    renderer.volumes.map((v) => [v.source, v.target, v.read_only]),
    [['renderer_credentials', '/run/slideless-renderer', true]]
  );
  assert.equal(renderer.environment.SLIDELESS_URL, 'http://app:3000');
  assert.equal(
    renderer.environment.SLIDELESS_RENDERER_SECRET,
    undefined,
    'read from its file, never interpolated'
  );
  // Both sides read the secret from the shared file; neither command carries a value.
  for (const [name, service] of [
    ['renderer', renderer],
    ['app', services.app]
  ]) {
    const script = service.command.at(-1);
    assert.match(
      script,
      /="\$+\(cat \/run\/slideless-renderer\/renderer-secret\)/,
      `${name} reads the secret file`
    );
    assert.match(script, /export SLIDELESS_RENDERER_SECRET="\$+(secret|rs)"/, `${name} exports what it read`);
    assert.equal(/[a-f0-9]{32,}/.test(script), false, `${name} carries no literal secret`);
  }
  assert.equal(renderer.logging.options['max-size'], '10m');
  assert.match(renderer.image, /^ghcr\.io\/antasphere\/slideless-renderer:/);
  assert.equal(renderer.depends_on['init-renderer'].condition, 'service_completed_successfully');
  // The app hands versions to it and never waits on it.
  assert.equal(services.app.depends_on.renderer, undefined);
  assert.ok(services.app.volumes.some((v) => v.source === 'renderer_credentials' && v.read_only));
  assert.match(services.app.command.at(-1), /SLIDELESS_RENDERER_URL=http:\/\/renderer:3100/);
  // Its secret lives in its own volume, written by its own one-shot initializer.
  const init = services['init-renderer'];
  assert.equal(init.image, services.app.image);
  assert.equal(init.network_mode, 'none');
  assert.equal(init.read_only, true);
  assert.deepEqual(
    init.volumes.map((v) => [v.source, v.target]),
    [['renderer_credentials', '/data']]
  );
  assert.ok('renderer_credentials' in volumes);
});

test('renderer initializer preserves its secret and rejects corruption', () => {
  const result = config();
  assert.equal(result.status, 0, result.stderr);
  const { command } = JSON.parse(result.stdout).services['init-renderer'];
  const dir = mkdtempSync(join(tmpdir(), 'slideless-hostinger-renderer-'));
  const run = () =>
    spawnSync(process.execPath, [...command.slice(1, -1), dir], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {}
    });
  try {
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const path = join(dir, 'renderer-secret');
    const secret = readFileSync(path, 'utf8');
    assert.match(secret, /^[a-f0-9]{64}\n$/);
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(first.stdout.includes(secret.trim()), false);
    assert.equal(run().status, 0);
    assert.equal(readFileSync(path, 'utf8'), secret);
    writeFileSync(path, 'broken');
    const corrupt = run();
    assert.notEqual(corrupt.status, 0);
    assert.equal(readFileSync(path, 'utf8'), 'broken');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

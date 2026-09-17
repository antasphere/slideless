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

test('template requires a hostname and exposes only the HTTPS proxy', () => {
  const missing = config('');
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /SLIDELESS_DOMAIN/);
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
    'ghcr.io/antasphere/slideless:0.4.1@sha256:74ed6d9ff24cff07d22c7393e53fddb8d95819769e73cdc674bc22d28a29bed2'
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

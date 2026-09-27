import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = fileURLToPath(new URL('../', import.meta.url));
const directory = mkdtempSync(join(tmpdir(), 'slideless-hostinger-smoke-'));
const project = `hostinger-smoke-${randomBytes(6).toString('hex')}`;
const domain = 'slides.test';
const env = { ...process.env, SLIDELESS_DOMAIN: domain };
const composeFile = join(directory, 'compose.json');
const cookies = join(directory, 'cookies');
const ca = join(directory, 'ca.crt');

function run(binary, args, { input, timeout = 300_000, sensitive = false } = {}) {
  const result = spawnSync(binary, args, {
    cwd: root,
    env,
    input,
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024
  });
  if (result.status !== 0) {
    throw new Error(
      `${binary} failed (${result.status ?? result.error?.code}): ${sensitive ? 'response omitted to protect test credentials' : result.stderr}`
    );
  }
  return result.stdout;
}

const compose = (...args) =>
  run('docker', ['compose', '--env-file', '/dev/null', '-p', project, '-f', composeFile, ...args]);
let httpsPort;
function request(path, { body, type = 'application/json', expected = 200, method } = {}) {
  const output = join(directory, 'response');
  const args = [
    '--silent',
    '--show-error',
    '--max-time',
    '20',
    '--noproxy',
    '*',
    '--cacert',
    ca,
    '--connect-to',
    `${domain}:443:127.0.0.1:${httpsPort}`,
    '-b',
    cookies,
    '-c',
    cookies,
    '-o',
    output,
    '-w',
    '%{http_code}',
    '-H',
    `Origin: https://${domain}`
  ];
  if (method) args.push('-X', method);
  if (body !== undefined) args.push('-H', `Content-Type: ${type}`, '--data-binary', '@-');
  args.push(`https://${domain}${path}`);
  const status = run('curl', args, {
    input: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    sensitive: true
  });
  assert.equal(Number(status), expected, `${path}: unexpected HTTP status`);
  return readFileSync(output, 'utf8');
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// One deck pushed through the API with the signed-in owner's cookie, as the CLI does:
// the file, an upload session, the commit. Returns the deck id.
function pushDeck(html) {
  const bytes = Buffer.from(html);
  const path = join(directory, 'index.html');
  writeFileSync(path, bytes);
  const status = run(
    'curl',
    [
      '--silent',
      '--show-error',
      '--max-time',
      '20',
      '--noproxy',
      '*',
      '--cacert',
      ca,
      '--connect-to',
      `${domain}:443:127.0.0.1:${httpsPort}`,
      '-b',
      cookies,
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-H',
      `Origin: https://${domain}`,
      '-F',
      `sha256=${sha256(bytes)}`,
      '-F',
      `file=@${path};type=text/html;filename=index.html`,
      `https://${domain}/api/v1/presentations/assets`
    ],
    { sensitive: true }
  );
  assert.equal(Number(status), 201, 'deck asset upload');
  const session = JSON.parse(
    request('/api/v1/presentations/uploads', { method: 'POST', expected: 201 })
  ).uploadSession;
  const manifest = [
    { path: 'index.html', sha256: sha256(bytes), sizeBytes: bytes.length, contentType: 'text/html' }
  ];
  request(`/api/v1/presentations/uploads/${session.id}/commit`, {
    body: { title: 'Hostinger picture', entryPath: 'index.html', manifest },
    expected: 201
  });
  return session.presentationId;
}

// The deck's still image, as the dashboard reads it: 200 and a WebP within the wait.
async function expectPicture(deckId) {
  const out = join(directory, 'thumb');
  for (let attempt = 0; attempt < 45; attempt++) {
    const status = run(
      'curl',
      [
        '--silent',
        '--max-time',
        '20',
        '--noproxy',
        '*',
        '--cacert',
        ca,
        '--connect-to',
        `${domain}:443:127.0.0.1:${httpsPort}`,
        '-b',
        cookies,
        '-o',
        out,
        '-w',
        '%{http_code}',
        `https://${domain}/api/v1/presentations/${deckId}/versions/1/thumbnail`
      ],
      { sensitive: true }
    );
    if (status === '200') {
      const image = readFileSync(out);
      assert.equal(image.subarray(0, 4).toString('latin1'), 'RIFF', 'thumbnail is not a RIFF file');
      assert.equal(image.subarray(8, 12).toString('latin1'), 'WEBP', 'thumbnail is not a WebP');
      return image.length;
    }
    await delay(1000);
  }
  throw new Error(
    `deck ${deckId}: no picture within 45 s (${compose('logs', '--no-color', '--tail', '40', 'renderer')})`
  );
}

try {
  const config = JSON.parse(
    run('docker', [
      'compose',
      '--env-file',
      '/dev/null',
      '-f',
      'deploy/hostinger/docker-compose.yml',
      'config',
      '--format',
      'json'
    ])
  );
  // Compose config resolves default names. Remove them so ALL test resources
  // belong to this unique project, even when multiple drills run together.
  delete config.name;
  for (const value of Object.values(config.volumes)) delete value.name;
  for (const value of Object.values(config.networks)) delete value.name;
  if (process.env.HOSTINGER_TEST_IMAGE) {
    config.services.init.image = process.env.HOSTINGER_TEST_IMAGE;
    config.services['init-renderer'].image = process.env.HOSTINGER_TEST_IMAGE;
    config.services.app.image = process.env.HOSTINGER_TEST_IMAGE;
  }
  if (process.env.HOSTINGER_TEST_RENDERER_IMAGE) {
    config.services.renderer.image = process.env.HOSTINGER_TEST_RENDERER_IMAGE;
  }
  config.services.caddy.command.push('--internal-certs');
  config.services.caddy.ports = [80, 443].map((target) => ({ target, host_ip: '127.0.0.1' }));
  writeFileSync(composeFile, JSON.stringify(config), { mode: 0o600 });
  console.log(`Starting ${project} with ${config.services.app.image} and ${config.services.renderer.image}`);
  compose('up', '-d', '--wait', '--wait-timeout', '180');
  httpsPort = compose('port', 'caddy', '443').trim().split(':').at(-1);
  const httpPort = compose('port', 'caddy', '80').trim().split(':').at(-1);
  // Caddy starts its listener before the local CA has necessarily been written.
  let copied = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      compose('cp', 'caddy:/data/caddy/pki/authorities/local/root.crt', ca);
      request('/readyz');
      copied = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert.ok(copied, 'HTTPS did not become ready within 30 attempts');
  const redirect = run('curl', [
    '-sS',
    '--max-time',
    '10',
    '--noproxy',
    '*',
    '-I',
    '-H',
    `Host: ${domain}`,
    `http://127.0.0.1:${httpPort}/`
  ]);
  assert.match(redirect, /HTTP\/1\.1 308/);
  assert.match(redirect, new RegExp(`location: https://${domain}/`, 'i'));
  request('/');

  const logs = compose('logs', '--no-color', 'app');
  const token = /Use this token to claim the instance: ([a-f0-9]{32})/.exec(logs)?.[1];
  assert.ok(token, 'Setup token must be available in the app logs');
  const fingerprint = (service, path) =>
    createHash('sha256')
      .update(compose('exec', '-T', service, 'cat', path))
      .digest('hex');
  const dbCredential = fingerprint('app', '/run/slideless-secrets/postgres-password');
  const authSecret = fingerprint('app', '/data/secret');
  // Recreate before claim as well: the first-boot token must be stable.
  compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180', 'app');
  assert.equal(compose('exec', '-T', 'app', 'cat', '/data/setup-token').trim(), token);
  const owner = {
    email: 'owner@hostinger.test',
    name: 'Hostinger owner',
    password: randomBytes(24).toString('hex')
  };
  const setup = { instanceName: 'Hostinger smoke', owner, setupToken: token };
  request('/api/v1/setup', { body: { ...setup, setupToken: 'wrong-token' }, expected: 403 });
  request('/api/v1/setup', { body: setup, expected: 201 });
  request('/api/v1/setup', { body: setup, expected: 410 });
  compose('exec', '-T', 'app', 'test', '!', '-e', '/data/setup-token');
  request('/api/v1/auth/sign-in/email', { body: { email: owner.email, password: owner.password } });
  assert.match(readFileSync(cookies, 'utf8'), /\tTRUE\t/, 'Authentication cookie must be Secure');
  assert.equal(JSON.parse(request('/api/v1/me')).user.email, owner.email);
  // Deck pictures (PRDCT-2790): the renderer started with Chromium's sandbox on (it
  // refuses to run otherwise, and `up --wait` waited for its healthcheck), holds no
  // capability in its process, never sees the database credential, and a pushed deck
  // gets its picture.
  assert.match(
    compose('exec', '-T', 'renderer', 'sh', '-c', 'grep -h CapEff /proc/[0-9]*/status | sort -u'),
    /^CapEff:\s+0{16}\n$/,
    'no process in the renderer may hold an effective capability'
  );
  compose('exec', '-T', 'renderer', 'test', '!', '-e', '/run/slideless-secrets/postgres-password');
  assert.equal(
    fingerprint('renderer', '/run/slideless-renderer/renderer-secret'),
    fingerprint('app', '/run/slideless-renderer/renderer-secret')
  );
  const deckId = pushDeck(
    '<!doctype html><title>Hostinger</title><body style="background:#1d4ed8"><h1>Hostinger picture</h1>'
  );
  const pictureBytes = await expectPicture(deckId);
  const key = JSON.parse(
    request('/api/v1/api-keys', {
      body: { name: 'Persistence', scopes: ['presentations:read'] },
      expected: 201
    })
  ).key;
  assert.ok(key);
  const payload = 'Hostinger volume persistence fixture';
  const file = JSON.parse(
    request('/api/v1/files?name=hostinger.txt', { body: payload, type: 'text/plain', expected: 201 })
  ).file;
  assert.equal(request(`/api/v1/files/${file.id}/content`), payload);

  compose('up', '-d', '--force-recreate', '--wait', '--wait-timeout', '180');
  httpsPort = compose('port', 'caddy', '443').trim().split(':').at(-1);
  // Same CA, auth cookie, owner, stored file and database password after recreation.
  let readyAfterRecreate = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      request('/readyz');
      readyAfterRecreate = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert.ok(readyAfterRecreate, 'HTTPS did not recover after container recreation');
  assert.equal(fingerprint('app', '/run/slideless-secrets/postgres-password'), dbCredential);
  assert.equal(fingerprint('app', '/data/secret'), authSecret);
  assert.equal(JSON.parse(request('/api/v1/me')).user.email, owner.email);
  assert.equal(request(`/api/v1/files/${file.id}/content`), payload);
  assert.equal(await expectPicture(deckId), pictureBytes, 'the stored picture survives recreation');
  const me = run(
    'curl',
    [
      '-fsS',
      '--max-time',
      '20',
      '--noproxy',
      '*',
      '--cacert',
      ca,
      '--connect-to',
      `${domain}:443:127.0.0.1:${httpsPort}`,
      '-H',
      `Authorization: Bearer ${key}`,
      `https://${domain}/api/v1/me`
    ],
    { sensitive: true }
  );
  assert.equal(JSON.parse(me).user.email, owner.email);
  request('/api/v1/setup', { body: setup, expected: 410 });
  console.log(
    'PASS: HTTPS, redirect, owner claim, sign-in, upload, deck picture, credential and data persistence.'
  );
} finally {
  // Only this script's disposable test project is removed.
  try {
    compose('down', '-v', '--remove-orphans');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

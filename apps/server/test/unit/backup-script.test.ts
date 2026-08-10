import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * PRDCT-1348, tested as BEHAVIOR: a real `backup.sh` run (docker stubbed,
 * everything else genuine — bash, tar, gzip, openssl, the chmods, the
 * umask) whose produced bytes are then scanned for secret canaries. A
 * string assertion over the script text can stay green through a
 * behaviorally identical regression — a different tar spelling, a `cp`, a
 * different extension; this cannot: if any run ever writes `.env` material
 * into an artifact in cleartext, the canary scan finds it in the bytes.
 *
 * The contract pinned here:
 *   - without BACKUP_PASSPHRASE: db + data artifacts only, no config
 *     archive of any kind, no canary anywhere (raw or decompressed);
 *   - with BACKUP_PASSPHRASE: config-<stamp>.tar.gz.enc appears, its raw
 *     bytes carry no canary, and the passphrase decrypts it back to the
 *     exact .env (the OPS-1 recovery path);
 *   - every artifact is mode 0600.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const CANARIES = {
  AUTH_SECRET: 'canary-auth-secret-3f9a1c',
  POSTGRES_PASSWORD: 'canary-pg-password-7b2e4d',
  SETUP_TOKEN: 'canary-setup-token-9c6f0a',
  METRICS_TOKEN: 'canary-metrics-token-1d8b5e'
} as const;

/** A structurally valid plain-text pg_dump, as dr_verify_pg_dump requires. */
const FAKE_DUMP = [
  '--',
  '-- PostgreSQL database dump',
  '--',
  '',
  'COPY public.users (id) FROM stdin;',
  '1',
  '2',
  '\\.',
  '',
  '--',
  '-- PostgreSQL database dump complete',
  '--',
  ''
].join('\n');

/**
 * Stub docker handling exactly the two invocations backup.sh makes:
 * `compose exec … pg_dump …` (emit a dump on stdout — backup.sh gzips it)
 * and `compose run … --entrypoint tar app -czf /backup/data-<stamp>.tar.gz
 * -C /data .` (write the data tarball to the -v host directory).
 */
const DOCKER_STUB = [
  '#!/usr/bin/env bash',
  'set -euo pipefail',
  'case "${2:-}" in',
  '  exec)',
  `    cat "$STUB_DUMP"`,
  '    ;;',
  '  run)',
  '    hostdir="" out="" prev=""',
  '    for a in "$@"; do',
  '      case "$prev" in',
  '        -v) hostdir="${a%%:*}" ;;',
  '        -czf) out="$a" ;;',
  '      esac',
  '      prev="$a"',
  '    done',
  '    tmpd=$(mktemp -d)',
  '    mkdir -p "$tmpd/files"',
  '    printf \'stub-data-secret\\n\' > "$tmpd/secret"',
  '    printf \'blob\\n\' > "$tmpd/files/blob1"',
  '    tar -czf "$hostdir/$(basename "$out")" -C "$tmpd" .',
  '    rm -rf "$tmpd"',
  '    ;;',
  '  *)',
  '    echo "stub docker: unhandled: $*" >&2',
  '    exit 1',
  '    ;;',
  'esac'
].join('\n');

let work: string;
let checkout: string;
let backupDir: string;
let binDir: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'backup-sh-'));
  checkout = join(work, 'repo');
  backupDir = join(work, 'backups');
  binDir = join(work, 'bin');
  mkdirSync(join(checkout, 'scripts', 'lib'), { recursive: true });
  mkdirSync(binDir);
  cpSync(join(repoRoot, 'scripts/backup.sh'), join(checkout, 'scripts/backup.sh'));
  cpSync(join(repoRoot, 'scripts/lib/dr-lib.sh'), join(checkout, 'scripts/lib/dr-lib.sh'));
  writeFileSync(
    join(checkout, '.env'),
    Object.entries(CANARIES)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n') + '\n'
  );
  writeFileSync(join(checkout, 'docker-compose.yml'), 'services: {}\n');
  writeFileSync(join(work, 'dump.sql'), FAKE_DUMP);
  writeFileSync(join(binDir, 'docker'), DOCKER_STUB, { mode: 0o755 });
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function runBackup(passphrase?: string): { status: number; output: string } {
  const env: Record<string, string | undefined> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    BACKUP_DIR: backupDir,
    STUB_DUMP: join(work, 'dump.sql')
  };
  delete env.BACKUP_PASSPHRASE;
  if (passphrase !== undefined) env.BACKUP_PASSPHRASE = passphrase;
  // spawnSync, not execFileSync: dr_warn writes to stderr, and the skip
  // warning this suite asserts on must be visible on the SUCCESS path too.
  const r = spawnSync('bash', [join(checkout, 'scripts/backup.sh')], {
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** Every produced artifact's bytes — raw, plus gunzipped for .gz files. */
function producedBytes(): Array<{ name: string; bytes: string }> {
  const out: Array<{ name: string; bytes: string }> = [];
  for (const name of readdirSync(backupDir)) {
    const raw = readFileSync(join(backupDir, name));
    out.push({ name, bytes: raw.toString('latin1') });
    if (name.endsWith('.gz')) {
      out.push({ name: `${name} (decompressed)`, bytes: gunzipSync(raw).toString('latin1') });
    }
  }
  return out;
}

function expectNoCanary(scope: Array<{ name: string; bytes: string }>) {
  for (const { name, bytes } of scope) {
    for (const [key, canary] of Object.entries(CANARIES)) {
      expect(bytes.includes(canary), `${key} canary found in ${name}`).toBe(false);
    }
  }
}

describe('backup.sh never lets .env material reach a backup in cleartext (PRDCT-1348)', () => {
  it('without BACKUP_PASSPHRASE: db+data only, no config archive, no canary in any byte', () => {
    const r = runBackup();
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('config archive SKIPPED');

    const names = readdirSync(backupDir).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^data-.*\.tar\.gz$/);
    expect(names[1]).toMatch(/^db-.*\.sql\.gz$/);
    expectNoCanary(producedBytes());

    for (const name of names) {
      expect(statSync(join(backupDir, name)).mode & 0o777, `${name} must be 0600`).toBe(0o600);
    }
  }, 30000);

  it('with BACKUP_PASSPHRASE: the config archive is opaque ciphertext that decrypts back to .env', () => {
    const r = runBackup('correct-horse-battery');
    expect(r.status, r.output).toBe(0);

    const enc = readdirSync(backupDir).find((n) => /^config-.*\.tar\.gz\.enc$/.test(n));
    expect(enc, 'encrypted config archive must exist').toBeDefined();
    expect(statSync(join(backupDir, enc!)).mode & 0o777).toBe(0o600);
    expectNoCanary(producedBytes());

    // The recovery path (OPS-1): the passphrase brings the exact .env back.
    const recovered = execFileSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        'openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass fd:3 ' +
          `-in ${JSON.stringify(join(backupDir, enc!))} 3<<< "$PASS" | tar -xzOf - .env`
      ],
      { encoding: 'utf8', env: { ...process.env, PASS: 'correct-horse-battery' } }
    );
    expect(recovered).toBe(readFileSync(join(checkout, '.env'), 'utf8'));
  }, 30000);
});

import { execFileSync, spawnSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import {
  cpSync,
  existsSync,
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
 *   - without BACKUP_PASSPHRASE and without --allow-unencrypted: the run
 *     REFUSES (non-zero exit) before writing anything at all — a backup
 *     that cannot restore to a working instance must be a conscious
 *     choice, not a cron default;
 *   - with --allow-unencrypted: db + data artifacts only, no config
 *     archive of any kind, no canary anywhere (raw or decompressed);
 *   - with BACKUP_PASSPHRASE: config-<stamp>.tar.gz.enc appears, its raw
 *     bytes carry no canary, and the passphrase decrypts it back to the
 *     exact .env (the OPS-1 recovery path);
 *   - every artifact is mode 0600.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

const CANARIES = {
  AUTH_SECRET: 'canary-auth-secret-3f9a1c',
  // The server-generated pepper root the docker stub serves as /data/secret
  // (PRDCT-1440): with a passphrase it must never appear in cleartext either.
  DATA_SECRET: 'stub-data-secret',
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
  '    hostdir="" out="" prev="" entrypoint="" excl_secret=0',
  '    for a in "$@"; do',
  '      case "$prev" in',
  '        -v) hostdir="${a%%:*}" ;;',
  '        -czf) out="$a" ;;',
  '        --entrypoint) entrypoint="$a" ;;',
  '      esac',
  '      [ "$a" = --exclude=./secret ] && excl_secret=1',
  '      prev="$a"',
  '    done',
  // The PRDCT-1440 read-out of /data/secret (`--entrypoint sh app -c "cat /data/secret …"`).
  '    if [ "$entrypoint" = sh ]; then printf \'stub-data-secret\\n\'; exit 0; fi',
  '    tmpd=$(mktemp -d)',
  '    mkdir -p "$tmpd/files"',
  // A real `tar --exclude=./secret` leaves the entry out; the stub mirrors that.
  '    [ "$excl_secret" = 1 ] || printf \'stub-data-secret\\n\' > "$tmpd/secret"',
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

function runBackup(passphrase?: string, args: string[] = []): { status: number; output: string } {
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
  const r = spawnSync('bash', [join(checkout, 'scripts/backup.sh'), ...args], {
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

function expectNoCanary(scope: Array<{ name: string; bytes: string }>, except: string[] = []) {
  for (const { name, bytes } of scope) {
    for (const [key, canary] of Object.entries(CANARIES)) {
      if (except.includes(key)) continue;
      expect(bytes.includes(canary), `${key} canary found in ${name}`).toBe(false);
    }
  }
}

describe('backup.sh never lets .env material reach a backup in cleartext (PRDCT-1348)', () => {
  it('without BACKUP_PASSPHRASE and no flag: refuses with a non-zero exit and writes nothing', () => {
    const r = runBackup();
    expect(r.status, r.output).not.toBe(0);
    expect(r.output).toContain('BACKUP_PASSPHRASE');
    expect(r.output).toContain('--allow-unencrypted');
    // The gate sits before the first write — not even the backup dir exists.
    const produced = existsSync(backupDir) ? readdirSync(backupDir) : [];
    expect(produced).toHaveLength(0);
  }, 30000);

  it('--allow-unencrypted: db+data only, no config archive, no canary in any byte', () => {
    const r = runBackup(undefined, ['--allow-unencrypted']);
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('config archive SKIPPED');

    const names = readdirSync(backupDir).sort();
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^data-.*\.tar\.gz$/);
    expect(names[1]).toMatch(/^db-.*\.sql\.gz$/);
    // .env material: never. The generated pepper root DOES ride in the data
    // tarball on this path (the conscious cleartext choice, PRDCT-1440) — and
    // the run says so.
    expectNoCanary(producedBytes(), ['DATA_SECRET']);
    expect(r.output).toContain('rides INSIDE');
    expect(r.output).toContain('CLEARTEXT');

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

describe('backup.sh keeps the pepper root out of the cleartext data tarball (PRDCT-1440)', () => {
  const decrypt = (enc: string, member: string, pass: string) =>
    execFileSync(
      'bash',
      [
        '-euo',
        'pipefail',
        '-c',
        'openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -pass fd:3 ' +
          `-in ${JSON.stringify(enc)} 3<<< "$PASS" | tar -xzOf - ${member}`
      ],
      { encoding: 'utf8', env: { ...process.env, PASS: pass } }
    );

  it('with BACKUP_PASSPHRASE: /data/secret is absent from the data tarball and rides in the encrypted archive', () => {
    const r = runBackup('correct-horse-battery');
    expect(r.status, r.output).toBe(0);
    expect(r.output).toContain('carried in the encrypted config archive');

    const names = readdirSync(backupDir);
    const data = names.find((n) => /^data-.*\.tar\.gz$/.test(n))!;
    const enc = names.find((n) => /^config-.*\.tar\.gz\.enc$/.test(n))!;
    expect(data).toBeDefined();
    expect(enc).toBeDefined();

    // No cleartext artifact — raw or decompressed — holds the pepper root.
    expectNoCanary(producedBytes());
    const entries = execFileSync('tar', ['-tzf', join(backupDir, data)], { encoding: 'utf8' });
    expect(entries).not.toMatch(/(^|\/)secret$/m);
    expect(entries).toMatch(/files\/blob1/);

    // The recovery path: the passphrase brings the root back, byte-exact.
    expect(decrypt(join(backupDir, enc), 'data-secret', 'correct-horse-battery')).toBe('stub-data-secret\n');
    // …and .env still rides beside it (the OPS-1 path is untouched).
    expect(decrypt(join(backupDir, enc), '.env', 'correct-horse-battery')).toBe(
      readFileSync(join(checkout, '.env'), 'utf8')
    );
  }, 30000);

  it('with BACKUP_PASSPHRASE and no .env: the encrypted archive still carries the pepper root', () => {
    rmSync(join(checkout, '.env'));
    const r = runBackup('correct-horse-battery');
    expect(r.status, r.output).toBe(0);
    const enc = readdirSync(backupDir).find((n) => /^config-.*\.tar\.gz\.enc$/.test(n));
    expect(enc, 'the archive exists for the root alone').toBeDefined();
    expectNoCanary(producedBytes());
    expect(decrypt(join(backupDir, enc!), 'data-secret', 'correct-horse-battery')).toBe('stub-data-secret\n');
  }, 30000);
});

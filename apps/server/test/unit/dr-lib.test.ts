import { execFileSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { INSECURE_SETUP_ORIGINS, SECURE_SETUP_ORIGINS } from '../fixtures/setup-origins.js';

/**
 * The DR path is shell, so it gets tested as shell. `scripts/lib/dr-lib.sh`
 * exists precisely so the load-bearing decisions in backup.sh/restore.sh —
 * "is this archive intact?", "how many rows should each table have?", "which
 * secrets come back from the config archive?" — are pure functions over files
 * that a laptop can run.
 *
 * What these tests defend:
 *   PLT-12 — restore.sh must reject a truncated dump BEFORE it drops the
 *            database. Verification is a separate phase for that reason, and
 *            a gzip check alone is not enough: `pg_dump | gzip` can wrap a
 *            perfectly valid gzip stream around a dump pg_dump never finished.
 *   OPS-1  — restore.sh must bring AUTH_SECRET back (the pepper root for API
 *            keys, share links and edit secrets) while KEEPING the live
 *            POSTGRES_PASSWORD, which belongs to the database container on
 *            this host, not to the backup.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const drLib = join(repoRoot, 'scripts/lib/dr-lib.sh');

let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'dr-lib-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

/** Run a snippet with dr-lib.sh sourced. Returns stdout, stderr and status. */
function sh(snippet: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      'bash',
      ['-euo', 'pipefail', '-c', `. ${JSON.stringify(drLib)}\n${snippet}`],
      { cwd: work, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
    );
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    const e = err as { status: number; stdout: string; stderr: string };
    return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

/** A minimal but structurally faithful plain-text pg_dump. */
function pgDump(tables: Array<{ name: string; rows: string[] }>): string {
  const head = ['--', '-- PostgreSQL database dump', '--', '', 'SET client_encoding = UTF8;', ''];
  const body = tables.flatMap((t) => [`COPY ${t.name} (id, val) FROM stdin;`, ...t.rows, '\\.', '']);
  const tail = ['--', '-- PostgreSQL database dump complete', '--', ''];
  return [...head, ...body, ...tail].join('\n');
}

function writeDump(name: string, sql: string): string {
  const path = join(work, name);
  writeFileSync(path, gzipSync(Buffer.from(sql, 'utf8')));
  return path;
}

const goodDump = () =>
  pgDump([
    { name: 'public."user"', rows: ['1\tada', '2\tgrace', '3\tlin'] },
    { name: 'public.api_keys', rows: ['a\tk1', 'b\tk2'] },
    { name: 'public.empty_table', rows: [] }
  ]);

describe('dr_verify_pg_dump — a bad dump must fail BEFORE anything is dropped', () => {
  it('accepts an intact dump and reports the row count of every COPY block', () => {
    writeDump('db.sql.gz', goodDump());
    const r = sh('dr_verify_pg_dump db.sql.gz');
    expect(r.status).toBe(0);
    expect(r.stdout.trimEnd().split('\n')).toEqual([
      'public."user"\t3',
      'public.api_keys\t2',
      'public.empty_table\t0'
    ]);
  });

  it('REJECTS a dump truncated mid-COPY even though the gzip stream is valid', () => {
    // The exact PLT-12 scenario: pg_dump was killed, gzip closed cleanly.
    const full = goodDump();
    const cut = full.slice(0, full.indexOf('2\tgrace'));
    writeDump('db.sql.gz', cut);
    // The gzip layer is happy — which is why the gzip check alone is a trap.
    expect(sh('dr_verify_gzip db.sql.gz').status).toBe(0);

    const r = sh('dr_verify_pg_dump db.sql.gz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TRUNCATED dump: COPY block for public\."user" is never terminated/);
  });

  it('REJECTS a dump missing the pg_dump completion trailer', () => {
    const full = goodDump();
    writeDump('db.sql.gz', full.slice(0, full.indexOf('-- PostgreSQL database dump complete')));
    const r = sh('dr_verify_pg_dump db.sql.gz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/TRUNCATED dump: the pg_dump completion trailer is missing/);
  });

  it('REJECTS a file that is not a plain-text pg_dump at all', () => {
    writeDump('db.sql.gz', 'this is not a dump\n');
    expect(sh('dr_verify_pg_dump db.sql.gz').stderr).toMatch(/not a plain-text pg_dump/);
  });

  it('REJECTS a corrupt gzip stream and an empty file', () => {
    writeFileSync(join(work, 'corrupt.sql.gz'), Buffer.from('not gzip at all'));
    expect(sh('dr_verify_pg_dump corrupt.sql.gz').stderr).toMatch(/corrupt gzip stream/);
    writeFileSync(join(work, 'empty.sql.gz'), '');
    expect(sh('dr_verify_pg_dump empty.sql.gz').stderr).toMatch(/empty archive/);
    expect(sh('dr_verify_pg_dump absent.sql.gz').stderr).toMatch(/missing archive/);
  });

  it('does not mistake COPY-looking DATA for a new COPY header', () => {
    // A text column may legitimately hold a line that reads like a header —
    // and on a SINGLE-column table the data line is that text and nothing
    // else, so it matches `^COPY .* FROM stdin;$` exactly. That is the case
    // the `!incopy` guard exists for: a row that merely CONTAINS the text
    // (`1<tab>COPY …`) never matches the anchored pattern and therefore
    // exercises nothing.
    const sql = pgDump([
      {
        name: 'public.notes',
        rows: ['COPY public.evil (id) FROM stdin;', 'ok', '1\tCOPY public.other (id) FROM stdin;']
      }
    ]);
    writeDump('db.sql.gz', sql);
    const r = sh('dr_verify_pg_dump db.sql.gz');
    expect(r.status).toBe(0);
    // Without the guard the first data line would restart the counter under
    // the name `public.evil`, and the real table's count would be lost.
    expect(r.stdout.trim()).toBe('public.notes\t3');
  });
});

describe('dr_verify_tar', () => {
  it('accepts a tarball with entries', () => {
    writeFileSync(join(work, 'a.txt'), 'x');
    execFileSync('tar', ['-czf', join(work, 'data.tar.gz'), '-C', work, 'a.txt']);
    expect(sh('dr_verify_tar data.tar.gz').status).toBe(0);
  });

  it('REJECTS an empty tarball — extracting it would wipe /data for nothing', () => {
    execFileSync('tar', ['-czf', join(work, 'data.tar.gz'), '-T', '/dev/null']);
    const r = sh('dr_verify_tar data.tar.gz');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/tar archive is empty/);
  });

  it('REJECTS a truncated tarball', () => {
    writeFileSync(join(work, 'a.txt'), 'x'.repeat(200_000));
    execFileSync('tar', ['-czf', join(work, 'data.tar.gz'), '-C', work, 'a.txt']);
    const bytes = readFileSync(join(work, 'data.tar.gz'));
    writeFileSync(join(work, 'data.tar.gz'), bytes.subarray(0, Math.floor(bytes.length / 2)));
    expect(sh('dr_verify_tar data.tar.gz').status).not.toBe(0);
  });
});

/**
 * OPS-1, the half the first pass missed. AUTH_SECRET is OPTIONAL: unset, the
 * server generates one into $DATA_DIR/secret and reuses it forever
 * (apps/server/src/secret.ts). So the pepper root lives in the .env OR in the
 * data volume, and restore.sh has to tell which — before it destroys anything.
 */
describe('dr_tar_has_entry — which archive carries the pepper root', () => {
  function tarWith(names: string[], out = 'data.tar.gz'): void {
    for (const n of names) {
      const dir = join(work, 'root', ...n.split('/').slice(0, -1));
      execFileSync('mkdir', ['-p', dir]);
      writeFileSync(join(work, 'root', n), 'x');
    }
    execFileSync('tar', ['-czf', join(work, out), '-C', join(work, 'root'), '.']);
  }

  it('finds the secret file the way backup.sh archives it (tar -C /data .)', () => {
    tarWith(['secret', 'files/a.bin']);
    expect(sh('dr_tar_has_entry data.tar.gz secret').status).toBe(0);
  });

  it('reports absent when the data volume carries no secret', () => {
    tarWith(['files/a.bin']);
    expect(sh('dr_tar_has_entry data.tar.gz secret').status).not.toBe(0);
  });

  it('does not match a merely similar entry', () => {
    tarWith(['secrets', 'files/secret']);
    // `secrets` is a different file, and `files/secret` is not the top-level
    // one resolveAuthSecret reads. Either false positive would make restore.sh
    // strip AUTH_SECRET from .env and leave the instance with no pepper root.
    expect(sh('dr_tar_has_entry data.tar.gz secret').status).not.toBe(0);
  });
});

describe('dr_env_unset', () => {
  it('removes every assignment and leaves the rest byte-identical', () => {
    writeFileSync(join(work, 'f.env'), '# AUTH_SECRET=note\nA=1\nAUTH_SECRET=one\nB=2\nAUTH_SECRET=two\n');
    sh('dr_env_unset f.env AUTH_SECRET');
    expect(readFileSync(join(work, 'f.env'), 'utf8')).toBe('# AUTH_SECRET=note\nA=1\nB=2\n');
  });

  it('is a no-op when the key is absent', () => {
    writeFileSync(join(work, 'f.env'), 'A=1\n', { mode: 0o600 });
    sh('dr_env_unset f.env AUTH_SECRET');
    expect(readFileSync(join(work, 'f.env'), 'utf8')).toBe('A=1\n');
  });

  /**
   * Both writers replace the .env through a temp file, so the result's mode
   * comes from the temp file, NOT from the original — starting at 0644 is what
   * makes this assertion mean anything.
   *
   * Honest limit: this pins the OUTCOME, not the mechanism. mktemp already
   * creates at 0600, so deleting the explicit `chmod 600` from either writer
   * leaves this green; the chmod is belt-and-braces over mktemp's guarantee
   * and has no separately observable behaviour. Do not "strengthen" this by
   * asserting the source text contains a chmod — that tests the spelling, not
   * the file.
   */
  it.each(['dr_env_unset f.env A', 'dr_env_set f.env A 2'])(
    '%s leaves the .env at 0600 even when it started world-readable',
    (cmd) => {
      writeFileSync(join(work, 'f.env'), 'A=1\n', { mode: 0o644 });
      execFileSync('chmod', ['644', join(work, 'f.env')]);
      sh(cmd);
      expect(statSync(join(work, 'f.env')).mode & 0o777).toBe(0o600);
    }
  );
});

describe('dr_merge_pepper_env — OPS-1: restore the pepper root, keep the live DB password', () => {
  const backupEnv = [
    '# Auto-generated by setup.sh on 2026-01-01T00:00:00Z',
    'POSTGRES_PASSWORD=old-db-password',
    'AUTH_SECRET=the-original-pepper-root-0123456789abcdef',
    'API_KEY_PEPPERS=1:the-original-pepper-root-0123456789abcdef',
    'SETUP_TOKEN=old-setup-token',
    'PUBLIC_BASE_URL=https://old.example.com',
    ''
  ].join('\n');

  const liveEnv = [
    '# Auto-generated by setup.sh on 2026-07-26T00:00:00Z',
    'POSTGRES_PASSWORD=freshly-generated-db-password',
    'AUTH_SECRET=a-brand-new-secret-that-hashes-nothing-yet',
    'SETUP_TOKEN=new-setup-token',
    'PUBLIC_BASE_URL=https://new.example.com',
    'APP_PORT=8080',
    ''
  ].join('\n');

  beforeEach(() => {
    writeFileSync(join(work, 'backup.env'), backupEnv, { mode: 0o600 });
    writeFileSync(join(work, 'live.env'), liveEnv, { mode: 0o600 });
  });

  const live = () => readFileSync(join(work, 'live.env'), 'utf8');

  it('brings AUTH_SECRET and API_KEY_PEPPERS back from the backup', () => {
    const r = sh('dr_merge_pepper_env backup.env live.env');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n').sort()).toEqual(['API_KEY_PEPPERS', 'AUTH_SECRET']);
    expect(live()).toContain('AUTH_SECRET=the-original-pepper-root-0123456789abcdef');
    expect(live()).toContain('API_KEY_PEPPERS=1:the-original-pepper-root-0123456789abcdef');
    expect(live()).not.toContain('a-brand-new-secret-that-hashes-nothing-yet');
  });

  it('KEEPS the live POSTGRES_PASSWORD — the old one locks the app out of its own database', () => {
    sh('dr_merge_pepper_env backup.env live.env');
    expect(live()).toContain('POSTGRES_PASSWORD=freshly-generated-db-password');
    expect(live()).not.toContain('old-db-password');
  });

  it('touches nothing else in the live .env', () => {
    sh('dr_merge_pepper_env backup.env live.env');
    expect(live()).toContain('SETUP_TOKEN=new-setup-token');
    expect(live()).toContain('PUBLIC_BASE_URL=https://new.example.com');
    expect(live()).toContain('APP_PORT=8080');
    expect(live()).not.toContain('old.example.com');
  });

  it('brings the .env to mode 600 and reports nothing when already merged', () => {
    // From 0644, so the assertion tests the chmod rather than mktemp's default.
    execFileSync('chmod', ['644', join(work, 'live.env')]);
    sh('dr_merge_pepper_env backup.env live.env');
    expect(statSync(join(work, 'live.env')).mode & 0o777).toBe(0o600);
    const second = sh('dr_merge_pepper_env backup.env live.env');
    expect(second.stdout.trim()).toBe('');
  });

  it('appends the key when the live .env does not carry it at all', () => {
    writeFileSync(join(work, 'live.env'), 'POSTGRES_PASSWORD=keepme\n', { mode: 0o600 });
    sh('dr_merge_pepper_env backup.env live.env');
    expect(live()).toContain('POSTGRES_PASSWORD=keepme');
    expect(live()).toContain('AUTH_SECRET=the-original-pepper-root-0123456789abcdef');
  });
});

/**
 * PLT-10, shell side. setup.sh warns the operator when PUBLIC_BASE_URL is an
 * origin the server will refuse the wizard on, and it does that by asking
 * dr_origin_is_secure — the shell twin of isSecureSetupOrigin().
 *
 * Driven from the SAME table as test/unit/setup-transport.test.ts. Two
 * implementations of one security rule drift: the first shell version was a
 * `case` on the URL prefix and accepted `http://localhost.evil.test` and
 * `http://127.0.0.1.evil.test` as loopback, so it stayed silent about exactly
 * the origins the finding is about.
 */
describe('dr_origin_is_secure agrees with isSecureSetupOrigin', () => {
  it.each(SECURE_SETUP_ORIGINS)('accepts %s', (url) => {
    expect(sh(`dr_origin_is_secure ${JSON.stringify(url)}`).status).toBe(0);
  });

  it.each(INSECURE_SETUP_ORIGINS)('REFUSES %s', (url) => {
    expect(sh(`dr_origin_is_secure ${JSON.stringify(url)}`).status).not.toBe(0);
  });

  it('refuses a scheme it does not understand', () => {
    for (const url of ['ftp://host/x', 'platform.example.com', '']) {
      expect(sh(`dr_origin_is_secure ${JSON.stringify(url)}`).status, url).not.toBe(0);
    }
  });
});

describe('dr_env_get / dr_env_set', () => {
  it('reads a value verbatim, ignores comments, and appends when absent', () => {
    writeFileSync(join(work, 'f.env'), '# APP_PORT=1\nAPP_PORT=9999\n');
    expect(sh('dr_env_get f.env APP_PORT').stdout.trim()).toBe('9999');
    expect(sh('dr_env_get f.env NOPE').stdout.trim()).toBe('');
    sh('dr_env_set f.env NOPE yes');
    expect(sh('dr_env_get f.env NOPE').stdout.trim()).toBe('yes');
    // The commented line must survive untouched.
    expect(readFileSync(join(work, 'f.env'), 'utf8')).toContain('# APP_PORT=1');
  });

  it('replaces in place rather than appending a shadowing duplicate', () => {
    writeFileSync(join(work, 'f.env'), 'A=1\nAPP_PORT=3000\nB=2\n');
    sh('dr_env_set f.env APP_PORT 8443');
    expect(readFileSync(join(work, 'f.env'), 'utf8')).toBe('A=1\nAPP_PORT=8443\nB=2\n');
  });
});

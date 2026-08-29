import { describe, expect, it } from 'vitest';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { compareMigrations, migrationHash, onDiskMigrationHashes } from '../src/migrate.js';

/**
 * OPS-6 (PRDCT-1357): migration status is hash-based. A count-based status
 * called a database migrated by a NEWER image "current" (n applied, n on
 * disk) — the `:next`-behind-`:latest` downgrade that leaves this image's
 * schema expectations silently wrong.
 */
const drizzleDir = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle');

describe('compareMigrations', () => {
  it('a database ahead of the image is a DOWNGRADE, not "current", even when the counts match', () => {
    const status = compareMigrations(['a', 'b', 'c'], ['a', 'b', 'd']);
    expect(status.applied).toBe(3);
    expect(status.onDisk).toBe(3);
    expect(status.downgrade).toBe(true);
    expect(status.unknownApplied).toBe(1);
    // …and the image's own unapplied file is still pending.
    expect(status.pending).toBe(true);
  });

  it('strictly more applied than on disk is a downgrade too', () => {
    const status = compareMigrations(['a', 'b'], ['a', 'b', 'c']);
    expect(status).toMatchObject({ downgrade: true, unknownApplied: 1, pending: false });
  });

  it('the exact set is current; a strict subset is pending', () => {
    expect(compareMigrations(['a', 'b'], ['a', 'b'])).toMatchObject({ pending: false, downgrade: false });
    expect(compareMigrations(['a', 'b'], ['a'])).toMatchObject({ pending: true, downgrade: false });
    expect(compareMigrations(['a'], [])).toMatchObject({ pending: true, downgrade: false, applied: 0 });
  });
});

describe('the on-disk hashes are exactly what drizzle records', () => {
  it('hashes the WHOLE .sql file with sha256, in journal order', async () => {
    const journal = JSON.parse(readFileSync(join(drizzleDir, 'meta/_journal.json'), 'utf8')) as {
      entries: Array<{ tag: string }>;
    };
    const hashes = await onDiskMigrationHashes(drizzleDir);
    expect(hashes).toHaveLength(journal.entries.length);
    expect(hashes[0]).toBe(
      migrationHash(readFileSync(join(drizzleDir, `${journal.entries[0]!.tag}.sql`), 'utf8'))
    );
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
  });
});

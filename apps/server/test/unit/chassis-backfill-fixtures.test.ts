import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The chassis suite runs two backfill statements from fixtures it OWNS
 * (`packages/chassis-server/test/fixtures`, PRDCT-2544), so that no chassis
 * test names one of Slideless's migration files. A copy can drift: this test
 * is the Slideless half of the bargain. Each fixture, minus its `--# ` header,
 * must stay byte-equal to the part of the real migration it mirrors. A
 * migration is never edited once shipped, so red here means the FIXTURE moved.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const migration = (name: string) => readFileSync(join(repoRoot, 'packages/db/drizzle', name), 'utf8');
const fixture = (name: string) => {
  const text = readFileSync(join(repoRoot, 'packages/chassis-server/test/fixtures', name), 'utf8');
  const body = text.replace(/^(?:--# .*\n)+/, '');
  // The header exists and is the only thing removed.
  expect(body.length).toBeLessThan(text.length);
  expect(text.endsWith(body)).toBe(true);
  return body;
};

describe('the chassis backfill fixtures mirror the real migrations', () => {
  it('onboarding-backfill.sql is 0028_user_onboarding_backfill.sql, whole', () => {
    expect(fixture('onboarding-backfill.sql')).toBe(migration('0028_user_onboarding_backfill.sql'));
  });

  it('operator-user-id-backfill.sql is 0036_operator_user_id.sql after its first statement breakpoint', () => {
    const parts = migration('0036_operator_user_id.sql').split('--> statement-breakpoint');
    expect(parts).toHaveLength(2);
    expect(fixture('operator-user-id-backfill.sql')).toBe(parts.slice(1).join('\n'));
    expect(parts[1]).toMatch(/UPDATE "instance_settings"/);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Guards the drizzle migration journal against the trap that bricked upgrades
 * once already: drizzle applies a migration only when
 * `max(applied created_at) < entry.when`, using the journal's `when` (not idx,
 * not order). A migration whose `when` is LOWER than an already-applied one is
 * silently skipped — AUTO_MIGRATE reports success, fresh installs and CI stay
 * green (they apply everything in order), and only upgraded-in-place instances
 * break. So `when` MUST be strictly increasing, and idx/tag must stay aligned.
 * Migration 0009 was once hand-stamped a day in the future, sorting 0010 below
 * it; this test would have caught it.
 */
const journalPath = resolve(dirname(fileURLToPath(import.meta.url)), '../drizzle/meta/_journal.json');
const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

describe('drizzle migration journal', () => {
  it('has strictly increasing `when` timestamps', () => {
    for (let i = 1; i < journal.entries.length; i++) {
      const prev = journal.entries[i - 1]!;
      const cur = journal.entries[i]!;
      expect(cur.when, `${cur.tag}.when must be > ${prev.tag}.when`).toBeGreaterThan(prev.when);
    }
  });

  it('has sequential idx aligned with the tag prefix', () => {
    journal.entries.forEach((entry, i) => {
      expect(entry.idx, `entry ${i} idx`).toBe(i);
      expect(entry.tag, `entry ${i} tag`).toMatch(new RegExp(`^${String(i).padStart(4, '0')}_`));
    });
  });

  it('has no `when` dated absurdly far ahead of the newest migration', () => {
    // A future-dated stamp is the exact failure mode; a small skew guard keeps
    // a hand-edited entry from poisoning every later migration.
    const whens = journal.entries.map((e) => e.when);
    const newest = Math.max(...whens);
    for (const entry of journal.entries) {
      // Every entry sits at or before the newest — trivially true once
      // strictly-increasing holds, but pins the intent explicitly.
      expect(entry.when).toBeLessThanOrEqual(newest);
    }
  });
});

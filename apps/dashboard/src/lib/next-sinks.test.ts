import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DASH-1, the other half: `safeNext` being correct only helps at the sinks
 * that call it.
 *
 * This walks the WHOLE dashboard source tree. A hardcoded file list (the shape
 * this test started as in the template) is not good enough: this repo's login
 * page has more `next` readers than the template's, and one of them
 * deliberately passes the RAW value on.
 *
 * The rule: every read of the `next` query parameter must either be wrapped in
 * `safeNext(…)` on the same expression, or be listed in
 * {@link NON_REDIRECT_READERS} with a reason. The allowlist exists because
 * "reads `next`" and "navigates to `next`" are different things and only the
 * second is DASH-1 — but it is an ALLOWLIST keyed by file, and the second test
 * below checks the claim, so a genuinely new redirect sink still fails.
 */

/**
 * Files that read `next` for something other than navigating to it. Each entry
 * is a claim the second test enforces.
 */
const NON_REDIRECT_READERS: Record<string, string> = {
  // The hub-SSO detour (lib/sso.ts, decision 7): `writePendingNext` is handed
  // the RAW parameter on purpose, because it sanitises internally —
  // `safeNext` runs on WRITE (sso.ts) and again on CONSUME (parsePendingNext),
  // so a hand-tampered localStorage record can never become a navigation
  // target either. Wrapping at the call site would double-sanitise and hide
  // where the real guarantee lives. Every OTHER `next` read on this page is
  // wrapped at the call site, and this file's own tests cover both directions.
  'routes/login/+page.svelte': 'writePendingNext sanitises on write AND on consume (lib/sso.ts)'
};

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.svelte-kit') continue;
      out.push(...sourceFiles(full));
    } else if (/\.(ts|js|svelte)$/.test(entry.name) && !/\.test\.ts$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/** Every spelling of "read the next parameter" that could reach a redirect. */
const READ = /(?:searchParams|params)\.get\(\s*['"]next['"]\s*\)/g;
const WRAPPED = /safeNext\(\s*[^)]*?(?:searchParams|params)\.get\(\s*['"]next['"]\s*\)/g;

describe('every `next` reader goes through safeNext', () => {
  it('has no unaccounted-for next-parameter read anywhere in the dashboard source', () => {
    const root = join(import.meta.dirname, '..');
    const offenders: string[] = [];
    const inventory: string[] = [];
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, 'utf8');
      const reads = source.match(READ) ?? [];
      if (reads.length === 0) continue;
      const rel = file.slice(root.length + 1);
      const wrapped = source.match(WRAPPED) ?? [];
      const exempt = rel in NON_REDIRECT_READERS;
      inventory.push(`${rel} x${reads.length}${exempt ? ' (exempt)' : ''}`);
      if (!exempt && reads.length !== wrapped.length) {
        offenders.push(`${rel}: ${reads.length} reads, ${wrapped.length} wrapped`);
      }
    }
    expect(offenders).toEqual([]);
    // Guards the guard: the full inventory is pinned, so a new home for the
    // parameter forces someone to look rather than sliding in silently.
    expect(inventory.sort()).toEqual(['routes/login/+page.svelte x5 (exempt)', 'routes/login/+page.ts x1']);
  });

  /**
   * The exemption above is file-scoped, so it must not become a blanket pass
   * for the login page. Pin the shape instead: EVERY read on that page is
   * either wrapped in safeNext at the call site or handed to writePendingNext,
   * and writePendingNext still sanitises. A sixth read of any other shape
   * fails here.
   */
  it('the exempt page wraps every read except the one that delegates', () => {
    const root = join(import.meta.dirname, '..');
    const source = readFileSync(join(root, 'routes/login/+page.svelte'), 'utf8');
    const reads = source.match(READ) ?? [];
    const wrapped = source.match(WRAPPED) ?? [];
    const delegated =
      source.match(/writePendingNext\([^;]*?(?:searchParams|params)\.get\(\s*['"]next['"]\s*\)/g) ?? [];
    expect(wrapped.length + delegated.length).toBe(reads.length);
    expect(delegated.length).toBe(1);
    // And the delegate really does sanitise, on both directions.
    const sso = readFileSync(join(root, 'lib/sso.ts'), 'utf8');
    expect(sso).toMatch(/export function writePendingNext[\s\S]*?safeNext\(next\)/);
    expect(sso).toMatch(/function parsePendingNext[\s\S]*?return safeNext\(record\.next\)/);
  });
});

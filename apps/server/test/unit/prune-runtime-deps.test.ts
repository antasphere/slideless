import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * PRDCT-1346, tested as BEHAVIOR on a synthetic `pnpm deploy` tree: the
 * prune script is run for real (a child `node` process, exactly as the
 * Dockerfile runs it) against a store laid out the way pnpm lays it out —
 * `node_modules/<pkg>` symlinks into `.pnpm/<pkg>@<v>/node_modules/<pkg>`,
 * sibling deps linked across store entries, and the `.pnpm/node_modules`
 * hoist links pnpm adds for undeclared requires.
 *
 * The contract pinned here:
 *   - a deny-listed package (better-auth's optional dev peers included)
 *     is removed from the store, and so is its OWN dependency subtree once
 *     nothing reachable links to it any more (the orphan pass) — the class
 *     of leftover that shipped rollup/postcss/tinypool as scanner surface;
 *   - the hoist links that went dangling because of either removal are
 *     unlinked, so the image ships zero dangling symlinks;
 *   - a store entry the deployed package can still reach is NEVER touched,
 *     however deep the chain;
 *   - the run still FAILS on a dangling link it cannot attribute, on a
 *     deny-listed package that survives as a real directory, and on a
 *     declared dependency that no longer resolves — the guarantees the
 *     deny-list extension must not weaken.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'prune-runtime-deps.mjs');

let root: string;
let store: string;

function pkg(entry: string, name: string, extra: Record<string, unknown> = {}) {
  const dir = join(store, entry, 'node_modules', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', ...extra }));
  return dir;
}
/** `.pnpm/<from>/node_modules/<name>` → the package dir of store entry `to`. */
function link(from: string, name: string, to: string, toName = name) {
  const at = join(store, from, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join('..', '..', to, 'node_modules', toName), at);
}
function hoist(name: string, to: string) {
  const at = join(store, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join('..', to, 'node_modules', name), at);
}
function top(name: string, to: string) {
  const at = join(root, 'node_modules', name);
  mkdirSync(dirname(at), { recursive: true });
  symlinkSync(join('.pnpm', to, 'node_modules', name), at);
}
function run() {
  return spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
}
function danglingLinks(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      try {
        statSync(p);
      } catch {
        out.push(p);
      }
    } else if (e.isDirectory()) out.push(...danglingLinks(p));
  }
  return out;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'prune-'));
  store = join(root, 'node_modules', '.pnpm');
  mkdirSync(store, { recursive: true });
  // the deployed package: one declared runtime dep, and a --boot-check entry
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app', dependencies: { hono: '1' } }));
  mkdirSync(join(root, 'dist'));
  writeFileSync(
    join(root, 'dist', 'index.js'),
    "if (process.argv.includes('--boot-check')) process.exit(0);\n"
  );
  // hono → kysely (a transitive runtime dep, reachable only through hono)
  pkg('hono@1.0.0', 'hono');
  pkg('kysely@1.0.0', 'kysely');
  link('hono@1.0.0', 'kysely', 'kysely@1.0.0');
  top('hono', 'hono@1.0.0');
  hoist('kysely', 'kysely@1.0.0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('prune-runtime-deps: deny-list + orphan pass', () => {
  it('removes a deny-listed optional peer AND its stranded subtree, unlinks the dangling hoists, keeps the runtime graph', () => {
    // vite → rollup: vite is deny-listed, rollup is reachable ONLY through vite
    pkg('vite@6.0.0', 'vite');
    pkg('rollup@4.0.0', 'rollup');
    link('vite@6.0.0', 'rollup', 'rollup@4.0.0');
    hoist('vite', 'vite@6.0.0');
    hoist('rollup', 'rollup@4.0.0');
    // a scoped deny-listed peer with its own subtree
    pkg('@sveltejs+kit@2.0.0', '@sveltejs/kit');
    pkg('devalue@5.0.0', 'devalue');
    link('@sveltejs+kit@2.0.0', 'devalue', 'devalue@5.0.0');

    const res = run();
    expect(res.status, res.stderr + res.stdout).toBe(0);

    for (const gone of ['vite@6.0.0', 'rollup@4.0.0', '@sveltejs+kit@2.0.0', 'devalue@5.0.0']) {
      expect(existsSync(join(store, gone)), gone).toBe(false);
    }
    for (const kept of ['hono@1.0.0', 'kysely@1.0.0']) {
      expect(existsSync(join(store, kept)), kept).toBe(true);
    }
    expect(danglingLinks(join(root, 'node_modules'))).toEqual([]);
    expect(lstatSync(join(store, 'node_modules', 'kysely')).isSymbolicLink()).toBe(true);
    expect(res.stdout).toMatch(/orphans: removed unreachable \.pnpm\/rollup@4\.0\.0/);
    expect(res.stdout).toMatch(/orphans: removed unreachable \.pnpm\/devalue@5\.0\.0/);
    expect(res.stdout).toMatch(/prune-runtime-deps: OK/);
  });

  it('never removes a store entry the deployed package can still reach, even when a pruned package also linked it', () => {
    // vite and hono BOTH depend on picocolors; it must survive vite's removal
    pkg('vite@6.0.0', 'vite');
    pkg('picocolors@1.0.0', 'picocolors');
    link('vite@6.0.0', 'picocolors', 'picocolors@1.0.0');
    link('hono@1.0.0', 'picocolors', 'picocolors@1.0.0');

    const res = run();
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(existsSync(join(store, 'vite@6.0.0'))).toBe(false);
    expect(existsSync(join(store, 'picocolors@1.0.0', 'node_modules', 'picocolors', 'package.json'))).toBe(
      true
    );
    expect(statSync(join(store, 'hono@1.0.0', 'node_modules', 'picocolors', 'package.json')).isFile()).toBe(
      true
    );
  });

  it('treats a store entry reachable only through a hoist link as an orphan (hoist links are not a dependency edge)', () => {
    pkg('tinypool@1.0.0', 'tinypool');
    hoist('tinypool', 'tinypool@1.0.0');

    const res = run();
    expect(res.status, res.stderr + res.stdout).toBe(0);
    expect(existsSync(join(store, 'tinypool@1.0.0'))).toBe(false);
    expect(existsSync(join(store, 'node_modules', 'tinypool'))).toBe(false);
    expect(danglingLinks(join(root, 'node_modules'))).toEqual([]);
  });

  it('still fails the build on a dangling symlink it cannot attribute to the deny-list or the orphan pass', () => {
    symlinkSync(
      join('..', '..', 'never-existed@1.0.0', 'node_modules', 'never-existed'),
      join(store, 'hono@1.0.0', 'node_modules', 'never-existed')
    );
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/dangling symlink not attributable/);
  });

  it('still fails the build when a deny-listed package survives as a real directory outside the store', () => {
    const nested = join(store, 'hono@1.0.0', 'node_modules', 'hono', 'node_modules', 'vitest');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'package.json'), '{"name":"vitest"}');
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/deny-listed package still present \(real directory\)/);
  });

  it('still fails the build when a declared dependency no longer resolves', () => {
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', dependencies: { hono: '1', ioredis: '5' } })
    );
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/declared dependency no longer resolves: ioredis/);
  });

  it('still fails the build when --boot-check cannot load the runtime graph', () => {
    writeFileSync(join(root, 'dist', 'index.js'), "import 'vite';\n");
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ name: 'app', type: 'module', dependencies: { hono: '1' } })
    );
    const res = run();
    expect(res.status).toBe(1);
    expect(res.stderr).toMatch(/--boot-check could not load the runtime module graph/);
  });
});

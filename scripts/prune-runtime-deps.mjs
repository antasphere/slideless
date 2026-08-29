#!/usr/bin/env node
/**
 * Prune build-time tooling from a `pnpm deploy` output and PROVE the result
 * still satisfies the server's runtime dependency graph. Runs inside the
 * Docker build stage (see Dockerfile); any non-zero exit fails the image.
 *
 * Why not a plain `rm -rf` in the Dockerfile? Deleting .pnpm store dirs
 * leaves dangling symlinks that only "work" because nothing follows them at
 * runtime — a pnpm or better-auth bump could silently make a pruned package
 * reachable again, and nothing before container boot would notice (the
 * kysely near-miss recorded in LESSONS.md M8). Here removal and
 * verification share ONE deny-list, so they cannot drift:
 *
 *   1. prune   — delete deny-listed packages from node_modules/.pnpm
 *   1b. orphans — delete every store dir no symlink chain from the deployed
 *                package's node_modules reaches any more (the pruned
 *                packages' own dependency subtrees); unreachable = Node
 *                cannot resolve it, so this cannot change what loads
 *   2. sweep   — walk ALL of node_modules: every dangling symlink must be
 *                attributable to the deny-list or to the orphan pass (then it
 *                is unlinked, so the image ships zero dangling links);
 *                anything else fails
 *   3. absence — no deny-listed package may survive anywhere (a pnpm store
 *                layout change or a vendored nested copy fails the build)
 *   4. deps    — every `dependencies` entry of the deployed package must
 *                resolve to a real directory (guards the lazily imported
 *                drivers a graph load never touches: ioredis, nodemailer,
 *                resend, the OTLP exporter)
 *   5. load    — `node dist/index.js --boot-check` makes Node resolve and
 *                initialize the FULL static runtime import graph, then exit
 *                before any env/DB/listener work; ERR_MODULE_NOT_FOUND here
 *                means something runtime-reachable was pruned
 *
 * Usage: node scripts/prune-runtime-deps.mjs <deploy-dir>
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  unlinkSync
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Build-time-only packages to strip from the shipped image. drizzle-kit
 * (migrations ship pre-generated and are applied via drizzle-orm) drags in
 * the esbuild Go binaries — the CVE source — plus typescript. The second
 * group is better-auth's OPTIONAL peer set (its framework/test/driver
 * integrations, declared as optionalDependencies so `pnpm deploy --prod`
 * resolves them): the SvelteKit toolchain, vitest, better-sqlite3 and the
 * Prisma client — none of which the server imports (the runtime adapter is
 * drizzle; the dashboard is a prebuilt static bundle). Entries are exact
 * package names, or a scope glob like `@esbuild/*`.
 * NEVER add anything here without understanding LESSONS.md: better-auth
 * statically imports kysely, and pino/pg/pg-boss load files dynamically.
 */
const DENY_LIST = [
  'drizzle-kit',
  'esbuild',
  '@esbuild/*',
  '@esbuild-kit/*',
  'typescript',
  // better-auth optional peers (PRDCT-1346)
  'svelte',
  '@sveltejs/*',
  'vite',
  'vitest',
  'better-sqlite3',
  '@prisma/*'
];

const root = process.argv[2];
if (!root) {
  console.error('usage: node scripts/prune-runtime-deps.mjs <deploy-dir>');
  process.exit(2);
}
const nodeModules = join(root, 'node_modules');
const store = join(nodeModules, '.pnpm');
const errors = [];

function denied(name) {
  return DENY_LIST.some((p) => (p.endsWith('/*') ? name.startsWith(p.slice(0, -1)) : name === p));
}

/** `@esbuild+linux-x64@0.25.0_foo` (a .pnpm store dir name) → `@esbuild/linux-x64`. */
function storePkgName(dir) {
  const at = dir.indexOf('@', dir.startsWith('@') ? 1 : 0);
  if (at <= 0) return null;
  return dir.slice(0, at).replaceAll('+', '/');
}

/** Does a symlink's TARGET path point into a deny-listed package (covers .bin shims)? */
function targetDenied(linkPath) {
  let raw;
  try {
    raw = readlinkSync(linkPath);
  } catch {
    return false;
  }
  const segs = resolve(dirname(linkPath), raw).split('/');
  for (let i = 0; i < segs.length - 1; i++) {
    if (segs[i] === 'node_modules') {
      const name = segs[i + 1].startsWith('@') && segs[i + 2] ? `${segs[i + 1]}/${segs[i + 2]}` : segs[i + 1];
      if (denied(name)) return true;
    }
    if (segs[i] === '.pnpm') {
      const name = storePkgName(segs[i + 1]);
      if (name && denied(name)) return true;
    }
  }
  return false;
}

// ── 1. prune: remove deny-listed packages from the .pnpm store ─────────────
if (!existsSync(store)) {
  console.error(`prune: ${store} does not exist — not a pnpm deploy output?`);
  process.exit(1);
}
let removedDirs = 0;
for (const entry of readdirSync(store)) {
  const name = storePkgName(entry);
  if (name && denied(name)) {
    rmSync(join(store, entry), { recursive: true, force: true });
    console.log(`prune: removed .pnpm/${entry}`);
    removedDirs++;
  }
}
if (removedDirs === 0) {
  console.log('prune: nothing matched the deny-list (fine — nothing to strip)');
}

// ── 1b. orphans: store dirs nothing reachable links to any more ────────────
// Removing a deny-listed package strands its own dependency subtree in the
// store (vite's rollup/postcss, vitest's tinypool, …): real directories, so
// the dangling-symlink sweep never sees them, yet they ship as scanner
// surface. Node resolves ONLY through node_modules symlinks, so a store dir
// no symlink chain reaches from the deployed package's node_modules is
// unresolvable by construction — deleting it cannot change what loads
// (steps 4 and 5 still prove that). Walk from the top-level entries,
// following every `node_modules/*` symlink into the store, and drop the rest.
// Compare against the store's REAL path: realpathSync answers canonical
// paths, and the deploy dir itself may sit behind a symlink (macOS /var →
// /private/var in the unit test; a bind mount in some CI runners).
const storeReal = realpathSync(store);
function storeDirOf(target) {
  // a realpath'd target carries the canonical prefix; a DANGLING link's
  // lexically resolved target carries the store path as spelled
  const base = [storeReal, store].find((b) => target.startsWith(b + '/'));
  return base ? target.slice(base.length + 1).split('/')[0] : null;
}
function linkTargetsOf(nmDir) {
  const out = [];
  if (!existsSync(nmDir)) return out;
  for (const e of readdirSync(nmDir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = join(nmDir, e.name);
    if (e.isSymbolicLink()) out.push(p);
    else if (e.isDirectory() && e.name.startsWith('@')) {
      for (const s of readdirSync(p, { withFileTypes: true })) {
        if (s.isSymbolicLink()) out.push(join(p, s.name));
      }
    }
  }
  return out;
}
const reachable = new Set();
const queue = linkTargetsOf(nodeModules);
while (queue.length > 0) {
  const link = queue.pop();
  let real;
  try {
    real = realpathSync(link);
  } catch {
    continue; // dangling — step 2 adjudicates it
  }
  const dir = storeDirOf(real);
  if (!dir || reachable.has(dir)) continue;
  reachable.add(dir);
  // every package dir inside this store entry can resolve through the entry's
  // shared node_modules (pnpm's flat-per-entry layout)
  queue.push(...linkTargetsOf(join(store, dir, 'node_modules')));
}
const removedOrphans = new Set();
for (const entry of readdirSync(store, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
  if (!reachable.has(entry.name)) {
    rmSync(join(store, entry.name), { recursive: true, force: true });
    console.log(`orphans: removed unreachable .pnpm/${entry.name}`);
    removedOrphans.add(entry.name);
  }
}
console.log(`orphans: ${reachable.size} store entries reachable, ${removedOrphans.size} removed`);

/** Does a symlink's TARGET point into a store dir the orphan pass removed (the `.pnpm/node_modules` hoist links)? */
function targetOrphaned(linkPath) {
  let raw;
  try {
    raw = readlinkSync(linkPath);
  } catch {
    return false;
  }
  const dir = storeDirOf(resolve(dirname(linkPath), raw));
  return dir !== null && removedOrphans.has(dir);
}

// ── 2+3. sweep node_modules: dangling symlinks + surviving denied copies ───
// `kind` says how entries of `dir` should be read: 'nm' = children are
// package entries (or @scopes), 'scope' = children are scoped packages,
// 'other' = plain directory contents. Symlinks are never followed.
let unlinkedDangling = 0;
function sweep(dir, kind, scope = '') {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    let pkgName = null;
    if (kind === 'nm' && !e.name.startsWith('.') && !e.name.startsWith('@')) pkgName = e.name;
    else if (kind === 'scope') pkgName = `${scope}/${e.name}`;

    if (e.isSymbolicLink()) {
      let resolves = true;
      try {
        statSync(p);
      } catch {
        resolves = false;
      }
      if (!resolves) {
        if ((pkgName && denied(pkgName)) || targetDenied(p) || targetOrphaned(p)) {
          unlinkSync(p);
          unlinkedDangling++;
        } else {
          errors.push(`dangling symlink not attributable to the deny-list: ${p}`);
        }
      } else if (pkgName && denied(pkgName)) {
        errors.push(`deny-listed package still resolvable (symlink): ${p}`);
      }
    } else if (e.isDirectory()) {
      if (pkgName && denied(pkgName)) {
        errors.push(`deny-listed package still present (real directory): ${p}`);
        continue;
      }
      const childKind =
        e.name === 'node_modules' ? 'nm' : kind === 'nm' && e.name.startsWith('@') ? 'scope' : 'other';
      sweep(p, childKind, childKind === 'scope' ? e.name : '');
    }
  }
}
sweep(nodeModules, 'nm');
console.log(`sweep: removed ${unlinkedDangling} dangling symlink(s) left by the prune and the orphan pass`);

// ── 4. every declared prod dependency must still resolve ───────────────────
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const deps = Object.keys(pkg.dependencies ?? {});
let depFailures = 0;
for (const dep of deps) {
  try {
    const real = realpathSync(join(nodeModules, dep));
    if (!existsSync(join(real, 'package.json'))) throw new Error('missing package.json');
  } catch {
    errors.push(`declared dependency no longer resolves: ${dep}`);
    depFailures++;
  }
}
if (depFailures === 0) console.log(`deps: all ${deps.length} declared dependencies resolve`);

if (errors.length > 0) {
  console.error('\nprune-runtime-deps FAILED:');
  for (const err of errors) console.error(`  - ${err}`);
  process.exit(1);
}

// ── 5. load the full static runtime import graph via the --boot-check exit ─
const res = spawnSync(process.execPath, ['dist/index.js', '--boot-check'], {
  cwd: root,
  stdio: 'inherit'
});
if (res.status !== 0) {
  console.error('prune-runtime-deps FAILED: --boot-check could not load the runtime module graph');
  process.exit(1);
}
console.log('prune-runtime-deps: OK — pruned tree satisfies the runtime dependency graph');

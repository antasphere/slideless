import { realpathSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { CliEnv, CliIo, CliProfile, CliSiteFacts } from '@antasphere/chassis-cli';
import { configPath, HUB_TOOL, normalizeUrl, sameInstance } from '@antasphere/cli-core';
// cli.ts imports this module back (its `resolveContext` calls `sayIfOlderThanSite`): `cli` is read
// inside the functions only, never while the modules load.
import { cli, type CliContext } from './cli.js';

/**
 * R5 shape (b), the command says when it is older than its site
 * (PRDCT-5249): once per run, on stderr, before the first request, from what
 * the resolved profile remembers of its site (the kit's `profile.site`,
 * written by cli-core's `rememberSite`), so it costs no request. It names the
 * update command only when it knows who installed the running file: team's
 * prefix, or a global npm install; anywhere else (Clave's own copy, a build
 * from source, a project's local install) the two versions only, since a
 * wrong command is worse than none.
 */

/** The npm package the CLI ships as. */
const PACKAGE = '@antasphere/slideless';

// ── Versions ─────────────────────────────────────────────────────────────────
// A COPY of the kit's comparison (`@antasphere/chassis-cli` src/listing.ts:
// `parseVersion`, `compareVersions`, `cliBehindOf`), which the kit does not
// export: the line and `profiles --json`'s `cliBehind` say the same fact.
// PRDCT-5254 has the kit print this line itself; Slideless then drops this copy.

const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

interface Version {
  core: [number, number, number];
  pre: string[];
}

function parseVersion(value: string | null | undefined): Version | undefined {
  const m = typeof value === 'string' ? VERSION_RE.exec(value.trim()) : null;
  if (!m) return undefined;
  return { core: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/** Semver order: `x.y.z` numerically, a pre-release older than its release, its identifiers in order. */
function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i += 1) if (a.core[i] !== b.core[i]) return a.core[i]! < b.core[i]! ? -1 : 1;
  if (a.pre.length === 0 && b.pre.length === 0) return 0;
  if (a.pre.length === 0) return 1;
  if (b.pre.length === 0) return -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    const x = a.pre[i];
    const y = b.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xn = /^\d+$/.test(x);
    const yn = /^\d+$/.test(y);
    if (xn && yn && Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    if (!xn && x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Whether this CLI is older than the version a site speaks; null when either is not a version. */
export function cliBehindOf(cliVersion: string, siteVersion: string | null): boolean | null {
  const site = parseVersion(siteVersion);
  const cli = parseVersion(cliVersion);
  if (!site || !cli) return null;
  return compareVersions(cli, site) < 0;
}

/** What a profile remembers of its site, when it reads as such (the kit's `rememberedSite`, copied). */
function rememberedSite(profile: CliProfile | undefined): CliSiteFacts | undefined {
  const s: unknown = profile?.site;
  if (typeof s !== 'object' || s === null) return undefined;
  const f = s as Record<string, unknown>;
  const nullableText = (v: unknown): boolean => v === null || typeof v === 'string';
  if (!nullableText(f.hub) || typeof f.federated !== 'boolean' || !nullableText(f.name)) return undefined;
  if (!nullableText(f.cliVersion) || typeof f.seenAt !== 'string') return undefined;
  return s as CliSiteFacts;
}

// ── Who installed the running file ───────────────────────────────────────────

/** Whether `file` lies inside the folder `dir`. */
function isInside(file: string, dir: string): boolean {
  return file.startsWith(dir.endsWith(sep) ? dir : `${dir}${sep}`);
}

/** The real path of a folder, or null when it cannot be read. */
function realOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/**
 * Who installed the running bundle (`file`, its real path): `team` when it
 * lies under team's npm prefix (`<config home>/antasphere/prefix/`, team-cli
 * `teamPaths`; its real path too, for a config home reached through a link),
 * `npm` for a global npm install (`…/lib/node_modules/@antasphere/slideless/`,
 * Homebrew's copy under `/Cellar/` excepted: it has the same shape and is not
 * npm's), else null.
 */
export function installedBy(file: string, env: CliEnv): 'team' | 'npm' | null {
  const hubFile = configPath(env, HUB_TOOL);
  if (hubFile !== null) {
    const prefix = join(dirname(hubFile), 'prefix');
    const real = realOrNull(prefix);
    if (isInside(file, prefix) || (real !== null && isInside(file, real))) return 'team';
  }
  if (file.includes(`/lib/node_modules/${PACKAGE}/`) && !file.includes('/Cellar/')) return 'npm';
  return null;
}

// ── The line ─────────────────────────────────────────────────────────────────

/** The runs that already said it (keyed by the run's io, as the kit keys a run). */
const said = new WeakSet<CliIo>();

/**
 * The one line, on stderr, when this CLI (`version`) is older than what the
 * context's profile remembers its site speaks; nothing otherwise (equal,
 * newer, no memory, a site that announces none, an unreadable memory, a
 * version that does not parse). `file` is the running bundle's real path,
 * null when it could not be read: then the line names no command. No request.
 */
export function sayIfOlderThanSite(ctx: CliContext, version: string, file: string | null): void {
  if (said.has(ctx.io)) return;
  const name = ctx.profileName;
  if (name === undefined || !Object.hasOwn(ctx.config.profiles, name)) return;
  const profile = ctx.config.profiles[name];
  if (!profile || !sameInstance(cli.profileUrl(profile), ctx.baseUrl)) return;
  const site = rememberedSite(profile);
  if (!site || site.cliVersion === null || cliBehindOf(version, site.cliVersion) !== true) return;
  const siteVersion = site.cliVersion.trim();
  const by = file === null ? null : installedBy(file, ctx.io.env);
  const update =
    by === 'team'
      ? ' Update it: team tools update'
      : by === 'npm'
        ? ` Update it: npm install -g ${PACKAGE}@${siteVersion}`
        : '';
  said.add(ctx.io);
  ctx.io.err.write(
    `This ${cli.identity.bin} (${version}) is older than ${normalizeUrl(ctx.baseUrl)} (${siteVersion}).${update}\n`
  );
}

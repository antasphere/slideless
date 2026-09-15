#!/usr/bin/env node
/**
 * The release motion (PRDCT-2340). The image reports its version intrinsically
 * (apps/server inlines the package version at build time, PRDCT-1844) and the
 * fleet deploy asserts that version on the live instance after every
 * promotion — which only proves something if the number MOVES with every
 * release. Nothing moved it until this script: the version last changed by
 * hand in a release chore commit, and a week of real work shipped as 0.3.0 on
 * 2026-09-15, byte-identical in name to what had run all week.
 *
 * Two commands:
 *
 *   node scripts/release.mjs patch|minor|major [--title "…"] [--push] [--dry-run]
 *
 *     On a clean `dev` checkout: bumps the root and apps/server package.json
 *     together (they are pinned equal by env.test.ts and by release.yml),
 *     commits `chore(release): slideless X.Y.Z[ — title]`, and makes the
 *     ANNOTATED tag vX.Y.Z on that commit (the docs site seeds its changelog
 *     entry from the tag's subject). It pushes nothing unless --push (dev +
 *     the tag); the promotion stays the human's, and the script prints it.
 *     Never derives the bump from commit subjects, and never auto-increments:
 *     the kind is the one argument, chosen by the human.
 *
 *   node scripts/release.mjs guard
 *
 *     The structural check release.yml runs first on every push: refuses when
 *     the package version already carries a v-tag on ANOTHER commit, i.e. a
 *     promotion that forgot the bump and would publish a lookalike of a
 *     previous release. A version with no tag (moved, not yet tagged) and a
 *     tag pointing at HEAD (this very release) both pass. Needs the tags and
 *     their commits in the checkout (`fetch-depth: 0`).
 *
 * The CLI has its own series (packages/cli, `cli-v*`, publish-cli.yml) and is
 * deliberately not touched here.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const VERSION_FILES = ['package.json', 'apps/server/package.json'];
const RELEASE_BRANCH = 'dev';
const KINDS = ['patch', 'minor', 'major'];
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(message) {
  // The `::error::` prefix makes the line a GitHub annotation when this runs
  // in a workflow; locally it is just the first word of the reason.
  console.error(`::error::${message}`);
  process.exit(1);
}

function git(args, { root, allowFail = false } = {}) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) fail(`git ${args.join(' ')} failed: ${(r.stderr || '').trim()}`);
  return { status: r.status, out: (r.stdout || '').trim() };
}

function repoRoot() {
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (r.status !== 0) fail('not inside a git repository');
  return r.stdout.trim();
}

/** The version each package file declares; all must agree and be a plain semver. */
function readVersion(root) {
  const seen = VERSION_FILES.map((f) => {
    const raw = readFileSync(join(root, f), 'utf8');
    const m = raw.match(/^(\s*"version":\s*")([^"]+)(")/m);
    if (!m) fail(`${f} has no top-level "version" field`);
    return { file: f, version: m[2] };
  });
  const versions = new Set(seen.map((s) => s.version));
  if (versions.size !== 1) {
    fail(
      `the package files disagree: ${seen.map((s) => `${s.file} ${s.version}`).join(', ')} — fix them before releasing`
    );
  }
  const version = seen[0].version;
  if (!SEMVER.test(version)) fail(`"${version}" is not a plain X.Y.Z semver`);
  return version;
}

function nextVersion(current, kind) {
  const [, major, minor, patch] = current.match(SEMVER).map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function writeVersion(root, next) {
  for (const f of VERSION_FILES) {
    const path = join(root, f);
    const raw = readFileSync(path, 'utf8');
    // Replace the one top-level field textually so the file's formatting
    // (key order, indentation, trailing newline) stays byte-identical.
    const updated = raw.replace(/^(\s*"version":\s*")([^"]+)(")/m, `$1${next}$3`);
    if (updated === raw) fail(`${f}: could not rewrite the version field`);
    writeFileSync(path, updated);
  }
}

/** The commit a tag points at (annotated tags peeled), or null when the tag does not exist. */
function tagTarget(root, tag) {
  const r = git(['rev-parse', '-q', '--verify', `refs/tags/${tag}^{commit}`], { root, allowFail: true });
  return r.status === 0 ? r.out : null;
}

function parseArgs(argv) {
  const args = { kind: null, title: '', push: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--push') args.push = true;
    else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--title') {
      args.title = argv[++i] ?? '';
      if (!args.title) fail('--title needs a value');
    } else if (a.startsWith('--')) fail(`unknown option ${a}`);
    else if (args.kind) fail(`one command only (got ${args.kind} and ${a})`);
    else args.kind = a;
  }
  return args;
}

function guard(root) {
  const version = readVersion(root);
  const tag = `v${version}`;
  const head = git(['rev-parse', 'HEAD'], { root }).out;
  const target = tagTarget(root, tag);
  if (target === null) {
    console.log(`release guard: ${version} carries no tag yet — the version moved, ok`);
    return;
  }
  if (target === head) {
    console.log(`release guard: ${tag} points at HEAD — this is the ${version} release, ok`);
    return;
  }
  fail(
    `package version ${version} is already released: ${tag} points at ${target.slice(0, 7)}, not at HEAD ${head.slice(0, 7)}. ` +
      `Run \`pnpm release patch|minor|major\` on dev before promoting — a promotion that keeps the number would ship a lookalike of ${tag}.`
  );
}

function release(root, { kind, title, push, dryRun }) {
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD'], { root }).out;
  if (branch !== RELEASE_BRANCH) fail(`releases are cut on ${RELEASE_BRANCH}, this checkout is on ${branch}`);
  const dirty = git(['status', '--porcelain', '--untracked-files=no'], { root }).out;
  if (dirty) fail(`the working tree is not clean:\n${dirty}`);

  const current = readVersion(root);
  const next = nextVersion(current, kind);
  const tag = `v${next}`;
  if (tagTarget(root, tag) !== null) fail(`${tag} already exists locally`);
  const hasOrigin = git(['remote', 'get-url', 'origin'], { root, allowFail: true }).status === 0;
  if (hasOrigin && git(['ls-remote', '--tags', 'origin', `refs/tags/${tag}`], { root }).out) {
    fail(`${tag} already exists on origin`);
  }

  const subject = `chore(release): slideless ${next}${title ? ` — ${title}` : ''}`;
  console.log(`${current} → ${next}  (${VERSION_FILES.join(', ')})`);
  console.log(`commit  ${subject}`);
  console.log(`tag     ${tag} (annotated)`);
  if (dryRun) {
    console.log('dry run: nothing written');
    return;
  }

  writeVersion(root, next);
  git(['add', ...VERSION_FILES], { root });
  git(['commit', '-q', '-m', subject], { root });
  git(['tag', '-a', tag, '-m', subject], { root });
  const sha = git(['rev-parse', '--short', 'HEAD'], { root }).out;
  console.log(`done    ${sha}`);

  if (push) {
    git(['push', 'origin', RELEASE_BRANCH, tag], { root });
    console.log(`pushed  ${RELEASE_BRANCH} and ${tag} to origin`);
  } else {
    console.log('');
    console.log('next:');
    console.log(`  git push origin ${RELEASE_BRANCH} ${tag}`);
  }
  console.log(`  git push origin origin/${RELEASE_BRANCH}:refs/heads/prod    # the promotion`);
}

const args = parseArgs(process.argv.slice(2));
const root = repoRoot();
if (args.kind === 'guard') guard(root);
else if (KINDS.includes(args.kind)) release(root, args);
else fail(`usage: release.mjs <${KINDS.join('|')}> [--title "…"] [--push] [--dry-run]  |  release.mjs guard`);

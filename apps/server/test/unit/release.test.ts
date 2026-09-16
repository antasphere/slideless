import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * PRDCT-2340, tested as BEHAVIOR: the release script is run for real (a
 * child `node` process, exactly as `pnpm release` and release.yml run it)
 * against a throwaway git repository shaped like this one — the two version
 * files, a `dev` branch, an annotated tag on the last release, and, where the
 * case needs one, a bare origin the tags are pushed to.
 *
 * The contract pinned here:
 *   - a bump moves BOTH package files together, at the TOP-LEVEL field even
 *     when a nested "version" line sits above it, commits with the release
 *     subject and makes an ANNOTATED tag on that commit, leaving the tree
 *     clean; the file formatting survives byte for byte;
 *   - it refuses a dirty tree (tracked changes; an untracked file is a
 *     recorded non-blocker), a branch other than dev, disagreeing package
 *     files, a tag that already exists locally OR on origin, and it writes
 *     nothing on --dry-run;
 *   - the guard (what release.yml runs first) FAILS when the package version
 *     already carries a v-tag on another commit — the forgotten bump — also
 *     from a shallow or --no-tags clone, because it asks origin; it passes
 *     when the tag points at HEAD and when the version has no tag at all; and
 *     with no origin it refuses a shallow checkout rather than guess. A guard
 *     that never fires is the silent failure this pins.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release.mjs');

let root: string;
let origin: string;

function gitIn(cwd: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function git(...args: string[]) {
  return gitIn(root, ...args);
}
function runIn(cwd: string, ...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' });
}
function run(...args: string[]) {
  return runIn(root, ...args);
}
function configure(cwd: string) {
  gitIn(cwd, 'config', 'user.email', 'test@example.com');
  gitIn(cwd, 'config', 'user.name', 'Test');
  gitIn(cwd, 'config', 'commit.gpgsign', 'false');
  gitIn(cwd, 'config', 'tag.gpgsign', 'false');
}
function writeVersionFiles(rootVersion: string, serverVersion: string = rootVersion) {
  // Deliberately distinct shapes: the rewrite must touch the top-level version line only.
  writeFileSync(
    join(root, 'package.json'),
    `{\n  "name": "slideless",\n  "private": true,\n  "version": "${rootVersion}",\n  "scripts": {}\n}\n`
  );
  mkdirSync(join(root, 'apps/server'), { recursive: true });
  writeFileSync(
    join(root, 'apps/server/package.json'),
    `{\n  "name": "@slideless/server",\n  "version": "${serverVersion}",\n  "dependencies": { "version": "not-this-one" }\n}\n`
  );
}
function version(file: string, cwd: string = root) {
  return (JSON.parse(readFileSync(join(cwd, file), 'utf8')) as { version: string }).version;
}
/** A bare origin holding dev and every tag, wired as `origin` of the working repo. */
function withOrigin() {
  gitIn(origin, 'init', '-q', '--bare', '-b', 'dev'); // HEAD on dev, so a clone checks dev out
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'dev', '--tags');
}
/** A clone of origin into a fresh directory, `extra` being the clone flags under test. */
function cloneOrigin(...extra: string[]) {
  const dir = mkdtempSync(join(tmpdir(), 'slideless-release-clone-'));
  // file:// and not the bare path: git silently ignores --depth on a local-path clone.
  gitIn(tmpdir(), 'clone', '-q', ...extra, `file://${origin}`, dir);
  configure(dir);
  return dir;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slideless-release-'));
  origin = `${root}-origin.git`;
  mkdirSync(origin);
  git('init', '-q', '-b', 'dev');
  configure(root);
  writeVersionFiles('0.3.0');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore(release): slideless 0.3.0');
  git('tag', '-a', 'v0.3.0', '-m', 'chore(release): slideless 0.3.0');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(origin, { recursive: true, force: true });
});

describe('pnpm release <kind>', () => {
  it('bumps both package files, commits and makes an annotated tag on the commit', () => {
    const before = readFileSync(join(root, 'apps/server/package.json'), 'utf8');
    const r = run('minor', '--title', 'forms remember their answers');
    expect(r.status, r.stderr).toBe(0);
    expect(version('package.json')).toBe('0.4.0');
    expect(version('apps/server/package.json')).toBe('0.4.0');
    // Only the version line moved; the decoy "version" key under dependencies did not.
    expect(readFileSync(join(root, 'apps/server/package.json'), 'utf8')).toBe(
      before.replace('"version": "0.3.0"', '"version": "0.4.0"')
    );
    expect(git('log', '-1', '--format=%s')).toBe(
      'chore(release): slideless 0.4.0 — forms remember their answers'
    );
    expect(git('cat-file', '-t', 'v0.4.0')).toBe('tag'); // annotated, not lightweight
    expect(git('rev-parse', 'v0.4.0^{commit}')).toBe(git('rev-parse', 'HEAD'));
    expect(git('tag', '-l', '--format=%(subject)', 'v0.4.0')).toBe(
      'chore(release): slideless 0.4.0 — forms remember their answers'
    );
    expect(git('status', '--porcelain')).toBe('');
    expect(r.stdout).toContain('git push origin dev v0.4.0');
    expect(r.stdout).toContain('git push origin origin/dev:refs/heads/prod');
  });

  it.each([
    ['patch', '0.3.1'],
    ['minor', '0.4.0'],
    ['major', '1.0.0']
  ])('%s → %s', (kind, expected) => {
    expect(run(kind).status).toBe(0);
    expect(version('package.json')).toBe(expected);
    expect(git('rev-parse', `v${expected}^{commit}`)).toBe(git('rev-parse', 'HEAD'));
  });

  it('moves the TOP-LEVEL version even when a nested "version" line sits above it in both files', () => {
    // The shape a settings block above the version field takes (pnpm.overrides,
    // a nested dependency pin): the first "version" line is not the field.
    writeFileSync(
      join(root, 'package.json'),
      `{\n  "pnpm": {\n    "overrides": {\n      "version": "0.3.0"\n    }\n  },\n  "name": "slideless",\n  "version": "0.3.0"\n}\n`
    );
    writeFileSync(
      join(root, 'apps/server/package.json'),
      `{\n  "resolutions": {\n    "version": "0.3.0"\n  },\n  "name": "@slideless/server",\n  "version": "0.3.0"\n}\n`
    );
    git('commit', '-q', '-am', 'a settings block above the version');
    const r = run('patch');
    expect(r.status, r.stderr).toBe(0);
    expect(version('package.json')).toBe('0.3.1');
    expect(version('apps/server/package.json')).toBe('0.3.1');
    // The decoys stayed where they were.
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain(
      '"overrides": {\n      "version": "0.3.0"'
    );
    expect(readFileSync(join(root, 'apps/server/package.json'), 'utf8')).toContain(
      '"resolutions": {\n    "version": "0.3.0"'
    );
    expect(run('guard').status).toBe(0);
  });

  it('picks the top-level line by JSON depth, so mixed tabs and spaces cannot mislead it', () => {
    // A decoy indented with ONE tab above a top-level field indented with TWO
    // spaces: shorter indentation, deeper structure. Depth wins.
    writeFileSync(
      join(root, 'package.json'),
      `{\n  "pnpm": {\n\t"version": "0.3.0"\n  },\n  "name": "slideless",\n  "version": "0.3.0"\n}\n`
    );
    git('commit', '-q', '-am', 'mixed indentation');
    const r = run('patch');
    expect(r.status, r.stderr).toBe(0);
    expect(version('package.json')).toBe('0.3.1');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('\t"version": "0.3.0"');
  });

  it('is not fooled by an escaped quote and a brace inside a string value above the field', () => {
    // The scanner must treat \" as part of the string: otherwise the brace that
    // follows counts, every later line is mis-depthed, and the field is lost.
    writeFileSync(
      join(root, 'package.json'),
      `{\n  "description": "he said \\" and { here",\n  "o": {\n    "version": "0.3.0"\n  },\n  "name": "slideless",\n  "version": "0.3.0"\n}\n`
    );
    git('commit', '-q', '-am', 'an escaped quote in a value');
    const r = run('patch');
    expect(r.status, r.stderr).toBe(0);
    expect(version('package.json')).toBe('0.3.1');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toContain('"o": {\n    "version": "0.3.0"');
  });

  it('refuses a file where the top-level version line cannot be identified, and writes nothing', () => {
    // Two top-level "version" keys: JSON.parse keeps the last, the pick is
    // ambiguous, and the release must stop before touching either file.
    writeFileSync(
      join(root, 'package.json'),
      `{\n  "version": "0.3.0",\n  "name": "slideless",\n  "version": "0.3.0"\n}\n`
    );
    git('commit', '-q', '-am', 'a duplicate key');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('expected exactly one top-level line');
    expect(version('apps/server/package.json')).toBe('0.3.0');
    expect(git('status', '--porcelain')).toBe('');
    expect(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v0.3.1'], { cwd: root }).status
    ).not.toBe(0);
  });

  it('writes nothing on --dry-run', () => {
    const r = run('patch', '--dry-run');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('0.3.0 → 0.3.1');
    expect(version('package.json')).toBe('0.3.0');
    expect(
      spawnSync('git', ['rev-parse', '-q', '--verify', 'refs/tags/v0.3.1'], { cwd: root }).status
    ).not.toBe(0);
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v0.3.0^{commit}'));
  });

  it('pushes dev and the tag on --push, and prints the promotion alone', () => {
    withOrigin();
    const r = run('patch', '--push');
    expect(r.status, r.stderr).toBe(0);
    expect(gitIn(origin, 'rev-parse', 'refs/heads/dev')).toBe(git('rev-parse', 'HEAD'));
    expect(gitIn(origin, 'rev-parse', 'v0.3.1^{commit}')).toBe(git('rev-parse', 'HEAD'));
    expect(r.stdout).toContain('next:\n  git push origin origin/dev:refs/heads/prod');
    expect(r.stdout).not.toContain('git push origin dev v0.3.1');
  });

  it('refuses a dirty tree', () => {
    writeFileSync(join(root, 'package.json'), readFileSync(join(root, 'package.json'), 'utf8') + '\n');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not clean');
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v0.3.0^{commit}'));
  });

  it('is not blocked by an untracked file: it never reaches the release commit', () => {
    writeFileSync(join(root, 'scratch.txt'), 'leftover\n');
    const r = run('patch');
    expect(r.status, r.stderr).toBe(0);
    expect(git('show', '--stat', '--format=', 'HEAD')).not.toContain('scratch.txt');
    expect(git('status', '--porcelain')).toBe('?? scratch.txt');
  });

  it('refuses a branch other than dev', () => {
    git('checkout', '-q', '-b', 'lane/something');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('releases are cut on dev');
    expect(version('package.json')).toBe('0.3.0');
  });

  it('refuses disagreeing package files instead of guessing', () => {
    writeVersionFiles('0.3.0', '0.2.9');
    git('commit', '-q', '-am', 'half a bump');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('disagree');
  });

  it('refuses a tag that already exists locally', () => {
    git('tag', 'v0.3.1', 'HEAD');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v0.3.1 already exists locally');
    expect(version('package.json')).toBe('0.3.0');
  });

  it('refuses a tag that already exists on origin, cut from another machine', () => {
    withOrigin();
    git('tag', 'v0.3.1', 'HEAD');
    git('push', '-q', 'origin', 'v0.3.1');
    git('tag', '-d', 'v0.3.1');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v0.3.1 already exists on origin');
    expect(version('package.json')).toBe('0.3.0');
  });

  it('refuses an unknown kind, an unknown option, and a flag where the title should be', () => {
    expect(run('bump').status).toBe(1);
    expect(run('patch', '--yolo').status).toBe(1);
    const r = run('patch', '--title', '--push');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('--title needs a value');
    expect(version('package.json')).toBe('0.3.0');
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v0.3.0^{commit}'));
  });
});

describe('release guard (what release.yml runs first on every push)', () => {
  it('passes when the version tag points at HEAD: this is the release', () => {
    const r = run('guard');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('points at HEAD');
  });

  it('FAILS on the forgotten bump: the version already carries a tag on another commit', () => {
    writeFileSync(join(root, 'README.md'), 'a week of real work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: something users see');
    const r = run('guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('0.3.0 is already released');
    expect(r.stderr).toContain('pnpm release');
  });

  it('passes when the version moved and carries no tag yet', () => {
    writeVersionFiles('0.4.0');
    git('commit', '-q', '-am', 'chore(release): slideless 0.4.0');
    const r = run('guard');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('no tag yet');
  });

  it('passes right after pnpm release, and fails again on the next untagged commit', () => {
    expect(run('patch').status).toBe(0);
    expect(run('guard').status).toBe(0);
    writeFileSync(join(root, 'README.md'), 'more work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'fix: something');
    expect(run('guard').status).toBe(1);
  });

  it('fails on disagreeing package files, the half-bump', () => {
    writeVersionFiles('0.4.0', '0.3.0');
    git('commit', '-q', '-am', 'half a bump');
    const r = run('guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('disagree');
  });

  it('FAILS on the forgotten bump from a shallow clone, the CI checkout shape: it asks origin', () => {
    writeFileSync(join(root, 'README.md'), 'a week of real work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: something users see');
    withOrigin();
    const shallow = cloneOrigin('--depth', '1');
    expect(gitIn(shallow, 'tag')).toBe(''); // the clone holds no tag at all
    const r = runIn(shallow, 'guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v0.3.0 on origin points at');
    rmSync(shallow, { recursive: true, force: true });
  });

  it('FAILS on the forgotten bump from a --no-tags clone: the tag lives on origin only', () => {
    writeFileSync(join(root, 'README.md'), 'a week of real work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: something users see');
    withOrigin();
    const clone = cloneOrigin('--no-tags');
    expect(gitIn(clone, 'tag')).toBe('');
    const r = runIn(clone, 'guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('0.3.0 is already released');
    rmSync(clone, { recursive: true, force: true });
  });

  it('passes from a shallow clone when the tag on origin points at HEAD', () => {
    withOrigin();
    const shallow = cloneOrigin('--depth', '1');
    const r = runIn(shallow, 'guard');
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('v0.3.0 on origin points at HEAD');
    rmSync(shallow, { recursive: true, force: true });
  });

  it('refuses to answer from a shallow checkout that has no origin to ask', () => {
    withOrigin();
    const shallow = cloneOrigin('--depth', '1');
    gitIn(shallow, 'remote', 'remove', 'origin');
    const r = runIn(shallow, 'guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('cannot verify');
    rmSync(shallow, { recursive: true, force: true });
  });

  it('FAILS on a release cut here and not pushed: the tag lives in this checkout only, origin has nothing', () => {
    withOrigin();
    expect(run('patch').status).toBe(0); // v0.3.1 made locally, no --push
    git('push', '-q', 'origin', 'dev'); // the branch pushed, the tag forgotten
    writeFileSync(join(root, 'README.md'), 'a week of real work\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'feat: something users see');
    expect(gitIn(origin, 'tag')).toBe('v0.3.0'); // origin never saw v0.3.1
    const r = run('guard');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v0.3.1 on this checkout points at');
  });

  it('takes no options', () => {
    const r = run('guard', '--dry-run');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('guard takes no options');
  });
});

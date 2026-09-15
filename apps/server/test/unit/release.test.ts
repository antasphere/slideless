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
 * files, a `dev` branch, an annotated tag on the last release.
 *
 * The contract pinned here:
 *   - a bump moves BOTH package files together, commits with the release
 *     subject and makes an ANNOTATED tag on that commit, leaving the tree
 *     clean; the file formatting survives byte for byte;
 *   - it refuses a dirty tree, a branch other than dev, disagreeing package
 *     files, a tag that already exists, and it writes nothing on --dry-run;
 *   - the guard (what release.yml runs first) FAILS when the package version
 *     already carries a v-tag on another commit — the forgotten bump — and
 *     passes both when the tag points at HEAD and when the version has no
 *     tag at all. A guard that never fires is the silent failure this pins.
 */
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const script = join(repoRoot, 'scripts', 'release.mjs');

let root: string;

function git(...args: string[]) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
function run(...args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' });
}
function writeVersionFiles(rootVersion: string, serverVersion: string = rootVersion) {
  // Deliberately distinct shapes: the rewrite must touch the version line only.
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
function version(file: string) {
  return (JSON.parse(readFileSync(join(root, file), 'utf8')) as { version: string }).version;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'slideless-release-'));
  git('init', '-q', '-b', 'dev');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'tag.gpgsign', 'false');
  writeVersionFiles('0.3.0');
  git('add', '-A');
  git('commit', '-q', '-m', 'chore(release): slideless 0.3.0');
  git('tag', '-a', 'v0.3.0', '-m', 'chore(release): slideless 0.3.0');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

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

  it('refuses a dirty tree', () => {
    writeFileSync(join(root, 'package.json'), readFileSync(join(root, 'package.json'), 'utf8') + '\n');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not clean');
    expect(git('rev-parse', 'HEAD')).toBe(git('rev-parse', 'v0.3.0^{commit}'));
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

  it('refuses a tag that already exists', () => {
    git('tag', 'v0.3.1', 'HEAD');
    const r = run('patch');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('v0.3.1 already exists');
    expect(version('package.json')).toBe('0.3.0');
  });

  it('refuses an unknown kind and an unknown option', () => {
    expect(run('bump').status).toBe(1);
    expect(run('patch', '--yolo').status).toBe(1);
    expect(version('package.json')).toBe('0.3.0');
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
});

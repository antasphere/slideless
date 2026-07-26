import { describe, expect, it } from 'vitest';
import {
  assetPathSchema,
  isSafeAssetPath,
  isTraversalSafeAssetPath,
  manifestEntrySchema,
  uploadSessionCommitSchema,
  versionCommitSchema
} from '../src/index.js';

/**
 * Manifest paths are what `slideless pull` writes onto a developer's disk.
 * Everything here is a path that used to be LEGAL at commit and would then
 * be materialized locally by a pull into `.` (PRDCT-1353 / CLI-1).
 */

const SHA = 'a'.repeat(64);
const entry = (path: string) => ({ path, sha256: SHA, sizeBytes: 1, contentType: 'text/plain' });

describe('assetPathSchema', () => {
  it('keeps accepting ordinary deck paths', () => {
    for (const ok of ['index.html', 'assets/style.css', 'a/b/c/deep.png', 'AGENT.md', 'my file.html']) {
      expect(assetPathSchema.safeParse(ok).success, ok).toBe(true);
      expect(isSafeAssetPath(ok), ok).toBe(true);
    }
  });

  it('refuses traversal and absolute paths', () => {
    for (const bad of ['../x.html', 'a/../../x', '/etc/passwd', 'a\\b', './x', 'a//b', '']) {
      expect(assetPathSchema.safeParse(bad).success, bad).toBe(false);
      expect(isSafeAssetPath(bad), bad).toBe(false);
    }
  });

  it('refuses dot-prefixed segments — the "write it and something runs it" paths', () => {
    for (const bad of [
      '.git/hooks/pre-commit',
      '.git/config',
      '.env',
      '.npmrc',
      '.envrc',
      '.github/workflows/ci.yml',
      'sub/.git/hooks/pre-commit',
      'sub/.env'
    ]) {
      expect(assetPathSchema.safeParse(bad).success, bad).toBe(false);
      expect(isSafeAssetPath(bad), bad).toBe(false);
    }
  });

  it('refuses package.json and the lockfiles, case-insensitively', () => {
    for (const bad of [
      'package.json',
      'Package.JSON',
      'sub/package.json',
      'package-lock.json',
      'pnpm-lock.yaml',
      'yarn.lock',
      'bun.lockb'
    ]) {
      expect(assetPathSchema.safeParse(bad).success, bad).toBe(false);
      expect(isSafeAssetPath(bad), bad).toBe(false);
    }
  });

  it('separates the traversal rule from the name rule', () => {
    // The viewer only asks "could this escape?" — it looks paths up in the
    // manifest, so an already-committed dotfile must still resolve there.
    expect(isTraversalSafeAssetPath('.git/config')).toBe(true);
    expect(isTraversalSafeAssetPath('../x')).toBe(false);
  });
});

describe('commit refuses a crafted manifest', () => {
  const base = { expectedBaseVersion: 0, entryPath: 'index.html' };

  it.each([['../evil.html'], ['.git/hooks/pre-commit'], ['package.json'], ['.env']])(
    'version commit rejects %s',
    (path) => {
      const parsed = versionCommitSchema.safeParse({
        ...base,
        manifest: [entry('index.html'), entry(path)]
      });
      expect(parsed.success).toBe(false);
    }
  );

  it.each([['../evil.html'], ['.git/hooks/pre-commit'], ['package.json'], ['.env']])(
    'upload-session commit rejects %s',
    (path) => {
      const parsed = uploadSessionCommitSchema.safeParse({
        title: 'Deck',
        entryPath: 'index.html',
        manifest: [entry('index.html'), entry(path)]
      });
      expect(parsed.success).toBe(false);
    }
  );

  it('rejects a hostile entryPath too', () => {
    expect(
      versionCommitSchema.safeParse({ ...base, entryPath: '.git/config', manifest: [entry('index.html')] })
        .success
    ).toBe(false);
  });

  it('still accepts a clean manifest', () => {
    expect(
      versionCommitSchema.safeParse({
        ...base,
        manifest: [entry('index.html'), entry('assets/app.js')]
      }).success
    ).toBe(true);
    expect(manifestEntrySchema.safeParse(entry('index.html')).success).toBe(true);
  });
});

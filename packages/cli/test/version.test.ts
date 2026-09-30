import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * ONE version per tool (2026-09-30): the npm CLI is released with the app, at
 * the app's number, never on a series of its own. The root package.json is the
 * canonical version; `pnpm release` moves this package and the `VERSION`
 * constant the binary reports together with it, and publish-cli.yml publishes
 * this package after release.yml succeeds on prod. A CLI left behind the app
 * (the 0.4.1 that sat on npm while the app shipped 0.13.0) goes red here, in
 * the checks job, long before any release.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const versionOf = (rel: string) => (JSON.parse(read(rel)) as { version: string }).version;

describe('the CLI version is the app version', () => {
  it('packages/cli/package.json carries the root version', () => {
    expect(versionOf('../package.json')).toBe(versionOf('../../../package.json'));
  });

  it('the VERSION constant the binary reports is the package version', () => {
    const matches = [...read('../src/index.ts').matchAll(/^const VERSION = '([^']*)';$/gm)];
    expect(matches).toHaveLength(1);
    expect(matches[0]![1]).toBe(versionOf('../package.json'));
  });
});

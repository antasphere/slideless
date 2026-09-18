import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * One license, stated the same way everywhere (PRDCT-1350). The root LICENSE
 * is the only source; `prepack` copies it over this package's copy so the npm
 * tarball ships it, and this test keeps the committed copy from drifting.
 */
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('the CLI package license', () => {
  it('ships a LICENSE byte-identical to the repository root', () => {
    expect(read('../LICENSE')).toBe(read('../../../LICENSE'));
  });

  it('declares the non-SPDX form npm sanctions and publishes the file', () => {
    const pkg = JSON.parse(read('../package.json')) as { license: string; files: string[] };
    expect(pkg.license).toBe('SEE LICENSE IN LICENSE');
    expect(pkg.files).toContain('LICENSE');
  });
});

import { describe, expect, it } from 'vitest';
import { DEFAULT_DOWNLOAD_TIMEOUT_MS, DEFAULT_TIMEOUT_MS } from '../src/index.js';

/**
 * The public surface of `@slideless/sdk`, as literals (PRDCT-2530, verifier
 * F-5 / M19). Its generic half is an explicit re-export list over
 * `@antasphere/chassis-sdk`, and a name trimmed from a list is invisible next
 * to no declaration. The RUNTIME names are pinned here; the TYPE names are
 * pinned by `exports.types.ts`, which `typecheck` compiles.
 */
describe('@slideless/sdk public surface', () => {
  it('exports exactly these runtime names', async () => {
    expect(Object.keys(await import('../src/index.js')).sort()).toEqual([
      'DEFAULT_DOWNLOAD_TIMEOUT_MS',
      'DEFAULT_TIMEOUT_MS',
      'PlatformApiError',
      'PlatformClient'
    ]);
  });

  it('keeps the default deadlines: 30 s a request, 10 min a download', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(30_000);
    expect(DEFAULT_DOWNLOAD_TIMEOUT_MS).toBe(600_000);
  });
});

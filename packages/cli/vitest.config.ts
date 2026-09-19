import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * This package's own tests, plus the CHASSIS SUITE
 * (`packages/chassis-cli/test/suite`) a second time, against the real
 * Slideless kit. The suite imports its host from `@chassis-cli-test/host`;
 * here that is `test/chassis-host.ts` (the chassis package aliases it to its
 * minimal `things` tool). Everything under `@antasphere/chassis-cli` resolves
 * to the BUILT package in this run, for the suite and for `src/` alike: one
 * loaded copy of the stateful modules.
 */
export default defineConfig({
  resolve: {
    alias: [{ find: '@chassis-cli-test/host', replacement: at('./test/chassis-host.ts') }]
  },
  test: {
    include: ['test/**/*.test.ts', '../chassis-cli/test/suite/**/*.test.ts']
  }
});

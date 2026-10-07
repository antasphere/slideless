import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The installed chassis CLI: its dist entry, two levels up, the real path in pnpm's store.
const chassis = realpathSync(
  dirname(dirname(createRequire(import.meta.url).resolve('@antasphere/chassis-cli')))
);
const suite = join(chassis, 'test/suite');
// A suite that moved or emptied would leave this run green on the app's files alone: refuse it.
if (!existsSync(suite) || !readdirSync(suite).some((file) => file.endsWith('.test.ts'))) {
  throw new Error(`${suite} holds no *.test.ts: the installed chassis no longer ships its suite there`);
}

/**
 * This package's own tests, plus the CHASSIS SUITE
 * (`@antasphere/chassis-cli/test/suite`, shipped in the installed package) a
 * second time, against the real Slideless kit. The suite imports its host from
 * `@chassis-cli-test/host`; here that is `test/chassis-host.ts` (the chassis
 * repository aliases it to its minimal `things` tool). Everything under
 * `@antasphere/chassis-cli` resolves to the BUILT package in this run, for the
 * suite and for `src/` alike: one loaded copy of the stateful modules. The
 * package sits under node_modules, which vitest leaves to Node by default:
 * `server.deps.inline` has vitest transform it, as it did the workspace copy.
 */
export default defineConfig({
  resolve: {
    alias: [{ find: '@chassis-cli-test/host', replacement: at('./test/chassis-host.ts') }]
  },
  server: {
    deps: {
      inline: [
        /node_modules\/(\.pnpm\/@antasphere\+chassis-cli@[^/]+\/node_modules\/)?@antasphere\/chassis-cli\//
      ]
    }
  },
  test: {
    include: ['test/**/*.test.ts', `${suite}/**/*.test.ts`]
  }
});

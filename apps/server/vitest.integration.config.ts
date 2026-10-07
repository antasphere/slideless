import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The installed chassis server: its dist entry, two levels up, the real path in pnpm's store.
const chassis = realpathSync(
  dirname(dirname(createRequire(import.meta.url).resolve('@antasphere/chassis-server')))
);
const suite = join(chassis, 'test/integration');

/**
 * The integration run: this app's own files, plus the CHASSIS SUITE
 * (`@antasphere/chassis-server/test/integration`, shipped in the installed
 * package) a second time, against the real Slideless composition. The suite
 * imports its host from `@chassis-test/host`; here that is
 * `test/integration/chassis-host.ts` (the chassis repository aliases it to its
 * minimal test tool). `empty-tool.test.ts`, `entitlements-null-hook.test.ts`
 * and `timers.test.ts` carry their own tool and belong to the chassis run only.
 * The package sits under node_modules, which vitest leaves to Node by default:
 * `server.deps.inline` has vitest transform it, so the suite's relative imports
 * of the package's TypeScript `src` load.
 */
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [{ find: '@chassis-test/host', replacement: at('./test/integration/chassis-host.ts') }]
    },
    server: {
      deps: {
        inline: [
          /node_modules\/(\.pnpm\/@antasphere\+chassis-server@[^/]+\/node_modules\/)?@antasphere\/chassis-server\//
        ]
      }
    },
    test: {
      include: ['test/integration/**/*.test.ts', `${suite}/**/*.test.ts`],
      exclude: [
        `${suite}/empty-tool.test.ts`,
        `${suite}/entitlements-null-hook.test.ts`,
        `${suite}/timers.test.ts`
      ]
    }
  })
);

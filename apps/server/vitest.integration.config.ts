import { fileURLToPath } from 'node:url';
import { defineConfig, mergeConfig } from 'vitest/config';
import base from './vitest.config.js';

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The integration run: this app's own files, plus the CHASSIS SUITE
 * (`packages/chassis-server/test/integration`) a second time, against the real
 * Slideless composition. The suite imports its host from `@chassis-test/host`;
 * here that is `test/integration/chassis-host.ts` (the chassis package aliases
 * it to its minimal test tool). `empty-tool.test.ts` carries its own tool and
 * belongs to the chassis run only.
 */
export default mergeConfig(
  base,
  defineConfig({
    resolve: {
      alias: [{ find: '@chassis-test/host', replacement: at('./test/integration/chassis-host.ts') }]
    },
    test: {
      include: [
        'test/integration/**/*.test.ts',
        '../../packages/chassis-server/test/integration/**/*.test.ts'
      ],
      exclude: ['**/node_modules/**', '../../packages/chassis-server/test/integration/empty-tool.test.ts']
    }
  })
);

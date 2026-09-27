import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', selfcheck: 'src/selfcheck.ts', healthcheck: 'src/healthcheck.ts' },
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Never bundle runtime deps: playwright-core resolves its browsers and its
  // driver by path at runtime. The runtime node_modules ships via `pnpm
  // deploy` in the Docker build.
  bundle: true,
  external: [/^[^./]/]
});

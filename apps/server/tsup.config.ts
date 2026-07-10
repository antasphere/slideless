import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  target: 'node22',
  sourcemap: true,
  clean: true,
  // Never bundle runtime deps: pino resolves transport workers by path at
  // runtime and pg/pg-boss carry dynamic requires — bundling breaks them.
  // The runtime node_modules ships via `pnpm deploy` in the Docker build.
  bundle: true,
  external: [/^[^./]/]
});

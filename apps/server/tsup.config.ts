import { defineConfig } from 'tsup';

export default defineConfig({
  // The server, and the still-image self-check the image and CI run
  // (`node dist/thumbnail-selfcheck.js`, PRDCT-2725).
  entry: { index: 'src/index.ts', 'thumbnail-selfcheck': 'src/thumbnails/selfcheck.ts' },
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

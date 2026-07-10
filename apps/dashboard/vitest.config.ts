import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

// Unit tests only — e2e/ belongs to Playwright (pnpm test:e2e). The svelte
// plugin + browser condition compile the `.svelte.ts` runes modules; the
// $lib alias mirrors SvelteKit's (plain vitest doesn't know it).
export default defineConfig({
  plugins: [svelte()],
  resolve: {
    conditions: ['browser'],
    alias: { $lib: fileURLToPath(new URL('./src/lib', import.meta.url)) }
  },
  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    passWithNoTests: true
  }
});

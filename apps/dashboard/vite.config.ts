import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()],
  ssr: {
    // @slideless/sdk and @slideless/contract are internal workspace packages —
    // bundle them (never externalize) in the SSR pass that renders the SPA
    // fallback shell, so the pre-rendered shell resolves them without a
    // separate runtime dependency.
    noExternal: ['@slideless/sdk', '@slideless/contract']
  },
  server: {
    // Dev-only: the SPA calls the API same-origin in production; in dev the
    // Hono server runs on :3000 and vite proxies to it.
    proxy: {
      '/api': 'http://localhost:3000',
      '/healthz': 'http://localhost:3000',
      '/readyz': 'http://localhost:3000'
    }
  }
});

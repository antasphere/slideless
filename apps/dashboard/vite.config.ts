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
    // Dev-only: the SPA calls the API same-origin in production; in dev
    // vite proxies to the API origin. Override with DEV_API_ORIGIN when the
    // stack is not on :3000 (e.g. the compose stack publishes :3100).
    proxy: {
      '/api': process.env.DEV_API_ORIGIN ?? 'http://localhost:3000',
      '/healthz': process.env.DEV_API_ORIGIN ?? 'http://localhost:3000',
      '/readyz': process.env.DEV_API_ORIGIN ?? 'http://localhost:3000'
    }
  }
});

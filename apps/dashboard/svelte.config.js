import adapter from '@sveltejs/adapter-static';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  kit: {
    // Pure SPA: one index.html fallback, served by the Hono server. The build
    // lands in the server's public/ so the single image carries the dashboard.
    adapter: adapter({
      pages: '../server/public',
      assets: '../server/public',
      fallback: 'index.html',
      strict: false
    })
  }
};

export default config;

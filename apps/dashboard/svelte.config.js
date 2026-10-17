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
      // A .br and a .gz sibling beside every asset: the server serves them
      // in place of the file when the browser accepts the encoding, and
      // compresses nothing at runtime (PRDCT-3584).
      precompress: true,
      strict: false
    })
  }
};

export default config;

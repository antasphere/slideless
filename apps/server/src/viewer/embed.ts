import { createHash } from 'node:crypto';
import { Hono } from 'hono';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';

/**
 * The official embed loader (PRDCT-1312): `GET /embed.js`, served anonymous
 * and cache-friendly from the viewer surface. A customer pastes
 *
 *   <script src="https://<instance>/embed.js" async></script>
 *   <div data-slideless-embed="https://<instance>/v/{secret}/"></div>
 *
 * into their own site and the loader replaces each such div with the ADR 012
 * Surface D iframe — the SAME sandbox attribute set as the dashboard preview,
 * templated in from the contract constant so the loader can never drift from
 * the blessed set (embed.test.ts additionally pins the served bytes).
 *
 * Safety posture, inherited rather than invented: the deck bytes were always
 * frameable (VIEWER_CSP carries no frame-ancestors — ADR 021 records that as
 * deliberate), and the iframe sandbox reproduces the opaque-origin isolation
 * plus blocks framebusting and parent access on the EMBEDDING page's side.
 * The loader itself touches only elements the embedding author explicitly
 * marked, validates the URL shape before using it, and never throws — a bad
 * embed div degrades to nothing, not to a broken host page.
 */

export const EMBED_JS_PATH = '/embed.js';

/**
 * Vanilla, framework-free, ~2 KiB. Behavior contract (documented in
 * docs/sharing/embedding.md, exercised by the embed e2e spec):
 *
 *  - runs on DOMContentLoaded, or immediately when the document is already
 *    parsed (the snippet loads with `async`);
 *  - processes every `div[data-slideless-embed]` exactly once — a re-run of
 *    the whole script (double paste, SPA re-injection) never double-mounts;
 *  - accepts only http(s) URLs whose path is the viewer shape /v/{secret}/
 *    (a missing trailing slash is normalized, matching the server's 301);
 *  - appends `data-slideless-placement` as the `?p=` analytics label
 *    (sanitized server-side, sharing/view-events.ts);
 *  - sizes responsively: width 100% + CSS aspect-ratio from
 *    `data-aspect-ratio` ("16/9" default; invalid values fall back);
 *  - an invalid URL logs a console.warn and leaves the div untouched.
 */
export const EMBED_JS_SOURCE = `/* Slideless official embed loader — https://github.com/antasphere/slideless */
(function () {
  'use strict';
  var SANDBOX = '${VIEWER_IFRAME_SANDBOX}';
  var VIEWER_PATH = /^\\/v\\/[A-Za-z0-9_-]+\\/?$/;
  var RATIO = /^\\d{1,4}(\\.\\d+)?\\s*\\/\\s*\\d{1,4}(\\.\\d+)?$/;

  function viewerUrl(raw) {
    var url;
    try { url = new URL(raw); } catch (e) { return null; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (!VIEWER_PATH.test(url.pathname)) return null;
    if (url.pathname.charAt(url.pathname.length - 1) !== '/') url.pathname += '/';
    return url;
  }

  function mount(el) {
    if (el.getAttribute('data-slideless-ready') === '1') return;
    var url = viewerUrl(el.getAttribute('data-slideless-embed') || '');
    if (!url) {
      if (window.console && console.warn) {
        console.warn('[slideless-embed] not a viewer URL, element left untouched:', el);
      }
      return;
    }
    var placement = el.getAttribute('data-slideless-placement');
    if (placement) url.searchParams.set('p', placement);
    var ratio = el.getAttribute('data-aspect-ratio');
    var frame = document.createElement('iframe');
    frame.setAttribute('sandbox', SANDBOX);
    frame.setAttribute('referrerpolicy', 'no-referrer');
    frame.setAttribute('allow', 'fullscreen');
    frame.setAttribute('loading', 'lazy');
    frame.setAttribute('title', 'Slideless presentation');
    frame.src = url.href;
    frame.style.width = '100%';
    frame.style.aspectRatio = ratio && RATIO.test(ratio) ? ratio : '16/9';
    frame.style.border = '0';
    frame.style.display = 'block';
    el.setAttribute('data-slideless-ready', '1');
    el.textContent = '';
    el.appendChild(frame);
  }

  function mountAll() {
    var els = document.querySelectorAll('div[data-slideless-embed]');
    for (var i = 0; i < els.length; i++) {
      try { mount(els[i]); } catch (e) { /* one bad embed never breaks the host page */ }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
`;

/** Strong ETag over the exact bytes — the file only changes at release. */
const EMBED_JS_ETAG = `"${createHash('sha256').update(EMBED_JS_SOURCE).digest('hex').slice(0, 32)}"`;

const EMBED_JS_HEADERS: Readonly<Record<string, string>> = {
  'content-type': 'text/javascript; charset=utf-8',
  'x-content-type-options': 'nosniff',
  // Cross-site <script src> needs no CORS; an hour of shared caching keeps
  // the loader cheap while release upgrades still land the same day.
  'cache-control': 'public, max-age=3600',
  etag: EMBED_JS_ETAG
};

/** No auth, no principal, no cookies — the loader is public static bytes. */
export function embedRoutes(): Hono {
  const app = new Hono();
  app.on(['GET', 'HEAD'], EMBED_JS_PATH, (c) => {
    if (c.req.header('if-none-match') === EMBED_JS_ETAG) {
      return c.body(null, 304, { etag: EMBED_JS_ETAG, 'cache-control': EMBED_JS_HEADERS['cache-control']! });
    }
    return c.req.method === 'HEAD'
      ? c.body(null, 200, { ...EMBED_JS_HEADERS })
      : c.body(EMBED_JS_SOURCE, 200, { ...EMBED_JS_HEADERS });
  });
  return app;
}

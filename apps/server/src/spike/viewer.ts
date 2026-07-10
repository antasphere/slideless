import { Hono } from 'hono';

/**
 * THROWAWAY SPIKE (branch spike/viewer-origin) — viewer-origin security probe.
 *
 * Serves a deliberately HOSTILE user-authored deck on the APP ORIGIN under
 * `Content-Security-Policy: sandbox ...` and reports, from inside the browser,
 * whether the sandboxed opaque origin denies it access to the app's session
 * cookie, credentialed same-origin API, storage, service workers, and the top
 * frame. Three surfaces:
 *
 *   GET /spike/viewer/deck    — hostile deck under `CSP: sandbox <tokens>`
 *                               (?tokens=… to vary the sandbox allow-list;
 *                                ?ctx=iframe when embedded)
 *   GET /spike/viewer/control — SAME hostile deck with NO sandbox (permissive
 *                               CSP) = the danger baseline the sandbox must beat
 *   GET /spike/viewer/framed  — a normal app page that embeds the deck inside an
 *                               iframe with the `sandbox` attribute (the
 *                               dashboard-preview defense-in-depth case)
 *   GET /spike/viewer/sw.js   — a trivial service worker script to register
 *
 * NOT for dev/prod. Delete with the branch.
 */

const DEFAULT_TOKENS = 'allow-scripts allow-forms allow-popups';

/**
 * The hostile deck body. `ctx` is 'top' | 'iframe' | 'control' — purely a label
 * threaded into the report so the evidence names which surface produced it.
 */
function deckHtml(ctx: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>hostile-deck</title>
<style>body{font:14px/1.4 ui-monospace,monospace;margin:1rem;background:#111;color:#eee}
h1{font-size:15px}pre{white-space:pre-wrap;word-break:break-all;background:#000;padding:1rem;border:1px solid #333}
.pass{color:#5f5}.fail{color:#f66}</style>
</head>
<body>
<h1>Hostile deck — surface: <b id="ctx"></b></h1>
<pre id="out">running…</pre>
<script>
(function(){
  var results = { ctx: ${JSON.stringify(ctx)} };
  document.getElementById('ctx').textContent = results.ctx;

  function safe(label, fn){ try { results[label] = fn(); } catch(e){ results[label] = 'THROW:'+e.name+':'+e.message; } }

  // Context.
  safe('href', function(){ return location.href; });
  safe('origin', function(){ return location.origin; });     // "null" for an opaque origin
  safe('isSecureContext', function(){ return self.isSecureContext; });
  safe('framed', function(){ return window.top !== window.self; });

  // (1) read the app's cookies (session-theft vector #1).
  safe('cookieRead', function(){ return JSON.stringify(document.cookie); });
  // (6) set a cookie.
  safe('cookieWrite', function(){ document.cookie = 'spike_probe=1; path=/'; return 'set; readback='+JSON.stringify(document.cookie); });

  // (2) localStorage / sessionStorage of the app origin.
  safe('localStorage', function(){ localStorage.setItem('spike','1'); return 'ok:'+localStorage.getItem('spike'); });
  safe('sessionStorage', function(){ sessionStorage.setItem('spike','1'); return 'ok:'+sessionStorage.getItem('spike'); });

  // parent / top access (meaningful when framed).
  if (results.framed) {
    safe('topLocationHref', function(){ return window.top.location.href; });
    safe('parentDocument', function(){ return String(window.parent.document.title); });
  }

  function render(done){
    var pre = document.getElementById('out');
    pre.textContent = JSON.stringify(results, null, 2);
    for (var k in results){ if(Object.prototype.hasOwnProperty.call(results,k)){
      var v = results[k]; console.log('[SPIKE]', k, typeof v === 'object' ? JSON.stringify(v) : String(v));
    }}
    if (done){ document.documentElement.setAttribute('data-done','1'); console.log('[SPIKE] DONE'); }
  }
  render(false);

  // Async probes. Each is independently guarded so one synchronous throw (an
  // opaque origin throws on navigator.serviceWorker access, not via a rejected
  // promise) can never stall the others, and a hard safety-flush guarantees the
  // done sentinel + full render fire regardless.
  var finished = false;
  function flush(){ if (!finished){ finished = true; render(true); } }

  // (3) credentialed same-origin API call (session-theft vector #2 — the real one).
  (function(){
    try {
      fetch('/api/v1/me', { credentials: 'include' }).then(function(r){
        return r.text().then(function(body){
          results.fetchMe = { status: r.status, type: r.type, ok: r.ok, body: body.slice(0, 400) };
        }, function(e){ results.fetchMe = { status: r.status, type: r.type, ok: r.ok, bodyError: e.name }; });
      }).catch(function(e){
        results.fetchMe = { error: e.name + ':' + e.message };
      });
    } catch(e){ results.fetchMe = { syncThrow: e.name + ':' + e.message }; }
  })();

  // (4) service worker registration (opaque origins throw SYNCHRONOUSLY here).
  (function(){
    try {
      if (!('serviceWorker' in navigator)) { results.serviceWorker = 'no-api'; return; }
      navigator.serviceWorker.register('/spike/viewer/sw.js').then(function(reg){
        results.serviceWorker = 'REGISTERED scope=' + (reg && reg.scope);
      }, function(e){ results.serviceWorker = 'THROW:' + e.name + ':' + e.message; });
    } catch(e){ results.serviceWorker = 'SYNC-THROW:' + e.name + ':' + e.message; }
  })();

  // (5) top-frame navigation attempt — only when framed.
  if (results.framed) {
    try { window.top.location.href = '/spike/viewer/PWNED-TOPNAV'; results.topNav = 'ATTEMPTED-NO-THROW'; }
    catch(e){ results.topNav = 'THROW:' + e.name + ':' + e.message; }
  }

  // Flush once probes have had time to settle (fetch + SW are the only async
  // ones; 1500ms is ample on localhost). A second flush re-renders late arrivals.
  setTimeout(function(){ render(false); }, 800);
  setTimeout(flush, 1500);
})();
</script>
</body>
</html>`;
}

const HEADERS_COMMON = {
  'content-type': 'text/html; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
} as const;

export function viewerSpikeApp(): Hono {
  const app = new Hono();

  // The real deal: hostile deck served under a sandboxing CSP on the app origin.
  app.get('/spike/viewer/deck', (c) => {
    const tokens = c.req.query('tokens') ?? DEFAULT_TOKENS;
    const ctx = c.req.query('ctx') ?? 'top';
    const csp = `sandbox ${tokens}`.trim();
    return new Response(deckHtml(ctx), {
      status: 200,
      headers: { ...HEADERS_COMMON, 'content-security-policy': csp }
    });
  });

  // Danger baseline: the SAME hostile deck with NO sandbox. Permissive CSP so
  // its inline script runs (models a naive product rendering user HTML inline
  // on the app origin). This SHOULD leak the session — that is the point.
  app.get('/spike/viewer/control', (c) => {
    return new Response(deckHtml('control'), {
      status: 200,
      headers: {
        ...HEADERS_COMMON,
        'content-security-policy': "default-src * 'unsafe-inline' 'unsafe-eval' data: blob:"
      }
    });
  });

  // Defense-in-depth: a normal app page embedding the deck in a `sandbox`
  // iframe (what the dashboard preview will do). No CSP set here on purpose —
  // the global middleware stamps the dashboard CSP; it needs no inline script.
  app.get('/spike/viewer/framed', (c) => {
    const tokens = c.req.query('tokens') ?? 'allow-scripts';
    const src = `/spike/viewer/deck?ctx=iframe&tokens=${encodeURIComponent(tokens)}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" /><title>framed-preview</title></head>
<body><h1>Dashboard-preview simulation (iframe sandbox="${tokens}")</h1>
<iframe id="deck" title="deck" style="width:95vw;height:80vh;border:2px solid #555" sandbox="${tokens}" src="${src}"></iframe>
</body></html>`;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  });

  app.get('/spike/viewer/sw.js', () => {
    return new Response('/* spike service worker */\nself.addEventListener("install", function(){});\n', {
      status: 200,
      headers: { 'content-type': 'application/javascript; charset=utf-8' }
    });
  });

  return app;
}

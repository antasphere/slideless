/**
 * The annotation overlay client (Phase 5): a single self-contained inline
 * <script> injected into the ENTRY HTML for browser views of a token with
 * `can_annotate` (viewer/inject.ts). Vanilla JS + inline CSS, zero external
 * requests — the sandbox CSP allows scripts but the page must stay
 * self-sufficient, and an extra request would add an origin to reason about.
 *
 * TRUST BOUNDARY — the overlay shares the document with UNTRUSTED deck JS
 * inside the sandboxed OPAQUE origin (ADR 012). Consequences, by design:
 *
 *  - The deck's scripts can read/patch anything the overlay can (globals,
 *    fetch, the DOM, this script's text). The only "secret" the overlay
 *    holds is the share-token secret — which is ALREADY in location.pathname
 *    and therefore deck-readable regardless — plus, for password-protected
 *    tokens, a signed unlock proof scoped to annotation calls on this same
 *    token. Deck JS could always call the annotation API itself with those;
 *    the overlay adds NO capability the deck did not have. No session, no
 *    cookie, no principal credential ever exists in this document.
 *  - Requests go out `credentials: 'omit'` so even Firefox's opaque-origin
 *    cookie forwarding (ADR 012 residual risk 2) sends nothing.
 *  - The server treats every annotation write as hostile input regardless:
 *    token re-validation, zod body validation, size caps, and a rate limit
 *    (viewer/annotations-api.ts). A compromised overlay can spam only as
 *    far as the limiter allows, on this one deck, as this one token.
 *
 * The config JSON is server-controlled (version number + unlock MAC); it is
 * serialized with `<` escaped so a `</script>` sequence can never break out.
 */

export interface OverlayConfig {
  /** The deck version this view resolved to — what notes anchor against. */
  version: number;
  /** Signed unlock proof for password-protected tokens (else null). */
  unlock: string | null;
}

/** Attribute marking the injected script — tests and humans grep for it. */
export const OVERLAY_MARKER = 'data-slideless-annotate';

const OVERLAY_JS = String.raw`
var doc = document;
if (!doc || !doc.documentElement) return;
var fetchFn = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (!fetchFn) return;
var apiUrl;
try {
  var seg = location.pathname.split('/');
  if (seg[1] !== 'v' || !seg[2]) return;
  apiUrl = new URL('/api/v1/viewer/' + seg[2] + '/annotations', location.href).toString();
} catch (e) { return; }

function headers(json) {
  var h = {};
  if (json) h['content-type'] = 'application/json';
  if (CFG.unlock) h['x-slideless-unlock'] = CFG.unlock;
  return h;
}

var css = [
  '#__slideless_annotate{position:fixed;bottom:16px;right:16px;z-index:2147483646;',
  'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:13px;color:#18181b}',
  '#__slideless_annotate *{box-sizing:border-box}',
  '#__slideless_annotate .sa-btn{background:#18181b;color:#fff;border:0;border-radius:999px;',
  'padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25)}',
  '#__slideless_annotate .sa-panel{display:none;position:absolute;bottom:48px;right:0;width:300px;',
  'max-height:70vh;overflow:auto;background:#fff;border:1px solid #e4e4e7;border-radius:12px;',
  'box-shadow:0 8px 30px rgba(0,0,0,.18);padding:12px}',
  '#__slideless_annotate.sa-open .sa-panel{display:block}',
  '#__slideless_annotate .sa-list{margin:0 0 10px;padding:0;list-style:none}',
  '#__slideless_annotate .sa-list li{border-bottom:1px solid #f1f1f3;padding:6px 0;font-size:12px;line-height:1.4}',
  '#__slideless_annotate .sa-list .sa-meta{color:#a1a1aa;font-size:11px}',
  '#__slideless_annotate .sa-quote{background:#f4f4f5;border-left:3px solid #d4d4d8;padding:4px 8px;',
  'margin:0 0 8px;font-size:11px;color:#52525b;max-height:48px;overflow:hidden}',
  '#__slideless_annotate input,#__slideless_annotate textarea{width:100%;border:1px solid #d4d4d8;',
  'border-radius:8px;padding:6px 8px;font-size:12px;margin:0 0 8px;font-family:inherit}',
  '#__slideless_annotate textarea{min-height:56px;resize:vertical}',
  '#__slideless_annotate .sa-send{width:100%;background:#18181b;color:#fff;border:0;border-radius:8px;',
  'padding:8px;font-size:12px;font-weight:600;cursor:pointer}',
  '#__slideless_annotate .sa-status{font-size:11px;color:#a1a1aa;margin:6px 0 0;min-height:14px}'
].join('');

var root = doc.createElement('div');
root.id = '__slideless_annotate';
root.innerHTML =
  '<div class="sa-panel">' +
  '<ul class="sa-list"></ul>' +
  '<div class="sa-quote" hidden></div>' +
  '<input class="sa-name" maxlength="120" placeholder="Your name (optional)">' +
  '<textarea class="sa-note" maxlength="10000" placeholder="Leave a note on this version"></textarea>' +
  '<button type="button" class="sa-send">Add note</button>' +
  '<p class="sa-status"></p>' +
  '</div>' +
  '<button type="button" class="sa-btn">✎ Annotate</button>';
var style = doc.createElement('style');
style.textContent = css;

var selection = null;
var $ = function (sel) { return root.querySelector(sel); };

function esc(s) {
  return String(s).replace(/[&<>"]/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
  });
}

function renderList(items) {
  var list = $('.sa-list');
  if (!items.length) {
    list.innerHTML = '<li class="sa-meta">No notes yet — select text or just write one.</li>';
    return;
  }
  list.innerHTML = items.map(function (a) {
    var who = a.authorName ? esc(a.authorName) : 'Anonymous';
    var quote = a.selection && a.selection.quote ? '<div class="sa-meta">“' + esc(String(a.selection.quote).slice(0, 80)) + '”</div>' : '';
    return '<li>' + quote + esc(a.body) + '<div class="sa-meta">' + who + ' · ' + esc(a.status) + '</div></li>';
  }).join('');
}

function refresh() {
  fetchFn(apiUrl, { method: 'GET', headers: headers(false), credentials: 'omit', mode: 'cors', cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : { annotations: [] }; })
    .then(function (data) { renderList((data && data.annotations) || []); })
    .catch(function () { renderList([]); });
}

function setStatus(msg) { $('.sa-status').textContent = msg; }

function currentSelectionQuote() {
  try {
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel || sel.isCollapsed) return null;
    var text = String(sel.toString() || '').trim();
    if (!text) return null;
    return text.slice(0, 500);
  } catch (e) { return null; }
}

doc.addEventListener('mouseup', function (ev) {
  if (root.contains(ev.target)) return;
  var quote = currentSelectionQuote();
  if (quote) {
    selection = { type: 'text', quote: quote };
    var q = $('.sa-quote');
    q.hidden = false;
    q.textContent = '“' + quote.slice(0, 120) + '”';
  }
}, true);

$('.sa-btn').addEventListener('click', function () {
  var open = root.className.indexOf('sa-open') !== -1;
  root.className = open ? '' : 'sa-open';
  if (!open) refresh();
});

$('.sa-send').addEventListener('click', function () {
  var body = $('.sa-note').value.trim();
  if (!body) { setStatus('Write a note first.'); return; }
  var name = $('.sa-name').value.trim();
  var payload = { body: body, version: CFG.version, selection: selection || {} };
  if (name) payload.authorName = name;
  setStatus('Sending…');
  fetchFn(apiUrl, {
    method: 'POST',
    headers: headers(true),
    credentials: 'omit',
    mode: 'cors',
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (res.status === 201) {
      $('.sa-note').value = '';
      $('.sa-quote').hidden = true;
      selection = null;
      setStatus('Note saved.');
      refresh();
    } else if (res.status === 429) {
      setStatus('Slow down — too many notes.');
    } else {
      setStatus('Could not save the note.');
    }
  }).catch(function () { setStatus('Could not save the note.'); });
});

function mount() {
  if (!doc.body) return;
  doc.body.appendChild(style);
  doc.body.appendChild(root);
}
if (doc.readyState === 'loading') {
  doc.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
`;

/**
 * The full inline script tag to inject before `</body>`. The config is
 * embedded as escaped JSON; everything runs inside one IIFE so the deck's
 * global namespace is untouched (and vice versa, to the extent a shared
 * document allows — see the trust-boundary note above).
 */
export function overlayScriptTag(cfg: OverlayConfig): string {
  const json = JSON.stringify({ version: cfg.version, unlock: cfg.unlock }).replace(/</g, '\\u003c');
  return `\n<script ${OVERLAY_MARKER}>\n(function(){\n"use strict";\ntry{\nvar CFG=${json};\n${OVERLAY_JS}\n}catch(e){}\n})();\n</script>\n`;
}

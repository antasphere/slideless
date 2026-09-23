/**
 * The annotation overlay client (Phase 5, reworked for PRDCT-1241/1242/1296):
 * a single self-contained inline <script> injected into same-deck HTML
 * DOCUMENT NAVIGATIONS (entry and sub-pages alike — viewer/inject.ts) for
 * browser views of a token with `can_annotate`. Vanilla JS + inline CSS, zero
 * external requests — the sandbox CSP allows scripts but the page must stay
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
 *  - The overlay mounts ONLY in the top browsing context (`self === top`).
 *    Content inside nested sub-frames stays unannotatable until the frame
 *    participation protocol ships (PRDCT-1296 gap 2) — the anchor format
 *    already reserves a `frame` field for it.
 *
 * ANCHOR DESCRIPTOR v2 — what the overlay writes into `selection` (opaque
 * jsonb to the server; the contract schema stays `record(string, unknown)`):
 *
 *   { v: 2,
 *     type: 'text' | 'point' | 'region',
 *     page: 'index.html',                          // deck-relative document
 *     frame: null,                                 // reserved (sub-frames)
 *     quote?, context?: {before, after},           // text anchors
 *     selector?,                                   // bounded CSS path
 *     container?: {kind, index, heading},          // [data-slide]/[data-panel]
 *     point?: {nx, ny}, rect?: {nx, ny, nw, nh},   // normalized 0..1 in the
 *                                                  // selector element's box
 *     viewport: {w, h} }                           // capture-time context
 *
 * Resolution ladder on render/jump: selector hit → quote search (scoped to
 * container when present) → container → unanchored. Legacy v1 anchors
 * ({type:'text', quote}) resolve by quote search alone. Anchors are FROZEN
 * at capture time (pill shown / pin placed) and submitted verbatim — the
 * live selection is never re-read at submit (the PRDCT-1242 fix).
 *
 * The config JSON is server-controlled (version + unlock MAC + entry path);
 * it is serialized with `<` escaped so a `</script>` sequence can never
 * break out.
 */

import { MOTION_DURATION_MS, MOTION_EASING } from '@slideless/contract';

export interface OverlayConfig {
  /** The deck version this view resolved to — what notes anchor against. */
  version: number;
  /** Signed unlock proof for password-protected tokens (else null). */
  unlock: string | null;
  /** The deck's entry path — the canonical name of the root document. */
  entry: string;
  /**
   * Badge slot (token override ?? deck default; viewer/routes.ts resolves).
   * One of: top-left, top, top-right, right, bottom-right, bottom,
   * bottom-left, left. Null = bottom-right.
   */
  badge: string | null;
  /** When this share link was created (ISO) — settings-dialog metadata. */
  linkCreatedAt: string;
  /** When this share link expires (ISO), or null — settings-dialog metadata. */
  linkExpiresAt: string | null;
}

/** Attribute marking the injected script — tests and humans grep for it. */
export const OVERLAY_MARKER = 'data-slideless-annotate';

const OVERLAY_JS = String.raw`
var doc = document;
if (!doc || !doc.documentElement) return;
// Top browsing context only: nested frames wait for the participation
// protocol. Never mount twice (a deck could re-run injected scripts).
if (window.self !== window.top) return;
if (window.__slidelessAnnotateLoaded) return;
window.__slidelessAnnotateLoaded = true;
var fetchFn = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (!fetchFn) return;

// ---- URL model ---------------------------------------------------------
// The viewer serves the deck under /v/{secret}[/{path}]. The RAW (still
// percent-encoded) secret segment authenticates API calls and prefixes
// cross-page navigations; everything after it is the deck-relative path.
var rawSecret, apiUrl;
try {
  var seg = location.pathname.split('/');
  if (seg[1] !== 'v' || !seg[2]) return;
  rawSecret = seg[2];
  apiUrl = new URL('/api/v1/viewer/' + rawSecret + '/annotations', location.href).toString();
} catch (e) { return; }

var ENTRY = CFG.entry || 'index.html';
var CONTEXT_CHARS = 40;

/** Deck-relative path of the document currently shown (e.g. "index.html"). */
function currentPage() {
  var segs = location.pathname.split('/').slice(3);
  var parts = [];
  for (var i = 0; i < segs.length; i++) {
    if (segs[i] === '') continue;
    try { parts.push(decodeURIComponent(segs[i])); } catch (e) { parts.push(segs[i]); }
  }
  return parts.length ? parts.join('/') : ENTRY;
}
function samePage(page) { return !page || page === currentPage(); }
function encodePath(p) {
  return p.split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
}
/** Viewer URL of a deck-relative page, secret prefix included. */
function pageUrl(page) {
  return '/v/' + rawSecret + '/' + encodePath(page);
}

function headers(json) {
  var h = {};
  if (json) h['content-type'] = 'application/json';
  if (CFG.unlock) h['x-slideless-unlock'] = CFG.unlock;
  return h;
}

// ---- State -------------------------------------------------------------
var notes = [];            // this token's own notes on CFG.version
var filter = 'open';       // sheet tab: 'open' | 'done'
var snapshot = null;       // FROZEN anchor for the composer (PRDCT-1242)
var pendingRange = null;   // candidate selection behind the visible pill
var savedName = '';        // reviewer name, kept for the session only
                           // (the opaque origin has no storage — ADR 012)
var mode = 'browse';       // 'browse' | 'annotate'
var pinsVisible = true;    // sheet toggle; per-visit (no storage, ADR 012)
var indicatorRect = null;  // viewport rect of the pending capture's indicator
                           // (selection rect / pin point / region box) — what
                           // the composer must sit BESIDE, never on top of.
                           // Kept OUT of the snapshot: it is placement state,
                           // not anchor data, and must never be submitted.
var seenIds = null;        // ids already rendered once (animate only new)
var isSaving = false;
var placedId = null;       // the note just saved: its pin pulses once

// ---- DOM helpers -------------------------------------------------------
function el(tag, cls, text) {
  var n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
function cssEscape(s) {
  if (window.CSS && CSS.escape) return CSS.escape(s);
  return String(s).replace(/[^a-zA-Z0-9_-]/g, '\\$&');
}
function parseIdx(v) { var n = parseInt(v, 10); return isNaN(n) ? null : n; }
/** The recipient bar's current height (PRDCT-2281), 0 when absent or collapsed: nothing of ours may be placed under it. */
function topInset() {
  try {
    var v = parseFloat(getComputedStyle(doc.documentElement).getPropertyValue('--slideless-topbar'));
    return isNaN(v) ? 0 : v;
  } catch (e) { return 0; }
}
function clamp01(n) { return Math.max(0, Math.min(1, n)); }
function round4(n) { return Math.round(n * 10000) / 10000; }

// ---- Anchor capture ----------------------------------------------------
function elementOf(range) {
  var n = range.startContainer;
  return n.nodeType === 1 ? n : n.parentElement;
}
function findContainer(node) {
  while (node && node.nodeType) {
    if (node.nodeType === 1 && node.hasAttribute) {
      if (node.hasAttribute('data-slide'))
        return { el: node, kind: 'slide', index: parseIdx(node.getAttribute('data-slide')) };
      if (node.hasAttribute('data-panel'))
        return { el: node, kind: 'panel', index: parseIdx(node.getAttribute('data-panel')) };
    }
    node = node.parentNode;
  }
  return null;
}
function headingOf(container) {
  if (!container) return null;
  var h = container.querySelector('h1,h2,h3,h4,.headline,.title');
  return h ? String(h.textContent || '').trim().slice(0, 120) : null;
}
/** Bounded CSS path: id / data-slide / data-panel anchored, ≤6 hops. */
function buildSelector(node) {
  if (!node || node.nodeType !== 1) return null;
  if (node.id) return '#' + cssEscape(node.id);
  var parts = [];
  var hops = 0;
  while (node && node.nodeType === 1 && node !== doc.body && hops < 6) {
    if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
    if (node.hasAttribute && node.hasAttribute('data-slide')) {
      parts.unshift('[data-slide="' + node.getAttribute('data-slide') + '"]');
      break;
    }
    if (node.hasAttribute && node.hasAttribute('data-panel')) {
      parts.unshift('[data-panel="' + node.getAttribute('data-panel') + '"]');
      break;
    }
    var part = node.tagName.toLowerCase();
    var parent = node.parentNode;
    if (parent && parent.children) {
      var same = [];
      for (var i = 0; i < parent.children.length; i++) {
        if (parent.children[i].tagName === node.tagName) same.push(parent.children[i]);
      }
      if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
    }
    parts.unshift(part);
    node = node.parentNode;
    hops++;
  }
  var sel = parts.join(' > ');
  return sel.length > 400 ? null : sel;
}
function contextOf(range) {
  var before = '', after = '';
  try {
    var s = range.startContainer;
    if (s.nodeType === 3) {
      before = s.textContent.slice(Math.max(0, range.startOffset - CONTEXT_CHARS), range.startOffset);
    }
    var e = range.endContainer;
    if (e.nodeType === 3) {
      after = e.textContent.slice(range.endOffset, range.endOffset + CONTEXT_CHARS);
    }
  } catch (e2) {}
  return { before: before, after: after };
}
function baseAnchor(type, node) {
  var c = findContainer(node);
  return {
    v: 2,
    type: type,
    page: currentPage(),
    frame: null,
    selector: buildSelector(node),
    container: {
      kind: c ? c.kind : null,
      index: c ? c.index : null,
      heading: c ? headingOf(c.el) : null
    },
    viewport: { w: window.innerWidth, h: window.innerHeight }
  };
}
function textAnchor(range, text) {
  var a = baseAnchor('text', elementOf(range));
  a.quote = text.slice(0, 500);
  a.context = contextOf(range);
  return a;
}
/** Element under a viewport point, ignoring the overlay's own surfaces. */
function deckElementAt(x, y) {
  var prevLayer = layer.style.pointerEvents;
  var prevRoot = root.style.pointerEvents;
  layer.style.pointerEvents = 'none';
  root.style.pointerEvents = 'none';
  var hit = doc.elementFromPoint(x, y);
  layer.style.pointerEvents = prevLayer;
  root.style.pointerEvents = prevRoot;
  if (!hit || hit === doc.documentElement) hit = doc.body;
  return hit;
}
function pointAnchor(x, y) {
  var target = deckElementAt(x, y);
  var a = baseAnchor('point', target);
  var r = target.getBoundingClientRect();
  a.point = {
    nx: round4(clamp01(r.width ? (x - r.left) / r.width : 0)),
    ny: round4(clamp01(r.height ? (y - r.top) / r.height : 0))
  };
  return a;
}
function regionAnchor(box) {
  var cx = box.left + box.width / 2;
  var cy = box.top + box.height / 2;
  var target = deckElementAt(cx, cy);
  var a = baseAnchor('region', target);
  var r = target.getBoundingClientRect();
  var w = r.width || 1;
  var h = r.height || 1;
  a.rect = {
    nx: round4(clamp01((box.left - r.left) / w)),
    ny: round4(clamp01((box.top - r.top) / h)),
    nw: round4(clamp01(box.width / w)),
    nh: round4(clamp01(box.height / h))
  };
  return a;
}

// ---- Anchor resolution (the ladder) ------------------------------------
function findTextIn(scope, text) {
  if (!text) return null;
  var needle = String(text).trim().slice(0, 60);
  if (!needle) return null;
  var walker = doc.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
  var node;
  while ((node = walker.nextNode())) {
    if (node.textContent && node.textContent.indexOf(needle) !== -1) {
      var p = node.parentElement;
      if (p && !root.contains(p)) return p;
    }
  }
  return null;
}
function containerEl(a) {
  var c = a && a.container;
  if (!c || c.index == null || !c.kind) return null;
  try { return doc.querySelector('[data-' + c.kind + '="' + c.index + '"]'); } catch (e) { return null; }
}
/** selector → quote search (container-scoped) → container → null. */
function resolveAnchor(a) {
  if (!a || typeof a !== 'object') return null;
  if (a.selector) {
    try {
      var hit = doc.querySelector(a.selector);
      if (hit && !root.contains(hit)) return hit;
    } catch (e) {}
  }
  if (a.quote) {
    var scope = containerEl(a) || doc.body;
    var byText = findTextIn(scope, a.quote);
    if (byText) return byText;
  }
  return containerEl(a);
}
/** Viewport rect the anchor points at (element box refined by point/rect). */
function anchorRect(a) {
  var target = resolveAnchor(a);
  if (!target) return null;
  var r = target.getBoundingClientRect();
  if (a.type === 'point' && a.point) {
    var x = r.left + r.width * a.point.nx;
    var y = r.top + r.height * a.point.ny;
    return { left: x, top: y, width: 0, height: 0, el: target };
  }
  if (a.type === 'region' && a.rect) {
    return {
      left: r.left + r.width * a.rect.nx,
      top: r.top + r.height * a.rect.ny,
      width: r.width * a.rect.nw,
      height: r.height * a.rect.nh,
      el: target
    };
  }
  return { left: r.left, top: r.top, width: r.width, height: r.height, el: target };
}

// ---- Styles ------------------------------------------------------------
var css = [
  // The dashboard's tokens, copied by value (the overlay cannot import the
  // app's CSS: another origin, a sandboxed page). Light is the Slideless
  // recipe of apps/dashboard/src/lib/tokens.css, dark its :root.dark set;
  // the float material and the wash are app.css (.float, --wash), the
  // button edges ui/button, the tag tone ui/tag (slate), the motion the
  // contract's one pair (MOTION_DURATION_MS, MOTION_EASING), zeroed under
  // reduced motion. Kept in sync by hand with the bar's copy (topbar.ts).
  '#__slideless_annotate{',
  '  --sl-ink:#1c1915;--sl-ink-soft:#35302a;--sl-muted:#6e6759;--sl-hairline:#e0daca;',
  '  --sl-ground:#f7f4ec;--sl-ground-2:#f1ede1;--sl-paper:#faf7f0;--sl-plate-strong:rgb(251 249 243 / 0.82);',
  '  --sl-accent:#7a6652;--sl-accent-ink:#f7f4ec;--sl-accent-soft:rgba(122,102,82,.14);--sl-accent-deep:#8a4630;',
  '  --sl-focus:#b4552f;--sl-danger:#b4552f;--sl-ok:#2e7d52;--sl-ok-soft:#dfece3;',
  '  --sl-shadow-md:0 4px 6px -1px rgba(28,25,21,.1),0 2px 4px -2px rgba(28,25,21,.1);',
  '  --sl-shadow-lg:0 10px 15px -3px rgba(28,25,21,.12),0 4px 6px -4px rgba(28,25,21,.1);',
  '  --sl-scrim:rgba(28,25,21,.28);',
  '  --sl-float:linear-gradient(var(--sl-plate-strong),var(--sl-plate-strong)),color-mix(in oklab,var(--sl-paper) 72%,transparent);',
  '  --sl-wash:color-mix(in oklab,var(--sl-accent) 8%,transparent);',
  '  --sl-hover-edge:color-mix(in oklab,var(--sl-accent) 45%,var(--sl-hairline));',
  '  --sl-hover-fill:color-mix(in oklab,var(--sl-accent) 6%,var(--sl-plate-strong));',
  '  --sl-tone:#5c7285;',
  '  --sl-display:"Sentient",ui-serif,Georgia,"Times New Roman",serif;',
  '  --sl-mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;',
  '  --sl-motion:${MOTION_DURATION_MS}ms ${MOTION_EASING};',
  '  position:fixed;z-index:2147483000;',
  '  font:13.5px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  '  color:var(--sl-ink);-webkit-font-smoothing:antialiased;}',
  '@media (prefers-color-scheme: dark){#__slideless_annotate{',
  '  --sl-ink:#f3eee6;--sl-ink-soft:#dcd4c8;--sl-muted:#aca196;--sl-hairline:#3e362e;',
  '  --sl-ground:#1f1b17;--sl-ground-2:#171310;--sl-paper:#1f1b17;--sl-plate-strong:rgb(40 34 28 / 0.84);',
  '  --sl-accent:#db7d5f;--sl-accent-ink:#2a1d15;--sl-accent-soft:rgba(219,125,95,.16);--sl-accent-deep:#f3c7ac;',
  '  --sl-focus:#d9805a;--sl-danger:#e07a56;--sl-ok:#5db487;--sl-ok-soft:#1d3127;',
  '  --sl-shadow-md:0 4px 6px -1px rgba(0,0,0,.45),0 2px 4px -2px rgba(0,0,0,.45);',
  '  --sl-shadow-lg:0 10px 15px -3px rgba(0,0,0,.5),0 4px 6px -4px rgba(0,0,0,.45);',
  '  --sl-scrim:rgba(0,0,0,.5);}}',
  '@media (prefers-reduced-motion: reduce){#__slideless_annotate{--sl-motion:0s linear;}}',
  '#__slideless_annotate *{box-sizing:border-box;}',
  '#__slideless_annotate svg{width:15px;height:15px;display:block;flex:none;}',

  // Flash highlight on jump-to. Lands on DECK elements (outside the overlay),
  // so colors are literal, scoped CSS vars being out of reach there. The
  // clay of the dark set (#db7d5f): it reads on a light deck and on a dark one.
  '@keyframes __sl-anno-pulse{0%{outline-color:#db7d5f;box-shadow:0 0 0 6px rgba(219,125,95,.34);}',
  '  68%{outline-color:#db7d5f;box-shadow:0 0 0 6px rgba(219,125,95,.16);}',
  '  100%{outline-color:rgba(219,125,95,0);box-shadow:0 0 0 12px rgba(219,125,95,0);}}',
  '.__sl-anno-flash{border-radius:5px;outline:2px solid #db7d5f;outline-offset:3px;',
  '  animation:__sl-anno-pulse 1.5s ease-out forwards;}',
  '@media (prefers-reduced-motion: reduce){.__sl-anno-flash{animation:none;}}',

  // The "Add note" pill at the selection: the one action there, so the ink
  // primary of ui/button at the small size.
  '#__sl-add{position:fixed;display:none;align-items:center;gap:7px;transform:translateY(7px);',
  '  height:30px;padding:0 11px;border:0;border-radius:10px;background:var(--sl-ink);color:var(--sl-ground);',
  '  font:500 12.5px/1 inherit;cursor:pointer;box-shadow:inset 0 1px 0 rgb(255 255 255 / 0.14),var(--sl-shadow-md);}',
  '#__sl-add svg{width:14px;height:14px;}',
  '#__sl-add:hover{box-shadow:inset 0 1px 0 rgb(255 255 255 / 0.14),0 0 0 3px var(--sl-accent-soft),var(--sl-shadow-md);}',

  // Composer popover (shared by text / point / region captures): the float
  // material (app.css .float: the plate over a blur, one hairline), 14px
  // corners, the lg shadow.
  '#__sl-pop{position:fixed;display:none;width:300px;max-width:calc(100vw - 16px);background:var(--sl-float);',
  '  -webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  border:1px solid var(--sl-hairline);border-radius:14px;padding:14px;box-shadow:var(--sl-shadow-lg);}',
  // The eyebrow voice (app.css .eyebrow): 11px, wide, uppercase, muted.
  '.__sl-eyebrow{font:300 11px/1 inherit;letter-spacing:.14em;text-transform:uppercase;color:var(--sl-muted);}',
  '#__sl-pop .__sl-cap{margin-bottom:10px;}',
  '#__sl-pop .__sl-quote{font-size:12.5px;color:var(--sl-muted);margin-bottom:10px;max-height:46px;',
  '  overflow:hidden;border-left:2px solid var(--sl-accent);padding-left:9px;font-style:italic;}',
  // ui/input: the plate with a hairline, 10px corners, the accent edge and
  // a 3px accent-soft ring on focus.
  '#__sl-pop input,#__sl-pop textarea{width:100%;background:var(--sl-plate-strong);color:var(--sl-ink);',
  '  border:1px solid var(--sl-hairline);border-radius:10px;padding:8px 11px;font:inherit;margin-bottom:8px;',
  '  transition:border-color var(--sl-motion),box-shadow var(--sl-motion);}',
  '#__sl-pop input::placeholder,#__sl-pop textarea::placeholder{color:var(--sl-muted);}',
  '#__sl-pop textarea{min-height:74px;resize:vertical;margin-bottom:0;}',
  '#__sl-pop input:hover,#__sl-pop textarea:hover{border-color:color-mix(in oklab,var(--sl-accent) 35%,var(--sl-hairline));}',
  '#__sl-pop input:focus,#__sl-pop textarea:focus{outline:none;border-color:var(--sl-accent);box-shadow:0 0 0 3px var(--sl-accent-soft);}',
  '#__sl-pop .__sl-row{display:flex;gap:8px;justify-content:flex-end;margin-top:11px;}',
  '#__sl-pop .__sl-err{color:var(--sl-danger);font-size:12.5px;margin-top:8px;display:none;}',
  // ui/button, size sm: 32px, 10px corners. The ink primary is THE action
  // (Save, Done, Add a pin), the outline the others; the primary lifts and
  // takes the accent ring under the pointer, the outline the accent edge.
  '.__sl-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;padding:0 12px;',
  '  border:0;border-radius:10px;cursor:pointer;font:500 13px/1 inherit;white-space:nowrap;',
  '  transition:color var(--sl-motion),background-color var(--sl-motion),border-color var(--sl-motion),',
  '    box-shadow var(--sl-motion),transform var(--sl-motion);}',
  '.__sl-btn:active{transform:scale(.97);}',
  '.__sl-btn-primary{background:var(--sl-ink);color:var(--sl-ground);',
  '  box-shadow:inset 0 1px 0 rgb(255 255 255 / 0.14),0 1px 2px rgb(28 25 21 / 0.18);}',
  '.__sl-btn-primary:hover{transform:translateY(-1px);',
  '  box-shadow:inset 0 1px 0 rgb(255 255 255 / 0.14),0 0 0 3px var(--sl-accent-soft),0 6px 14px -6px rgb(28 25 21 / 0.45);}',
  '.__sl-btn-primary[disabled]{opacity:.5;cursor:default;transform:none;}',
  '.__sl-btn-outline{background:var(--sl-plate-strong);color:var(--sl-ink);border:1px solid var(--sl-hairline);}',
  '.__sl-btn-outline:hover{border-color:var(--sl-hover-edge);background:var(--sl-hover-fill);}',
  // app.css :focus-visible: the ember ring, offset.
  '#__slideless_annotate button:focus-visible{outline:2px solid var(--sl-focus);outline-offset:2px;}',

  // The floating fallback, for a link whose bar is off (viewer/inject.ts:
  // the bar and the overlay have separate switches): the two entrances as
  // a small stack at the badge slot, the bar's icon style on the float
  // material. With a bar mounted neither is created; the bar hosts them
  // (topbar.ts, the annotation controls note).
  '#__sl-badge,#__sl-fab-pin{position:fixed;display:inline-flex;align-items:center;justify-content:center;gap:6px;',
  '  height:36px;min-width:36px;padding:0;border:1px solid var(--sl-hairline);border-radius:10px;',
  '  background:var(--sl-float);-webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  color:var(--sl-muted);cursor:pointer;box-shadow:var(--sl-shadow-md);user-select:none;font:inherit;',
  '  transition:color var(--sl-motion),background-color var(--sl-motion),border-color var(--sl-motion);}',
  '#__sl-badge:hover,#__sl-fab-pin:hover{color:var(--sl-ink);border-color:var(--sl-hover-edge);}',
  '#__sl-badge.__sl-open,#__sl-fab-pin.__sl-on{color:var(--sl-accent-deep);background:var(--sl-wash);}',
  '#__sl-badge .__sl-bicon{display:flex;}',
  '#__sl-badge .__sl-bicon svg,#__sl-fab-pin svg{width:16px;height:16px;}',
  '#__sl-badge.__sl-has{padding:0 7px 0 8px;}',
  // The count: the bar's tag (ui/tag, slate tone, at count size).
  '#__sl-badge .__sl-bcount{display:none;min-width:18px;height:18px;padding:0 5px;border-radius:6px;',
  '  border:1px solid color-mix(in oklab,var(--sl-tone) 24%,transparent);',
  '  background:color-mix(in oklab,var(--sl-tone) 11%,var(--sl-plate-strong));',
  '  color:color-mix(in oklab,var(--sl-tone) 62%,var(--sl-ink));font:500 11px/16px var(--sl-mono);',
  '  align-items:center;justify-content:center;}',
  '#__sl-badge.__sl-has .__sl-bcount{display:inline-flex;}',

  // The panel: the float material (app.css .float), inset from the edges,
  // 14px corners, the lg shadow, below the recipient bar when one is
  // mounted (PRDCT-2281). It opens on the one motion, a short slide with a
  // fade, and leaves the accessibility tree once gone (visibility, delayed
  // by the motion). On a phone it is a bottom sheet, full width, rounded
  // at the top.
  '#__sl-sheet{position:fixed;top:calc(10px + var(--slideless-topbar,0px));right:10px;bottom:10px;width:360px;',
  '  max-width:calc(100vw - 20px);background:var(--sl-float);',
  '  -webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  border:1px solid var(--sl-hairline);border-radius:14px;box-shadow:var(--sl-shadow-lg);',
  '  display:flex;flex-direction:column;overflow:hidden;',
  '  visibility:hidden;opacity:0;transform:translateX(12px);',
  '  transition:opacity var(--sl-motion),transform var(--sl-motion),visibility 0s linear ${MOTION_DURATION_MS}ms;}',
  '#__sl-sheet.open{visibility:visible;opacity:1;transform:none;',
  '  transition:opacity var(--sl-motion),transform var(--sl-motion),visibility 0s linear 0s;}',
  '@media (max-width:640px){#__sl-sheet{top:auto;left:0;right:0;bottom:0;width:auto;max-width:none;max-height:72vh;',
  '  border-radius:16px 16px 0 0;border-bottom:0;transform:translateY(16px);}',
  '  #__sl-sheet.open{transform:none;}}',
  '@media (prefers-reduced-motion: reduce){#__sl-sheet{transition:none;}}',
  '#__sl-sheet .__sl-head{display:flex;align-items:center;gap:4px;padding:14px 12px 10px 18px;}',
  // The display serif (tokens.css --display, at the section-head size):
  // the panel opens on a title, not a caption.
  '#__sl-sheet .__sl-head strong{flex:1;font:400 19px/1.2 var(--sl-display);letter-spacing:-.01em;color:var(--sl-ink);}',
  // ui/button ghost, the icon size: the gear and the close here, the close
  // of the settings dialog. Root-scoped (not sheet-scoped), which keeps it
  // off deck content, which shares the document.
  '#__slideless_annotate .__sl-x{display:inline-flex;align-items:center;justify-content:center;flex:none;',
  '  width:32px;height:32px;padding:0;border:0;border-radius:10px;background:transparent;cursor:pointer;color:var(--sl-muted);',
  '  transition:color var(--sl-motion),background-color var(--sl-motion);}',
  '#__slideless_annotate .__sl-x:hover{background:var(--sl-wash);color:var(--sl-ink);}',
  '#__slideless_annotate .__sl-x svg{width:16px;height:16px;}',
  // The footer holds THE action of the panel (the ink primary, full width);
  // viewing preferences sit behind the gear.
  '#__sl-foot{padding:12px 16px 14px;border-top:1px solid var(--sl-hairline);}',
  '#__sl-mode{width:100%;height:36px;}',
  '#__sl-mode svg{width:15px;height:15px;}',

  // Settings dialog: badge-position grid + pins switch + link metadata, on
  // the float material over a scrim; the eyebrow for its section labels,
  // the field look on the grid's cells.
  '#__sl-scrim{position:fixed;inset:0;display:none;background:var(--sl-scrim);}',
  '#__sl-scrim.on{display:block;}',
  '#__sl-settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:none;',
  '  width:320px;max-width:calc(100vw - 20px);background:var(--sl-float);',
  '  -webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  border:1px solid var(--sl-hairline);border-radius:14px;padding:14px 16px 16px;box-shadow:var(--sl-shadow-lg);}',
  '#__sl-settings.on{display:block;}',
  '#__sl-settings .__sl-shead{display:flex;align-items:center;justify-content:space-between;margin:0 -6px 4px 0;}',
  '#__sl-settings .__sl-shead strong{font:400 19px/1.2 var(--sl-display);letter-spacing:-.01em;}',
  '.__sl-slabel{margin:14px 0 8px;}',
  // The position section belongs to the floating fallback: with the bar
  // hosting the controls there is nothing to move (.__sl-hosted, at mount).
  '#__slideless_annotate.__sl-hosted .__sl-pos{display:none;}',
  '#__sl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}',
  '#__sl-grid button{height:34px;border:1px solid var(--sl-hairline);border-radius:10px;',
  '  background:var(--sl-plate-strong);cursor:pointer;position:relative;padding:0;',
  '  transition:border-color var(--sl-motion),background-color var(--sl-motion);}',
  '#__sl-grid button:hover{border-color:var(--sl-hover-edge);background:var(--sl-hover-fill);}',
  '#__sl-grid button.active{border-color:var(--sl-accent);background:var(--sl-accent-soft);}',
  '#__sl-grid button::after{content:"";position:absolute;width:8px;height:8px;border-radius:999px;',
  '  background:var(--sl-muted);}',
  '#__sl-grid button.active::after{background:var(--sl-accent);}',
  '#__sl-grid button[data-slot="top-left"]::after{top:5px;left:5px;}',
  '#__sl-grid button[data-slot="top"]::after{top:5px;left:50%;margin-left:-4px;}',
  '#__sl-grid button[data-slot="top-right"]::after{top:5px;right:5px;}',
  '#__sl-grid button[data-slot="left"]::after{top:50%;margin-top:-4px;left:5px;}',
  '#__sl-grid button[data-slot="right"]::after{top:50%;margin-top:-4px;right:5px;}',
  '#__sl-grid button[data-slot="bottom-left"]::after{bottom:5px;left:5px;}',
  '#__sl-grid button[data-slot="bottom"]::after{bottom:5px;left:50%;margin-left:-4px;}',
  '#__sl-grid button[data-slot="bottom-right"]::after{bottom:5px;right:5px;}',
  '#__sl-grid .__sl-void{border:0;background:transparent;cursor:default;pointer-events:none;}',
  '#__sl-grid .__sl-void::after{display:none;}',
  '.__sl-setrow{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:14px;}',
  '.__sl-setrow span{font-size:13.5px;color:var(--sl-ink-soft);}',
  // ui/switch: the hairline track on the second ground, the accent when on.
  '#__sl-pinvis{width:38px;height:22px;flex:none;border-radius:999px;border:1px solid var(--sl-hairline);',
  '  background:var(--sl-ground-2);position:relative;cursor:pointer;padding:0;',
  '  transition:background-color var(--sl-motion),border-color var(--sl-motion);}',
  '#__sl-pinvis::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;',
  '  border-radius:999px;background:var(--sl-muted);transition:left var(--sl-motion),background-color var(--sl-motion);}',
  '#__sl-pinvis.on{background:var(--sl-accent);border-color:var(--sl-accent);}',
  '#__sl-pinvis.on::after{left:18px;background:var(--sl-accent-ink);}',
  '#__sl-smeta{margin-top:14px;padding-top:12px;border-top:1px solid var(--sl-hairline);',
  '  font:400 11.5px/1.8 var(--sl-mono);color:var(--sl-muted);}',
  '#__sl-serr{color:var(--sl-danger);font-size:12px;margin-top:8px;display:none;}',
  // The two tabs: the eyebrow voice, the active one in ink over an accent
  // rule; the counts in the mono face.
  '#__sl-tabs{display:flex;gap:18px;margin:0 18px;border-bottom:1px solid var(--sl-hairline);}',
  '.__sl-tab{display:flex;align-items:center;gap:6px;padding:6px 0 9px;margin-bottom:-1px;cursor:pointer;',
  '  color:var(--sl-muted);font:300 11px/1 inherit;letter-spacing:.14em;text-transform:uppercase;',
  '  border-bottom:2px solid transparent;transition:color var(--sl-motion),border-color var(--sl-motion);}',
  '.__sl-tab:hover{color:var(--sl-ink);}',
  '.__sl-tab.active{color:var(--sl-ink);border-bottom-color:var(--sl-accent);}',
  '.__sl-tab .__sl-tcount{font:400 11px/1 var(--sl-mono);letter-spacing:0;text-transform:none;color:var(--sl-muted);}',
  '#__sl-list{flex:1;overflow:auto;padding:4px 10px 12px;}',
  // A note is a row: a hairline between two, the wash under the pointer,
  // the accent on its left edge while it is the one just jumped to.
  '.__sl-item{position:relative;padding:12px 8px 12px 10px;border-radius:7px;cursor:pointer;',
  '  transition:background-color var(--sl-motion),box-shadow var(--sl-motion);}',
  '.__sl-item+.__sl-item::before{content:"";position:absolute;left:10px;right:8px;top:0;height:1px;background:var(--sl-hairline);}',
  '.__sl-item:hover{background:var(--sl-wash);}',
  '.__sl-item.__sl-focus{box-shadow:inset 2px 0 0 var(--sl-accent);}',
  '.__sl-item .__sl-ihead{display:flex;align-items:center;gap:8px;margin-bottom:6px;}',
  // The number of the pin, as on the deck: a ringed dot in the accent, the mono face.
  '.__sl-item .__sl-num{flex:none;min-width:18px;height:18px;padding:0 4px;border-radius:999px;background:var(--sl-accent);',
  '  color:var(--sl-accent-ink);font:600 10px/18px var(--sl-mono);text-align:center;',
  '  box-shadow:0 0 0 1.5px var(--sl-paper),0 0 0 2.5px color-mix(in oklab,var(--sl-accent) 45%,transparent);}',
  '.__sl-item .__sl-where{font-size:11.5px;color:var(--sl-muted);flex:1;overflow:hidden;',
  '  text-overflow:ellipsis;white-space:nowrap;}',
  '.__sl-item .__sl-quote{font-size:12px;color:var(--sl-muted);border-left:2px solid var(--sl-accent);',
  '  padding-left:8px;margin-bottom:8px;max-height:36px;overflow:hidden;font-style:italic;}',
  '.__sl-item .__sl-note{white-space:pre-wrap;word-break:break-word;font-size:13.5px;color:var(--sl-ink);}',
  '.__sl-item .__sl-meta{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-top:8px;',
  '  font-size:11.5px;color:var(--sl-muted);}',
  // ui/tag as a state: the dot in place of the glyph, the ok tone for a
  // resolved note. Capitalised by the stylesheet, so the text stays the
  // status word the API sends.
  '.__sl-tag{display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:6px;',
  '  border:1px solid color-mix(in oklab,var(--sl-tone) 24%,transparent);',
  '  background:color-mix(in oklab,var(--sl-tone) 11%,var(--sl-plate-strong));',
  '  color:color-mix(in oklab,var(--sl-tone) 62%,var(--sl-ink));font:500 11px/1 inherit;',
  '  text-transform:capitalize;white-space:nowrap;}',
  '.__sl-tag::before{content:"";width:5px;height:5px;border-radius:50%;background:var(--sl-tone);',
  '  box-shadow:0 0 0 2.5px color-mix(in oklab,var(--sl-tone) 18%,transparent);margin:0 1px;}',
  '.__sl-tag.__sl-tag-ok{--sl-tone:var(--sl-ok);}',
  '@keyframes __sl-in{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:none;}}',
  '.__sl-item.__sl-enter{animation:__sl-in var(--sl-motion);}',
  '.__sl-empty{padding:36px 14px;color:var(--sl-muted);text-align:center;font-size:13px;line-height:1.5;text-wrap:pretty;}',

  // Pins layer: one fixed pass-through layer; only the pins themselves are
  // interactive. A pin is a ringed dot in the accent (a paper gap, then the
  // accent ring) with its number in the mono face; the one just placed
  // pulses once. Region anchors draw their outline plus a corner pin.
  '#__sl-pins{position:fixed;inset:0;pointer-events:none;}',
  '.__sl-pin{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:999px;',
  '  background:var(--sl-accent);color:var(--sl-accent-ink);font:600 10.5px/18px var(--sl-mono);text-align:center;',
  '  border:2px solid var(--sl-paper);box-shadow:0 0 0 1.5px var(--sl-accent),var(--sl-shadow-md);',
  '  cursor:pointer;pointer-events:auto;user-select:none;transition:transform var(--sl-motion);}',
  '.__sl-pin:hover{transform:scale(1.12);}',
  '@keyframes __sl-placed{from{box-shadow:0 0 0 1.5px var(--sl-accent),0 0 0 0 color-mix(in oklab,var(--sl-accent) 45%,transparent);}',
  '  to{box-shadow:0 0 0 1.5px var(--sl-accent),0 0 0 14px color-mix(in oklab,var(--sl-accent) 0%,transparent);}}',
  '.__sl-pin.__sl-placed{animation:__sl-placed .9s cubic-bezier(0.2,0,0,1) 1;}',
  '@media (prefers-reduced-motion: reduce){.__sl-pin.__sl-placed{animation:none;}}',
  '.__sl-region{position:fixed;border:1.5px solid var(--sl-accent);border-radius:6px;',
  '  background:color-mix(in oklab,var(--sl-accent) 10%,transparent);}',

  // Pending-capture preview: while the composer is open for a point/region,
  // a provisional pin marks the exact spot, and a dashed contour outlines
  // the DOM element the anchor resolves to — what you see is literally
  // anchorRect() re-resolving the frozen snapshot, i.e. what re-opening the
  // note will find later.
  // The contour takes the picker's blue (below): the element the box was
  // framing a moment ago keeps the same frame once the click lands on it.
  '#__sl-preview{position:fixed;inset:0;pointer-events:none;}',
  '.__sl-target{position:fixed;border:1.5px solid var(--sl-pick);border-radius:8px;',
  '  background:var(--sl-pick-fill);pointer-events:none;}',
  '@keyframes __sl-ghost-pulse{0%,100%{box-shadow:0 0 0 1.5px var(--sl-accent),0 0 0 0 color-mix(in oklab,var(--sl-accent) 45%,transparent);}',
  '  50%{box-shadow:0 0 0 1.5px var(--sl-accent),0 0 0 8px color-mix(in oklab,var(--sl-accent) 0%,transparent);}}',
  '.__sl-pin.__sl-ghost{animation:__sl-ghost-pulse 1.4s ease-out infinite;}',
  '@media (prefers-reduced-motion: reduce){.__sl-pin.__sl-ghost{animation:none;}}',

  // Annotate mode: capture layer + instruction banner + live drag rect
  '#__sl-layer{position:fixed;inset:0;display:none;cursor:crosshair;}',
  '#__sl-layer.on{display:block;}',
  '#__sl-drag{position:fixed;display:none;border:1.5px solid var(--sl-pick);border-radius:6px;',
  '  background:var(--sl-pick-fill);pointer-events:none;}',

  // The picker: ONE box that travels to the element under the pointer while
  // a pin is being placed (fitHighlight). A calm selection blue, deliberately
  // not the amber accent (amber on the deck reads as a problem). Only
  // transform, size and radius move, on the product's motion curve; a fresh
  // show jumps into place (.__sl-hl-jump) and fades in rather than sliding
  // from wherever the box last sat. The chip names the element in plain
  // words and flips under the box when the top of the viewport is too close.
  '#__slideless_annotate{--sl-pick:#4a78b0;--sl-pick-fill:rgba(71,121,154,.10);',
  '  --sl-pick-glow:0 0 0 4px rgba(71,121,154,.14);}',
  '#__sl-hl{position:fixed;left:0;top:0;width:0;height:0;pointer-events:none;opacity:0;',
  '  border:1.5px solid var(--sl-pick);border-radius:6px;background:var(--sl-pick-fill);',
  '  box-shadow:var(--sl-pick-glow);will-change:transform,width,height;',
  '  transition:transform .18s cubic-bezier(.2,0,0,1),width .18s cubic-bezier(.2,0,0,1),',
  '    height .18s cubic-bezier(.2,0,0,1),border-radius .18s cubic-bezier(.2,0,0,1),opacity .14s ease;}',
  '#__sl-hl.on{opacity:1;}',
  '#__sl-hl.__sl-hl-jump{transition:none;}',
  '@media (prefers-reduced-motion: reduce){#__sl-hl{transition:none;}}',
  '#__sl-hl-tag{position:absolute;left:-1.5px;top:-7px;transform:translateY(-100%);',
  '  max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;',
  '  background:#fbf9f3;color:#1c1915;border:1px solid rgba(71,121,154,.4);border-radius:7px;',
  '  padding:3px 7px;font:600 11px/1.2 inherit;letter-spacing:.01em;',
  '  box-shadow:0 1px 3px rgba(20,20,40,.14);}',
  '#__sl-hl.__sl-hl-below #__sl-hl-tag{top:auto;bottom:-7px;transform:translateY(100%);}',
  // The instruction banner of the placing mode: a pill on the float
  // material, Done as the ink primary.
  '#__sl-banner{position:fixed;top:calc(14px + var(--slideless-topbar,0px));left:50%;transform:translateX(-50%);display:none;',
  '  align-items:center;gap:12px;background:var(--sl-float);',
  '  -webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  border:1px solid var(--sl-hairline);border-radius:999px;padding:6px 6px 6px 16px;font-size:13px;color:var(--sl-ink-soft);',
  '  box-shadow:var(--sl-shadow-md);white-space:nowrap;max-width:calc(100vw - 20px);}',
  '#__sl-banner.on{display:inline-flex;}',
  '#__sl-banner .__sl-btn{height:28px;padding:0 12px;border-radius:999px;}',

  // Transient toast (e.g. when a jumped-to section no longer exists)
  '#__sl-toast{position:fixed;left:50%;bottom:24px;transform:translateX(-50%) translateY(8px);',
  '  background:var(--sl-float);-webkit-backdrop-filter:blur(20px) saturate(1.2);backdrop-filter:blur(20px) saturate(1.2);',
  '  color:var(--sl-ink);border:1px solid var(--sl-hairline);border-radius:10px;',
  '  padding:9px 14px;font-size:13px;box-shadow:var(--sl-shadow-md);opacity:0;',
  '  pointer-events:none;max-width:80vw;transition:opacity var(--sl-motion),transform var(--sl-motion);}',
  '#__sl-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
].join('\n');

// ---- Icons (feather-style, inherit currentColor) -----------------------
var ICONS = {
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
  // The two entrances of the floating fallback, the bar's own drawings (topbar.ts ICONS).
  notes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 14.5a2 2 0 0 1-2 2H8l-4 3.5v-14a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"/></svg>',
  pinAdd: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21s-6-5.2-6-11a6 6 0 0 1 12 0c0 5.8-6 11-6 11Z"/><path d="M12 7.5v5"/><path d="M9.5 10h5"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
  empty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
};

// ---- Build the DOM -----------------------------------------------------
var root = el('div');
root.id = '__slideless_annotate';
var style = doc.createElement('style');
style.textContent = css;

var addBtn = el('button');
addBtn.id = '__sl-add';
addBtn.type = 'button';
addBtn.innerHTML = ICONS.mark;
addBtn.appendChild(el('span', null, 'Add note'));

var pop = el('div');
pop.id = '__sl-pop';
var popCap = el('div', '__sl-cap __sl-eyebrow', 'New annotation');
var popQuote = el('div', '__sl-quote');
var popName = doc.createElement('input');
popName.maxLength = 120;
popName.placeholder = 'Your name (optional)';
var popText = doc.createElement('textarea');
popText.maxLength = 10000;
popText.placeholder = 'What should change here?';
var popErr = el('div', '__sl-err', 'Could not save your note — please try again.');
var popRow = el('div', '__sl-row');
var popCancel = el('button', '__sl-btn __sl-btn-outline', 'Cancel');
popCancel.type = 'button';
var popSave = el('button', '__sl-btn __sl-btn-primary', 'Save');
popSave.type = 'button';
popRow.appendChild(popCancel);
popRow.appendChild(popSave);
pop.appendChild(popCap);
pop.appendChild(popQuote);
pop.appendChild(popName);
pop.appendChild(popText);
pop.appendChild(popErr);
pop.appendChild(popRow);

// The floating fallback's two entrances (the stylesheet note): created
// here, mounted only when no recipient bar hosts them.
var badge = el('button');
badge.id = '__sl-badge';
badge.type = 'button';
badge.title = 'Annotations';
badge.setAttribute('aria-label', 'Annotations');
var bIcon = el('span', '__sl-bicon');
bIcon.innerHTML = ICONS.notes;
var bCount = el('span', '__sl-bcount');
bCount.setAttribute('aria-hidden', 'true');
badge.appendChild(bIcon);
badge.appendChild(bCount);

// The pin button: one click into annotate mode, no sheet detour. Lives next
// to the badge and follows its slot.
var fabPin = el('button');
fabPin.id = '__sl-fab-pin';
fabPin.type = 'button';
fabPin.title = 'Add a pin';
fabPin.setAttribute('aria-label', 'Add a pin');
fabPin.setAttribute('aria-pressed', 'false');
fabPin.innerHTML = ICONS.pinAdd;

// ---- Badge placement -----------------------------------------------------
// Server-resolved slot (link override ?? deck's remembered default): the 4
// corners + the 4 edge centers. The stylesheet default is bottom-right; a
// slot sets its own sides and pins the others to auto (leaving them empty
// would let the stylesheet's right/bottom stretch the box). Config is
// server-controlled, but validate anyway and fall back to the default. The
// + FAB stacks toward the viewport center from the badge's slot.
// The three TOP slots add the recipient bar's height (PRDCT-2281): the bar
// publishes it as --slideless-topbar on the root (0 when absent or
// collapsed). Only the floating fallback uses the slots (a bar hosts the
// entrances itself, see the bar handshake below); the offset still serves
// the panel, the banner and the pins.
var TOP_OFFSET = 'var(--slideless-topbar, 0px)';
var BADGE_SLOTS = {
  'top-left': { top: 'calc(20px + ' + TOP_OFFSET + ')', left: '20px' },
  top: { top: 'calc(20px + ' + TOP_OFFSET + ')', left: '50%', transform: 'translateX(-50%)' },
  'top-right': { top: 'calc(20px + ' + TOP_OFFSET + ')', right: '20px' },
  right: { right: '20px', top: '50%', transform: 'translateY(-50%)' },
  'bottom-right': { bottom: '20px', right: '20px' },
  bottom: { bottom: '20px', left: '50%', transform: 'translateX(-50%)' },
  'bottom-left': { bottom: '20px', left: '20px' },
  left: { left: '20px', top: '50%', transform: 'translateY(-50%)' }
};
var FAB_SLOTS = {
  'top-left': { top: 'calc(64px + ' + TOP_OFFSET + ')', left: '20px' },
  top: { top: 'calc(64px + ' + TOP_OFFSET + ')', left: '50%', transform: 'translateX(-50%)' },
  'top-right': { top: 'calc(64px + ' + TOP_OFFSET + ')', right: '20px' },
  right: { right: '20px', top: 'calc(50% - 44px)', transform: 'translateY(-50%)' },
  'bottom-right': { bottom: '64px', right: '20px' },
  bottom: { bottom: '64px', left: '50%', transform: 'translateX(-50%)' },
  'bottom-left': { bottom: '64px', left: '20px' },
  left: { left: '20px', top: 'calc(50% - 44px)', transform: 'translateY(-50%)' }
};
var currentBadge = BADGE_SLOTS[CFG.badge] ? CFG.badge : 'bottom-right';
var fabBaseTransform = '';
// The pin button reads pressed while the placing mode is on.
function syncFabTransform() {
  fabPin.style.transform = fabBaseTransform;
  var placing = mode === 'annotate';
  fabPin.classList.toggle('__sl-on', placing);
  fabPin.setAttribute('aria-pressed', placing ? 'true' : 'false');
  fabPin.title = placing ? 'Done placing pins' : 'Add a pin';
  fabPin.setAttribute('aria-label', fabPin.title);
}
function applyBadgeSlot(pos) {
  var slot = BADGE_SLOTS[pos] || BADGE_SLOTS['bottom-right'];
  badge.style.top = slot.top || 'auto';
  badge.style.bottom = slot.bottom || 'auto';
  badge.style.left = slot.left || 'auto';
  badge.style.right = slot.right || 'auto';
  badge.style.transform = slot.transform || '';
  var f = FAB_SLOTS[pos] || FAB_SLOTS['bottom-right'];
  fabPin.style.top = f.top || 'auto';
  fabPin.style.bottom = f.bottom || 'auto';
  fabPin.style.left = f.left || 'auto';
  fabPin.style.right = f.right || 'auto';
  fabBaseTransform = f.transform || '';
  syncFabTransform();
}
applyBadgeSlot(currentBadge);

var sheet = el('div');
sheet.id = '__sl-sheet';
var head = el('div', '__sl-head');
head.appendChild(el('strong', null, 'Annotations'));
// Lean header: title · ⚙ · ✕. Actions live elsewhere — "Add a pin" is the
// sheet's footer CTA, viewing preferences sit behind the gear.
var gearBtn = el('button', '__sl-x');
gearBtn.id = '__sl-gear';
gearBtn.type = 'button';
gearBtn.title = 'Annotation settings';
gearBtn.setAttribute('aria-label', 'Annotation settings');
gearBtn.innerHTML = ICONS.gear;
var headClose = el('button', '__sl-x');
headClose.id = '__sl-close';
headClose.type = 'button';
headClose.title = 'Close';
headClose.setAttribute('aria-label', 'Close the annotations');
headClose.innerHTML = ICONS.close;
head.appendChild(gearBtn);
head.appendChild(headClose);
var tabs = el('div');
tabs.id = '__sl-tabs';
function makeTab(label, active) {
  var t = el('div', '__sl-tab' + (active ? ' active' : ''));
  t.appendChild(el('span', null, label));
  var count = el('span', '__sl-tcount', '(0)');
  t.appendChild(count);
  t._count = count;
  return t;
}
var tabOpen = makeTab('Open', true);
var tabDone = makeTab('Done', false);
tabs.appendChild(tabOpen);
tabs.appendChild(tabDone);
var list = el('div');
list.id = '__sl-list';
var foot = el('div');
foot.id = '__sl-foot';
var modeBtn = el('button', '__sl-btn __sl-btn-primary');
modeBtn.id = '__sl-mode';
modeBtn.type = 'button';
modeBtn.innerHTML = ICONS.pin;
modeBtn.appendChild(el('span', null, 'Add a pin'));
foot.appendChild(modeBtn);
sheet.appendChild(head);
sheet.appendChild(tabs);
sheet.appendChild(list);
sheet.appendChild(foot);

// ---- Settings dialog -----------------------------------------------------
var scrim = el('div');
scrim.id = '__sl-scrim';
var settings = el('div');
settings.id = '__sl-settings';
var shead = el('div', '__sl-shead');
shead.appendChild(el('strong', null, 'Settings'));
var settingsClose = el('button', '__sl-x');
settingsClose.type = 'button';
settingsClose.title = 'Close';
settingsClose.setAttribute('aria-label', 'Close the settings');
settingsClose.innerHTML = ICONS.close;
shead.appendChild(settingsClose);
settings.appendChild(shead);
// The position section (label, grid, error) is the floating fallback's;
// the stylesheet hides it while the bar hosts the controls.
var posSection = el('div', '__sl-pos');
settings.appendChild(posSection);
posSection.appendChild(el('div', '__sl-slabel __sl-eyebrow', 'Notes button position'));
var grid = el('div');
grid.id = '__sl-grid';
// 3×3 spatial picker: the 8 slots around an empty center. Saved to THIS
// link (token-authed PUT), so it sticks across pages and visits — and never
// touches the deck's owner-set default.
['top-left', 'top', 'top-right', 'left', null, 'right', 'bottom-left', 'bottom', 'bottom-right'].forEach(
  function (slot) {
    if (!slot) {
      grid.appendChild(el('div', '__sl-void'));
      return;
    }
    var cell = el('button');
    cell.type = 'button';
    cell.setAttribute('data-slot', slot);
    cell.title = slot.replace('-', ' ');
    cell.addEventListener('click', function () { setBadgeSlot(slot); });
    grid.appendChild(cell);
  }
);
posSection.appendChild(grid);
var settingsErr = el('div');
settingsErr.id = '__sl-serr';
settingsErr.textContent = 'Could not save the position — it will reset on reload.';
posSection.appendChild(settingsErr);
var pinsRow = el('div', '__sl-setrow');
pinsRow.appendChild(el('span', null, 'Show pins on the deck'));
// Per-visit only: the opaque origin has no storage (ADR 012), so this
// resets to ON on every load — which suits a "read it clean" toggle.
var pinsBtn = el('button', 'on');
pinsBtn.id = '__sl-pinvis';
pinsBtn.type = 'button';
pinsBtn.title = 'Show or hide the pins on the deck';
pinsRow.appendChild(pinsBtn);
settings.appendChild(pinsRow);
var smeta = el('div');
smeta.id = '__sl-smeta';
settings.appendChild(smeta);

function fmtDate(iso) {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch (e) { return String(iso); }
}
function syncSettings() {
  var cells = grid.children;
  for (var i = 0; i < cells.length; i++) {
    if (cells[i].classList) {
      cells[i].classList.toggle('active', cells[i].getAttribute('data-slot') === currentBadge);
    }
  }
  pinsBtn.classList.toggle('on', pinsVisible);
  smeta.textContent = '';
  smeta.appendChild(el('div', null, 'Viewing version ' + CFG.version));
  if (CFG.linkCreatedAt) smeta.appendChild(el('div', null, 'Link active since ' + fmtDate(CFG.linkCreatedAt)));
  if (CFG.linkExpiresAt) smeta.appendChild(el('div', null, 'Link expires ' + fmtDate(CFG.linkExpiresAt)));
}
function toggleSettings(open) {
  scrim.classList.toggle('on', open);
  settings.classList.toggle('on', open);
  if (open) { settingsErr.style.display = 'none'; syncSettings(); }
}
function setBadgeSlot(slot) {
  var previous = currentBadge;
  if (slot === previous) return;
  currentBadge = slot;
  applyBadgeSlot(slot); // optimistic: move now, persist behind it
  syncSettings();
  settingsErr.style.display = 'none';
  fetchFn(new URL('/api/v1/viewer/' + rawSecret + '/badge', location.href).toString(), {
    method: 'PUT',
    headers: headers(true),
    credentials: 'omit',
    mode: 'cors',
    body: JSON.stringify({ position: slot })
  }).then(function (res) {
    if (!res.ok) throw new Error('save_failed');
  }).catch(function () {
    // Keep the moved badge for this visit (the reviewer wanted it there),
    // but say plainly that it will not survive a reload.
    settingsErr.style.display = 'block';
  });
}
gearBtn.addEventListener('click', function () { toggleSettings(true); });
settingsClose.addEventListener('click', function () { toggleSettings(false); });
scrim.addEventListener('click', function () { toggleSettings(false); });

var pins = el('div');
pins.id = '__sl-pins';
var previewLayer = el('div');
previewLayer.id = '__sl-preview';
var layer = el('div');
layer.id = '__sl-layer';
var hl = el('div');
hl.id = '__sl-hl';
var hlTag = el('span');
hlTag.id = '__sl-hl-tag';
hl.appendChild(hlTag);
var dragBox = el('div');
dragBox.id = '__sl-drag';
var banner = el('div');
banner.id = '__sl-banner';
banner.appendChild(el('span', null, 'Click to pin · drag for a region · Esc to exit'));
var bannerDone = el('button', '__sl-btn __sl-btn-primary', 'Done');
bannerDone.type = 'button';
banner.appendChild(bannerDone);
var toast = el('div');
toast.id = '__sl-toast';

// ---- Event isolation (the PRDCT-1241 fix) ------------------------------
// Deck scripts navigate slides off document-level click/key listeners; any
// interaction with the overlay must never reach them. Stopping propagation
// at the overlay root covers every bubble-phase listener outside it (our
// own inner handlers sit below the root, so they still run first).
[
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
  'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel'
].forEach(function (type) {
  root.addEventListener(type, function (ev) { ev.stopPropagation(); });
});

// ---- The bar handshake --------------------------------------------------
// The recipient bar (viewer/topbar.ts, the annotation controls note) hosts
// the two entrances on an annotating link. Two custom events on the
// document, nothing else: the overlay announces its state on mount and on
// every change, the bar sends an action. A bar mounted BEFORE this script
// is found in the DOM at mount; one that mounts after says so with a
// state query, and the floating fallback leaves. Deck JS can fire the
// same events, as it could already click the overlay's own buttons.
var STATE_EVENT = 'slideless:annotations-state';
var ACTION_EVENT = 'slideless:annotations';
var hosted = false;
function announce() {
  try {
    doc.dispatchEvent(new CustomEvent(STATE_EVENT, {
      detail: { count: notes.length, open: openCount(), panel: sheet.classList.contains('open'), mode: mode }
    }));
  } catch (e) {}
}
function hostByBar() {
  if (hosted) return;
  hosted = true;
  root.classList.add('__sl-hosted');
  if (badge.parentNode) badge.parentNode.removeChild(badge);
  if (fabPin.parentNode) fabPin.parentNode.removeChild(fabPin);
}
doc.addEventListener(ACTION_EVENT, function (e) {
  var action = e && e.detail && typeof e.detail === 'object' ? e.detail.action : null;
  if (action === 'panel') toggleSheet();
  else if (action === 'pin') setMode(mode === 'annotate' ? 'browse' : 'annotate');
  else if (action === 'state') { hostByBar(); announce(); }
});

function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { toast.classList.remove('show'); }, 2800);
}

// ---- Transport ---------------------------------------------------------
function apiList() {
  return fetchFn(apiUrl, {
    method: 'GET', headers: headers(false), credentials: 'omit', mode: 'cors', cache: 'no-store'
  })
    .then(function (res) { return res.ok ? res.json() : { annotations: [] }; })
    .then(function (data) { return (data && data.annotations) || []; })
    .catch(function () { return []; });
}
function apiCreate(payload) {
  return fetchFn(apiUrl, {
    method: 'POST', headers: headers(true), credentials: 'omit', mode: 'cors',
    body: JSON.stringify(payload)
  }).then(function (res) {
    if (res.status === 201) return res.json().catch(function () { return null; });
    if (res.status === 429) throw new Error('rate_limited');
    throw new Error('save_failed');
  });
}

// ---- Composer ----------------------------------------------------------
function hideAdd() { addBtn.style.display = 'none'; pendingRange = null; }
/**
 * FREEZE the anchor the moment the pill appears; the pill click only opens
 * the composer over that frozen snapshot, and Save submits it verbatim.
 * The live selection is never consulted again (PRDCT-1242).
 */
function showAddAt(range, text) {
  var rect = range.getBoundingClientRect();
  snapshot = textAnchor(range, text);
  pendingRange = range;
  indicatorRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
  var left = Math.min(rect.left, window.innerWidth - 140);
  addBtn.style.left = Math.max(8, left) + 'px';
  addBtn.style.top = Math.max(8 + topInset(), rect.bottom) + 'px';
  addBtn.style.display = 'inline-flex';
}

function rectsIntersect(aLeft, aTop, aW, aH, b) {
  return aLeft < b.left + b.width && aLeft + aW > b.left && aTop < b.top + b.height && aTop + aH > b.top;
}

/**
 * Place the composer BESIDE the capture indicator, never on top of it (or
 * of the ghost pin): try right → left → below → above of the indicator
 * rect, take the first candidate that fits the viewport and covers neither
 * the indicator nor the pin; as a last resort clamp near the indicator's
 * bottom-right. Deliberately no placement setting — auto-placement is the
 * product behavior; a knob only appears if a real deck ever defeats it.
 */
function placeComposer() {
  var W = 300;
  var M = 8;
  var MT = M + topInset(); // the top bound: below the recipient bar
  var GAP = 14;
  pop.style.visibility = 'hidden';
  pop.style.display = 'block';
  var H = pop.offsetHeight || 280;
  var vw = window.innerWidth;
  var vh = window.innerHeight;
  var r = indicatorRect || { left: vw / 2, top: vh / 2, width: 0, height: 0 };
  // Everything the panel must not cover: the indicator (inflated so the
  // panel never touches it) and the provisional pin's own footprint.
  var avoid = [{ left: r.left - 14, top: r.top - 14, width: r.width + 28, height: r.height + 28 }];
  var pRect = snapshot ? anchorRect(snapshot) : null;
  if (pRect) {
    var pinX = snapshot.type === 'point' ? pRect.left : pRect.left + pRect.width;
    avoid.push({ left: pinX - 16, top: pRect.top - 16, width: 32, height: 32 });
  }
  var candidates = [
    { left: r.left + r.width + GAP, top: r.top, clampY: true },
    { left: r.left - GAP - W, top: r.top, clampY: true },
    { left: r.left, top: r.top + r.height + GAP, clampY: false },
    { left: r.left, top: r.top - GAP - H, clampY: false }
  ];
  var chosen = null;
  for (var i = 0; i < candidates.length && !chosen; i++) {
    var c = candidates[i];
    if (c.clampY) c.top = Math.max(MT, Math.min(c.top, vh - H - M));
    else c.left = Math.max(M, Math.min(c.left, vw - W - M));
    if (c.left < M || c.top < MT || c.left + W > vw - M || c.top + H > vh - M) continue;
    var hits = false;
    for (var j = 0; j < avoid.length; j++) {
      if (rectsIntersect(c.left, c.top, W, H, avoid[j])) { hits = true; break; }
    }
    if (!hits) chosen = c;
  }
  if (!chosen) {
    chosen = {
      left: Math.max(M, Math.min(r.left + r.width + GAP, vw - W - M)),
      top: Math.max(MT, Math.min(r.top + r.height + GAP, vh - H - M))
    };
  }
  pop.style.left = chosen.left + 'px';
  pop.style.top = chosen.top + 'px';
  pop.style.visibility = '';
}

// A draft the reader typed and then clicked away from (PRDCT-2671): kept
// until the next composer opens, so a stray click never loses a written note.
var keptDraft = '';
function openComposer() {
  popQuote.style.display = 'none';
  popQuote.textContent = '';
  if (snapshot && snapshot.type === 'text' && snapshot.quote) {
    popQuote.textContent = '“' + snapshot.quote.slice(0, 140) + '”';
    popQuote.style.display = 'block';
    popCap.textContent = 'New annotation';
  } else if (snapshot && snapshot.type === 'region') {
    popCap.textContent = 'New annotation · region';
  } else {
    popCap.textContent = 'New annotation · pin';
  }
  popName.value = savedName;
  // The draft a stray click closed comes back in the next composer (PRDCT-2671).
  popText.value = keptDraft;
  keptDraft = '';
  popErr.style.display = 'none';
  placeComposer();
  popText.focus();
  renderPreview();
}
function closeComposer() {
  pop.style.display = 'none';
  snapshot = null;
  indicatorRect = null;
  renderPreview();
}

function openCount() {
  var n = 0;
  for (var i = 0; i < notes.length; i++) { if (notes[i].status === 'open') n++; }
  return n;
}

/**
 * Live preview of the PENDING point/region capture while the composer is
 * open: provisional pin (with the number it will get), the region box, and
 * a dashed contour around the resolved target element. Rendered from the
 * frozen snapshot through the same anchorRect() ladder saved notes use, so
 * the preview shows exactly where the note will re-anchor.
 */
function renderPreview() {
  previewLayer.textContent = '';
  if (!snapshot || pop.style.display !== 'block') return;
  var rect = anchorRect(snapshot);
  if (!rect) return;
  if (rect.el) {
    var tr = rect.el.getBoundingClientRect();
    var contour = el('div', '__sl-target');
    contour.style.left = tr.left - 3 + 'px';
    contour.style.top = tr.top - 3 + 'px';
    contour.style.width = tr.width + 6 + 'px';
    contour.style.height = tr.height + 6 + 'px';
    previewLayer.appendChild(contour);
  }
  if (snapshot.type === 'region' && rect.width > 4 && rect.height > 4) {
    var regionEl = el('div', '__sl-region');
    regionEl.style.left = rect.left + 'px';
    regionEl.style.top = rect.top + 'px';
    regionEl.style.width = rect.width + 'px';
    regionEl.style.height = rect.height + 'px';
    previewLayer.appendChild(regionEl);
  }
  var pin = el('div', '__sl-pin __sl-ghost', String(openCount() + 1));
  // Same corner the SAVED pin will take (renderPins): element/region
  // top-right for text and region anchors, the exact point for point ones.
  var px = snapshot.type === 'point' ? rect.left : rect.left + rect.width;
  pin.style.left = Math.max(12, Math.min(px, window.innerWidth - 12)) + 'px';
  pin.style.top = Math.max(12 + topInset(), Math.min(rect.top, window.innerHeight - 12)) + 'px';
  previewLayer.appendChild(pin);
}

addBtn.addEventListener('mousedown', function (e) { e.preventDefault(); });
addBtn.addEventListener('click', function () {
  if (!snapshot) return;
  hideAdd();
  openComposer();
});
popCancel.addEventListener('click', function () { closeComposer(); });

popSave.addEventListener('click', function () {
  if (isSaving || !snapshot) return;
  var body = popText.value.trim();
  if (!body) { popText.focus(); return; }
  var name = popName.value.trim();
  savedName = name;
  var payload = { body: body, version: CFG.version, selection: snapshot };
  if (name) payload.authorName = name;
  isSaving = true;
  popSave.disabled = true;
  popSave.textContent = 'Saving…';
  popErr.style.display = 'none';
  apiCreate(payload).then(function (created) {
    // The pin of the note just saved pulses once when it lands (renderPins).
    placedId = created && typeof created.id === 'string' ? created.id : null;
    closeComposer();
    try { window.getSelection().removeAllRanges(); } catch (e) {}
    return refresh();
  }).catch(function (err) {
    // Keep the composer open with the text intact so the note isn't lost.
    popErr.textContent = err && err.message === 'rate_limited'
      ? 'Slow down — too many notes. Try again in a moment.'
      : 'Could not save your note — please try again.';
    popErr.style.display = 'block';
  }).then(function () {
    isSaving = false;
    popSave.disabled = false;
    popSave.textContent = 'Save';
  });
});

// ---- Text-selection capture (browse mode) ------------------------------
doc.addEventListener('mouseup', function () {
  if (mode !== 'browse') return;
  // The selection is not final at mouseup time — read it on the next tick.
  setTimeout(function () {
    if (pop.style.display === 'block') return; // composer holds its snapshot
    var sel = doc.getSelection ? doc.getSelection() : null;
    if (!sel || sel.isCollapsed || !sel.rangeCount) { hideAdd(); return; }
    var text = String(sel.toString() || '');
    if (!text.trim()) { hideAdd(); return; }
    var range = sel.getRangeAt(0);
    if (root.contains(range.startContainer) || root.contains(range.endContainer)) return;
    showAddAt(range, text.trim());
  }, 0);
});
doc.addEventListener('mousedown', function (e) {
  if (root.contains(e.target)) return;
  hideAdd();
  // A click on the deck closes an open composer (a highlight note in browse
  // mode lands here; a pin's click lands on the layer below): the typed draft
  // is kept for the next composer either way (PRDCT-2671).
  if (pop.style.display === 'block') { keptDraft = popText.value; closeComposer(); }
});

// ---- Annotate mode (point / region pins) -------------------------------
function setMode(next) {
  mode = next;
  layer.classList.toggle('on', next === 'annotate');
  banner.classList.toggle('on', next === 'annotate');
  if (next === 'annotate') { hideAdd(); closeComposer(); toggleSheet(false); toggleSettings(false); }
  else hideHighlight();
  syncFabTransform();
  renderPins();
  announce();
}
modeBtn.addEventListener('click', function () {
  setMode(mode === 'annotate' ? 'browse' : 'annotate');
});
fabPin.addEventListener('click', function () {
  setMode(mode === 'annotate' ? 'browse' : 'annotate');
});
pinsBtn.addEventListener('click', function () {
  pinsVisible = !pinsVisible;
  pinsBtn.classList.toggle('on', pinsVisible);
  renderPins();
});
bannerDone.addEventListener('click', function () { setMode('browse'); });
// Esc leaves annotate mode wherever focus sits. Capture phase: the deck must
// not swallow it, and our root's stopPropagation must not starve it.
doc.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    if (settings.classList.contains('on')) { toggleSettings(false); return; }
    if (pop.style.display === 'block') { closeComposer(); return; }
    if (mode === 'annotate') { setMode('browse'); return; }
    if (sheet.classList.contains('open')) toggleSheet(false);
  }
}, true);

var dragStart = null;
layer.addEventListener('pointerdown', function (e) {
  if (e.button !== 0) return;
  // PRDCT-2671: while the composer is open, a click on the deck closes it,
  // the way a click outside a dialog leaves it, and places nothing. The
  // next click places a new note as usual.
  if (pop.style.display === 'block') {
    keptDraft = popText.value;
    closeComposer();
    e.preventDefault();
    return;
  }
  dragStart = { x: e.clientX, y: e.clientY };
  try { layer.setPointerCapture(e.pointerId); } catch (e2) {}
  e.preventDefault();
});
layer.addEventListener('pointermove', function (e) {
  if (!dragStart) return;
  var box = dragRect(e);
  if (box.width > 6 || box.height > 6) {
    dragBox.style.display = 'block';
    dragBox.style.left = box.left + 'px';
    dragBox.style.top = box.top + 'px';
    dragBox.style.width = box.width + 'px';
    dragBox.style.height = box.height + 'px';
  }
});
layer.addEventListener('pointerup', function (e) {
  if (!dragStart) return;
  var box = dragRect(e);
  dragStart = null;
  dragBox.style.display = 'none';
  if (box.width > 6 || box.height > 6) {
    snapshot = regionAnchor(box);
    indicatorRect = box;
  } else {
    snapshot = pointAnchor(e.clientX, e.clientY);
    indicatorRect = { left: e.clientX - 11, top: e.clientY - 11, width: 22, height: 22 };
  }
  openComposer();
});
function dragRect(e) {
  var x1 = Math.min(dragStart.x, e.clientX);
  var y1 = Math.min(dragStart.y, e.clientY);
  var x2 = Math.max(dragStart.x, e.clientX);
  var y2 = Math.max(dragStart.y, e.clientY);
  return { left: x1, top: y1, width: x2 - x1, height: y2 - y1 };
}

// ---- The picker's highlight box ----------------------------------------
// While annotate mode is on and nothing else holds the pointer (no drag,
// no composer), #__sl-hl frames the element a click would pin, resolved by
// the SAME deckElementAt() the pin itself uses, so what the box frames is
// what gets anchored. One box moves rather than an outline per element:
// pointermove only records the point and queues a frame; the frame resolves
// the target, measures it, and writes transform + size, which the
// stylesheet transitions. A scroll or a resize re-fits under the still
// pointer (the content moved, the pointer did not), a ResizeObserver
// follows the framed element's own size, and the label is textContent
// only, never markup from the deck.
var HL_PAD = 4;
var hlPoint = null;      // last pointer position over the layer
var hlTarget = null;     // the element the box frames, null while hidden
var hlQueued = false;
var hlObserver = typeof ResizeObserver === 'function'
  ? new ResizeObserver(function () { queueHighlight(); })
  : null;
var HL_WORDY = { h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, p: 1, a: 1, button: 1, li: 1, label: 1,
  figcaption: 1, summary: 1, th: 1, td: 1, blockquote: 1 };
/** "h1 · First words", "img · alt", or the bare tag: the words are the element's own, cut at 28. */
function describeElement(node) {
  var tag = node.tagName.toLowerCase();
  var words = '';
  try {
    words = node.getAttribute('aria-label') || '';
    if (!words && tag === 'img') words = node.getAttribute('alt') || '';
    if (!words && HL_WORDY[tag]) words = String(node.textContent || '');
    // A container is named by the heading it holds, when it holds one.
    if (!words && !HL_WORDY[tag] && node.querySelector) {
      var h = node.querySelector('h1,h2,h3,h4,h5,h6');
      if (h) words = String(h.textContent || '');
    }
  } catch (e) {}
  words = words.replace(/\s+/g, ' ').trim();
  if (!words) return tag;
  var room = 28 - tag.length - 3;
  if (words.length > room) words = words.slice(0, Math.max(0, room - 1)).replace(/\s+$/, '') + '…';
  return tag + ' · ' + words;
}
/** Skipped targets: the document itself (a box round everything says nothing) and every overlay surface. */
function pickable(node) {
  if (!node || node === doc.body || node === doc.documentElement) return false;
  if (root.contains(node) || node.id === '__slideless_topbar') return false;
  return true;
}
function queueHighlight() {
  if (hlQueued) return;
  hlQueued = true;
  requestAnimationFrame(function () {
    hlQueued = false;
    fitHighlight();
  });
}
function hideHighlight() {
  hlPoint = null;
  if (hlTarget && hlObserver) hlObserver.unobserve(hlTarget);
  hlTarget = null;
  hl.classList.remove('on');
}
function fitHighlight() {
  if (mode !== 'annotate' || !hlPoint || dragStart || pop.style.display === 'block') {
    hideHighlight();
    return;
  }
  var target = deckElementAt(hlPoint.x, hlPoint.y);
  if (!pickable(target)) { hideHighlight(); return; }
  var r = target.getBoundingClientRect();
  if (target !== hlTarget) {
    if (hlObserver) {
      if (hlTarget) hlObserver.unobserve(hlTarget);
      hlObserver.observe(target);
    }
    hlTarget = target;
    hlTag.textContent = describeElement(target);
    var radius = 0;
    try { radius = parseFloat(getComputedStyle(target).borderTopLeftRadius) || 0; } catch (e) {}
    hl.style.borderRadius = Math.max(4, Math.min(12, radius > 0 ? radius + HL_PAD : 0)) + 'px';
  }
  var fresh = !hl.classList.contains('on');
  if (fresh) hl.classList.add('__sl-hl-jump');
  hl.style.transform = 'translate(' + (r.left - HL_PAD) + 'px,' + (r.top - HL_PAD) + 'px)';
  hl.style.width = r.width + 2 * HL_PAD + 'px';
  hl.style.height = r.height + 2 * HL_PAD + 'px';
  // The chip sits above the box unless that would put it under the bar or off the top.
  hl.classList.toggle('__sl-hl-below', r.top - HL_PAD - 7 - (hlTag.offsetHeight || 22) < topInset() + 4);
  if (fresh) {
    void hl.offsetWidth; // flush the jump before the transition comes back
    hl.classList.remove('__sl-hl-jump');
    hl.classList.add('on');
  }
}
layer.addEventListener('pointermove', function (e) {
  hlPoint = { x: e.clientX, y: e.clientY };
  queueHighlight();
});
layer.addEventListener('pointerdown', hideHighlight);
layer.addEventListener('pointerleave', hideHighlight);
window.addEventListener('scroll', function () { if (hlPoint) queueHighlight(); }, true);
window.addEventListener('resize', function () { if (hlPoint) queueHighlight(); });

// ---- Pins layer --------------------------------------------------------
// Open notes anchored on THIS page get a numbered pin (and regions their
// outline). Repositioned on scroll/resize (capture-phase scroll catches
// nested scrollers) plus a slow safety tick for animated layouts.
var pinLayoutQueued = false;
var pinSignature = '';
function layoutPins() {
  if (pinLayoutQueued) return;
  pinLayoutQueued = true;
  requestAnimationFrame(function () {
    pinLayoutQueued = false;
    renderPins();
    renderPreview();
  });
}
function renderPins() {
  // Cleared while annotate mode owns the viewport, and while the reviewer
  // has toggled pins off to read the deck clean.
  if (mode === 'annotate' || !pinsVisible) {
    pins.textContent = '';
    pinSignature = '';
    return;
  }
  // Compute placements first; rebuild the DOM only when they changed, so the
  // safety tick doesn't destroy a pin mid-hover/click.
  var placed = [];
  var minY = 12 + topInset();
  for (var i = 0; i < notes.length; i++) {
    var a = notes[i];
    if (a.status !== 'open') continue;
    var anchor = a.selection;
    if (!anchor || typeof anchor !== 'object' || !samePage(anchor.page)) continue;
    var rect = anchorRect(anchor);
    if (!rect) continue;
    var px = anchor.type === 'text' || anchor.type === 'region' ? rect.left + rect.width : rect.left;
    placed.push({
      note: a,
      rect: rect,
      region: anchor.type === 'region' && rect.width > 4 && rect.height > 4,
      x: Math.max(12, Math.min(px, window.innerWidth - 12)),
      y: Math.max(minY, Math.min(rect.top, window.innerHeight - 12))
    });
  }
  var sig = placed.map(function (p) {
    return p.note.id + ':' + Math.round(p.x) + ',' + Math.round(p.y) + ',' + (p.region ? Math.round(p.rect.width) + 'x' + Math.round(p.rect.height) : '');
  }).join('|');
  if (sig === pinSignature) return;
  pinSignature = sig;
  pins.textContent = '';
  placed.forEach(function (p) {
    if (p.region) {
      var regionEl = el('div', '__sl-region');
      regionEl.style.left = p.rect.left + 'px';
      regionEl.style.top = p.rect.top + 'px';
      regionEl.style.width = p.rect.width + 'px';
      regionEl.style.height = p.rect.height + 'px';
      pins.appendChild(regionEl);
    }
    var pin = el('div', '__sl-pin', String(p.note.__num));
    pin.style.left = p.x + 'px';
    pin.style.top = p.y + 'px';
    if (placedId && p.note.id === placedId) { pin.classList.add('__sl-placed'); placedId = null; }
    pin.addEventListener('click', function () {
      sheet.classList.add('open');
      // Focus the card only after the open-triggered refresh re-rendered it.
      refresh().then(function () { focusItem(p.note.id); });
      var r = anchorRect(p.note.selection);
      if (r && r.el) flash(r.el);
    });
    pins.appendChild(pin);
  });
}
window.addEventListener('scroll', layoutPins, true);
window.addEventListener('resize', layoutPins);
setInterval(layoutPins, 1200);

// ---- Jump-to -----------------------------------------------------------
function flash(target) {
  target.classList.add('__sl-anno-flash');
  setTimeout(function () { target.classList.remove('__sl-anno-flash'); }, 1600);
}
function jumpTo(a) {
  var anchor = a.selection && typeof a.selection === 'object' ? a.selection : {};
  // A different page of a multi-page deck: navigate there carrying the note
  // id in the hash; the destination page's overlay resolves it on load.
  if (anchor.page && !samePage(anchor.page)) {
    location.assign(pageUrl(anchor.page) + '#__slanno=' + encodeURIComponent(a.id));
    return;
  }
  var rect = anchorRect(anchor);
  if (!rect || !rect.el) {
    showToast('That section no longer exists in this version of the deck.');
    return;
  }
  try { rect.el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (e) { rect.el.scrollIntoView(); }
  flash(rect.el);
  layoutPins();
}
// After a cross-page navigation, resolve the note named in the URL hash.
function jumpFromHash() {
  var m = /__slanno=([^&]+)/.exec(location.hash || '');
  if (!m) return;
  var id;
  try { id = decodeURIComponent(m[1]); } catch (e) { id = m[1]; }
  try { history.replaceState(null, '', location.pathname + location.search); } catch (e2) {}
  for (var i = 0; i < notes.length; i++) {
    if (notes[i].id === id) {
      var note = notes[i];
      setTimeout(function () { jumpTo(note); }, 250);
      return;
    }
  }
}

// ---- Sheet -------------------------------------------------------------
function toggleSheet(open) {
  var willOpen = open != null ? open : !sheet.classList.contains('open');
  sheet.classList.toggle('open', willOpen);
  badge.classList.toggle('__sl-open', willOpen);
  announce();
  if (willOpen) refresh();
}
badge.addEventListener('click', function () { toggleSheet(); });
headClose.addEventListener('click', function () { toggleSheet(false); });
tabOpen.addEventListener('click', function () { filter = 'open'; syncTabs(); renderList(); });
tabDone.addEventListener('click', function () { filter = 'done'; syncTabs(); renderList(); });
function syncTabs() {
  tabOpen.classList.toggle('active', filter === 'open');
  tabDone.classList.toggle('active', filter === 'done');
}

function whereLabel(a) {
  var anchor = a.selection && typeof a.selection === 'object' ? a.selection : {};
  var bits = [];
  if (anchor.page && anchor.page !== ENTRY) bits.push(anchor.page);
  var c = anchor.container;
  if (c && c.index != null && c.kind) bits.push(c.kind + ' ' + c.index);
  if (c && c.heading) bits.push('“' + c.heading + '”');
  if (!bits.length && anchor.type === 'point') bits.push('pinned');
  if (!bits.length && anchor.type === 'region') bits.push('region');
  return bits.join(' · ') || 'this version';
}

function focusItem(id) {
  var items = list.children;
  for (var i = 0; i < items.length; i++) {
    var item = items[i];
    if (item._noteId === id) {
      item.classList.add('__sl-focus');
      try { item.scrollIntoView({ block: 'nearest' }); } catch (e) {}
      setTimeout(function () { item.classList.remove('__sl-focus'); }, 1600);
    } else if (item.classList) {
      item.classList.remove('__sl-focus');
    }
  }
}

function renderItem(a) {
  var item = el('div', '__sl-item');
  item._noteId = a.id;
  if (seenIds && !seenIds[a.id]) { item.classList.add('__sl-enter'); seenIds[a.id] = 1; }
  var ihead = el('div', '__sl-ihead');
  if (a.status === 'open' && a.__num) ihead.appendChild(el('span', '__sl-num', String(a.__num)));
  ihead.appendChild(el('div', '__sl-where', whereLabel(a)));
  item.appendChild(ihead);
  var anchor = a.selection && typeof a.selection === 'object' ? a.selection : {};
  if (anchor.quote) {
    item.appendChild(el('div', '__sl-quote', '“' + String(anchor.quote).slice(0, 120) + '”'));
  }
  item.appendChild(el('div', '__sl-note', a.body));
  // Who, when, on which version; a resolved note carries its state as a tag.
  var meta = el('div', '__sl-meta');
  var metaBits = [];
  if (a.authorName) metaBits.push(a.authorName);
  if (a.createdAt) metaBits.push(fmtDate(a.createdAt));
  metaBits.push('v' + a.version);
  meta.appendChild(el('span', null, metaBits.join(' · ')));
  if (a.status === 'resolved') meta.appendChild(el('span', '__sl-tag __sl-tag-ok', 'resolved'));
  item.appendChild(meta);
  // The whole card jumps (reviewers have no other per-note actions: edits,
  // deletes and status flips are owner-surface capabilities).
  item.addEventListener('click', function (e) {
    var sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.anchorNode && item.contains(sel.anchorNode)) return;
    jumpTo(a);
  });
  return item;
}

function renderList() {
  list.textContent = '';
  var shown = notes.filter(function (a) {
    return filter === 'open' ? a.status === 'open' : a.status !== 'open';
  });
  if (!shown.length) {
    var empty = el('div', '__sl-empty');
    empty.appendChild(el('div', null, filter === 'open'
      ? 'No open notes yet. Select text, or use “Add pin” to mark a spot.'
      : 'Nothing resolved yet. Notes move here when the deck owner resolves them.'));
    list.appendChild(empty);
    return;
  }
  shown.forEach(function (a) { list.appendChild(renderItem(a)); });
}

function updateBadge() {
  var open = openCount();
  bCount.textContent = String(open);
  badge.classList.toggle('__sl-has', open > 0);
  badge.title = notes.length === 0
    ? 'Annotations. Select text or pin a spot to leave a note'
    : (open > 0 ? 'Annotations, ' + open + ' open' : 'Annotations, all resolved');
  badge.setAttribute('aria-label', badge.title);
  tabOpen._count.textContent = '(' + open + ')';
  tabDone._count.textContent = '(' + (notes.length - open) + ')';
  announce();
}

function refresh() {
  return apiList().then(function (items) {
    notes = items;
    // Stable pin numbers: oldest-first arrival order, open notes only.
    var num = 0;
    for (var i = 0; i < notes.length; i++) {
      if (notes[i].status === 'open') { num++; notes[i].__num = num; }
    }
    if (seenIds === null) {
      seenIds = {};
      notes.forEach(function (a) { seenIds[a.id] = 1; });
    }
    updateBadge();
    renderList();
    renderPins();
  });
}

// ---- Mount -------------------------------------------------------------
function mount() {
  if (!doc.body) return;
  root.appendChild(style);
  root.appendChild(pins);
  root.appendChild(previewLayer);
  root.appendChild(layer);
  root.appendChild(hl);
  root.appendChild(dragBox);
  root.appendChild(addBtn);
  root.appendChild(pop);
  // The bar mounts before this script runs (its tag precedes ours in the
  // plan): found, it hosts the two entrances and the floating fallback is
  // never created.
  if (doc.getElementById('__slideless_topbar')) hostByBar();
  else { root.appendChild(badge); root.appendChild(fabPin); }
  root.appendChild(sheet);
  root.appendChild(scrim);
  root.appendChild(settings);
  root.appendChild(banner);
  root.appendChild(toast);
  doc.body.appendChild(root);
  announce();
  refresh().then(jumpFromHash);
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
  const json = JSON.stringify({
    version: cfg.version,
    unlock: cfg.unlock,
    entry: cfg.entry,
    badge: cfg.badge,
    linkCreatedAt: cfg.linkCreatedAt,
    linkExpiresAt: cfg.linkExpiresAt
  }).replace(/</g, '\\u003c');
  return `\n<script ${OVERLAY_MARKER}>\n(function(){\n"use strict";\ntry{\nvar CFG=${json};\n${OVERLAY_JS}\n}catch(e){}\n})();\n</script>\n`;
}

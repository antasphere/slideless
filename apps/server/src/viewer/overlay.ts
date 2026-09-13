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
  '#__slideless_annotate{',
  '  --sl-bg:#17171d; --sl-bg2:#1f1f28; --sl-ink:#ededf2; --sl-muted:#9b9baa;',
  '  --sl-border:#2b2b36; --sl-border2:#363643; --sl-accent:#f5b301; --sl-accent-ink:#1a1505;',
  '  --sl-shadow:0 12px 40px rgba(0,0,0,.46);',
  '  position:fixed; z-index:2147483000;',
  '  font:13px/1.45 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  '  color:var(--sl-ink); -webkit-font-smoothing:antialiased;}',
  '@media (prefers-color-scheme: light){#__slideless_annotate{',
  '  --sl-bg:#ffffff; --sl-bg2:#f6f6f9; --sl-ink:#1d1d24; --sl-muted:#6c6c78;',
  '  --sl-border:#e6e6ec; --sl-border2:#dadae2; --sl-shadow:0 12px 40px rgba(20,20,40,.16);}}',
  '#__slideless_annotate *{box-sizing:border-box;}',
  '#__slideless_annotate svg{width:15px;height:15px;display:block;flex:none;}',

  // Flash highlight on jump-to. Lands on DECK elements (outside the overlay),
  // so colors are literal — scoped CSS vars are out of reach there.
  '@keyframes __sl-anno-pulse{0%{outline-color:#f5b301;box-shadow:0 0 0 6px rgba(245,179,1,.34);}',
  '  68%{outline-color:#f5b301;box-shadow:0 0 0 6px rgba(245,179,1,.16);}',
  '  100%{outline-color:rgba(245,179,1,0);box-shadow:0 0 0 12px rgba(245,179,1,0);}}',
  '.__sl-anno-flash{border-radius:5px;outline:2px solid #f5b301;outline-offset:3px;',
  '  animation:__sl-anno-pulse 1.5s ease-out forwards;}',
  '@media (prefers-reduced-motion: reduce){.__sl-anno-flash{animation:none;}}',

  // Floating "Add note" pill at the selection
  '#__sl-add{position:fixed;display:none;align-items:center;gap:7px;transform:translateY(7px);',
  '  background:var(--sl-accent);color:var(--sl-accent-ink);border:0;border-radius:9px;',
  '  padding:8px 12px;font:600 12.5px/1 inherit;cursor:pointer;box-shadow:var(--sl-shadow);}',
  '#__sl-add svg{width:14px;height:14px;}',
  '#__sl-add:hover{filter:brightness(1.05);}',

  // Composer popover (shared by text / point / region captures)
  '#__sl-pop{position:fixed;display:none;width:300px;background:var(--sl-bg);',
  '  border:1px solid var(--sl-border);border-radius:14px;padding:14px;box-shadow:var(--sl-shadow);}',
  '#__sl-pop .__sl-cap{font:600 11px/1 inherit;letter-spacing:.06em;text-transform:uppercase;',
  '  color:var(--sl-muted);margin-bottom:9px;}',
  '#__sl-pop .__sl-quote{font-size:12px;color:var(--sl-muted);margin-bottom:10px;max-height:46px;',
  '  overflow:hidden;border-left:2px solid var(--sl-accent);padding-left:9px;font-style:italic;}',
  '#__sl-pop input,#__sl-pop textarea{width:100%;background:var(--sl-bg2);color:var(--sl-ink);',
  '  border:1px solid var(--sl-border);border-radius:9px;padding:9px;font:inherit;margin-bottom:8px;}',
  '#__sl-pop textarea{min-height:74px;resize:vertical;margin-bottom:0;}',
  '#__sl-pop input:focus,#__sl-pop textarea:focus{outline:none;border-color:var(--sl-accent);}',
  '#__sl-pop .__sl-row{display:flex;gap:8px;justify-content:flex-end;margin-top:11px;}',
  '#__sl-pop .__sl-err{color:#e0625e;font-size:12px;margin-top:8px;display:none;}',
  '.__sl-btn{border:0;border-radius:8px;padding:7px 14px;cursor:pointer;font:600 12.5px/1 inherit;}',
  '.__sl-btn-primary{background:var(--sl-accent);color:var(--sl-accent-ink);}',
  '.__sl-btn-primary:hover{filter:brightness(1.05);}',
  '.__sl-btn-primary[disabled]{opacity:.6;cursor:default;}',
  '.__sl-btn-ghost{background:transparent;color:var(--sl-muted);border:1px solid var(--sl-border);}',
  '.__sl-btn-ghost:hover{color:var(--sl-ink);border-color:var(--sl-border2);}',

  // Bottom-right badge that expands to explain itself
  '#__sl-badge{position:fixed;right:20px;bottom:20px;display:inline-flex;align-items:center;',
  '  background:var(--sl-bg);border:1px solid var(--sl-border);border-radius:999px;padding:10px 13px;',
  '  cursor:pointer;box-shadow:var(--sl-shadow);user-select:none;color:var(--sl-ink);}',
  '#__sl-badge:hover{border-color:var(--sl-border2);}',
  '#__sl-badge .__sl-bicon{display:flex;color:var(--sl-accent);}',
  '#__sl-badge .__sl-bicon svg{width:18px;height:18px;}',
  // Label width animates via grid (0fr->1fr) so the easing tracks the real
  // label width — smoother than animating a fixed max-width past the content.
  '#__sl-badge .__sl-blabel{display:grid;grid-template-columns:0fr;opacity:0;margin:0;',
  '  transition:grid-template-columns .5s cubic-bezier(.22,1,.36,1),opacity .36s ease,margin .5s cubic-bezier(.22,1,.36,1);}',
  '#__sl-badge .__sl-blabel>span{overflow:hidden;white-space:nowrap;font-weight:500;}',
  '#__sl-badge.__sl-open .__sl-blabel,#__sl-badge:hover .__sl-blabel{',
  '  grid-template-columns:1fr;opacity:1;margin:0 11px;}',
  '#__sl-badge .__sl-bcount{display:none;min-width:20px;height:20px;padding:0 6px;border-radius:999px;',
  '  margin-left:10px;background:var(--sl-accent);color:var(--sl-accent-ink);font:700 11px/20px inherit;',
  '  text-align:center;transition:margin .5s cubic-bezier(.22,1,.36,1);}',
  '#__sl-badge.__sl-has .__sl-bcount{display:inline-block;}',
  '#__sl-badge.__sl-open .__sl-bcount,#__sl-badge:hover .__sl-bcount{margin-left:0;}',

  // The big + : one-click entry into annotate mode, stacked beside the
  // badge (follows its slot). Rotates into an × while the mode is active.
  '#__sl-fab-pin{position:fixed;width:46px;height:46px;border:0;border-radius:14px;',
  '  background:var(--sl-accent);color:var(--sl-accent-ink);cursor:pointer;box-shadow:var(--sl-shadow);',
  '  font:300 30px/1 inherit;display:flex;align-items:center;justify-content:center;',
  '  transition:transform .18s ease;}',
  '#__sl-fab-pin:hover{filter:brightness(1.05);}',
  '@media (prefers-reduced-motion: reduce){#__sl-fab-pin{transition:none;}}',

  // Right sliding sheet
  '#__sl-sheet{position:fixed;top:0;right:0;height:100%;width:360px;max-width:92vw;',
  '  background:var(--sl-bg);border-left:1px solid var(--sl-border);box-shadow:var(--sl-shadow);',
  '  transform:translateX(100%);transition:transform .26s cubic-bezier(.2,.8,.2,1);',
  '  display:flex;flex-direction:column;}',
  '#__sl-sheet.open{transform:translateX(0);}',
  '@media (prefers-reduced-motion: reduce){#__sl-sheet{transition:none;}}',
  '#__sl-sheet .__sl-head{display:flex;align-items:center;justify-content:space-between;gap:8px;',
  '  padding:16px 16px 12px;}',
  '#__sl-sheet .__sl-head strong{font-size:15px;font-weight:650;flex:1;}',
  // Root-scoped (not sheet-scoped): the settings dialog reuses this icon
  // button too. Root prefix keeps it off deck content, which shares the doc.
  '#__slideless_annotate .__sl-x{display:flex;align-items:center;justify-content:center;',
  '  width:30px;height:30px;border-radius:8px;cursor:pointer;color:var(--sl-muted);}',
  '#__slideless_annotate .__sl-x:hover{background:var(--sl-bg2);color:var(--sl-ink);}',
  // Footer CTA — THE action of the sheet; settings-ish things live behind ⚙.
  '#__sl-foot{padding:12px 16px 16px;border-top:1px solid var(--sl-border);}',
  '#__sl-mode{display:flex;width:100%;align-items:center;justify-content:center;gap:8px;',
  '  background:var(--sl-accent);color:var(--sl-accent-ink);border:0;border-radius:10px;',
  '  padding:11px;cursor:pointer;font:600 13px/1 inherit;}',
  '#__sl-mode:hover{filter:brightness(1.05);}',
  '#__sl-mode svg{width:15px;height:15px;}',

  // Settings dialog: badge-position grid + pins switch + link metadata.
  '#__sl-scrim{position:fixed;inset:0;display:none;background:rgba(0,0,0,.35);}',
  '#__sl-scrim.on{display:block;}',
  '#__sl-settings{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);display:none;',
  '  width:320px;max-width:92vw;background:var(--sl-bg);border:1px solid var(--sl-border);',
  '  border-radius:14px;padding:16px;box-shadow:var(--sl-shadow);}',
  '#__sl-settings.on{display:block;}',
  '#__sl-settings .__sl-shead{display:flex;align-items:center;justify-content:space-between;',
  '  margin-bottom:6px;}',
  '#__sl-settings .__sl-shead strong{font-size:14px;font-weight:650;}',
  '.__sl-slabel{font:600 11px/1 inherit;letter-spacing:.06em;text-transform:uppercase;',
  '  color:var(--sl-muted);margin:12px 0 8px;}',
  '#__sl-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}',
  '#__sl-grid button{height:34px;border:1px solid var(--sl-border);border-radius:8px;',
  '  background:var(--sl-bg2);cursor:pointer;position:relative;padding:0;}',
  '#__sl-grid button:hover{border-color:var(--sl-border2);}',
  '#__sl-grid button.active{border-color:var(--sl-accent);background:var(--sl-accent);}',
  '#__sl-grid button::after{content:"";position:absolute;width:8px;height:8px;border-radius:999px;',
  '  background:var(--sl-muted);}',
  '#__sl-grid button.active::after{background:var(--sl-accent-ink);}',
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
  '.__sl-setrow span{font-size:13px;}',
  '#__sl-pinvis{width:38px;height:22px;flex:none;border-radius:999px;border:1px solid var(--sl-border);',
  '  background:var(--sl-bg2);position:relative;cursor:pointer;padding:0;}',
  '#__sl-pinvis::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;',
  '  border-radius:999px;background:var(--sl-muted);transition:left .15s ease,background .15s ease;}',
  '#__sl-pinvis.on{background:var(--sl-accent);border-color:var(--sl-accent);}',
  '#__sl-pinvis.on::after{left:18px;background:var(--sl-accent-ink);}',
  '#__sl-smeta{margin-top:14px;padding-top:12px;border-top:1px solid var(--sl-border);',
  '  font-size:11.5px;color:var(--sl-muted);line-height:1.7;}',
  '#__sl-serr{color:#e0625e;font-size:11.5px;margin-top:8px;display:none;}',
  '#__sl-tabs{display:flex;gap:4px;margin:2px 16px 8px;padding:3px;background:var(--sl-bg2);',
  '  border-radius:10px;}',
  '.__sl-tab{flex:1;display:flex;align-items:center;justify-content:center;gap:5px;text-align:center;',
  '  padding:7px;border-radius:8px;cursor:pointer;color:var(--sl-muted);',
  '  font-weight:600;font-size:12.5px;transition:background .15s,color .15s;}',
  '.__sl-tab:hover{color:var(--sl-ink);}',
  '.__sl-tab.active{background:var(--sl-bg);color:var(--sl-ink);box-shadow:0 1px 3px rgba(0,0,0,.16);}',
  '.__sl-tab .__sl-tcount{opacity:.55;font-weight:600;}',
  '#__sl-list{flex:1;overflow:auto;padding:6px 16px 20px;}',
  '.__sl-item{position:relative;background:var(--sl-bg2);border:1px solid var(--sl-border);',
  '  border-radius:12px;padding:12px;margin-bottom:10px;cursor:pointer;',
  '  transition:border-color .15s,background .15s;}',
  '.__sl-item:hover{border-color:var(--sl-border2);}',
  '.__sl-item.__sl-focus{border-color:var(--sl-accent);}',
  '.__sl-item .__sl-ihead{display:flex;align-items:center;gap:7px;margin-bottom:7px;}',
  '.__sl-item .__sl-num{flex:none;min-width:18px;height:18px;border-radius:999px;background:var(--sl-accent);',
  '  color:var(--sl-accent-ink);font:700 10.5px/18px inherit;text-align:center;padding:0 4px;}',
  '.__sl-item .__sl-where{font-size:11px;color:var(--sl-muted);font-weight:500;flex:1;overflow:hidden;',
  '  text-overflow:ellipsis;white-space:nowrap;}',
  '.__sl-item .__sl-quote{font-size:11.5px;color:var(--sl-muted);border-left:2px solid var(--sl-border2);',
  '  padding-left:8px;margin-bottom:8px;max-height:36px;overflow:hidden;font-style:italic;}',
  '.__sl-item .__sl-note{white-space:pre-wrap;word-break:break-word;font-size:13.5px;}',
  '.__sl-item .__sl-meta{margin-top:7px;font-size:11px;color:var(--sl-muted);font-weight:500;}',
  '@keyframes __sl-in{from{opacity:0;transform:translateY(-7px) scale(.96);}to{opacity:1;transform:none;}}',
  '.__sl-item.__sl-enter{animation:__sl-in .28s cubic-bezier(.2,.8,.2,1);}',
  '@media (prefers-reduced-motion: reduce){.__sl-item.__sl-enter{animation:none;}}',
  '.__sl-empty{display:flex;flex-direction:column;align-items:center;gap:12px;color:var(--sl-muted);',
  '  text-align:center;padding:48px 18px;}',
  '.__sl-empty svg{width:34px;height:34px;opacity:.5;}',

  // Pins layer: one fixed pass-through layer; only the pins themselves are
  // interactive. Region anchors draw a dashed outline plus a corner pin.
  '#__sl-pins{position:fixed;inset:0;pointer-events:none;}',
  '.__sl-pin{position:fixed;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:999px;',
  '  background:var(--sl-accent);color:var(--sl-accent-ink);font:700 11px/22px inherit;text-align:center;',
  '  box-shadow:0 2px 8px rgba(0,0,0,.35);cursor:pointer;pointer-events:auto;user-select:none;}',
  '.__sl-pin:hover{filter:brightness(1.05);}',
  '.__sl-region{position:fixed;border:2px dashed var(--sl-accent);border-radius:6px;',
  '  background:rgba(245,179,1,.08);}',

  // Pending-capture preview: while the composer is open for a point/region,
  // a provisional pin marks the exact spot, and a dashed contour outlines
  // the DOM element the anchor resolves to — what you see is literally
  // anchorRect() re-resolving the frozen snapshot, i.e. what re-opening the
  // note will find later.
  '#__sl-preview{position:fixed;inset:0;pointer-events:none;}',
  '.__sl-target{position:fixed;border:2px dashed var(--sl-accent);border-radius:8px;',
  '  pointer-events:none;}',
  '@keyframes __sl-ghost-pulse{0%,100%{box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 0 rgba(245,179,1,.45);}',
  '  50%{box-shadow:0 2px 8px rgba(0,0,0,.35),0 0 0 7px rgba(245,179,1,0);}}',
  '.__sl-pin.__sl-ghost{animation:__sl-ghost-pulse 1.4s ease-out infinite;}',
  '@media (prefers-reduced-motion: reduce){.__sl-pin.__sl-ghost{animation:none;}}',

  // Annotate mode: capture layer + instruction banner + live drag rect
  '#__sl-layer{position:fixed;inset:0;display:none;cursor:crosshair;}',
  '#__sl-layer.on{display:block;}',
  '#__sl-drag{position:fixed;display:none;border:2px dashed var(--sl-accent);border-radius:6px;',
  '  background:rgba(245,179,1,.1);pointer-events:none;}',
  '#__sl-banner{position:fixed;top:calc(14px + var(--slideless-topbar,0px));left:50%;transform:translateX(-50%);display:none;',
  '  align-items:center;gap:10px;background:var(--sl-bg);border:1px solid var(--sl-border);',
  '  border-radius:999px;padding:8px 8px 8px 15px;font-size:12.5px;font-weight:500;',
  '  box-shadow:var(--sl-shadow);white-space:nowrap;max-width:92vw;}',
  '#__sl-banner.on{display:inline-flex;}',
  '#__sl-banner .__sl-btn{padding:6px 11px;}',

  // Transient toast (e.g. when a jumped-to section no longer exists)
  '#__sl-toast{position:fixed;left:50%;bottom:80px;transform:translateX(-50%) translateY(10px);',
  '  background:var(--sl-bg);color:var(--sl-ink);border:1px solid var(--sl-border);border-radius:10px;',
  '  padding:10px 15px;font-size:12.5px;font-weight:500;box-shadow:var(--sl-shadow);opacity:0;',
  '  pointer-events:none;max-width:80vw;transition:opacity .25s ease,transform .25s ease;}',
  '#__sl-toast.show{opacity:1;transform:translateX(-50%) translateY(0);}'
].join('\n');

// ---- Icons (feather-style, inherit currentColor) -----------------------
var ICONS = {
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
  pin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>',
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
var popCap = el('div', '__sl-cap', 'New annotation');
var popQuote = el('div', '__sl-quote');
var popName = doc.createElement('input');
popName.maxLength = 120;
popName.placeholder = 'Your name (optional)';
var popText = doc.createElement('textarea');
popText.maxLength = 10000;
popText.placeholder = 'What should change here?';
var popErr = el('div', '__sl-err', 'Could not save your note — please try again.');
var popRow = el('div', '__sl-row');
var popCancel = el('button', '__sl-btn __sl-btn-ghost', 'Cancel');
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

var badge = el('div');
badge.id = '__sl-badge';
var bIcon = el('span', '__sl-bicon');
bIcon.innerHTML = ICONS.mark;
var bLabel = el('span', '__sl-blabel');
var bLabelText = el('span');
bLabel.appendChild(bLabelText);
var bCount = el('span', '__sl-bcount');
badge.appendChild(bIcon);
badge.appendChild(bLabel);
badge.appendChild(bCount);

// The big + FAB: one click into annotate mode, no sheet detour. Lives next
// to the badge and follows its slot.
var fabPin = el('button');
fabPin.id = '__sl-fab-pin';
fabPin.type = 'button';
fabPin.title = 'Add a pin';
fabPin.textContent = '+';

// ---- Badge placement -----------------------------------------------------
// Server-resolved slot (link override ?? deck's remembered default): the 4
// corners + the 4 edge centers. The stylesheet default is bottom-right; a
// slot sets its own sides and pins the others to auto (leaving them empty
// would let the stylesheet's right/bottom stretch the box). Config is
// server-controlled, but validate anyway and fall back to the default. The
// + FAB stacks toward the viewport center from the badge's slot.
// The three TOP slots add the recipient bar's height (PRDCT-2281): the bar
// publishes it as --slideless-topbar on the root (0 when absent or
// collapsed), so the badge never sits under the bar and follows a collapse
// live, with no coupling between the two runtimes.
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
  'top-left': { top: 'calc(74px + ' + TOP_OFFSET + ')', left: '20px' },
  top: { top: 'calc(74px + ' + TOP_OFFSET + ')', left: '50%', transform: 'translateX(-50%)' },
  'top-right': { top: 'calc(74px + ' + TOP_OFFSET + ')', right: '20px' },
  right: { right: '20px', top: 'calc(50% - 62px)', transform: 'translateY(-50%)' },
  'bottom-right': { bottom: '74px', right: '20px' },
  bottom: { bottom: '74px', left: '50%', transform: 'translateX(-50%)' },
  'bottom-left': { bottom: '74px', left: '20px' },
  left: { left: '20px', top: 'calc(50% - 62px)', transform: 'translateY(-50%)' }
};
var currentBadge = BADGE_SLOTS[CFG.badge] ? CFG.badge : 'bottom-right';
var fabBaseTransform = '';
function syncFabTransform() {
  fabPin.style.transform = fabBaseTransform + (mode === 'annotate' ? ' rotate(45deg)' : '');
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
var gearBtn = el('div', '__sl-x');
gearBtn.id = '__sl-gear';
gearBtn.title = 'Annotation settings';
gearBtn.innerHTML = ICONS.gear;
var headClose = el('div', '__sl-x');
headClose.id = '__sl-close';
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
var modeBtn = el('button');
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
var settingsClose = el('div', '__sl-x');
settingsClose.innerHTML = ICONS.close;
shead.appendChild(settingsClose);
settings.appendChild(shead);
settings.appendChild(el('div', '__sl-slabel', 'Notes button position'));
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
settings.appendChild(grid);
var settingsErr = el('div');
settingsErr.id = '__sl-serr';
settingsErr.textContent = 'Could not save the position — it will reset on reload.';
settings.appendChild(settingsErr);
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
  addBtn.style.top = Math.max(8, rect.bottom) + 'px';
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
    if (c.clampY) c.top = Math.max(M, Math.min(c.top, vh - H - M));
    else c.left = Math.max(M, Math.min(c.left, vw - W - M));
    if (c.left < M || c.top < M || c.left + W > vw - M || c.top + H > vh - M) continue;
    var hits = false;
    for (var j = 0; j < avoid.length; j++) {
      if (rectsIntersect(c.left, c.top, W, H, avoid[j])) { hits = true; break; }
    }
    if (!hits) chosen = c;
  }
  if (!chosen) {
    chosen = {
      left: Math.max(M, Math.min(r.left + r.width + GAP, vw - W - M)),
      top: Math.max(M, Math.min(r.top + r.height + GAP, vh - H - M))
    };
  }
  pop.style.left = chosen.left + 'px';
  pop.style.top = chosen.top + 'px';
  pop.style.visibility = '';
}

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
  popText.value = '';
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
  pin.style.top = Math.max(12, Math.min(rect.top, window.innerHeight - 12)) + 'px';
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
  apiCreate(payload).then(function () {
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
  if (pop.style.display === 'block') closeComposer();
});

// ---- Annotate mode (point / region pins) -------------------------------
function setMode(next) {
  mode = next;
  layer.classList.toggle('on', next === 'annotate');
  banner.classList.toggle('on', next === 'annotate');
  if (next === 'annotate') { hideAdd(); closeComposer(); toggleSheet(false); toggleSettings(false); }
  syncFabTransform();
  renderPins();
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
      y: Math.max(12, Math.min(rect.top, window.innerHeight - 12))
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
  var metaBits = [];
  if (a.authorName) metaBits.push(a.authorName);
  metaBits.push('v' + a.version);
  if (a.status === 'resolved') metaBits.push('resolved');
  item.appendChild(el('div', '__sl-meta', metaBits.join(' · ')));
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
    empty.innerHTML = ICONS.empty;
    empty.appendChild(el('div', null, filter === 'open'
      ? 'No open notes yet. Select text, or use “Add pin” to mark a spot.'
      : 'Nothing resolved yet. Notes move here when the deck owner resolves them.'));
    list.appendChild(empty);
    return;
  }
  shown.forEach(function (a) { list.appendChild(renderItem(a)); });
}

function updateBadge() {
  var open = 0;
  for (var i = 0; i < notes.length; i++) { if (notes[i].status === 'open') open++; }
  bCount.textContent = String(open);
  badge.classList.toggle('__sl-has', notes.length > 0);
  bLabelText.textContent = notes.length === 0
    ? 'Select text or pin a spot to leave a note'
    : (open > 0 ? 'Review your notes' : 'All notes resolved');
  tabOpen._count.textContent = '(' + open + ')';
  tabDone._count.textContent = '(' + (notes.length - open) + ')';
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
  root.appendChild(dragBox);
  root.appendChild(addBtn);
  root.appendChild(pop);
  root.appendChild(badge);
  root.appendChild(fabPin);
  root.appendChild(sheet);
  root.appendChild(scrim);
  root.appendChild(settings);
  root.appendChild(banner);
  root.appendChild(toast);
  doc.body.appendChild(root);
  refresh().then(jumpFromHash);
  // Teach once per load: gently expand the badge to reveal the hint, then
  // collapse. Skipped when we arrived via a cross-page jump.
  if (!/__slanno=/.test(location.hash || '')) {
    setTimeout(function () {
      badge.classList.add('__sl-open');
      setTimeout(function () { badge.classList.remove('__sl-open'); }, 4200);
    }, 700);
  }
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

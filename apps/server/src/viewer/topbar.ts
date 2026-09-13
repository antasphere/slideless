/**
 * The recipient TOP BAR (PRDCT-2281): the third runtime on the injection
 * seam (viewer/inject.ts), beside the annotation overlay and the forms
 * runtime. A slim strip over the deck on a share link, telling the
 * recipient what they are looking at — the deck's title, `v{n}`, a small
 * Slideless mark — and, when the version carries attachments and the link
 * allows downloads, a Download menu listing each file and the whole set as
 * a zip. Read-only plus downloads; no owner action, no login, no version
 * history (a link resolves to ONE version and that is the only set a
 * recipient can take — the owner's history is the master page on the app
 * origin). Vanilla JS + inline CSS, zero external requests: no font, no
 * image, no CDN.
 *
 * WHERE IT MOUNTS. Top-level document navigations only, on links with
 * `show_bar` (default on): the server gate is `browserEntry` (Sec-Fetch-Dest
 * document) and the runtime refuses `self !== top` as belt-and-braces, so
 * an `embed.js` embed, a plain iframe and a nested frame of a multi-page
 * deck stay bare. The password gate and the error shells are built by
 * `shellHtml` in viewer/routes.ts and never enter the seam. Multi-page decks
 * get the bar on every HTML sub-page opened as a document, like the
 * overlay, so it survives a navigation to page2.
 *
 * TRUST BOUNDARY — the same regime as the overlay and the forms runtime,
 * and the same rule for the injected config: every value the server places
 * here must be one the deck could already obtain by itself, or plain
 * context the server re-derives at read time. The config carries the
 * unlock proof (password links; scoped to viewer calls on this same token,
 * the deck could always call the API with it), the deck's title and
 * version (what the bar exists to show), and one boolean saying whether a
 * list is worth fetching. No identity, no owner secret, no session. The
 * key set is pinned CLOSED by an integration assertion (viewer-topbar
 * .test.ts) so a new key turns a test red until argued past the rule.
 *
 *  - The bar calls exactly one endpoint, `/api/v1/viewer/{secret}/
 *    attachments`, relative to the deck page, `credentials: 'omit'` (the
 *    Firefox opaque-origin residual, ADR 012), authenticated by the secret
 *    it reads from `location.pathname` plus the unlock proof — never a
 *    cookie, never a session. The download links point at the two
 *    attachment routes, served `attachment` + `nosniff` by the viewer.
 *  - It mounts in a SHADOW ROOT: deck CSS cannot restyle the bar and the
 *    bar's stylesheet cannot reach the deck. The root is `open` so the
 *    browser suite can look inside; the isolation wanted is CSS-level, and
 *    a closed root would be no security boundary against deck JS anyway
 *    (same document, same origin).
 *  - The deck is PUSHED DOWN, never covered: the root element gets a top
 *    margin the height of the bar, a height reduced by the same amount and
 *    vertical scrolling, as `!important` inline styles (the strongest
 *    author-level declaration; a deck's own `!important` sheet rule loses
 *    to it). A deck sized with `100%` chains fits exactly; a deck sized in
 *    viewport units cannot shrink (vh resolves against the window, not
 *    against any box) and scrolls by the bar's height instead of losing
 *    its bottom. Collapsing the bar to its handle gives the deck its
 *    viewport back. The one shape this cannot reach is a `position:
 *    fixed; inset: 0` body, which ignores the root's margin by design.
 *  - The overlay follows the bar through ONE custom property on the root,
 *    `--slideless-topbar` (the bar's current height): its top badge slots
 *    add it to their offset, so the badge never sits under the bar and
 *    tracks a collapse live. No JS coupling between the two runtimes.
 *  - Event isolation as the overlay does it: pointer, key and wheel events
 *    stop at the host so a click on Download never advances a deck that
 *    navigates on document clicks.
 *  - The collapse state is remembered per link: `sessionStorage` when the
 *    document can reach it, else `window.name` — the deck runs in a
 *    sandboxed opaque origin where every storage access THROWS (ADR 012),
 *    and the window name is the one per-tab slot that survives there. The
 *    key is a 32-bit fingerprint of the path, never the secret: the name
 *    is readable by whatever page the tab navigates to next.
 *
 * The config JSON is server-controlled; it is serialized with `<` escaped
 * so a `</script>` sequence in a deck title can never break out.
 */

export interface TopbarConfig {
  /** The deck's title, as the owner named it (owner content, shown as text). */
  title: string;
  /** The deck version this view resolved to (pinned or latest). */
  version: number;
  /** Signed unlock proof for password-protected tokens (else null). */
  unlock: string | null;
  /**
   * True when a Download menu is worth building: the version carries
   * attachments AND the link allows downloads. False = no request is made.
   * Context only: the list endpoint re-derives both at read time and
   * answers an empty list on a link with downloads off.
   */
  downloads: boolean;
}

/** Attribute marking the injected script — tests and humans grep for it. */
export const TOPBAR_MARKER = 'data-slideless-topbar';

/** The bar's height, expanded and collapsed (its handle), in CSS px. */
export const TOPBAR_HEIGHT_PX = 44;
export const TOPBAR_HANDLE_PX = 10;

/** The root custom property the overlay reads to keep its top slots clear. */
export const TOPBAR_OFFSET_PROPERTY = '--slideless-topbar';

const TOPBAR_JS = String.raw`
var doc = document;
if (!doc || !doc.documentElement) return;
// Top browsing context only: an embed, a plain iframe or a nested frame of
// the deck stays bare. Never mount twice (a deck could re-run scripts).
if (window.self !== window.top) return;
if (window.__slidelessTopbarLoaded) return;
window.__slidelessTopbarLoaded = true;
var fetchFn = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
if (typeof Element.prototype.attachShadow !== 'function') return;

// ---- URL model ---------------------------------------------------------
// The viewer serves the deck under /v/{secret}[/{path}]. The RAW (still
// percent-encoded) secret segment authenticates the list call and prefixes
// the two download routes.
var rawSecret, listUrl;
try {
  var seg = location.pathname.split('/');
  if (seg[1] !== 'v' || !seg[2]) return;
  rawSecret = seg[2];
  listUrl = new URL('/api/v1/viewer/' + rawSecret + '/attachments', location.href).toString();
} catch (e) { return; }

var BAR = ${TOPBAR_HEIGHT_PX};
var HANDLE = ${TOPBAR_HANDLE_PX};
var OFFSET_PROP = '${TOPBAR_OFFSET_PROPERTY}';

function encodePath(p) {
  return p.split('/').map(function (s) { return encodeURIComponent(s); }).join('/');
}
function fileUrl(name) { return '/v/' + rawSecret + '/downloads/' + encodePath(name); }
function zipUrl() { return '/v/' + rawSecret + '/downloads.zip'; }
function fmtSize(n) {
  if (typeof n !== 'number' || !(n >= 0)) return '';
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

// ---- Collapse memory ---------------------------------------------------
// sessionStorage first (a future non-sandboxed context), then window.name:
// the opaque origin throws on every storage access. Keyed by a 32-bit
// fingerprint of the path so the name never carries the secret.
function fingerprint(s) {
  var h = 5381;
  for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}
var memKey = 'slbar:' + fingerprint('/v/' + rawSecret);
var memory = {
  read: function () {
    try { var v = window.sessionStorage.getItem(memKey); if (v !== null) return v === '0'; } catch (e) {}
    try {
      var name = String(window.name || '');
      if (name.indexOf('{"__slidelessBar":') === 0) {
        var parsed = JSON.parse(name).__slidelessBar;
        if (parsed && Object.prototype.hasOwnProperty.call(parsed, memKey)) return parsed[memKey] === 0;
      }
    } catch (e2) {}
    return false;
  },
  write: function (collapsed) {
    try { window.sessionStorage.setItem(memKey, collapsed ? '0' : '1'); return; } catch (e) {}
    try {
      var name = String(window.name || '');
      var state = {};
      if (name.indexOf('{"__slidelessBar":') === 0) state = JSON.parse(name).__slidelessBar || {};
      else if (name !== '') return; // the deck (or a popup opener) owns the name: keep in memory only
      state[memKey] = collapsed ? 0 : 1;
      window.name = JSON.stringify({ __slidelessBar: state });
    } catch (e2) {}
  }
};

// ---- Styles (inside the shadow root: unreachable from deck CSS) --------
var css = [
  ':host{all:initial;position:fixed;top:0;left:0;right:0;z-index:2147483001;display:block;',
  '  height:' + BAR + 'px;font:13px/1.4 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;',
  '  color:#ededf2;-webkit-font-smoothing:antialiased;}',
  ':host([data-collapsed]){height:' + HANDLE + 'px;}',
  '*{box-sizing:border-box;margin:0;padding:0;}',
  '.bar{display:flex;align-items:center;gap:12px;height:' + BAR + 'px;padding:0 14px;',
  '  background:#17171d;border-bottom:1px solid #2b2b36;box-shadow:0 1px 0 rgba(0,0,0,.35);}',
  ':host([data-collapsed]) .bar{display:none;}',
  '.mark{display:inline-flex;align-items:center;gap:6px;color:#9b9baa;font-weight:600;',
  '  letter-spacing:.02em;white-space:nowrap;text-decoration:none;}',
  '.mark svg{width:14px;height:14px;display:block;}',
  '.title{flex:1;min-width:0;display:flex;align-items:baseline;gap:8px;}',
  '.title strong{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.version{flex:none;font:600 11px/18px inherit;padding:0 7px;border-radius:999px;',
  '  background:#2b2b36;color:#c9c9d4;}',
  'button{appearance:none;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;}',
  '.dl{position:relative;}',
  '.dl>button{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:8px;',
  '  background:#f5b301;color:#1a1505;font-weight:600;}',
  '.dl>button:hover{filter:brightness(1.05);}',
  '.dl>button svg{width:14px;height:14px;}',
  '.menu{display:none;position:absolute;top:36px;right:0;min-width:260px;max-width:min(420px,92vw);',
  '  background:#1f1f28;border:1px solid #363643;border-radius:12px;padding:6px;',
  '  box-shadow:0 12px 40px rgba(0,0,0,.46);}',
  '.dl[data-open] .menu{display:block;}',
  '.menu a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;',
  '  color:#ededf2;text-decoration:none;}',
  '.menu a:hover,.menu a:focus{background:#2b2b36;outline:none;}',
  '.menu .name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
  '.menu .size{flex:none;color:#9b9baa;font-size:12px;}',
  '.menu .all{margin-top:4px;padding-top:8px;border-top:1px solid #2b2b36;font-weight:600;}',
  '.hide{width:30px;height:30px;border-radius:8px;color:#9b9baa;display:inline-flex;align-items:center;',
  '  justify-content:center;}',
  '.hide:hover,.hide:focus-visible{background:#2b2b36;color:#ededf2;outline:none;}',
  '.hide svg{width:16px;height:16px;}',
  '.handle{display:none;position:absolute;top:0;left:50%;transform:translateX(-50%);height:' + HANDLE + 'px;',
  '  width:72px;border-radius:0 0 8px 8px;background:#17171d;border:1px solid #2b2b36;border-top:0;',
  '  color:#9b9baa;align-items:center;justify-content:center;}',
  '.handle:hover,.handle:focus-visible{color:#ededf2;outline:none;height:' + (HANDLE + 4) + 'px;}',
  '.handle svg{width:12px;height:8px;}',
  ':host([data-collapsed]) .handle{display:inline-flex;}',
  'button:focus-visible{box-shadow:0 0 0 2px #f5b301;}',
  '@media (prefers-color-scheme: light){',
  '  :host{color:#1d1d24;}',
  '  .bar{background:#ffffff;border-bottom-color:#e6e6ec;box-shadow:0 1px 0 rgba(20,20,40,.08);}',
  '  .mark{color:#6c6c78;} .version{background:#f0f0f4;color:#4a4a58;}',
  '  .menu{background:#ffffff;border-color:#dadae2;box-shadow:0 12px 40px rgba(20,20,40,.16);}',
  '  .menu a{color:#1d1d24;} .menu a:hover,.menu a:focus{background:#f6f6f9;}',
  '  .menu .all{border-top-color:#e6e6ec;}',
  '  .hide{color:#6c6c78;} .hide:hover,.hide:focus-visible{background:#f6f6f9;color:#1d1d24;}',
  '  .handle{background:#ffffff;border-color:#e6e6ec;color:#6c6c78;} .handle:hover{color:#1d1d24;}',
  '}'
].join('\n');

var ICONS = {
  mark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/></svg>',
  up: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 12" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 3 6 6 6-6"/></svg>'
};

function el(tag, cls, text) {
  var n = doc.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// ---- Build the DOM (in the shadow root) ---------------------------------
var host = el('div');
host.id = '__slideless_topbar';
var shadow = host.attachShadow({ mode: 'open' });
var style = doc.createElement('style');
style.textContent = css;

var bar = el('div', 'bar');
bar.setAttribute('role', 'region');
bar.setAttribute('aria-label', 'Presentation');

var mark = el('span', 'mark');
mark.innerHTML = ICONS.mark;
mark.appendChild(el('span', null, 'Slideless'));

var title = el('div', 'title');
var titleText = el('strong', null, String(CFG.title || 'Presentation'));
titleText.title = String(CFG.title || '');
title.appendChild(titleText);
title.appendChild(el('span', 'version', 'v' + CFG.version));

var dl = el('div', 'dl');
var dlBtn = el('button');
dlBtn.type = 'button';
dlBtn.setAttribute('aria-haspopup', 'menu');
dlBtn.setAttribute('aria-expanded', 'false');
dlBtn.innerHTML = ICONS.download;
dlBtn.appendChild(el('span', null, 'Download'));
var menu = el('div', 'menu');
menu.setAttribute('role', 'menu');
dl.appendChild(dlBtn);
dl.appendChild(menu);
dl.style.display = 'none';

var hideBtn = el('button', 'hide');
hideBtn.type = 'button';
hideBtn.title = 'Hide this bar';
hideBtn.setAttribute('aria-label', 'Hide this bar');
hideBtn.innerHTML = ICONS.up;

var handle = el('button', 'handle');
handle.type = 'button';
handle.title = 'Show the bar';
handle.setAttribute('aria-label', 'Show the presentation bar');
handle.innerHTML = ICONS.down;

bar.appendChild(mark);
bar.appendChild(title);
bar.appendChild(dl);
bar.appendChild(hideBtn);
shadow.appendChild(style);
shadow.appendChild(bar);
shadow.appendChild(handle);

// ---- Event isolation (the overlay's rule) --------------------------------
// Deck scripts navigate slides off document-level click/key listeners; a
// click on Download must never reach them.
[
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
  'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'wheel'
].forEach(function (type) {
  host.addEventListener(type, function (ev) { ev.stopPropagation(); });
});

// ---- Layout: push the deck down by the bar's height ----------------------
var collapsed = false;
function applyLayout() {
  var h = collapsed ? HANDLE : BAR;
  var root = doc.documentElement;
  // The handle floats over the deck's first pixels; the deck gets its
  // viewport back when the bar is collapsed.
  var push = collapsed ? 0 : h;
  root.style.setProperty('margin-top', push + 'px', 'important');
  root.style.setProperty('height', push ? 'calc(100% - ' + push + 'px)' : '', push ? 'important' : '');
  root.style.setProperty('overflow-y', push ? 'auto' : '', push ? 'important' : '');
  root.style.setProperty('scroll-padding-top', push + 'px', 'important');
  root.style.setProperty(OFFSET_PROP, push + 'px');
  if (collapsed) host.setAttribute('data-collapsed', '');
  else host.removeAttribute('data-collapsed');
  dlBtn.setAttribute('aria-expanded', 'false');
  dl.removeAttribute('data-open');
}
function setCollapsed(next, remember) {
  collapsed = !!next;
  applyLayout();
  if (remember) memory.write(collapsed);
  (collapsed ? handle : hideBtn).focus({ preventScroll: true });
}
hideBtn.addEventListener('click', function () { setCollapsed(true, true); });
handle.addEventListener('click', function () { setCollapsed(false, true); });
// Esc collapses the bar (or closes the menu) only while focus is inside it,
// so a deck's own Esc handling is never hijacked. Capture phase: the host's
// stopPropagation above must not starve it.
doc.addEventListener('keydown', function (e) {
  if (e.key !== 'Escape' || doc.activeElement !== host) return;
  if (dl.hasAttribute('data-open')) { closeMenu(); dlBtn.focus(); return; }
  if (!collapsed) setCollapsed(true, true);
}, true);

// ---- The download menu ---------------------------------------------------
function closeMenu() {
  dl.removeAttribute('data-open');
  dlBtn.setAttribute('aria-expanded', 'false');
}
function openMenu() {
  dl.setAttribute('data-open', '');
  dlBtn.setAttribute('aria-expanded', 'true');
  var first = menu.querySelector('a');
  if (first) first.focus();
}
dlBtn.addEventListener('click', function () {
  if (dl.hasAttribute('data-open')) closeMenu(); else openMenu();
});
menu.addEventListener('click', function () { closeMenu(); });
// A click anywhere on the deck closes the menu (the deck's mousedown never
// reaches the host, so listen on the document).
doc.addEventListener('mousedown', function () { closeMenu(); });
menu.addEventListener('keydown', function (e) {
  var items = menu.querySelectorAll('a');
  if (!items.length) return;
  var idx = Array.prototype.indexOf.call(items, shadow.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(idx + 1) % items.length].focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(idx - 1 + items.length) % items.length].focus(); }
});

function renderMenu(files) {
  menu.textContent = '';
  if (!files.length) { dl.style.display = 'none'; return; }
  files.forEach(function (f) {
    var a = el('a');
    a.setAttribute('role', 'menuitem');
    a.href = fileUrl(f.name);
    a.appendChild(el('span', 'name', f.name));
    a.appendChild(el('span', 'size', fmtSize(f.sizeBytes)));
    menu.appendChild(a);
  });
  var all = el('a', 'all');
  all.setAttribute('role', 'menuitem');
  all.href = zipUrl();
  all.appendChild(el('span', 'name', 'Download all (' + files.length + ' file' + (files.length === 1 ? '' : 's') + ')'));
  all.appendChild(el('span', 'size', 'zip'));
  menu.appendChild(all);
  dl.style.display = '';
}

function loadAttachments() {
  if (!CFG.downloads || !fetchFn) return;
  var h = {};
  if (CFG.unlock) h['x-slideless-unlock'] = CFG.unlock;
  fetchFn(listUrl, { method: 'GET', headers: h, credentials: 'omit', mode: 'cors', cache: 'no-store' })
    .then(function (res) { return res.ok ? res.json() : null; })
    .then(function (data) {
      var list = data && Array.isArray(data.attachments) ? data.attachments : [];
      renderMenu(list.filter(function (f) { return f && typeof f.name === 'string' && f.name; }));
    })
    .catch(function () { renderMenu([]); });
}

// ---- Mount ---------------------------------------------------------------
function mount() {
  if (!doc.body) return;
  collapsed = memory.read();
  doc.body.appendChild(host);
  applyLayout();
  loadAttachments();
}
// The offset property is set before the overlay's script runs (the bar's
// tag precedes it in the plan), so its slots are right from the first paint.
doc.documentElement.style.setProperty(OFFSET_PROP, (memory.read() ? 0 : BAR) + 'px');
if (doc.readyState === 'loading') {
  doc.addEventListener('DOMContentLoaded', mount);
} else {
  mount();
}
`;

/**
 * The full inline script tag to inject before `</body>`, BEFORE the overlay's
 * tag so the root offset is in place when the overlay places its badge. The
 * config is embedded as escaped JSON; everything runs inside one IIFE so the
 * deck's global namespace is untouched.
 */
export function topbarScriptTag(cfg: TopbarConfig): string {
  const json = JSON.stringify({
    title: cfg.title,
    version: cfg.version,
    unlock: cfg.unlock,
    downloads: cfg.downloads
  }).replace(/</g, '\\u003c');
  return `\n<script ${TOPBAR_MARKER}>\n(function(){\n"use strict";\ntry{\nvar CFG=${json};\n${TOPBAR_JS}\n}catch(e){}\n})();\n</script>\n`;
}

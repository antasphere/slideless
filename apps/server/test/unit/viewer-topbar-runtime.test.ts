import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MOTION_DURATION_MS, MOTION_EASING } from '@slideless/contract';
import { ANTASPHERE_MARK_PATH } from '../../src/viewer/antasphere-mark.js';
import { TOPBAR_HEIGHT_PX, TOPBAR_OFFSET_PROPERTY, topbarScriptTag } from '../../src/viewer/topbar.js';

/**
 * The recipient bar's runtime, RUN (PRDCT-2281): the injected script executed
 * in a Node vm against a minimal fake window, so the three guards the ticket
 * names are pinned by BEHAVIOUR, not by a string in the source — a guard
 * that is still spelled but no longer returns goes red here. Verifier round
 * 1 (2026-09-13) found the string pins in viewer-topbar.test.ts insufficient
 * for exactly that mutation.
 *
 * The fake DOM is the smallest one the runtime needs to mount: elements are
 * plain objects with the handful of members the script touches, the shadow
 * root records what was attached, `fetch` records its call. Nothing here
 * proves layout or clicks; the browser spec does.
 */

interface FakeEl {
  tag: string;
  id: string;
  className: string;
  textContent: string;
  innerHTML: string;
  type: string;
  title: string;
  href: string;
  children: FakeEl[];
  attrs: Map<string, string>;
  style: {
    props: Map<string, string>;
    setProperty: (k: string, v: string, p?: string) => void;
    removeProperty: (k: string) => void;
    display: string;
  };
  shadowRoot: FakeRoot | null;
  appendChild: (c: FakeEl) => FakeEl;
  setAttribute: (k: string, v: string) => void;
  getAttribute: (k: string) => string | null;
  removeAttribute: (k: string) => void;
  hasAttribute: (k: string) => boolean;
  addEventListener: (t: string, fn: unknown) => void;
  querySelector: (s: string) => FakeEl | null;
  querySelectorAll: (s: string) => FakeEl[];
  focus: () => void;
  attachShadow: (init: { mode: string }) => FakeRoot;
}

interface FakeRoot {
  mode: string;
  children: FakeEl[];
  activeElement: FakeEl | null;
  appendChild: (c: FakeEl) => FakeEl;
  querySelector: (s: string) => FakeEl | null;
  querySelectorAll: (s: string) => FakeEl[];
}

function makeEl(tag: string, shadowRoots: FakeRoot[]): FakeEl {
  const el: FakeEl = {
    tag,
    id: '',
    className: '',
    textContent: '',
    innerHTML: '',
    type: '',
    title: '',
    href: '',
    children: [],
    attrs: new Map(),
    style: {
      props: new Map(),
      display: '',
      setProperty(k, v, p) {
        this.props.set(k, `${v}${p ? ` !${p}` : ''}`);
      },
      removeProperty(k) {
        this.props.delete(k);
      }
    },
    shadowRoot: null,
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    setAttribute(k, v) {
      el.attrs.set(k, v);
    },
    getAttribute(k) {
      return el.attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      el.attrs.delete(k);
    },
    hasAttribute(k) {
      return el.attrs.has(k);
    },
    addEventListener() {},
    querySelector() {
      return null;
    },
    querySelectorAll() {
      return [];
    },
    focus() {},
    attachShadow(init) {
      const root: FakeRoot = {
        mode: init.mode,
        children: [],
        activeElement: null,
        appendChild(c) {
          root.children.push(c);
          return c;
        },
        querySelector() {
          return null;
        },
        querySelectorAll() {
          return [];
        }
      };
      el.shadowRoot = root;
      shadowRoots.push(root);
      return root;
    }
  };
  return el;
}

interface Run {
  win: Record<string, unknown>;
  root: FakeEl;
  body: FakeEl;
  shadowRoots: FakeRoot[];
  fetches: Array<{ url: string; init: Record<string, unknown> }>;
  listeners: Array<{ target: string; type: string }>;
}

/** Execute the injected tag in a fake window; `top` decides the browsing context. */
function run(
  cfg: { title: string; version: number; unlock: string | null; downloads: boolean },
  opts: { top: boolean; tag?: string; attachments?: Array<{ name: string; sizeBytes: number }> } = {
    top: true
  },
  extraWindow: Record<string, unknown> = {}
): Run {
  const tag = opts.tag ?? topbarScriptTag(cfg);
  const src = /<script[^>]*>([\s\S]*)<\/script>/.exec(tag)?.[1];
  if (!src) throw new Error('no script body in the tag');

  const shadowRoots: FakeRoot[] = [];
  const fetches: Run['fetches'] = [];
  const listeners: Run['listeners'] = [];
  const root = makeEl('html', shadowRoots);
  const body = makeEl('body', shadowRoots);
  const document = {
    documentElement: root,
    body,
    readyState: 'complete',
    activeElement: null,
    createElement: (t: string) => makeEl(t, shadowRoots),
    addEventListener: (type: string) => listeners.push({ target: 'document', type })
  };
  const win: Record<string, unknown> = {
    document,
    location: { pathname: '/v/SECRET123/', href: 'http://decks.test/v/SECRET123/' },
    URL,
    JSON,
    Object,
    String,
    Array,
    Math,
    parseFloat,
    isNaN,
    Element: { prototype: { attachShadow() {} } },
    name: '',
    fetch: (url: string, init: Record<string, unknown>) => {
      fetches.push({ url, init });
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: 1, attachments: opts.attachments ?? [] })
      });
    },
    // No layout in a vm: the body never reads as clipped.
    getComputedStyle: () => ({ overflowY: 'visible' }),
    ...extraWindow
  };
  // The sandboxed opaque origin: every storage access throws (ADR 012).
  Object.defineProperty(win, 'sessionStorage', {
    get() {
      throw new Error('SecurityError: The document is sandboxed');
    }
  });
  win['window'] = win;
  win['self'] = win;
  win['top'] = opts.top ? win : { other: true };
  runInNewContext(src, win);
  return { win, root, body, shadowRoots, fetches, listeners };
}

const CFG = { title: 'Quarterly review', version: 3, unlock: null, downloads: true };

describe('the runtime, executed', () => {
  it('in the top browsing context: mounts once, in an open shadow root, and pushes the deck down', () => {
    const r = run(CFG);
    expect(r.win['__slidelessTopbarLoaded']).toBe(true);
    expect(r.shadowRoots).toHaveLength(1);
    expect(r.shadowRoots[0]!.mode).toBe('open');
    expect(r.body.children.map((c) => c.id)).toEqual(['__slideless_topbar']);
    expect(r.root.style.props.get('margin-top')).toBe(`${TOPBAR_HEIGHT_PX}px !important`);
    expect(r.root.style.props.get(TOPBAR_OFFSET_PROPERTY)).toBe(`${TOPBAR_HEIGHT_PX}px`);
    // A second run of the same script on the same window mounts nothing more.
    const again = /<script[^>]*>([\s\S]*)<\/script>/.exec(topbarScriptTag(CFG))![1]!;
    runInNewContext(again, r.win);
    expect(r.body.children).toHaveLength(1);
  });

  it('in a frame: mounts nothing, fetches nothing, touches nothing', () => {
    const r = run(CFG, { top: false });
    expect(r.win['__slidelessTopbarLoaded']).toBeUndefined();
    expect(r.shadowRoots).toHaveLength(0);
    expect(r.body.children).toHaveLength(0);
    expect(r.fetches).toHaveLength(0);
    expect(r.root.style.props.size).toBe(0);
  });

  it('calls the attachments list exactly once, cookie-less, relative to the page, with the unlock proof', () => {
    const r = run({ ...CFG, unlock: 'proof-value' });
    expect(r.fetches).toHaveLength(1);
    const call = r.fetches[0]!;
    expect(call.url).toBe('http://decks.test/api/v1/viewer/SECRET123/attachments');
    expect(call.init['credentials']).toBe('omit');
    expect(call.init['method']).toBe('GET');
    expect((call.init['headers'] as Record<string, string>)['x-slideless-unlock']).toBe('proof-value');
    // No proof on a password-less link.
    const bare = run(CFG);
    expect(
      (bare.fetches[0]!.init['headers'] as Record<string, string>)['x-slideless-unlock']
    ).toBeUndefined();
  });

  it('makes no request at all when the server said there is nothing to list', () => {
    const r = run({ ...CFG, downloads: false });
    expect(r.win['__slidelessTopbarLoaded']).toBe(true);
    expect(r.fetches).toHaveLength(0);
  });

  it('pins the host layout inline and important: an outer deck rule cannot move or hide it', () => {
    const r = run(CFG);
    const host = r.body.children[0]!;
    // The one declaration level an outer stylesheet cannot beat (verifier round 2, F2).
    for (const [k, v] of [
      ['position', 'fixed'],
      ['top', '0px'],
      ['left', '0px'],
      ['right', '0px'],
      ['height', `${TOPBAR_HEIGHT_PX}px`],
      ['display', 'block'],
      ['transform', 'none'],
      ['z-index', '2147483001']
    ]) {
      expect(host.style.props.get(k!), k).toBe(`${v} !important`);
    }
  });

  it('builds absolute download links against the page, so a deck base href cannot redirect them', async () => {
    const r = run(CFG, { top: true, attachments: [{ name: 'sub dir/an&nex #1.pdf', sizeBytes: 12 }] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const menu = r.shadowRoots[0]!.children.find((c) => c.className === 'bar')!.children.find(
      (c) => c.className === 'dl'
    )!.children[1]!;
    const hrefs = menu.children.map((a) => a.href);
    expect(hrefs).toEqual([
      'http://decks.test/v/SECRET123/downloads/sub%20dir/an%26nex%20%231.pdf',
      'http://decks.test/v/SECRET123/downloads.zip'
    ]);
  });

  it('survives the sandbox: storage throws and the bar still mounts, expanded', () => {
    const r = run(CFG);
    expect(r.body.children[0]!.hasAttribute('data-collapsed')).toBe(false);
  });

  // ── PRDCT-2308: the mark, the neutral button, the one motion ──────────

  const strip = (r: Run) => r.shadowRoots[0]!.children.find((c) => c.className === 'bar')!;
  const stylesheet = (r: Run) => r.shadowRoots[0]!.children.find((c) => c.tag === 'style')!.textContent;

  it('shows the Antasphere mark inline, the brand path verbatim in the bar colour, and no Slideless word', () => {
    const r = run(CFG);
    const mark = strip(r).children.find((c) => c.className === 'mark')!;
    expect(mark.innerHTML).toContain(`<path d="${ANTASPHERE_MARK_PATH}"/>`);
    expect(mark.innerHTML).toContain('fill="currentColor"');
    expect(mark.innerHTML).toContain('viewBox="0 0 512 512"');
    expect(mark.getAttribute('aria-label')).toBe('Antasphere');
    // No text child: the word is gone, the mark stands alone.
    expect(mark.children).toHaveLength(0);
    expect(mark.textContent).toBe('');
    expect(stylesheet(r)).toContain('.mark{display:inline-flex;align-items:center;color:inherit;');
  });

  it('carries the one motion, the contract values verbatim, and turns it off under reduced motion', () => {
    const css = stylesheet(run(CFG));
    const motion = `${MOTION_DURATION_MS}ms ${MOTION_EASING}`;
    // The strip's fold, the download menu and the handle all move with it.
    expect(css).toContain(
      `.bar{display:flex;align-items:center;gap:12px;height:${TOPBAR_HEIGHT_PX}px;padding:0 14px;`
    );
    expect(css).toContain(`transition:transform ${motion},opacity ${motion},visibility 0s linear 0s;}`);
    expect(css).toContain(
      `:host([data-collapsed]) .bar{transform:translateY(-100%);opacity:0;visibility:hidden;`
    );
    expect(css).toContain(`.dl[data-open] .menu{visibility:visible;opacity:1;transform:none;`);
    expect(css).toContain(`transition:opacity ${motion},transform ${motion},visibility 0s linear 0s;}`);
    expect(css).toContain(
      `:host([data-collapsed]) .handle{visibility:visible;opacity:1;pointer-events:auto;`
    );
    expect(css).toContain(
      '@media (prefers-reduced-motion: reduce){.bar,.menu,.handle{transition:none !important;}}'
    );
    // Nothing is hidden with display:none any more: the fold would have nothing to animate.
    expect(css).not.toContain(':host([data-collapsed]) .bar{display:none;}');
    expect(css).not.toContain('.menu{display:none;');
  });

  it('the download button wears the bar’s neutral tones, never the accent', () => {
    const css = stylesheet(run(CFG));
    expect(css).not.toContain('#f5b301');
    expect(css).toContain(
      '.dl>button{display:inline-flex;align-items:center;gap:7px;height:30px;padding:0 12px;border-radius:8px;'
    );
    expect(css).toContain('background:#2b2b36;color:#ededf2;font-weight:600;}');
    expect(css).toContain('.dl>button{background:#f0f0f4;color:#1d1d24;}');
  });

  it('arms the layout motion only after the first paint, and never in a frame or without a frame clock', () => {
    // No requestAnimationFrame in the vm: the bar mounts with no transition
    // on the host or the root, so a page never animates its own arrival.
    const r = run(CFG);
    const host = r.body.children[0]!;
    expect(host.style.props.has('transition')).toBe(false);
    expect(r.root.style.props.has('transition')).toBe(false);
    // With a frame clock, the two transitions are set after two frames.
    const frames: Array<() => void> = [];
    const clocked = run(CFG, { top: true }, { requestAnimationFrame: (fn: () => void) => frames.push(fn) });
    expect(clocked.body.children[0]!.style.props.has('transition')).toBe(false);
    frames.shift()!();
    frames.shift()!();
    expect(clocked.body.children[0]!.style.props.get('transition')).toBe(
      `height ${MOTION_DURATION_MS}ms ${MOTION_EASING} !important`
    );
    expect(clocked.root.style.props.get('transition')).toBe(
      `margin-top ${MOTION_DURATION_MS}ms ${MOTION_EASING} !important`
    );
  });

  it('never arms the layout motion for a reader who asked for reduced motion (verifier round 1, G1)', () => {
    const frames: Array<() => void> = [];
    const r = run(
      CFG,
      { top: true },
      {
        requestAnimationFrame: (fn: () => void) => frames.push(fn),
        matchMedia: () => ({ matches: true })
      }
    );
    while (frames.length) frames.shift()!();
    expect(r.body.children[0]!.style.props.has('transition')).toBe(false);
    expect(r.root.style.props.has('transition')).toBe(false);
  });

  it('appends its margin transition to a root transition the deck already has (verifier round 1, F2)', () => {
    const frames: Array<() => void> = [];
    const r = run(
      CFG,
      { top: true },
      {
        requestAnimationFrame: (fn: () => void) => frames.push(fn),
        getComputedStyle: () => ({ overflowY: 'visible', transition: 'background 5s ease 0s' })
      }
    );
    while (frames.length) frames.shift()!();
    expect(r.root.style.props.get('transition')).toBe(
      `background 5s ease 0s, margin-top ${MOTION_DURATION_MS}ms ${MOTION_EASING} !important`
    );
  });

  it('ships the brand file’s path, byte for byte (verifier round 1, G5)', () => {
    // The sha256 of the `d` attribute of company/brand src/brand/mark-light.svg
    // on 14 September 2026 (mark-dark.svg carries the same path). A redraw,
    // a rounding or a hand edit of the constant goes red here; a real change
    // of the mark updates this digest together with the constant.
    expect(createHash('sha256').update(ANTASPHERE_MARK_PATH).digest('hex')).toBe(
      '27a38ef3b11983ab711412c1691c01af7104178a92f722697ad615398f0cf129'
    );
    expect(ANTASPHERE_MARK_PATH).toHaveLength(4723);
    expect(ANTASPHERE_MARK_PATH.startsWith('M382.20,266.76 L488.75,266.76')).toBe(true);
    const r = run(CFG);
    const mark = r.shadowRoots[0]!.children.find((c) => c.className === 'bar')!.children.find(
      (c) => c.className === 'mark'
    )!;
    expect(mark.innerHTML).toContain(ANTASPHERE_MARK_PATH);
  });
});

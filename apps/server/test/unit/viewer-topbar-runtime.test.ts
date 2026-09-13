import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
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
  opts: { top: boolean; tag?: string } = { top: true }
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
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ version: 1, attachments: [] }) });
    }
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

  it('survives the sandbox: storage throws and the bar still mounts, expanded', () => {
    const r = run(CFG);
    expect(r.body.children[0]!.hasAttribute('data-collapsed')).toBe(false);
  });
});

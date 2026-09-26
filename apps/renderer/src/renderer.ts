import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserServer, type Route } from 'playwright-core';

/**
 * The still image of a deck version (PRDCT-2725): its entry page opened at a
 * 1280 × 720 desktop viewport in headless Chromium, captured at 960 × 540 and
 * encoded as WebP.
 *
 * SECURITY: the renderer container is the one place Slideless opens
 * USER-AUTHORED HTML, with its script running, and it holds nothing else: no
 * database, no storage, no secret but the shared one. Every layer below is
 * load-bearing; none replaces another.
 *
 *  1. Chromium's OWN sandbox, always (`chromiumSandbox: true`). Where the
 *     sandbox cannot start (a container that forbids user namespaces), the
 *     launch fails and capture is OFF — cards keep the drawn plate. There is
 *     no `--no-sandbox` fallback and no switch that adds one: without the
 *     sandbox a renderer exploit in any deck runs as this process, next to
 *     the instance's secrets.
 *  2. The network is the version's own files and nothing else. Every request
 *     the page makes is intercepted: a GET on the synthetic deck origin is
 *     answered from the version's manifest (through `resolve`), everything
 *     else — another origin, a POST, the metadata server, a private host, the
 *     public internet — is aborted before it leaves. WebSockets are closed,
 *     service workers blocked. Beneath the interception, the browser is
 *     pointed at a dead proxy and every host name resolves to nothing, so a
 *     request that ever escaped the interception (a browser-internal fetch,
 *     a future Chromium feature) still reaches no one.
 *  3. The process gets a clean environment (never this process's secrets), a
 *     throwaway profile directory, a V8 heap cap, one renderer process, and
 *     a hard wall-clock timeout that SIGKILLs the whole browser.
 *  4. One capture at a time per process (the caller serializes; the class
 *     refuses to overlap), and a fresh browser for every capture: nothing a
 *     deck leaves behind reaches the next deck.
 */

/** The synthetic origin a deck is served on inside the renderer. `.invalid` never resolves (RFC 2606). */
export const DECK_ORIGIN = 'https://deck.slideless.invalid';

export const CAPTURE_VIEWPORT = { width: 1280, height: 720 } as const;
/** 1280 × 0.75 = 960 px wide: sharp on a 480 CSS px card at 2x, the widest the dashboard draws one. */
export const CAPTURE_SCALE = 0.75;
export const CAPTURE_WIDTH = Math.round(CAPTURE_VIEWPORT.width * CAPTURE_SCALE);
export const CAPTURE_HEIGHT = Math.round(CAPTURE_VIEWPORT.height * CAPTURE_SCALE);

/** A file the page asked for, as the manifest holds it. */
export interface ResolvedFile {
  contentType: string;
  body: Buffer;
}

export interface CaptureInput {
  /** The version's entry document, a manifest path (`index.html`, `deck/start.html`). */
  entryPath: string;
  /**
   * The version's own file at a DECODED manifest path, or null (answered 404).
   * The caller owns the lookup rule (exact manifest match, traversal-safe).
   */
  resolve: (path: string) => Promise<ResolvedFile | null>;
}

export interface ThumbnailRenderer {
  /** The WebP bytes of the version's first page. Throws on any failure. */
  capture(input: CaptureInput): Promise<Buffer>;
}

export interface ChromiumRendererOptions {
  executablePath: string;
  /** Whole capture, launch to encoded bytes. */
  timeoutMs?: number;
  /** Total bytes the page may pull from the version (a deck's files are already capped one by one). */
  maxServedBytes?: number;
  /** After `load`: fonts, a first paint of script-built slides. */
  settleMs?: number;
}

/** Raised when Chromium would not start sandboxed: capture must stay off, not retry per version. */
export class SandboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`Chromium's sandbox could not start: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SandboxUnavailableError';
  }
}

export class CaptureTimeoutError extends Error {
  constructor(ms: number) {
    super(`capture exceeded ${ms} ms`);
    this.name = 'CaptureTimeoutError';
  }
}

/** Flags beneath the interception. Order does not matter; each one is a floor, not the wall. */
export const CHROMIUM_ARGS: readonly string[] = [
  // A proxy nothing listens on: any request that bypassed interception dies here.
  '--proxy-server=http://127.0.0.1:9',
  '--proxy-bypass-list=<-loopback>',
  // Every host name resolves to nothing — no DNS query leaves either.
  '--host-resolver-rules=MAP * ~NOTFOUND',
  '--dns-prefetch-disable',
  '--disable-background-networking',
  '--disable-component-update',
  '--disable-domain-reliability',
  '--disable-sync',
  '--no-pings',
  '--no-first-run',
  '--disable-extensions',
  '--disable-default-apps',
  '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--webrtc-ip-handling-policy=disable_non_proxied_udp',
  '--mute-audio',
  '--disable-gpu',
  // Containers ship a small /dev/shm; Chromium then writes shared memory to /tmp.
  '--disable-dev-shm-usage',
  '--renderer-process-limit=1',
  '--js-flags=--max-old-space-size=256'
];

/** Sandbox launch failures, as Chromium words them on Linux (namespaces, the setuid helper) and Playwright relays them. */
const SANDBOX_FAILURE =
  /No usable sandbox|namespace|Zygote|zygote|setuid sandbox|sandbox_host_linux|Operation not permitted/i;

export class ChromiumRenderer implements ThumbnailRenderer {
  private readonly timeoutMs: number;
  private readonly maxServedBytes: number;
  private readonly settleMs: number;
  private busy = false;

  constructor(private readonly opts: ChromiumRendererOptions) {
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxServedBytes = opts.maxServedBytes ?? 64 * 1024 * 1024;
    this.settleMs = opts.settleMs ?? 400;
  }

  async capture(input: CaptureInput): Promise<Buffer> {
    if (this.busy) throw new Error('a capture is already running in this process');
    this.busy = true;
    const profileDir = await mkdtemp(join(tmpdir(), 'slideless-capture-'));
    let server: BrowserServer | null = null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const work = (async () => {
        try {
          server = await chromium.launchServer({
            executablePath: this.opts.executablePath,
            headless: true,
            chromiumSandbox: true,
            // Playwright makes its own throwaway profile; HOME and TMPDIR point
            // into ours, removed after the capture.
            args: [...CHROMIUM_ARGS],
            // A clean environment: never this process's (DATABASE_URL, AUTH_SECRET, …).
            env: { HOME: profileDir, TMPDIR: profileDir, PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
            handleSIGINT: false,
            handleSIGTERM: false,
            handleSIGHUP: false,
            timeout: this.timeoutMs
          });
        } catch (e) {
          if (SANDBOX_FAILURE.test(e instanceof Error ? e.message : String(e))) {
            throw new SandboxUnavailableError(e);
          }
          throw e;
        }
        const browser = await chromium.connect(server.wsEndpoint(), { timeout: this.timeoutMs });
        try {
          const png = await this.screenshot(browser, input);
          return await encodeWebp(browser, png);
        } finally {
          await browser.close().catch(() => {});
        }
      })();
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new CaptureTimeoutError(this.timeoutMs)), this.timeoutMs);
      });
      return await Promise.race([work, deadline]);
    } finally {
      clearTimeout(timer);
      // SIGKILL the whole browser whatever happened: a hung renderer, a
      // timeout, a thrown step. kill() is a no-op on an exited process.
      const s = server as BrowserServer | null;
      if (s) await s.kill().catch(() => {});
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
      this.busy = false;
    }
  }

  private async screenshot(browser: Browser, input: CaptureInput): Promise<Buffer> {
    const context = await browser.newContext({
      viewport: { ...CAPTURE_VIEWPORT },
      deviceScaleFactor: CAPTURE_SCALE,
      javaScriptEnabled: true,
      serviceWorkers: 'block',
      acceptDownloads: false,
      permissions: [],
      locale: 'en-US'
    });
    try {
      let served = 0;
      await context.route('**/*', async (route: Route) => {
        const request = route.request();
        let url: URL;
        try {
          url = new URL(request.url());
        } catch {
          return route.abort('blockedbyclient');
        }
        if (url.origin !== DECK_ORIGIN || (request.method() !== 'GET' && request.method() !== 'HEAD')) {
          return route.abort('blockedbyclient');
        }
        const path = decodeDeckPath(url.pathname);
        const file = path === null ? null : await input.resolve(path).catch(() => null);
        if (!file || served + file.body.length > this.maxServedBytes) {
          return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
        }
        served += file.body.length;
        return route.fulfill({ status: 200, contentType: file.contentType, body: file.body });
      });
      await context.routeWebSocket(/.*/, (ws) => ws.close());

      const page = await context.newPage();
      // A deck cannot hold the capture on a modal or open windows.
      page.on('dialog', (d) => void d.dismiss().catch(() => {}));
      page.on('popup', (p) => void p.close().catch(() => {}));

      await page.goto(`${DECK_ORIGIN}/${encodeDeckPath(input.entryPath)}`, {
        waitUntil: 'load',
        timeout: this.timeoutMs
      });
      await page.waitForTimeout(this.settleMs);
      return await page.screenshot({
        type: 'png',
        animations: 'disabled',
        caret: 'hide',
        timeout: this.timeoutMs
      });
    } finally {
      await context.close().catch(() => {});
    }
  }
}

/**
 * PNG → WebP inside the same (already sandboxed) browser, in a FRESH context
 * that carries no deck and reaches nothing: Chromium's own encoder, so the
 * image needs no native module in the server. The deck's context is closed
 * before this runs.
 */
async function encodeWebp(browser: Browser, png: Buffer): Promise<Buffer> {
  const context = await browser.newContext({ javaScriptEnabled: true, serviceWorkers: 'block' });
  try {
    await context.route('**/*', (route) => route.abort('blockedbyclient'));
    const page = await context.newPage();
    const b64 = await page.evaluate(async (pngB64: string) => {
      // Runs in the page: the server's typings carry no DOM, so the two
      // browser globals it needs are typed here.
      const g = globalThis as unknown as {
        createImageBitmap(b: Blob): Promise<{ width: number; height: number }>;
        OffscreenCanvas: new (
          w: number,
          h: number
        ) => {
          getContext(k: '2d'): { drawImage(img: unknown, x: number, y: number): void } | null;
          convertToBlob(o: { type: string; quality: number }): Promise<Blob>;
        };
      };
      const bytes = Uint8Array.from(atob(pngB64), (ch) => ch.charCodeAt(0));
      const bitmap = await g.createImageBitmap(new Blob([bytes], { type: 'image/png' }));
      const canvas = new g.OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: 'image/webp', quality: 0.8 });
      if (blob.type !== 'image/webp') throw new Error(`encoder produced ${blob.type}`);
      const out = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < out.length; i += 0x8000) s += String.fromCharCode(...out.subarray(i, i + 0x8000));
      return btoa(s);
    }, png.toString('base64'));
    return Buffer.from(b64, 'base64');
  } finally {
    await context.close().catch(() => {});
  }
}

/** A manifest path as URL path segments (each percent-encoded). */
export function encodeDeckPath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

/** The URL path back to a manifest path, or null when it does not decode. Leading slash dropped. */
export function decodeDeckPath(pathname: string): string | null {
  try {
    return pathname.replace(/^\/+/, '').split('/').map(decodeURIComponent).join('/');
  } catch {
    return null;
  }
}

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium } from 'playwright-core';
import {
  CAPTURE_HEIGHT,
  CAPTURE_WIDTH,
  CaptureTimeoutError,
  ChromiumRenderer,
  decodeDeckPath,
  encodeDeckPath,
  type ResolvedFile
} from '../src/renderer.js';

/**
 * The REAL Chromium renderer of a deck version's still image (PRDCT-2725):
 * the image it makes, and the walls around the user-authored page it opens
 * (the version's own files and nothing else reach it; a modal or a loop can
 * not hold it). Runs when a Chromium exists — RENDERER_TEST_CHROMIUM, or
 * playwright-core's own download — and is skipped, saying why, otherwise.
 */

/**
 * playwright-core's headless shell beside its full Chrome when it is there:
 * a capture there takes about a second, where the full "Chrome for Testing"
 * on macOS takes several — more than the 4 s timeout case leaves for its
 * follow-up capture.
 */
function headlessShellBeside(fullChrome: string): string | null {
  const m = /^(.*[/\\]ms-playwright)[/\\]chromium-(\d+)[/\\]/.exec(fullChrome);
  if (!m) return null;
  const root = join(m[1]!, `chromium_headless_shell-${m[2]}`);
  if (!existsSync(root)) return null;
  for (const dir of readdirSync(root)) {
    for (const name of ['chrome-headless-shell', 'headless_shell']) {
      const candidate = join(root, dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function findChromium(): string | null {
  const fromEnv = process.env.RENDERER_TEST_CHROMIUM;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  try {
    const bundled = chromium.executablePath();
    if (bundled && existsSync(bundled)) return headlessShellBeside(bundled) ?? bundled;
  } catch {
    // playwright-core throws when it has no browser for this platform.
  }
  return null;
}

const CHROMIUM = findChromium();
if (!CHROMIUM) {
  console.warn(
    'renderer.test.ts: no Chromium (set RENDERER_TEST_CHROMIUM or run `npx playwright-core install chromium-headless-shell`) — the real-renderer cases are skipped'
  );
}

/** A deck version as `resolve` sees it: manifest paths → files, every lookup recorded. */
function deck(files: Record<string, { contentType: string; body: string | Buffer }>) {
  const asked: string[] = [];
  const resolve = async (path: string): Promise<ResolvedFile | null> => {
    asked.push(path);
    const f = files[path];
    return f ? { contentType: f.contentType, body: Buffer.from(f.body) } : null;
  };
  return { asked, resolve };
}

/** WebP magic and the canvas size, from the VP8 / VP8L / VP8X header. */
function webpInfo(b: Buffer): { width: number; height: number } {
  expect(b.subarray(0, 4).toString('ascii')).toBe('RIFF');
  expect(b.subarray(8, 12).toString('ascii')).toBe('WEBP');
  const chunk = b.subarray(12, 16).toString('ascii');
  if (chunk === 'VP8 ') {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

const HTML = 'text/html; charset=utf-8';

describe.skipIf(!CHROMIUM)('ChromiumRenderer (real Chromium)', () => {
  /** The production timeout: a cold Chromium launch alone can take seconds on a laptop. */
  let renderer: ChromiumRenderer;
  let server: Server;
  let port = 0;
  let serverHits = 0;

  beforeAll(async () => {
    renderer = new ChromiumRenderer({ executablePath: CHROMIUM! });
    server = createServer((_req, res) => {
      serverHits += 1;
      res.end('reached');
    });
    server.on('upgrade', (_req, socket) => {
      serverHits += 1;
      socket.destroy();
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('captures the entry page as a 960 × 540 WebP, reading files in a folder whose name has a space', async () => {
    const d = deck({
      'index.html': {
        contentType: HTML,
        body:
          '<!doctype html><html><head><link rel="stylesheet" href="style.css"></head>' +
          '<body><h1>Quarterly</h1><img src="my assets/pic.svg" width="200" height="100"></body></html>'
      },
      'style.css': { contentType: 'text/css', body: 'body { background: #123456; color: white; }' },
      'my assets/pic.svg': {
        contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="tomato"/></svg>'
      }
    });
    const webp = await renderer.capture({ entryPath: 'index.html', resolve: d.resolve });
    expect(webpInfo(webp)).toEqual({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT });
    expect({ width: CAPTURE_WIDTH, height: CAPTURE_HEIGHT }).toEqual({ width: 960, height: 540 });
    expect(d.asked).toContain('style.css');
    expect(d.asked).toContain('my assets/pic.svg');
  }, 30_000);

  it('the page reaches its own files and nothing else: no local server, no POST, no WebSocket, no metadata host', async () => {
    serverHits = 0;
    const d = deck({
      'index.html': {
        contentType: HTML,
        body: `<!doctype html><html><body><h1>net</h1>
<img src="http://127.0.0.1:${port}/pixel.png">
<script>
  fetch('http://127.0.0.1:${port}/fetch').catch(() => {});
  fetch('/submit', { method: 'POST', body: 'secret' }).catch(() => {});
  try { new WebSocket('ws://127.0.0.1:${port}/ws'); } catch (e) {}
  fetch('http://169.254.169.254/latest/meta-data/').catch(() => {});
  navigator.sendBeacon && navigator.sendBeacon('http://127.0.0.1:${port}/beacon', 'x');
</script></body></html>`
      }
    });
    const webp = await renderer.capture({ entryPath: 'index.html', resolve: d.resolve });
    expect(webpInfo(webp).width).toBe(CAPTURE_WIDTH);
    // Give anything that escaped a moment to land.
    await new Promise((r) => setTimeout(r, 300));
    expect(serverHits).toBe(0);
    expect(d.asked).not.toContain('submit');
    // The origin wall itself (verifier round 1, R6): a request to another
    // origin is aborted BEFORE the resolver is asked, so the page's own files
    // are the only paths that ever reach it.
    expect([...new Set(d.asked)].sort()).toEqual(['index.html']);
  }, 30_000);

  it('a modal dialog does not hold the capture', async () => {
    const d = deck({
      'index.html': {
        contentType: HTML,
        body: '<!doctype html><body><script>alert("x")</script><h1>after</h1></body>'
      }
    });
    const webp = await renderer.capture({ entryPath: 'index.html', resolve: d.resolve });
    expect(webpInfo(webp).height).toBe(CAPTURE_HEIGHT);
  }, 30_000);

  it('a page that never ends is killed at the timeout, and the next capture on the same renderer works', async () => {
    const short = new ChromiumRenderer({ executablePath: CHROMIUM!, timeoutMs: 4000 });
    const looping = deck({
      'index.html': {
        contentType: HTML,
        body: '<!doctype html><body><script>while (true) {}</script></body>'
      }
    });
    const started = Date.now();
    await expect(short.capture({ entryPath: 'index.html', resolve: looping.resolve })).rejects.toBeInstanceOf(
      CaptureTimeoutError
    );
    expect(Date.now() - started).toBeLessThan(4000 + 5000);

    const fine = deck({
      'index.html': { contentType: HTML, body: '<!doctype html><body><h1>fine</h1></body>' }
    });
    const webp = await short.capture({ entryPath: 'index.html', resolve: fine.resolve });
    expect(webpInfo(webp).width).toBe(CAPTURE_WIDTH);
  }, 40_000);
});

describe('deck paths on the synthetic origin', () => {
  it('encodes each segment and decodes back to the manifest path', () => {
    expect(encodeDeckPath('my assets/pic 1.svg')).toBe('my%20assets/pic%201.svg');
    expect(encodeDeckPath('a/b#c?d.css')).toBe('a/b%23c%3Fd.css');
    for (const p of ['index.html', 'my assets/pic 1.svg', 'deck/é/ü.png', 'a/b#c?d.css']) {
      expect(decodeDeckPath(`/${encodeDeckPath(p)}`)).toBe(p);
    }
  });

  it('drops the leading slashes, and refuses what does not decode', () => {
    expect(decodeDeckPath('//index.html')).toBe('index.html');
    expect(decodeDeckPath('/bad%E0%A4%A.css')).toBeNull();
  });
});

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ChromiumRenderer, SandboxUnavailableError, type ResolvedFile } from './renderer.js';

/**
 * `node dist/thumbnail-selfcheck.js` (PRDCT-2725): proves, in the bare image,
 * that the still-image capture starts Chromium SANDBOXED and that a deck's
 * script reaches nothing but the deck's own files. No secrets, no database,
 * no storage, no env required.
 *
 * Exit codes: 0 the capture ran and every check held; 3 Chromium's sandbox
 * could not start (the container's seccomp profile forbids user namespaces —
 * see docs/self-hosting/install.md, "Deck images"); 1 anything else.
 */

const DEFAULT_CHROMIUM_PATH = '/usr/bin/chromium-browser';

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
  });
}

function fixture(port: number): Map<string, ResolvedFile> {
  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>Self-check</title>
<link rel="stylesheet" href="s.css">
</head>
<body>
<h1>Slideless still-image self-check</h1>
<img src="img/a.svg" alt="">
<script>
for (const url of [
  'http://127.0.0.1:${port}/leak',
  'http://169.254.169.254/computeMetadata/v1/',
  'https://example.com/'
]) {
  fetch(url).catch(() => {});
}
try {
  const ws = new WebSocket('ws://127.0.0.1:${port}/');
  ws.onerror = () => {};
} catch {}
</script>
</body>
</html>
`;
  const css =
    'body { margin: 0; background: #0f172a; color: #f8fafc; font-family: sans-serif; } h1 { padding: 48px; }\n';
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><rect width="200" height="120" fill="#38bdf8"/></svg>\n';
  return new Map<string, ResolvedFile>([
    ['index.html', { contentType: 'text/html; charset=utf-8', body: Buffer.from(html) }],
    ['s.css', { contentType: 'text/css; charset=utf-8', body: Buffer.from(css) }],
    ['img/a.svg', { contentType: 'image/svg+xml', body: Buffer.from(svg) }]
  ]);
}

async function main(): Promise<number> {
  let localServerHits = 0;
  const server = createServer((req, res) => {
    localServerHits += 1;
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('reached');
  });
  // A WebSocket upgrade that got through would land here, not in the request handler.
  server.on('upgrade', (_req, socket) => {
    localServerHits += 1;
    socket.destroy();
  });
  const port = await listen(server);
  const files = fixture(port);
  const resolved: string[] = [];

  const renderer = new ChromiumRenderer({
    executablePath: process.env.SLIDELESS_CHROMIUM_PATH || DEFAULT_CHROMIUM_PATH,
    timeoutMs: 30_000
  });

  const started = Date.now();
  try {
    const out = await renderer.capture({
      entryPath: 'index.html',
      resolve: async (path) => {
        resolved.push(path);
        return files.get(path) ?? null;
      }
    });
    const ms = Date.now() - started;
    // Let any request that escaped reach the local server before counting.
    await new Promise((r) => setTimeout(r, 250));

    const isWebp =
      out.length > 12 &&
      out.subarray(0, 4).toString('latin1') === 'RIFF' &&
      out.subarray(8, 12).toString('latin1') === 'WEBP';
    const missing = ['index.html', 's.css', 'img/a.svg'].filter((p) => !resolved.includes(p));
    const ok = isWebp && localServerHits === 0 && missing.length === 0;
    console.log(JSON.stringify({ ok, bytes: out.length, ms, localServerHits, resolved }));
    if (!isWebp) console.error('the capture did not produce a WebP image');
    if (localServerHits !== 0) console.error(`the deck reached the local server ${localServerHits} time(s)`);
    if (missing.length) console.error(`the deck's own files were not all asked for: ${missing.join(', ')}`);
    return ok ? 0 : 1;
  } catch (e) {
    const ms = Date.now() - started;
    console.log(JSON.stringify({ ok: false, bytes: 0, ms, localServerHits, resolved }));
    if (e instanceof SandboxUnavailableError) {
      console.error(e.message);
      return 3;
    }
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    return 1;
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

main().then(
  (code) => process.exit(code),
  (e: unknown) => {
    console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
    process.exit(1);
  }
);

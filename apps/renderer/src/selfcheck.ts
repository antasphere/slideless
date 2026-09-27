import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { basename } from 'node:path';
import { readChromiumPath } from './config.js';
import { ChromiumRenderer, SandboxUnavailableError, type ResolvedFile } from './renderer.js';

/**
 * The renderer's self-check (PRDCT-2725), run at every boot before a job is
 * taken and on its own as `node dist/selfcheck.js`: it proves that Chromium
 * starts SANDBOXED and that a deck's script reaches nothing but the deck's
 * own files. No Slideless, no secret, no network.
 *
 * Codes: 0 the capture ran and every check held; 3 Chromium's sandbox could
 * not start (the container runs without deploy/seccomp-chromium.json, whose
 * namespace calls the sandbox needs); 1 anything else.
 */

export interface SelfCheckSummary {
  ok: boolean;
  bytes: number;
  ms: number;
  localServerHits: number;
  resolved: string[];
}

export interface SelfCheckResult {
  code: 0 | 1 | 3;
  summary: SelfCheckSummary;
  message?: string;
}

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

export async function runSelfCheck(renderer: ChromiumRenderer): Promise<SelfCheckResult> {
  let localServerHits = 0;
  const server = createServer((_req, res) => {
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
    const problems: string[] = [];
    if (!isWebp) problems.push('the capture did not produce a WebP image');
    if (localServerHits !== 0) problems.push(`the deck reached the local server ${localServerHits} time(s)`);
    if (missing.length) problems.push(`the deck's own files were not all asked for: ${missing.join(', ')}`);
    const summary = { ok, bytes: out.length, ms, localServerHits, resolved };
    return ok ? { code: 0, summary } : { code: 1, summary, message: problems.join('; ') };
  } catch (e) {
    const summary = { ok: false, bytes: 0, ms: Date.now() - started, localServerHits, resolved };
    if (e instanceof SandboxUnavailableError) return { code: 3, summary, message: e.message };
    return { code: 1, summary, message: e instanceof Error ? (e.stack ?? e.message) : String(e) };
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function main(): Promise<number> {
  // Only the Chromium path is read here: the self-check needs no Slideless and no secret.
  const chromium = readChromiumPath(process.env);
  if ('problem' in chromium) {
    console.error(chromium.problem);
    return 1;
  }
  const result = await runSelfCheck(
    new ChromiumRenderer({ executablePath: chromium.path, timeoutMs: 30_000 })
  );
  console.log(JSON.stringify(result.summary));
  if (result.message) console.error(result.message);
  return result.code;
}

/**
 * Run as a CLI only when THIS is the entry script. Not `import.meta.url ===
 * argv[1]`: tsup bundles this module into `dist/index.js` (or a shared chunk)
 * too, where `import.meta.url` names the bundle, not this file, so that test
 * either runs the CLI inside the server or never runs it at all.
 */
export function isSelfCheckEntry(argv1: string | undefined): boolean {
  return !!argv1 && /^selfcheck\.[cm]?[jt]s$/.test(basename(argv1));
}

if (isSelfCheckEntry(process.argv[1])) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? (e.stack ?? e.message) : String(e));
      process.exit(1);
    }
  );
}

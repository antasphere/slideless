import { watch, type FSWatcher } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { contentTypeFor } from './manifest.js';

/**
 * `slideless dev` — a LOCAL, backendless preview server. It serves the deck
 * folder with the exact ADR 012 viewer posture (CSP `sandbox`, nosniff,
 * no-referrer), so authors preview precisely what share-link recipients will
 * see: same isolation, same relative-path resolution. HTML responses get a
 * tiny SSE live-reload client injected; any file change reloads the page.
 *
 * The sandbox header set mirrors apps/server/src/viewer/routes.ts
 * (VIEWER_CONTENT_HEADERS) — keep them in lockstep.
 */

export const DEV_SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

const CONTENT_HEADERS: Record<string, string> = {
  'content-security-policy': DEV_SANDBOX_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

const RELOAD_PATH = '/__slideless/reload';

const RELOAD_SNIPPET = `<script>
(() => {
  const connect = () => {
    const es = new EventSource('${RELOAD_PATH}');
    es.addEventListener('reload', () => location.reload());
    es.onerror = () => { es.close(); setTimeout(connect, 1000); };
  };
  connect();
})();
</script>`;

export interface DevServerOptions {
  root: string;
  /** Relative path of the document served at `/`. */
  entryPath: string;
  port: number;
  host?: string;
}

export interface DevServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

function injectReload(html: string): string {
  const idx = html.lastIndexOf('</body>');
  if (idx === -1) return html + RELOAD_SNIPPET;
  return html.slice(0, idx) + RELOAD_SNIPPET + html.slice(idx);
}

/**
 * A served path must stay inside the deck root REALLY, not just lexically:
 * `resolve()` + `startsWith()` is blind to symlinks, so a link inside the
 * folder used to serve any file the developer could read (/etc/passwd, .env,
 * the CLI's own credential file). Dot-prefixed segments are refused outright
 * — nothing a deck needs starts with a dot, and it is where the secrets are.
 */
async function resolveServable(root: string, relPath: string): Promise<string | null> {
  if (relPath === '' || isAbsolute(relPath)) return null;
  // A backslash is a path separator on Windows and a legal filename
  // character on POSIX — refuse it either way rather than resolve it.
  if (relPath.includes('\\')) return null;
  if (relPath.split('/').some((seg) => seg.startsWith('.'))) return null;
  const target = resolve(root, relPath);
  const lexical = relative(root, target);
  if (lexical === '' || lexical.startsWith('..') || isAbsolute(lexical)) return null;
  const real = await realpath(target).catch(() => null);
  if (real === null) return null;
  const actual = relative(root, real);
  if (actual === '' || actual.startsWith('..') || isAbsolute(actual)) return null;
  return real;
}

/**
 * DNS rebinding: a page on any origin can make the browser resolve some
 * hostname to 127.0.0.1 and then read this server's responses. The Host
 * header is the only thing that distinguishes such a request from a real
 * one, so anything but the address the server actually bound is refused.
 */
function hostAllowed(req: IncomingMessage, allowed: ReadonlySet<string>): boolean {
  const host = req.headers.host;
  if (!host) return false;
  return allowed.has(host.toLowerCase());
}

/** Host:port values this server answers to (the bound address + loopback aliases). */
function allowedHosts(host: string, port: number): Set<string> {
  const names = new Set<string>([host]);
  const loopback = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
  if (loopback) {
    names.add('127.0.0.1');
    names.add('localhost');
    names.add('[::1]');
  }
  const out = new Set<string>();
  for (const name of names) {
    out.add(`${name}:${port}`.toLowerCase());
    // A default-port URL omits it; the dev server never binds 80, but keep
    // the mapping honest rather than special-casing later.
    if (port === 80) out.add(name.toLowerCase());
  }
  return out;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  // realpath the root once: every containment check below compares against
  // the REAL directory, so a symlinked deck folder still works.
  const root = await realpath(resolve(options.root));
  const host = options.host ?? '127.0.0.1';
  const sseClients = new Set<ServerResponse>();
  let allowed: ReadonlySet<string> = new Set<string>();

  const server: Server = createServer((req, res) => {
    void (async () => {
      if (!hostAllowed(req, allowed)) {
        res.writeHead(403, CONTENT_HEADERS).end('Forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      let pathname: string;
      try {
        pathname = decodeURIComponent(url.pathname);
      } catch {
        res.writeHead(400, CONTENT_HEADERS).end('Bad request');
        return;
      }

      if (pathname === RELOAD_PATH) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      const relPath = pathname === '/' ? options.entryPath : pathname.replace(/^\/+/, '');
      const target = await resolveServable(root, relPath);
      if (target === null) {
        res.writeHead(404, CONTENT_HEADERS).end('Not found');
        return;
      }
      const info = await stat(target).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, CONTENT_HEADERS).end('Not found');
        return;
      }

      const contentType = contentTypeFor(target);
      if (contentType === 'text/html') {
        const html = injectReload(await readFile(target, 'utf8'));
        res.writeHead(200, { ...CONTENT_HEADERS, 'content-type': 'text/html; charset=utf-8' }).end(html);
        return;
      }
      const bytes = await readFile(target);
      res.writeHead(200, { ...CONTENT_HEADERS, 'content-type': contentType }).end(bytes);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, CONTENT_HEADERS);
      res.end('Internal error');
    });
  });

  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const broadcast = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      for (const client of sseClients) client.write('event: reload\ndata: now\n\n');
    }, 100);
  };
  try {
    watcher = watch(root, { recursive: true }, broadcast);
  } catch {
    // Recursive watch unavailable (older Linux) — top-level changes only.
    try {
      watcher = watch(root, broadcast);
    } catch {
      watcher = null;
    }
  }

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(options.port, host, () => {
      // The real port is known only here (port 0 = ephemeral), and the Host
      // allowlist must exist before the first request can land.
      const bound = server.address();
      allowed = allowedHosts(host, typeof bound === 'object' && bound ? bound.port : options.port);
      resolvePromise();
    });
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : options.port;

  return {
    url: `http://${host}:${port}/`,
    port,
    close: async () => {
      watcher?.close();
      if (debounce) clearTimeout(debounce);
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  };
}

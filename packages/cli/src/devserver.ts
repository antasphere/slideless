import { watch, type FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { resolve, sep } from 'node:path';
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

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const root = resolve(options.root);
  const host = options.host ?? '127.0.0.1';
  const sseClients = new Set<ServerResponse>();

  const server: Server = createServer((req, res) => {
    void (async () => {
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
      // Traversal guard: the resolved target must stay inside the deck root.
      const target = resolve(root, relPath);
      if (target !== root && !target.startsWith(root + sep)) {
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
    server.listen(options.port, host, () => resolvePromise());
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

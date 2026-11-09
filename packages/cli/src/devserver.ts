import { randomBytes } from 'node:crypto';
import { createReadStream, watch, type FSWatcher } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isAbsolute, relative, resolve } from 'node:path';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { contentTypeFor } from './manifest.js';
import {
  blobPath,
  listLocalVersions,
  openLocalStore,
  readLocalVersion,
  snapshot as takeSnapshot,
  type SnapshotResult
} from './localversions.js';

/**
 * `slideless dev` — a LOCAL, backendless preview server, and the local
 * artefact rail Clave renders HTML artefacts through (PRDCT-4260).
 *
 * The deck's files are served with the exact ADR 012 viewer posture (CSP
 * `sandbox`, nosniff, no-referrer), so authors preview precisely what
 * share-link recipients will see: same isolation, same relative-path
 * resolution. The sandbox header set mirrors apps/server/src/viewer/routes.ts
 * (VIEWER_CONTENT_HEADERS) — keep them in lockstep.
 *
 * `/` is NOT the deck: it is a small wrapper page holding the deck in a
 * sandboxed iframe under a version bar. The wrapper is what listens to the
 * reload stream: a sandboxed document has an opaque origin, so a stream it
 * opened itself was cross-origin and every browser refused it (PRDCT-4070:
 * the reload this command promised never fired). The wrapper is an ordinary
 * same-origin page, so its stream works, and it reloads the frame.
 *
 * Local versions: the bar lists the folder's versions from the local store
 * (`localversions.ts`), shows the live folder, the latest version, or any
 * one version served from its own blobs, and takes a snapshot on demand.
 * The host that started the server (Clave, at the end of an agent's turn)
 * takes one with `POST /__slideless/snapshot`.
 *
 * Routes, all behind the Host allowlist:
 *   GET  /                               the wrapper (`?bar=0` hides the bar, `?v=live|latest|<n>`)
 *   GET  /__slideless/reload             SSE: `reload` on a file change, `versions` on a new version
 *   GET  /__slideless/versions           JSON: the CLI version, the entry, the versions
 *   POST /__slideless/snapshot           JSON: take a version (header `x-slideless: snapshot`)
 *   GET  /__slideless/v/<n>/<path>       a file of version n, from the store
 *   GET  /<path>                         a file of the live folder
 */

export const DEV_SANDBOX_CSP =
  'sandbox allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads';

const CONTENT_HEADERS: Record<string, string> = {
  'content-security-policy': DEV_SANDBOX_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

const PLAIN_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store'
};

export const DEV_ROUTE_PREFIX = '/__slideless/';
const RELOAD_PATH = '/__slideless/reload';
const VERSIONS_PATH = '/__slideless/versions';
const SNAPSHOT_PATH = '/__slideless/snapshot';
const VERSION_FILE_RE = /^\/__slideless\/v\/([1-9][0-9]{0,8})\/(.*)$/;
/** The header a snapshot request must carry: a custom header forces a CORS preflight, which is never answered. */
export const SNAPSHOT_HEADER = 'x-slideless';
const SNAPSHOT_HEADER_VALUE = 'snapshot';

export interface DevServerOptions {
  root: string;
  /** Relative path of the document the wrapper frames. */
  entryPath: string;
  port: number;
  host?: string;
  /** The local version store (default: the user's, see `defaultLocalStore`). */
  store?: string;
  /** The CLI's version, said on the versions route so a host can refuse an old CLI. */
  cliVersion?: string | undefined;
}

export interface DevServer {
  url: string;
  port: number;
  /** The real store root, or null when versions are unavailable (`storeError` says why). */
  store: string | null;
  storeError: string | null;
  /** Take a version now, exactly as the snapshot route does. */
  snapshot(): Promise<SnapshotResult>;
  close(): Promise<void>;
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

/** A path relative to the root, as a URL path (each segment encoded). */
function urlPath(relPath: string): string {
  return relPath.split('/').map(encodeURIComponent).join('/');
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res
    .writeHead(status, { ...PLAIN_HEADERS, 'content-type': 'application/json; charset=utf-8' })
    .end(`${JSON.stringify(body)}\n`);
}

/**
 * The wrapper's own policy: nothing but its nonce'd script and style, the
 * frame and the stream from this origin. It carries no `sandbox`: it is the
 * one same-origin document here, and it never shows the deck's content
 * itself.
 */
function wrapperCsp(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `style-src 'nonce-${nonce}'`,
    "connect-src 'self'",
    "frame-src 'self'",
    "img-src 'self' data:",
    "base-uri 'none'",
    "form-action 'none'"
  ].join('; ');
}

function wrapperHtml(nonce: string, entryPath: string): string {
  const entryUrl = JSON.stringify(`/${urlPath(entryPath)}`);
  const entry = JSON.stringify(entryPath);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Slideless · local</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --ink: #1d1b16; --muted: #6f6a5f; --ground: #f4f1ea; --line: #ddd7ca; --accent: #2f5bd3; }
  @media (prefers-color-scheme: dark) { :root { --ink: #ece8df; --muted: #a39d90; --ground: #1c1b18; --line: #34322c; --accent: #8fb0ff; } }
  html, body { margin: 0; height: 100%; background: var(--ground); color: var(--ink); font: 13px/1.3 system-ui, -apple-system, "Segoe UI", sans-serif; }
  body { display: flex; flex-direction: column; }
  #bar { display: flex; align-items: center; gap: 8px; padding: 6px 10px; border-bottom: 1px solid var(--line); flex: none; }
  #bar[hidden] { display: none; }
  #name { font-weight: 600; white-space: nowrap; }
  #sel { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 3px 6px; max-width: 46ch; }
  button { font: inherit; color: inherit; background: transparent; border: 1px solid var(--line); border-radius: 6px; padding: 3px 10px; cursor: pointer; }
  button:hover { border-color: var(--accent); }
  button[hidden] { display: none; }
  #status { color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #spacer { flex: 1; }
  #deck { flex: 1; width: 100%; border: 0; background: #fff; }
</style>
</head>
<body>
<div id="bar" role="toolbar" aria-label="Versions">
  <span id="name">Slideless</span>
  <select id="sel" aria-label="What to show"></select>
  <button id="back" type="button" hidden>Back to live</button>
  <span id="spacer"></span>
  <span id="status" role="status" aria-live="polite"></span>
  <button id="snap" type="button">Save version</button>
</div>
<iframe id="deck" title="Deck" sandbox="${VIEWER_IFRAME_SANDBOX}" referrerpolicy="no-referrer"></iframe>
<script nonce="${nonce}">
(() => {
  const ENTRY_URL = ${entryUrl};
  const ENTRY = ${entry};
  const params = new URLSearchParams(location.search);
  const bar = document.getElementById('bar');
  const sel = document.getElementById('sel');
  const back = document.getElementById('back');
  const snap = document.getElementById('snap');
  const status = document.getElementById('status');
  const frame = document.getElementById('deck');
  if (params.get('bar') === '0') bar.hidden = true;

  let versions = [];
  let mode = params.get('v') || 'live';
  if (mode !== 'live' && mode !== 'latest' && !/^[1-9][0-9]*$/.test(mode)) mode = 'live';
  let shown = null;

  const entryOf = (n) => {
    const v = versions.find((x) => x.version === n);
    return v ? v.entryPath : ENTRY;
  };
  const versionUrl = (n) =>
    '/__slideless/v/' + n + '/' + entryOf(n).split('/').map(encodeURIComponent).join('/');
  const target = () => {
    if (mode === 'live') return ENTRY_URL;
    const n = mode === 'latest' ? (versions.length ? versions[versions.length - 1].version : null) : Number(mode);
    return n ? versionUrl(n) : ENTRY_URL;
  };
  const show = (force) => {
    const url = target();
    if (force || url !== shown) {
      shown = url;
      frame.src = url;
    }
  };
  const when = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  };
  const render = () => {
    sel.textContent = '';
    const add = (value, text) => {
      const o = document.createElement('option');
      o.value = value;
      o.text = text;
      sel.add(o);
    };
    add('live', 'Live: the working folder');
    if (versions.length) add('latest', 'Latest version (v' + versions[versions.length - 1].version + ')');
    for (let i = versions.length - 1; i >= 0; i--) {
      const v = versions[i];
      add(String(v.version), 'v' + v.version + ' · ' + when(v.createdAt) + ' · ' + v.fileCount + (v.fileCount === 1 ? ' file' : ' files'));
    }
    if (![...sel.options].some((o) => o.value === mode)) mode = 'live';
    sel.value = mode;
    back.hidden = mode === 'live';
  };
  const remember = () => {
    const p = new URLSearchParams(location.search);
    if (mode === 'live') p.delete('v');
    else p.set('v', mode);
    const q = p.toString();
    history.replaceState(null, '', location.pathname + (q ? '?' + q : ''));
  };
  const load = async () => {
    try {
      const res = await fetch('/__slideless/versions', { cache: 'no-store' });
      const body = await res.json();
      versions = Array.isArray(body.versions) ? body.versions : [];
      if (body.error) {
        snap.hidden = true;
        status.textContent = 'Versions unavailable';
        status.title = body.error;
      }
    } catch {
      versions = [];
    }
    render();
    show(false);
  };
  sel.addEventListener('change', () => {
    mode = sel.value;
    back.hidden = mode === 'live';
    remember();
    show(false);
  });
  back.addEventListener('click', () => {
    mode = 'live';
    sel.value = 'live';
    back.hidden = true;
    remember();
    show(false);
  });
  snap.addEventListener('click', async () => {
    snap.disabled = true;
    try {
      const res = await fetch('/__slideless/snapshot', { method: 'POST', headers: { 'x-slideless': 'snapshot' } });
      const body = await res.json();
      if (!res.ok) status.textContent = body.error || 'Could not save a version';
      else status.textContent = body.created ? 'Saved as v' + body.version : 'No change since v' + body.version;
    } catch {
      status.textContent = 'Could not save a version';
    } finally {
      snap.disabled = false;
    }
  });
  const connect = () => {
    const es = new EventSource('/__slideless/reload');
    es.addEventListener('reload', () => {
      if (mode === 'live') show(true);
    });
    es.addEventListener('versions', () => {
      void load();
    });
    es.onerror = () => {
      es.close();
      setTimeout(connect, 1000);
    };
  };
  render();
  show(true);
  void load();
  connect();
})();
</script>
</body>
</html>
`;
}

export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  // realpath the root once: every containment check below compares against
  // the REAL directory, so a symlinked deck folder still works.
  const root = await realpath(resolve(options.root));
  const host = options.host ?? '127.0.0.1';
  const sseClients = new Set<ServerResponse>();
  let allowed: ReadonlySet<string> = new Set<string>();

  // The store is opened once. A store that cannot be opened (a read-only
  // home, a --store inside the folder) leaves the preview working and the
  // versions off, with the reason on the versions route.
  let store: string | null = null;
  let storeError: string | null = null;
  try {
    store = (await openLocalStore(root, options.store)).store;
  } catch (err) {
    storeError = (err as Error).message;
  }

  const broadcast = (event: 'reload' | 'versions') => {
    for (const client of sseClients) client.write(`event: ${event}\ndata: now\n\n`);
  };

  // Snapshots from the bar and from the host run one at a time.
  let queue: Promise<unknown> = Promise.resolve();
  const snapshotNow = (): Promise<SnapshotResult> => {
    const run = queue.then(async () => {
      if (store === null) throw new Error(storeError ?? 'Local versions are unavailable');
      const result = await takeSnapshot(root, { store, entry: options.entryPath });
      if (result.created) broadcast('versions');
      return result;
    });
    queue = run.catch(() => undefined);
    return run;
  };

  const sameOrigin = (req: IncomingMessage): boolean => {
    const origin = req.headers.origin;
    if (origin === undefined) return true;
    try {
      const url = new URL(origin);
      return url.protocol === 'http:' && allowed.has(url.host.toLowerCase());
    } catch {
      return false;
    }
  };

  const serveVersionFile = async (res: ServerResponse, n: number, relPath: string, head: boolean) => {
    if (store === null) {
      res.writeHead(404, CONTENT_HEADERS).end('Not found');
      return;
    }
    const record = await readLocalVersion(store, root, n);
    const wanted = relPath === '' ? record?.entryPath : relPath;
    const file = record?.manifest.find((f) => f.path === wanted);
    if (!record || !file) {
      res.writeHead(404, CONTENT_HEADERS).end('Not found');
      return;
    }
    const blob = blobPath(store, file.sha256);
    const info = await stat(blob).catch(() => null);
    if (!info?.isFile()) {
      res.writeHead(404, CONTENT_HEADERS).end('Not found');
      return;
    }
    const type = file.contentType === 'text/html' ? 'text/html; charset=utf-8' : file.contentType;
    res.writeHead(200, { ...CONTENT_HEADERS, 'content-type': type, 'content-length': String(info.size) });
    if (head) {
      res.end();
      return;
    }
    await new Promise<void>((done, fail) => {
      const stream = createReadStream(blob);
      stream.on('error', fail);
      res.on('close', () => {
        stream.destroy();
        done();
      });
      stream.pipe(res).on('finish', () => done());
    });
  };

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
      const method = req.method ?? 'GET';

      if (pathname === SNAPSHOT_PATH) {
        if (method !== 'POST') {
          res.writeHead(405, { ...PLAIN_HEADERS, allow: 'POST' }).end('Method not allowed');
          return;
        }
        if (req.headers[SNAPSHOT_HEADER] !== SNAPSHOT_HEADER_VALUE || !sameOrigin(req)) {
          json(res, 403, { error: 'forbidden' });
          return;
        }
        try {
          const result = await snapshotNow();
          json(res, result.created ? 201 : 200, {
            version: result.version,
            created: result.created,
            entryPath: result.entryPath,
            fileCount: result.fileCount,
            sizeBytes: result.sizeBytes
          });
        } catch (err) {
          json(res, 409, { error: (err as Error).message });
        }
        return;
      }

      if (method !== 'GET' && method !== 'HEAD') {
        res.writeHead(405, { ...CONTENT_HEADERS, allow: 'GET, HEAD' }).end('Method not allowed');
        return;
      }
      const head = method === 'HEAD';

      if (pathname === '/') {
        const nonce = randomBytes(16).toString('base64');
        res.writeHead(200, {
          ...PLAIN_HEADERS,
          'content-security-policy': wrapperCsp(nonce),
          'content-type': 'text/html; charset=utf-8'
        });
        res.end(head ? undefined : wrapperHtml(nonce, options.entryPath));
        return;
      }

      if (pathname === RELOAD_PATH) {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          connection: 'keep-alive'
        });
        res.write(': connected\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }

      if (pathname === VERSIONS_PATH) {
        const versions = store === null ? [] : await listLocalVersions(store, root);
        json(res, 200, {
          cli: options.cliVersion ?? null,
          entry: options.entryPath,
          versions: versions.map(({ root: _root, ...v }) => v),
          ...(storeError ? { error: storeError } : {})
        });
        return;
      }

      const versionFile = VERSION_FILE_RE.exec(pathname);
      if (versionFile) {
        await serveVersionFile(res, Number(versionFile[1]), versionFile[2]!, head);
        return;
      }
      if (pathname.startsWith(DEV_ROUTE_PREFIX)) {
        res.writeHead(404, CONTENT_HEADERS).end('Not found');
        return;
      }

      const relPath = pathname.replace(/^\/+/, '');
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
      const bytes = await readFile(target);
      res.writeHead(200, {
        ...CONTENT_HEADERS,
        'content-type': contentType === 'text/html' ? 'text/html; charset=utf-8' : contentType
      });
      res.end(head ? undefined : bytes);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500, CONTENT_HEADERS);
      res.end('Internal error');
    });
  });

  let watcher: FSWatcher | null = null;
  let debounce: NodeJS.Timeout | null = null;
  const onChange = (_event: string, filename: string | Buffer | null) => {
    // A change under a dot-prefixed path (.git, an editor's swap file, a
    // store kept under a dot directory) is nothing the deck serves.
    const name = filename === null ? '' : filename.toString();
    if (name && name.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return;
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcast('reload'), 100);
  };
  try {
    watcher = watch(root, { recursive: true }, onChange);
  } catch {
    // Recursive watch unavailable (older Linux) — top-level changes only.
    try {
      watcher = watch(root, onChange);
    } catch {
      watcher = null;
    }
  }
  // A watcher that errors later (EMFILE, the folder removed) must not take the process down.
  watcher?.on('error', () => {
    watcher?.close();
    watcher = null;
  });

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
    store,
    storeError,
    snapshot: snapshotNow,
    close: async () => {
      watcher?.close();
      if (debounce) clearTimeout(debounce);
      for (const client of sseClients) client.end();
      sseClients.clear();
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    }
  };
}

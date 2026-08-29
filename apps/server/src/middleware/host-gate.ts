import type { Context, MiddlewareHandler } from 'hono';

/**
 * The viewer-origin host gate (PRDCT-1352, ADR 012's separate-origin path).
 *
 * `VIEWER_BASE_URL` names a SECOND hostname, fronting this same process, on
 * which share-link decks are served. The point of the second hostname is a
 * browser-enforced origin boundary between author-controlled deck script and
 * the signed-in dashboard — but a boundary only exists if the two hostnames
 * serve DIFFERENT things. Without this gate, routing is host-agnostic: the
 * viewer hostname also answered the dashboard, the auth surface, `/mcp` and
 * the whole API, and every "trust the origin we are being served on" rule
 * (cross-site.ts, Better Auth's trustedOrigins) trusted the viewer origin by
 * construction. So, when the setting is present:
 *
 *  - On the VIEWER hostname only these answer: `/v/*` (deck entry, assets,
 *    the password form), `/api/v1/viewer/*` (the token-authed, cookie-less
 *    annotation + forms API the deck runtime calls RELATIVE to the page it
 *    runs in — overlay.ts / forms-runtime.ts build their URLs off
 *    `location.href`), and the two operator probes. Everything else answers
 *    404 with the wire error shape, before any route runs. No session cookie
 *    is ever issued on that hostname and nothing served there is
 *    authenticated by one (the viewer API authenticates on the share secret;
 *    the generic authContext still RESOLVES a presented cookie on
 *    `/api/v1/viewer/*` but no viewer route reads the principal).
 *  - On every OTHER hostname (the app origin, localhost, a preview host) a
 *    `GET|HEAD /v/*` redirects to the same path on the viewer origin, so links
 *    minted before the switch keep working; an unsafe method on `/v/*` there
 *    answers 404 (the password form lives on the viewer hostname and posts
 *    there). `/embed.js` stays on the app origin (ADR 021).
 *
 * Unset, the gate is not installed at all and the single-origin behaviour is
 * untouched — the lane brief's no-regression rule for existing installs.
 *
 * Host matching uses the request URL's host (scheme-less `host:port`), which
 * the node adapter builds from the `Host` header — the value a reverse proxy
 * forwards (Caddy by default; nginx with `proxy_set_header Host $host`). It is
 * deliberately NOT read from `X-Forwarded-Host`: that header is client-
 * controlled unless the proxy strips it, and a wrong answer here is what
 * decides whether a deck runs on the app origin (pinned by a test). The
 * comparison is exact on `host`: a Host carrying an explicit default port
 * (`decks.test:443`) or a trailing dot (`decks.test.`) is NOT the viewer host
 * and lands on the app side — the safe direction, since neither is the
 * browser origin deck script runs under (a browser never sends the default
 * port, and `decks.test.` is a distinct origin for same-origin policy and
 * cookies alike), and the app side never serves deck bytes.
 */
export interface HostGateOptions {
  /** VIEWER_BASE_URL, already validated as an http(s) URL. */
  viewerBaseUrl: string;
}

const PROBES = new Set(['/healthz', '/readyz']);
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** `/v/<something>`: a deck route. The bare `/v` and `/v/` route NOTHING in the viewer. */
function isDeckPath(path: string): boolean {
  return path.startsWith('/v/') && path.length > '/v/'.length;
}

/**
 * Paths the viewer hostname answers: the deck routes STRICTLY beneath `/v/`,
 * the token-authed viewer API STRICTLY beneath `/api/v1/viewer/`, and the
 * probes. The bare prefixes (`/v`, `/v/`, `/api/v1/viewer`) route nothing
 * and stay 404 — admitting them let the SPA fallback answer `/v` on the
 * viewer hostname with the app's HTML shell, the one first-party document
 * the split exists to keep off that origin (verifier finding, PRDCT-1352).
 * Prefix matches are on the `/` boundary — `/vanity` and `/api/v1/viewers`
 * are not viewer paths.
 */
export function isViewerHostPath(path: string): boolean {
  if (PROBES.has(path)) return true;
  if (isDeckPath(path)) return true;
  return path.startsWith('/api/v1/viewer/');
}

function requestHost(c: Context): string | null {
  try {
    return new URL(c.req.url).host.toLowerCase();
  } catch {
    return null;
  }
}

export function hostGate({ viewerBaseUrl }: HostGateOptions): MiddlewareHandler {
  const viewer = new URL(viewerBaseUrl);
  const viewerHost = viewer.host.toLowerCase();
  const viewerOrigin = viewer.origin;

  return async (c, next) => {
    const path = c.req.path;
    const host = requestHost(c);

    if (host === viewerHost) {
      if (isViewerHostPath(path)) return next();
      return c.json(
        { error: { code: 'not_found', message: 'This hostname serves share-link decks only' } },
        404
      );
    }

    if (isDeckPath(path)) {
      if (SAFE_METHODS.has(c.req.method)) {
        const target = new URL(c.req.url);
        return c.redirect(viewerOrigin + target.pathname + target.search, 308);
      }
      return c.json(
        { error: { code: 'not_found', message: 'Share-link decks are served on the viewer hostname' } },
        404
      );
    }

    return next();
  };
}

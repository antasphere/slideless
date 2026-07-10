import { Hono } from 'hono';
import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import type { ManifestEntry } from '@slideless/contract';
import type { PresentationRow, PresentationVersionRow, ShareTokenRow } from '@slideless/db';
import type { Logger } from '../logger.js';
import type { FileService } from '../files/service.js';
import { serveBlob } from '../files/serve.js';
import { encodeContentDisposition } from '../files/http.js';
import { blobKey, type StorageDriver } from '../storage/driver.js';
import type { PresentationService } from '../presentations/service.js';
import type { ShareTokenService } from '../sharing/service.js';
import { verifyViewerPassword } from '../sharing/password.js';
import type { ClientIpFn } from '../middleware/rate-limit.js';
import { entryTransformFor } from './inject.js';
import { mintUnlockValue, unlockCookieName, verifyUnlockValue } from './unlock.js';

/**
 * THE PUBLIC VIEWER (Phase 4, ADR 012) — the one sanctioned exception to the
 * chassis invariant "never render user content on the app origin".
 *
 * `GET /v/{secret}` serves a share token's deck ENTRY HTML **inline**, and
 * `GET /v/{secret}/{path}` its assets, to ANONYMOUS callers — no session, no
 * API key, no principal machinery. The 384-bit path secret is the entire
 * credential. This is only safe under the ADR 012 regime, enforced here and
 * regression-tested (test/integration/sharing-viewer.test.ts):
 *
 *   Content-Security-Policy: sandbox allow-scripts allow-forms allow-popups
 *                            allow-modals allow-downloads
 *   X-Content-Type-Options:  nosniff
 *   Referrer-Policy:         no-referrer
 *
 * on EVERY response that carries user bytes. The `sandbox` directive drops
 * the document into an OPAQUE ORIGIN: no cookies, no storage, no service
 * workers, no credentialed same-origin API — the spike proved this defeats
 * session theft on Chromium/WebKit/Firefox. NEVER add `allow-same-origin`
 * (fully re-opens the vulnerability) or `allow-top-navigation*`. The global
 * securityHeaders middleware is guarded to not clobber these per-route
 * headers. `VIEWER_BASE_URL` can move share links to a dedicated
 * user-content origin (the hardening path); this same handler serves either
 * way and keeps the sandbox on as defense-in-depth.
 *
 * Non-goals here, by design: no auth middleware, no scope gate (token
 * recipients are not principals), no audit rows (views are counted on the
 * token + deck instead), no `?token=` query form (path-carried secret only,
 * so relative asset references resolve).
 */

export const VIEWER_PATH_PREFIX = '/v';

/** The exact ADR 012 sandbox policy. Single definition — tests import it. */
export const VIEWER_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

/** Headers every user-content viewer response must carry (ADR 012). */
export const VIEWER_CONTENT_HEADERS: Readonly<Record<string, string>> = {
  'content-security-policy': VIEWER_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer'
};

export interface ViewerDeps {
  sharing: ShareTokenService;
  presentations: PresentationService;
  fileService: FileService;
  storage: StorageDriver;
  logger: Logger;
  /** MAC key for the password-unlock cookie (the server auth secret). */
  authSecret: string;
  /** Failed password attempts consume from this bucket (per IP + token). */
  passwordLimiter: RateLimiterAbstract;
  clientIp: ClientIpFn;
  /** True when the instance runs on https (Secure attribute on the unlock cookie). */
  secureCookies: boolean;
}

/** Everything resolved about one viewer request before bytes are served. */
interface ResolvedView {
  token: ShareTokenRow;
  deck: PresentationRow;
  version: PresentationVersionRow;
  manifest: ManifestEntry[];
  /** Raw (still percent-encoded) secret path segment, for cookie Path scoping. */
  rawSecretSegment: string;
}

type ResolveFailure =
  | { status: 404; code: 'not_found'; message: string }
  | { status: 403; code: 'revoked'; message: string }
  | { status: 410; code: 'expired'; message: string };

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Minimal self-contained shell for the viewer's OWN pages (password gate,
 * human-readable errors). This is trusted first-party HTML — not user
 * content — so it gets a conventional strict CSP, not the sandbox.
 */
const SHELL_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";

function shellHtml(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f4f4f5;color:#18181b;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
main{background:#fff;border-radius:12px;padding:32px;max-width:360px;width:100%;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:18px;margin:0 0 12px}p{font-size:14px;color:#3f3f46;margin:0 0 16px;line-height:1.5}
input[type=password]{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #d4d4d8;border-radius:8px;font-size:14px;margin:0 0 12px}
button{width:100%;background:#18181b;color:#fff;border:0;border-radius:8px;padding:10px 12px;font-size:14px;font-weight:600;cursor:pointer}
.err{color:#dc2626;font-size:13px;margin:0 0 12px}</style></head>
<body><main>${bodyHtml}</main></body></html>`;
}

function shellHeaders(): Record<string, string> {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': SHELL_CSP,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    // The gate/errors vary between the HTML shell and the JSON wire shape.
    vary: 'accept, user-agent'
  };
}

/** ?raw / ?format=html — agents asking for the exact authored bytes. */
function rawRequested(c: Context): boolean {
  return c.req.query('raw') !== undefined || c.req.query('format') === 'html';
}

/** Whether the caller is a browser navigation that should see HTML shells. */
function wantsHtmlShell(c: Context): boolean {
  if (rawRequested(c)) return false;
  return (c.req.header('accept') ?? '').includes('text/html');
}

/** Error responses: the JSON wire shape for agents, a readable page for browsers. */
function viewerError(c: Context, failure: { status: 403 | 404 | 410 | 401 | 429; code: string; message: string }): Response {
  if (wantsHtmlShell(c)) {
    return c.body(
      shellHtml('Slideless', `<h1>Nothing to see here</h1><p>${esc(failure.message)}</p>`),
      failure.status,
      shellHeaders()
    );
  }
  return c.json(
    { error: { code: failure.code, message: failure.message } },
    failure.status,
    { 'cache-control': 'no-store', vary: 'accept, user-agent' }
  );
}

export function viewerRoutes(deps: ViewerDeps): Hono {
  const { sharing, presentations, fileService, storage, logger } = deps;
  const app = new Hono();

  /**
   * Secret → token → live deck → version → manifest, or a typed failure:
   * unknown/gone → 404, revoked → 403, expired → 410. Password is judged
   * separately (401 challenge) — it gates BYTES, not existence.
   */
  async function resolve(c: Context): Promise<{ ok: true; view: ResolvedView } | { ok: false; failure: ResolveFailure }> {
    const notFound: ResolveFailure = {
      status: 404,
      code: 'not_found',
      message: 'This share link does not exist or is no longer available.'
    };
    const secret = c.req.param('secret') ?? '';
    const token = await sharing.resolveBySecret(secret);
    if (!token) return { ok: false, failure: notFound };
    if (token.revokedAt) {
      return {
        ok: false,
        failure: { status: 403, code: 'revoked', message: 'This share link has been revoked.' }
      };
    }
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      return {
        ok: false,
        failure: { status: 410, code: 'expired', message: 'This share link has expired.' }
      };
    }
    const deck = await presentations.get(token.workspaceId, token.presentationId);
    if (!deck) return { ok: false, failure: notFound }; // soft-deleted decks stop resolving
    const versionNumber = token.pinnedVersion ?? deck.currentVersion;
    if (versionNumber < 1) return { ok: false, failure: notFound };
    const version = await presentations.getVersion(token.workspaceId, deck.id, versionNumber);
    if (!version) return { ok: false, failure: notFound };
    // Raw second segment for byte-exact cookie Path scoping.
    const rawSecretSegment = c.req.path.split('/')[2] ?? secret;
    return {
      ok: true,
      view: { token, deck, version, manifest: version.manifest as ManifestEntry[], rawSecretSegment }
    };
  }

  // ── Password gate ──────────────────────────────────────────────────────────
  // Mechanism (kept deliberately simple + stateless):
  //  1. Browsers get a 401 with a tiny first-party form; POSTing the correct
  //     password sets a signed, token-scoped, 1h unlock cookie
  //     (viewer/unlock.ts) and 303s back to the deck. The cookie's Path is
  //     the token's own /v/{secret} subtree, so assets are covered and other
  //     tokens are not.
  //  2. Agents (no text/html Accept, or ?raw) get the 401 as the JSON wire
  //     shape and authenticate by resending with `x-viewer-password` —
  //     no cookie jar needed, no HTML shell served to non-browsers.
  //  3. The hash is scrypt (sharing/password.ts) and every comparison is
  //     constant-time; failed guesses burn a tight per-IP+token bucket.
  //  4. Changing/clearing the password invalidates outstanding cookies (the
  //     cookie MAC covers a fingerprint of the current hash).

  function passwordLimiterKey(c: Context, token: ShareTokenRow): string {
    return `${deps.clientIp(c)}:${token.id}`;
  }

  async function passwordAttemptsExhausted(c: Context, token: ShareTokenRow): Promise<boolean> {
    const res = await deps.passwordLimiter.get(passwordLimiterKey(c, token)).catch(() => null);
    return res !== null && res.remainingPoints <= 0;
  }

  async function burnPasswordAttempt(c: Context, token: ShareTokenRow): Promise<void> {
    await deps.passwordLimiter.consume(passwordLimiterKey(c, token)).catch(() => {});
  }

  /** True when the request already proves knowledge of the token password. */
  async function passwordSatisfied(c: Context, token: ShareTokenRow): Promise<
    { ok: true } | { ok: false; response: Response }
  > {
    if (!token.passwordHash) return { ok: true };

    const cookieValue = getCookie(c, unlockCookieName(token.id));
    if (cookieValue && verifyUnlockValue(deps.authSecret, token.id, token.passwordHash, cookieValue)) {
      return { ok: true };
    }

    const headerPassword = c.req.header('x-viewer-password');
    if (headerPassword !== undefined) {
      if (await passwordAttemptsExhausted(c, token)) {
        return { ok: false, response: rateLimited(c) };
      }
      if (await verifyViewerPassword(headerPassword, token.passwordHash)) {
        return { ok: true };
      }
      await burnPasswordAttempt(c, token);
      return { ok: false, response: passwordChallenge(c, true) };
    }

    return { ok: false, response: passwordChallenge(c, false) };
  }

  function rateLimited(c: Context): Response {
    return viewerError(c, {
      status: 429,
      code: 'rate_limited',
      message: 'Too many password attempts — try again later.'
    });
  }

  function passwordChallenge(c: Context, wrong: boolean): Response {
    if (wantsHtmlShell(c)) {
      return c.body(
        shellHtml(
          'Password required',
          `<h1>This presentation is protected</h1>
           <p>Enter the password you received with this link.</p>
           ${wrong ? '<p class="err">That password is not correct.</p>' : ''}
           <form method="post" action="">
             <input type="password" name="password" autofocus autocomplete="current-password" required>
             <button type="submit">Open presentation</button>
           </form>`
        ),
        401,
        shellHeaders()
      );
    }
    return c.json(
      {
        error: {
          code: wrong ? 'password_invalid' : 'password_required',
          message: wrong
            ? 'The x-viewer-password value is not correct.'
            : 'This share link is password protected — resend with the password in the x-viewer-password header.'
        }
      },
      401,
      { 'cache-control': 'no-store', vary: 'accept, user-agent' }
    );
  }

  // POST /v/{secret} — the browser password form. Verifies, then hands the
  // browser a signed unlock cookie and bounces back to the GET.
  app.post(`${VIEWER_PATH_PREFIX}/:secret`, async (c) => {
    const resolved = await resolve(c);
    if (!resolved.ok) return viewerError(c, resolved.failure);
    const { token, rawSecretSegment } = resolved.view;
    if (!token.passwordHash) return c.redirect(c.req.path, 303);

    if (await passwordAttemptsExhausted(c, token)) return rateLimited(c);

    const body = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const password = typeof body['password'] === 'string' ? body['password'] : '';
    if (password === '' || !(await verifyViewerPassword(password, token.passwordHash))) {
      await burnPasswordAttempt(c, token);
      return passwordChallenge(c, true);
    }

    const value = mintUnlockValue(deps.authSecret, token.id, token.passwordHash);
    const attrs = [
      `Path=${VIEWER_PATH_PREFIX}/${rawSecretSegment}`,
      'HttpOnly',
      'SameSite=Lax',
      'Max-Age=3600',
      ...(deps.secureCookies ? ['Secure'] : [])
    ].join('; ');
    c.header('set-cookie', `${unlockCookieName(token.id)}=${value}; ${attrs}`);
    return c.redirect(c.req.path, 303);
  });

  // ── Entry HTML ─────────────────────────────────────────────────────────────
  app.on(['GET', 'HEAD'], `${VIEWER_PATH_PREFIX}/:secret`, async (c) => {
    const resolved = await resolve(c);
    if (!resolved.ok) return viewerError(c, resolved.failure);
    const { token, deck, version, manifest } = resolved.view;

    const gate = await passwordSatisfied(c, token);
    if (!gate.ok) return gate.response;

    const entry = manifest.find((e) => e.path === version.entryPath);
    if (!entry) {
      return viewerError(c, { status: 404, code: 'not_found', message: 'This deck has no entry document.' });
    }
    const fileRow = await fileService.getBySha(token.workspaceId, entry.sha256);
    if (!fileRow) {
      return viewerError(c, { status: 404, code: 'not_found', message: 'This deck is no longer available.' });
    }

    // View accounting: the ENTRY serve is the view — assets never count.
    // Awaited so the count is durable before the bytes go out. The
    // dashboard's own transient preview tokens are excluded so an owner
    // previewing their deck never inflates its view stats. SECURITY: the
    // exclusion keys on the SERVER-SET `purpose` column, never on the token
    // NAME — the name is client input, and a name-keyed exclusion let any
    // deck writer mint stat-silent tokens (a token merely NAMED "Dashboard
    // preview" counts like any other).
    if (c.req.method === 'GET' && token.purpose !== 'preview') {
      await sharing.recordEntryView(token.id, deck.id);
    }

    // The exact ADR 012 header set. Entry HTML is `no-store`: it must
    // re-resolve on every open (revocation, expiry, latest-version follow,
    // password gate, view counting).
    const entryHeaders: Record<string, string> = {
      ...VIEWER_CONTENT_HEADERS,
      'cache-control': 'no-store'
    };

    // The annotation-injection seam (Phase 5). null = stream untouched.
    // `browserEntry` keeps the overlay away from agents: it requires an HTML
    // Accept AND no agent-style password unlock (x-viewer-password header) —
    // raw/agent pulls always get the exact authored bytes.
    const transform = entryTransformFor({
      token,
      rawRequested: rawRequested(c),
      browserEntry:
        (c.req.header('accept') ?? '').includes('text/html') &&
        c.req.header('x-viewer-password') === undefined,
      version: version.version,
      mintUnlockProof: () =>
        token.passwordHash ? mintUnlockValue(deps.authSecret, token.id, token.passwordHash) : null
    });
    if (transform) {
      const key = blobKey(token.workspaceId, entry.sha256);
      if (!(await storage.exists(key))) {
        return viewerError(c, { status: 404, code: 'not_found', message: 'This deck is no longer available.' });
      }
      const chunks: Buffer[] = [];
      for await (const chunk of await storage.getStream(key)) {
        chunks.push(chunk as Buffer);
      }
      const html = transform(Buffer.concat(chunks).toString('utf8'));
      // Injected responses re-assert the exact ADR 012 header set and carry
      // deliberately NO ETag: serveBlob's content-sha ETag would lie about
      // the mutated bytes (the entry is no-store anyway, so nothing is lost).
      const transformedHeaders = {
        ...entryHeaders,
        'content-type': 'text/html; charset=utf-8',
        'content-disposition': 'inline'
      };
      return c.req.method === 'HEAD'
        ? c.body(null, 200, transformedHeaders)
        : c.body(html, 200, transformedHeaders);
    }

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: token.workspaceId,
      sha256: entry.sha256,
      sizeBytes: fileRow.sizeBytes,
      // Forced: the entry renders as a document whatever the manifest claims.
      contentType: 'text/html; charset=utf-8',
      filename: entry.path.split('/').pop() ?? entry.path,
      headOnly: c.req.method === 'HEAD',
      // INLINE — the sanctioned ADR 012 exception to attachment-by-default,
      // safe ONLY because entryHeaders locks the response under CSP: sandbox.
      contentDisposition: 'inline',
      extraHeaders: entryHeaders
    });
  });

  // ── Deck assets (path-relative to the resolved version's manifest) ─────────
  app.on(['GET', 'HEAD'], `${VIEWER_PATH_PREFIX}/:secret/*`, async (c) => {
    const resolved = await resolve(c);
    if (!resolved.ok) return viewerError(c, resolved.failure);
    const { token, version, manifest } = resolved.view;

    // Assets sit behind the same password gate (the unlock cookie's Path
    // covers this subtree; agents resend the header) — otherwise the gate
    // would protect the shell and leak the contents.
    const gate = await passwordSatisfied(c, token);
    if (!gate.ok) return gate.response;

    // Percent-decode each raw segment; contract-shape validation (no "..",
    // no "\", no empty segments) happens against the DECODED path so an
    // encoded traversal cannot sneak past. Lookup is an exact manifest-path
    // match — there is no filesystem underneath, only content addresses.
    const rawSegments = c.req.path.split('/').slice(3);
    let assetPath: string;
    try {
      assetPath = rawSegments.map((s) => decodeURIComponent(s)).join('/');
    } catch {
      return viewerError(c, { status: 404, code: 'not_found', message: 'No such file in this deck.' });
    }
    const shape = assetPathSchemaCheck(assetPath);
    if (!shape) {
      return viewerError(c, { status: 404, code: 'not_found', message: 'No such file in this deck.' });
    }

    const entry = manifest.find((e) => e.path === assetPath);
    if (!entry) {
      return viewerError(c, { status: 404, code: 'not_found', message: 'No such file in this deck.' });
    }
    const fileRow = await fileService.getBySha(token.workspaceId, entry.sha256);
    if (!fileRow) {
      return viewerError(c, { status: 404, code: 'not_found', message: 'No such file in this deck.' });
    }

    void version; // resolved version pins the manifest; nothing else needed

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: token.workspaceId,
      sha256: entry.sha256,
      sizeBytes: fileRow.sizeBytes,
      // The author's declared type — neutralized by the sandbox CSP +
      // nosniff below, so even text/html sub-pages render isolated.
      contentType: entry.contentType,
      filename: assetPath.split('/').pop() ?? assetPath,
      headOnly: c.req.method === 'HEAD',
      contentDisposition: encodeContentDisposition('inline', assetPath.split('/').pop() ?? assetPath),
      extraHeaders: {
        ...VIEWER_CONTENT_HEADERS,
        // NOT content-addressed URLs (a latest-mode token re-maps paths on
        // every push, revocation must bite): always revalidate. The ETag is
        // the content sha, so unchanged assets stay cheap 304s.
        'cache-control': 'private, no-cache'
      }
    });
  });

  return app;
}

/** The contract's assetPath rules (packages/contract), inlined for the decoded path. */
function assetPathSchemaCheck(p: string): boolean {
  return (
    p.length >= 1 &&
    p.length <= 1024 &&
    !p.startsWith('/') &&
    !p.includes('\\') &&
    p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..')
  );
}

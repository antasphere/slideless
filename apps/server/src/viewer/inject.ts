import type { Context } from 'hono';
import type { ShareTokenRow } from '@slideless/db';
import { overlayScriptTag } from './overlay.js';

/**
 * The ANNOTATION-INJECTION SEAM (built Phase 4, live since Phase 5; extended
 * for multi-page decks with PRDCT-1296).
 *
 * For tokens with `can_annotate`, the viewer injects the annotation overlay
 * client (viewer/overlay.ts) into every SAME-DECK HTML DOCUMENT NAVIGATION —
 * the entry AND any text/html sub-page a multi-page deck links to — before
 * `</body>`. This module is that injection's single hook — the viewer routes
 * never string-mangle HTML themselves.
 *
 * Contract:
 *  - Return `null` = no transform → the viewer STREAMS the blob
 *    (Range-capable, never buffered). Return a function = the viewer buffers
 *    the document, applies the transform, and serves the result WITHOUT an
 *    ETag (serveBlob's content-sha ETag would lie about the mutated bytes)
 *    and with the exact ADR 012 sandbox header set re-asserted.
 *  - The transform injects before the last `</body>` (appending at the end
 *    when a deck omits the tag) and does NOT sanitize or otherwise rewrite
 *    deck HTML — isolation is the sandbox CSP's job (ADR 012), not a
 *    rewriter's.
 *  - Injection happens ONLY for a browser DOCUMENT navigation (docNavigation
 *    below): `rawRequested` (?raw / ?format=html) stays byte-exact for
 *    agents, non-HTML Accepts and agent-style password unlocks
 *    (x-viewer-password header) never see the overlay, and requests a
 *    browser marks as sub-resources (`Sec-Fetch-Dest: iframe` et al.) are
 *    served untouched — nested frames wait for the participation protocol
 *    (PRDCT-1296 gap 2), and the overlay itself refuses to mount below
 *    `window.top` as belt-and-braces.
 *  - Injected overlay code executes inside the SANDBOXED OPAQUE ORIGIN:
 *    no cookies, no storage, no credentialed same-origin API. It
 *    authenticates to the annotation routes with the share-token secret it
 *    reads from `location.pathname` (plus a signed unlock proof when the
 *    token is password-protected) — never with a session. Trust boundary:
 *    viewer/overlay.ts.
 */
export type EntryTransform = (html: string) => string;

export interface EntryTransformContext {
  token: Pick<ShareTokenRow, 'id' | 'canAnnotate'>;
  /** True when the caller asked for the raw authored HTML (?raw / ?format=html). */
  rawRequested: boolean;
  /** True for a browser top-level document navigation — see docNavigation(). */
  browserEntry: boolean;
  /** The version this view resolved to (pinned or latest) — the note anchor. */
  version: number;
  /** The version's entry path — tells the overlay the root document's name. */
  entryPath: string;
  /**
   * Mints the signed annotation unlock proof for password-protected tokens
   * (viewer/unlock.ts MAC), or null for password-less tokens. Called only
   * when the overlay is actually injected — the request already passed the
   * password gate, so handing its document a proof adds no new access.
   */
  mintUnlockProof: () => string | null;
}

/**
 * True for a browser TOP-LEVEL DOCUMENT navigation — the only requests that
 * get the overlay. `Sec-Fetch-Dest` is a forbidden header browsers always
 * send on modern engines: `document` means an address-bar/link navigation,
 * while `iframe`/`frame`/`embed`/`object`/anything else marks a sub-resource
 * that must stay byte-exact. Requests without the header (older engines,
 * plain HTTP clients) fall back to the Phase 5 heuristic: an HTML Accept
 * that did NOT authenticate agent-style via x-viewer-password.
 */
export function docNavigation(c: Context): boolean {
  if (c.req.header('x-viewer-password') !== undefined) return false;
  const dest = c.req.header('sec-fetch-dest');
  if (dest !== undefined) return dest === 'document';
  return (c.req.header('accept') ?? '').includes('text/html');
}

/** Inject a snippet before the LAST `</body>` (case-insensitive); append when absent. */
export function injectBeforeBodyClose(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

export function entryTransformFor(ctx: EntryTransformContext): EntryTransform | null {
  if (!ctx.token.canAnnotate || ctx.rawRequested || !ctx.browserEntry) return null;
  const script = overlayScriptTag({
    version: ctx.version,
    unlock: ctx.mintUnlockProof(),
    entry: ctx.entryPath
  });
  return (html) => injectBeforeBodyClose(html, script);
}

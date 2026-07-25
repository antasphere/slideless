import type { Context } from 'hono';
import type { ShareTokenRow } from '@slideless/db';
import { overlayScriptTag } from './overlay.js';
import { formsScriptTag } from './forms-runtime.js';

/**
 * The INJECTION SEAM (built Phase 4, live since Phase 5; multi-page with
 * PRDCT-1296, forms with ADR 022).
 *
 * Two injected runtimes ride it, with DIFFERENT navigation gates:
 *
 *  - The ANNOTATION OVERLAY (viewer/overlay.ts), for `can_annotate` tokens:
 *    browser DOCUMENT navigations only — entry and text/html sub-pages. A
 *    frame is a sub-resource to it (ADR 021 records "annotations never
 *    render in a frame" as policy) and the overlay refuses `self !== top`
 *    as belt-and-braces.
 *  - The FORMS RUNTIME (viewer/forms-runtime.ts), for `can_submit_forms`
 *    tokens: document navigations AND same-deck HTML FRAME navigations —
 *    official embeds are iframes, and an embedded deck's form must submit
 *    (ADR 021 §1: the sandbox regime holds identically in a frame). Without
 *    the runtime a sandboxed native submit would garbage-navigate.
 *
 * Shared contract:
 *  - Return `null` = no transform → the viewer STREAMS the blob
 *    (Range-capable, never buffered). Return a function = the viewer buffers
 *    the document, applies the transform, and serves the result WITHOUT an
 *    ETag (serveBlob's content-sha ETag would lie about the mutated bytes)
 *    and with the exact ADR 012 sandbox header set re-asserted.
 *  - The transform injects before the last `</body>` (appending at the end
 *    when a deck omits the tag) and does NOT sanitize or otherwise rewrite
 *    deck HTML — isolation is the sandbox CSP's job (ADR 012), not a
 *    rewriter's.
 *  - `rawRequested` (?raw / ?format=html) stays byte-exact for agents;
 *    non-HTML Accepts and agent-style password unlocks (x-viewer-password)
 *    never see any runtime; `embed`/`object` and other non-frame
 *    sub-resources are served untouched.
 *  - Injected code executes inside the SANDBOXED OPAQUE ORIGIN: no cookies,
 *    no storage, no credentialed same-origin API. It authenticates to the
 *    viewer APIs with the share-token secret it reads from
 *    `location.pathname` (plus a signed unlock proof when the token is
 *    password-protected) — never with a session. Trust boundaries:
 *    viewer/overlay.ts, viewer/forms-runtime.ts.
 */
export type EntryTransform = (html: string) => string;

export interface EntryTransformContext {
  token: Pick<ShareTokenRow, 'id' | 'canAnnotate' | 'canSubmitForms' | 'createdAt' | 'expiresAt'>;
  /** True when the caller asked for the raw authored HTML (?raw / ?format=html). */
  rawRequested: boolean;
  /** True for a browser top-level document navigation — see docNavigation(). */
  browserEntry: boolean;
  /** True for a same-deck iframe/frame navigation — see frameNavigation(). */
  frameEntry: boolean;
  /** The version this view resolved to (pinned or latest) — the note anchor. */
  version: number;
  /** The version's entry path — tells the overlay the root document's name. */
  entryPath: string;
  /**
   * Resolved badge slot for this link (token override ?? deck default), or
   * null = the overlay's own bottom-right default. One of the 8 slots: the
   * 4 corners + the 4 edge centers.
   */
  badgePosition: string | null;
  /**
   * Sanitized `?p=` placement label of THIS navigation (view-events
   * sanitizer), or null — stamped onto submissions for per-source slicing.
   */
  placement: string | null;
  /**
   * Signed respondent assertion (viewer/respondent.ts) when the serving
   * request carried a live first-party session, else null. Document
   * navigations only — a cross-site frame never sends the session cookie,
   * and the server never minted one there.
   */
  respondentAssertion: string | null;
  /** Whether the instance's mail driver delivers (shows the email opt-in). */
  emailAvailable: boolean;
  /**
   * Mints the signed unlock proof for password-protected tokens
   * (viewer/unlock.ts MAC), or null for password-less tokens. Called only
   * when a runtime is actually injected — the request already passed the
   * password gate, so handing its document a proof adds no new access.
   */
  mintUnlockProof: () => string | null;
}

/**
 * True for a browser TOP-LEVEL DOCUMENT navigation. `Sec-Fetch-Dest` is a
 * forbidden header browsers always send on modern engines: `document` means
 * an address-bar/link navigation, while `iframe`/`frame`/`embed`/`object`/
 * anything else marks a sub-resource. Requests without the header (older
 * engines, plain HTTP clients) fall back to the Phase 5 heuristic: an HTML
 * Accept that did NOT authenticate agent-style via x-viewer-password.
 */
export function docNavigation(c: Context): boolean {
  if (c.req.header('x-viewer-password') !== undefined) return false;
  const dest = c.req.header('sec-fetch-dest');
  if (dest !== undefined) return dest === 'document';
  return (c.req.header('accept') ?? '').includes('text/html');
}

/**
 * True for a browser FRAME navigation — the embed case (ADR 021: official
 * embeds mount the viewer in a sandboxed iframe). Only the two frame
 * destinations count; `embed`/`object` plugins and header-less callers do
 * not (the no-header fallback already routes real browsers through
 * docNavigation, and agents must stay byte-exact).
 */
export function frameNavigation(c: Context): boolean {
  if (c.req.header('x-viewer-password') !== undefined) return false;
  const dest = c.req.header('sec-fetch-dest');
  return dest === 'iframe' || dest === 'frame';
}

/** Inject a snippet before the LAST `</body>` (case-insensitive); append when absent. */
export function injectBeforeBodyClose(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

export function entryTransformFor(ctx: EntryTransformContext): EntryTransform | null {
  if (ctx.rawRequested) return null;

  let snippet = '';
  if (ctx.token.canAnnotate && ctx.browserEntry) {
    snippet += overlayScriptTag({
      version: ctx.version,
      unlock: ctx.mintUnlockProof(),
      entry: ctx.entryPath,
      badge: ctx.badgePosition,
      // Settings-dialog metadata: the recipient's own link, safe to show.
      linkCreatedAt: ctx.token.createdAt.toISOString(),
      linkExpiresAt: ctx.token.expiresAt?.toISOString() ?? null
    });
  }
  if (ctx.token.canSubmitForms && (ctx.browserEntry || ctx.frameEntry)) {
    snippet += formsScriptTag({
      version: ctx.version,
      unlock: ctx.mintUnlockProof(),
      source: ctx.frameEntry ? 'embed' : 'link',
      placement: ctx.placement,
      assertion: ctx.respondentAssertion,
      emailAvailable: ctx.emailAvailable
    });
  }
  if (snippet === '') return null;
  return (html) => injectBeforeBodyClose(html, snippet);
}

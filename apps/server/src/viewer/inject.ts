import type { ShareTokenRow } from '@slideless/db';
import { overlayScriptTag } from './overlay.js';

/**
 * The ANNOTATION-INJECTION SEAM (built Phase 4, live since Phase 5).
 *
 * For tokens with `can_annotate`, the viewer injects the annotation overlay
 * client (viewer/overlay.ts) into the ENTRY HTML before `</body>`. This
 * module is that injection's single hook — the viewer routes never
 * string-mangle HTML themselves.
 *
 * Contract:
 *  - Return `null` = no transform → the viewer STREAMS the entry blob
 *    (Range-capable, never buffered). Return a function = the viewer buffers
 *    the entry, applies the transform, and serves the result WITHOUT an
 *    ETag (serveBlob's content-sha ETag would lie about the mutated bytes)
 *    and with the exact ADR 012 sandbox header set re-asserted.
 *  - The transform injects before the last `</body>` (appending at the end
 *    when a deck omits the tag) and does NOT sanitize or otherwise rewrite
 *    deck HTML — isolation is the sandbox CSP's job (ADR 012), not a
 *    rewriter's.
 *  - Injection happens ONLY for a browser entry navigation: `rawRequested`
 *    (?raw / ?format=html) stays byte-exact for agents, and `browserEntry`
 *    is false for non-HTML Accepts and for agent-style password unlocks
 *    (x-viewer-password header) — agents never receive the overlay.
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
  /**
   * True for a browser document navigation (Accept includes text/html) that
   * did NOT authenticate agent-style via the x-viewer-password header.
   */
  browserEntry: boolean;
  /** The version this view resolved to (pinned or latest) — the note anchor. */
  version: number;
  /**
   * Mints the signed annotation unlock proof for password-protected tokens
   * (viewer/unlock.ts MAC), or null for password-less tokens. Called only
   * when the overlay is actually injected — the entry request already passed
   * the password gate, so handing its document a proof adds no new access.
   */
  mintUnlockProof: () => string | null;
}

/** Inject a snippet before the LAST `</body>` (case-insensitive); append when absent. */
export function injectBeforeBodyClose(html: string, snippet: string): string {
  const idx = html.toLowerCase().lastIndexOf('</body>');
  if (idx === -1) return html + snippet;
  return html.slice(0, idx) + snippet + html.slice(idx);
}

export function entryTransformFor(ctx: EntryTransformContext): EntryTransform | null {
  if (!ctx.token.canAnnotate || ctx.rawRequested || !ctx.browserEntry) return null;
  const script = overlayScriptTag({ version: ctx.version, unlock: ctx.mintUnlockProof() });
  return (html) => injectBeforeBodyClose(html, script);
}

import type { ShareTokenRow } from '@slideless/db';

/**
 * The ANNOTATION-INJECTION SEAM (Phase 4 → Phase 5).
 *
 * Phase 5 ships an annotation overlay: for tokens with `can_annotate`, the
 * viewer injects a small overlay client into the ENTRY HTML before
 * `</body>` (selection anchoring + note UI, talking to the token-session
 * annotation routes reserved under POST /api/v1/viewer/*). This module is
 * that injection's single hook — the viewer routes never string-mangle HTML
 * themselves.
 *
 * Contract for Phase 5:
 *  - Return `null` = no transform → the viewer STREAMS the entry blob
 *    (Range-capable, never buffered). Return a function = the viewer buffers
 *    the entry, applies the transform, and serves the result.
 *  - The transform must inject before the last `</body>` (appending at the
 *    end when a deck omits the tag) and must NOT sanitize or otherwise
 *    rewrite deck HTML — isolation is the sandbox CSP's job (ADR 012), not a
 *    rewriter's.
 *  - `rawRequested` (?raw / ?format=html) must stay untransformed: agents
 *    pull the exact authored bytes, never the overlay.
 *  - Injected overlay code executes inside the SANDBOXED OPAQUE ORIGIN:
 *    no cookies, no storage, no credentialed same-origin API. It must
 *    authenticate to the annotation routes with the share-token secret it
 *    can read from `location.pathname` — never with a session.
 */
export type EntryTransform = (html: string) => string;

export interface EntryTransformContext {
  token: Pick<ShareTokenRow, 'id' | 'canAnnotate'>;
  /** True when the caller asked for the raw authored HTML (?raw / ?format=html). */
  rawRequested: boolean;
}

/**
 * Phase 4 default: no transform, ever — the entry streams untouched. Phase 5
 * replaces ONLY the body of this function (return the overlay injector when
 * `ctx.token.canAnnotate && !ctx.rawRequested`).
 */
export function entryTransformFor(ctx: EntryTransformContext): EntryTransform | null {
  void ctx;
  return null;
}

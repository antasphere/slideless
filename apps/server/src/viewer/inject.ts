import type { Context } from 'hono';
import type { ShareTokenRow } from '@slideless/db';
import { overlayScriptTag } from './overlay.js';
import { formsScriptTag } from './forms-runtime.js';
import { linkRemembers } from '../forms/service.js';
import { topbarScriptTag } from './topbar.js';

/**
 * The INJECTION SEAM (built Phase 4, live since Phase 5; multi-page with
 * PRDCT-1296, forms with ADR 022, the recipient bar with PRDCT-2281).
 *
 * Three injected runtimes ride it, with DIFFERENT navigation gates:
 *
 *  - The RECIPIENT TOP BAR (viewer/topbar.ts), for `show_bar` tokens (the
 *    default): browser DOCUMENT navigations only, like the overlay — an
 *    embed or a frame is bare, and so are the password gate and the error
 *    shells, which never enter this seam. Since the switch defaults ON,
 *    every default share link now leaves the byte-exact streaming path on
 *    a browser navigation; the streaming injector keeps that O(window).
 *    Its tag is FIRST in the plan so the root offset it sets is in place
 *    when the overlay places its badge.
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
 *  - Return `null` = nothing to inject → the viewer STREAMS the blob
 *    (Range-capable, ETag-carrying, never buffered). Return a snippet =
 *    the viewer STILL streams, through the bounded-window injector
 *    (viewer/inject-stream.ts), and serves the result WITHOUT an ETag
 *    (serveBlob's content-sha ETag would lie about the mutated bytes) and
 *    with the exact ADR 012 sandbox header set re-asserted. The document is
 *    never read into memory whole — PRDCT-1333: `canSubmitForms` defaults
 *    ON, so a buffering seam was a ~10x-document single-request memory DoS
 *    on every share link.
 *  - The snippet is injected before the last `</body>` (appended at the end
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
/**
 * The EARLY snippet (PRDCT-1334 item 4): a few bytes injected right after the
 * opening `<head>` so they run BEFORE any deck script. Decks that normalize
 * their own URL (`history.replaceState(null,'','#slide=1')`) wipe the
 * respondent's `#slr=` fragment before the end-of-body runtime ever sees it,
 * silently killing the edit link. This stashes the arrival fragment first.
 */
export const FRAGMENT_CAPTURE_MARKER = 'data-slideless-frag';

export const fragmentCaptureTag = (): string =>
  `<script ${FRAGMENT_CAPTURE_MARKER}>window.__slidelessArrivalHash=location.hash||'';</script>`;

export interface EntryTransformContext {
  token: Pick<
    ShareTokenRow,
    | 'id'
    | 'purpose'
    | 'canAnnotate'
    | 'canSubmitForms'
    | 'canDownload'
    | 'showBar'
    | 'remembersResponses'
    | 'canUploadFiles'
    | 'createdAt'
    | 'expiresAt'
  >;
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
  /** The deck's title — what the recipient bar names (PRDCT-2281). */
  deckTitle: string;
  /**
   * True when the resolved VERSION carries attachments
   * (`presentation_versions.has_downloads`, PRDCT-2278). With the link's
   * `canDownload` it decides whether the bar fetches the list at all.
   */
  versionHasDownloads: boolean;
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
   * True when the resolved VERSION actually carries a marked form
   * (`presentation_versions.has_forms`, stamped at commit — PRDCT-1333). The
   * forms runtime is injected only then, so a form-less deck keeps the
   * streaming, ETag-carrying serve path it had before ADR 022.
   */
  versionHasForms: boolean;
  /** Whether the instance's mail driver delivers (shows the email opt-in). */
  emailAvailable: boolean;
  /** The instance's form-upload ceilings (PRDCT-2403); `maxFileBytes` 0 = uploads off. */
  formUploadCaps: { maxFileBytes: number; maxFilesPerResponse: number };
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

/** What one document navigation injects: an early stub plus the end-of-body runtimes. */
export interface InjectionPlan {
  /** Injected right after `<head>`; '' = nothing to inject early. */
  head: string;
  /** Injected before the last `</body>`; never '' when a plan exists. */
  body: string;
}

export function entryInjectionFor(ctx: EntryTransformContext): InjectionPlan | null {
  if (ctx.rawRequested) return null;

  let body = '';
  let head = '';
  // PRDCT-2281: the bar first, so its root offset precedes the overlay.
  if (ctx.token.showBar && ctx.browserEntry) {
    body += topbarScriptTag({
      title: ctx.deckTitle,
      version: ctx.version,
      unlock: ctx.mintUnlockProof(),
      downloads: ctx.token.canDownload && ctx.versionHasDownloads
    });
  }
  if (ctx.token.canAnnotate && ctx.browserEntry) {
    body += overlayScriptTag({
      version: ctx.version,
      unlock: ctx.mintUnlockProof(),
      entry: ctx.entryPath,
      badge: ctx.badgePosition,
      // Settings-dialog metadata: the recipient's own link, safe to show.
      linkCreatedAt: ctx.token.createdAt.toISOString(),
      linkExpiresAt: ctx.token.expiresAt?.toISOString() ?? null
    });
  }
  // PRDCT-1333: the capability is necessary but NOT sufficient — the version
  // must actually carry a marked form. Otherwise every share link of every
  // deck left the streaming path, because canSubmitForms defaults ON.
  if (ctx.token.canSubmitForms && ctx.versionHasForms && (ctx.browserEntry || ctx.frameEntry)) {
    head += fragmentCaptureTag();
    body += formsScriptTag({
      version: ctx.version,
      unlock: ctx.mintUnlockProof(),
      source: ctx.frameEntry ? 'embed' : 'link',
      placement: ctx.placement,
      emailAvailable: ctx.emailAvailable,
      // PRDCT-2328: the one boolean the remembering feature hands the
      // document. Context, not capability (see the runtime's trust-boundary
      // note): THE rule, `linkRemembers` in forms/service.ts, called rather
      // than re-spelled (verifier round 1, F8) so the document and the API
      // can never disagree about whether a link remembers.
      remembers: linkRemembers(ctx.token),
      // PRDCT-2403: whether this link takes files, and the two ceilings the
      // drop panel states. Context, not capability: the upload route applies
      // the same three conditions to every request whatever the document
      // says, and both numbers are ones a link holder learns from one
      // refused upload. Null = the panel shows file fields as unavailable.
      uploads:
        ctx.token.canUploadFiles && ctx.token.purpose === 'share' && ctx.formUploadCaps.maxFileBytes > 0
          ? { maxBytes: ctx.formUploadCaps.maxFileBytes, maxFiles: ctx.formUploadCaps.maxFilesPerResponse }
          : null
    });
  }
  if (body === '') return null;
  return { head, body };
}

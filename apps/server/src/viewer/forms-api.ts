import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { z } from 'zod';
import {
  formFileFieldNameSchema,
  formNameSchema,
  formResponsePayloadSchema,
  formResponseSourceSchema,
  formSubmitFilesSchema,
  isValidMediaType
} from '@slideless/contract';
import type { FormResponseRow } from '@slideless/db';
import type { Logger } from '../logger.js';
import type { Env } from '../env.js';
import type { PresentationService } from '../presentations/service.js';
import { buildViewerUrl, type ShareTokenService } from '../sharing/service.js';
import { viewPlacement } from '../sharing/view-events.js';
import type { EmailDriver } from '../email/driver.js';
import { buildResponseLinkEmail } from '../email/templates.js';
import type { ClientIpFn } from '../middleware/rate-limit.js';
import {
  formResponseToRespondentWire,
  FORM_RESPONSES_MAX_PER_DECK,
  linkRemembers,
  type FormResponseService
} from '../forms/service.js';
import type { FormResponseNotifier } from '../forms/notify.js';
import {
  EmptyFileError,
  FormFilesClaimError,
  FormUploadsFullError,
  sanitizeUploadName,
  type FormUploadService
} from '../forms/uploads.js';
import { FileTooLargeError } from '../files/spool.js';
import { resolveTokenSession, type TokenSessionView } from './token-session.js';

/**
 * THE TOKEN-SESSION FORM SURFACE (ADR 022) — the public `/api/v1/viewer/*`
 * form-response routes, the annotation surface's sibling. The caller is the
 * forms runtime injected into the sandboxed opaque-origin viewer document
 * (viewer/forms-runtime.ts) — in direct link views AND official embeds —
 * which authenticates with the share-token secret from `location.pathname`;
 * a respondent's OWN row is additionally guarded by its one-time EDIT
 * SECRET (`x-slideless-response`).
 *
 * Containment story (the annotations-api posture, same shared resolver):
 *  - AUTH: every request re-resolves the secret (404/403/410 mapping) and
 *    requires `can_submit_forms`; password-gated tokens prove knowledge via
 *    the injected unlock MAC or `x-viewer-password`. The edit secret only
 *    ever reaches THIS token's own row on THIS deck — a foreign edit secret
 *    answers the same 404 as a missing one.
 *  - SCOPE: create on, and read/update of own responses of, the one
 *    deck+token the secret resolves to. The respondent wire leaks no ids
 *    beyond the response's own.
 *  - INPUT: zod-validated flat payload (string/string[] values, field-count
 *    and key caps at the contract), a serialized-bytes cap here, and the
 *    view-events placement sanitizer. Payload meaning is NEVER interpreted.
 *  - IDENTITY: there is none, by construction. ADR 022 leg 3 injected a
 *    signed identity assertion into the deck document and let this handler
 *    stamp `respondent_user_id` from it; deck JS could lift it and file
 *    responses under a stranger's account (PRDCT-1331, audit §1). Removed.
 *    A response is anonymous unless the AUTHOR asked for a name in the form.
 *  - FORM BINDING: the own-row routes carry `{form}` and the row's
 *    `form_name` must match, so an edit secret can never reach another
 *    form's row even on the same deck and link (PRDCT-1334 item 2).
 *  - REMEMBERING LINKS (PRDCT-2328): on a link minted with
 *    `remembers_responses` the SHARE SECRET alone resolves the link's ONE
 *    remembered row per form — no fragment, no edit secret. This is NOT
 *    leg 3: the server keys on `share_token_id`, a fact it already stores
 *    and re-stamps, and hands the document nothing but a boolean. The
 *    token secret is thereby a bearer credential for the ANSWERS (the
 *    docs and the sharing surfaces say so). Embed submissions on such a
 *    link are ordinary fresh rows: a website's visitors share the link.
 *    Preview tokens never remember (linkRemembers refuses by purpose).
 *  - ABUSE: creates/updates burn a per-IP+token bucket; unknown share
 *    secrets burn per-IP; failed edit-secret lookups burn the same submit
 *    bucket; the email leg has its own tight per-IP+token AND per-address
 *    bucket; a hard per-deck response cap backstops it all. Responses are
 *    not audited (the viewer's documented non-goal); owner deletes are.
 *  - FILE FIELDS (PRDCT-2403): `POST …/forms/{form}/uploads` takes ONE
 *    file as a raw streamed body and answers a PENDING upload id; a submit
 *    then names its uploads (`files`), claimed in the response's own
 *    transaction and only through the SAME link, form and deck. Gated by
 *    `can_submit_forms` AND `can_upload_files` (new links on, links from
 *    before the feature off) AND the instance knob (FORMS_MAX_UPLOAD_MB, 0 =
 *    off). Bounded per file (mid-stream), per response (count), per deck
 *    (byte total under an advisory lock) and by its own per-IP+token bucket.
 *    The bytes never enter the workspace's content-addressed `files` pool,
 *    and NO route on this surface serves them back: the respondent wire
 *    carries names and sizes only, so a remembering link's secret never
 *    becomes a download URL. Anything the deck document can do here the
 *    link holder could already do with curl — the upload id is no grant
 *    beyond the link's own.
 *  - CORS: wildcard, like every token-session route — the opaque origin
 *    sends `Origin: null` and nothing here is cookie-authenticated.
 */

/**
 * The ONE path whose body is a respondent's file (PRDCT-2403). api/index.ts
 * exempts it from the JSON body cap and the JSON depth scan; the handler
 * caps it mid-stream. Exact shape, so nothing else rides the exemption.
 */
export function isViewerFormUploadPath(path: string): boolean {
  return /^\/api\/v1\/viewer\/[^/]+\/forms\/[^/]+\/uploads$/.test(path);
}

/** Serialized-payload byte cap (a form answer, not a document). */
export const MAX_FORM_PAYLOAD_JSON_BYTES = 32 * 1024;

/** Header carrying the respondent's own edit secret. */
export const RESPONSE_SECRET_HEADER = 'x-slideless-response';

const formSubmitBody = z.object({
  payload: formResponsePayloadSchema,
  version: z.number().int().min(1).optional(),
  /** Serving-document context, echoed from the injected config. Attribution-grade. */
  source: formResponseSourceSchema.default('link'),
  placement: z.string().max(200).optional(),
  /** The uploads this response holds, per file field (PRDCT-2403). */
  files: formSubmitFilesSchema.optional()
});

/**
 * An update re-stamps attribution: an edited row used to keep the CREATOR's
 * source/placement/version forever, so every edit silently mis-attributed
 * itself (PRDCT-1332, related finding). Unknown keys — an `assertion` from an
 * old runtime, say — are stripped by zod and never reach a column.
 */
const formUpdateBody = z.object({
  payload: formResponsePayloadSchema,
  version: z.number().int().min(1).optional(),
  source: formResponseSourceSchema.optional(),
  placement: z.string().max(200).optional(),
  /** The FULL set of files the response keeps; absent = files untouched (PRDCT-2403). */
  files: formSubmitFilesSchema.optional()
});

const formEmailBody = z.object({
  email: z.email()
});

const err = (code: string, message: string) => ({ error: { code, message } });

export interface ViewerFormDeps {
  sharing: ShareTokenService;
  presentations: PresentationService;
  forms: FormResponseService;
  logger: Logger;
  /** MAC key for the unlock proof (the auth secret). */
  authSecret: string;
  email: EmailDriver;
  env: Pick<Env, 'PUBLIC_BASE_URL' | 'VIEWER_BASE_URL'>;
  /** Submits, own-row reads/updates, and failed edit-secret lookups consume here (per IP + token). */
  formSubmitLimiter: RateLimiterAbstract;
  /** Edit-link emails consume here (per IP + token AND per address). */
  formEmailLimiter: RateLimiterAbstract;
  /** Failed password header attempts consume from this bucket (per IP + token). */
  passwordLimiter: RateLimiterAbstract;
  clientIp: ClientIpFn;
  /** Owner notifications (PRDCT-2330): best-effort, never awaited by the respondent's answer. */
  notifier: FormResponseNotifier;
  /** Form file uploads (PRDCT-2403): storage, the byte caps, the claim. */
  uploads: FormUploadService;
  /** File uploads and pending-upload removals consume here (per IP + token). */
  formUploadLimiter: RateLimiterAbstract;
}

export function registerViewerFormRoutes(api: OpenAPIHono, deps: ViewerFormDeps): void {
  const { sharing, presentations, forms, authSecret, clientIp, uploads } = deps;

  async function resolveSubmitter(
    c: Context
  ): Promise<{ ok: true; view: TokenSessionView } | { ok: false; res: Response }> {
    return resolveTokenSession(
      c,
      {
        sharing,
        presentations,
        authSecret,
        invalidSecretLimiter: deps.formSubmitLimiter,
        passwordLimiter: deps.passwordLimiter,
        clientIp
      },
      {
        allows: (token) => token.canSubmitForms,
        errorCode: 'forms_disabled',
        errorMessage: 'This share link does not allow form submissions.'
      }
    );
  }

  /** The `{form}` path segment, or a 400 — the same gate the create route uses. */
  function parseFormName(c: Context): { ok: true; name: string } | { ok: false; res: Response } {
    const parsed = formNameSchema.safeParse(c.req.param('form'));
    if (!parsed.success) {
      return {
        ok: false,
        res: c.json(err('validation_error', 'form name must be 1-64 chars of [A-Za-z0-9._-]'), 400)
      };
    }
    return { ok: true, name: parsed.data };
  }

  /**
   * The respondent's own row for THIS deck and THIS token, by edit secret —
   * form-agnostic. Any mismatch answers the same 404 as a missing secret
   * (no foreign-row oracle).
   *
   * Bucket policy: an unresolvable or foreign-deck/foreign-token secret
   * burns the submit bucket like an invalid share secret would. The runtime
   * resolves an arriving fragment secret ONCE per page load through the
   * form-agnostic GET below, so a bogus fragment costs one point per page
   * load — the pre-remediation cost. It used to probe once PER FORM through
   * the form-bound route: a two-form deck reloaded ten times locked the
   * bucket, and because the key is IP + token, every respondent behind one
   * NAT was then refused for ten minutes (PRDCT-1331/1334 residual).
   */
  async function lookupOwnRow(
    c: Context,
    view: TokenSessionView
  ): Promise<{ ok: true; view: TokenSessionView; row: FormResponseRow } | { ok: false; res: Response }> {
    const secret = c.req.header(RESPONSE_SECRET_HEADER);
    const row = secret === undefined ? null : await forms.resolveByEditSecret(secret);
    if (!row || row.presentationId !== view.presentationId || row.shareTokenId !== view.token.id) {
      await deps.formSubmitLimiter.consume(`${clientIp(c)}:${view.token.id}`).catch(() => {});
      return {
        ok: false,
        res: c.json(err('not_found', 'No response matches this link and edit secret.'), 404)
      };
    }
    return { ok: true, view, row };
  }

  async function resolveOwnRow(
    c: Context
  ): Promise<{ ok: true; view: TokenSessionView; row: FormResponseRow } | { ok: false; res: Response }> {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved;
    return lookupOwnRow(c, resolved.view);
  }

  /**
   * The respondent's own row: token session + edit secret + FORM NAME, bound
   * together — the row must belong to THIS deck, THIS token and THIS form.
   * Any mismatch answers the same 404 as a missing secret (no foreign-row
   * oracle).
   *
   * The form segment is what closes PRDCT-1334 item 2 server-side: the
   * runtime used to keep ONE edit secret for every form on the page, and
   * because the route carried no form name the server could not tell that a
   * PUT was landing on the wrong row — an `rsvp` edit silently overwrote the
   * respondent's `feedback` answer and the card said "updated". Now the
   * server refuses it whatever the client does.
   *
   * Order, the same as the create route: the token session FIRST (an invalid
   * share secret answers 404 and burns its bucket whatever the rest of the
   * path says), then the form name (400), then the secret lookup. A secret
   * that IS valid for this deck+token but names another form does NOT burn:
   * the caller already holds that capability, so the answer is not an
   * oracle.
   */
  async function resolveOwnResponse(
    c: Context,
    opts: { allowRemembered: boolean } = { allowRemembered: true }
  ): Promise<{ ok: true; view: TokenSessionView; row: FormResponseRow } | { ok: false; res: Response }> {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved;
    const formName = parseFormName(c);
    if (!formName.ok) return { ok: false, res: formName.res };
    // PRDCT-2328: no edit secret presented on a remembering link = the
    // link's own remembered row for this form. Nothing is guessed here (the
    // share secret already resolved), so a miss does not burn the bucket.
    if (
      opts.allowRemembered &&
      c.req.header(RESPONSE_SECRET_HEADER) === undefined &&
      linkRemembers(resolved.view.token)
    ) {
      const row = await forms.findRemembered(resolved.view.token.id, formName.name);
      if (!row) {
        return {
          ok: false,
          res: c.json(err('not_found', 'This link has no remembered response for this form yet.'), 404)
        };
      }
      return { ok: true, view: resolved.view, row };
    }
    const found = await lookupOwnRow(c, resolved.view);
    if (!found.ok) return found;
    if (found.row.formName !== formName.name) {
      return {
        ok: false,
        res: c.json(err('not_found', 'No response matches this link and edit secret.'), 404)
      };
    }
    return found;
  }

  /**
   * The version a response records is the one the respondent SAW — same
   * discipline as annotations: a pinned token can only mean its pin; a
   * latest-mode token may claim at most the version its document was served
   * with. Shared by create and update so an edit cannot rewrite the version
   * to something the link never served.
   */
  function resolveClaimedVersion(
    c: Context,
    view: TokenSessionView,
    claimed: number | undefined
  ): { ok: true; version: number } | { ok: false; res: Response } {
    if (claimed === undefined) return { ok: true, version: view.version };
    if (view.token.pinnedVersion !== null && claimed !== view.token.pinnedVersion) {
      return {
        ok: false,
        res: c.json(err('invalid_version', 'This share link is pinned to a different version'), 400)
      };
    }
    if (claimed > view.version) {
      return {
        ok: false,
        res: c.json(err('invalid_version', 'version does not exist on this presentation'), 400)
      };
    }
    return { ok: true, version: claimed };
  }

  /** A submit that names an unclaimable upload is the client's error, never a 500. */
  function claimRefusal(c: Context, e: unknown): Response | null {
    if (!(e instanceof FormFilesClaimError)) return null;
    return c.json(err(e.code, e.message), 400);
  }

  /** The respondent wire with the names and sizes of the files the row holds. */
  async function respondentWire(row: FormResponseRow) {
    return formResponseToRespondentWire(row, await uploads.listForResponse(row.id));
  }

  /** The respondent's personal edit link: their share URL + the fragment secret. */
  function editUrl(c: Context, editSecret: string): string {
    const shareSecret = c.req.param('secret') ?? '';
    return `${buildViewerUrl(deps.env, shareSecret)}#slr=${editSecret}`;
  }

  /** Best-effort edit-link mail — never fails the write it follows. */
  async function sendEditLink(c: Context, to: string, view: TokenSessionView, editSecret: string) {
    try {
      await deps.email.send({ to, ...buildResponseLinkEmail({ editUrl: editUrl(c, editSecret) }) });
      return true;
    } catch (e) {
      deps.logger.error(
        { err: e, presentationId: view.presentationId, shareTokenId: view.token.id },
        'form response edit-link email failed'
      );
      return false;
    }
  }

  // ── POST: submit one response (returns the one-time edit secret) ──────────
  api.post('/viewer/:secret/forms/:form/responses', async (c) => {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved.res;
    const { token, presentationId } = resolved.view;

    const formName = parseFormName(c);
    if (!formName.ok) return formName.res;

    // Spam wall BEFORE any write: per IP + token, from the limiter registry.
    try {
      await deps.formSubmitLimiter.consume(`${clientIp(c)}:${token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many submissions — slow down.'), 429);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('validation_error', 'Body must be JSON'), 400);
    }
    const parsed = formSubmitBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            details: parsed.error.issues
          }
        },
        400
      );
    }
    const body = parsed.data;
    if (JSON.stringify(body.payload).length > MAX_FORM_PAYLOAD_JSON_BYTES) {
      return c.json(
        err('payload_too_large', `payload must serialize under ${MAX_FORM_PAYLOAD_JSON_BYTES} bytes`),
        400
      );
    }
    const claimed = resolveClaimedVersion(c, resolved.view, body.version);
    if (!claimed.ok) return claimed.res;

    // PRDCT-2328: a DIRECT navigation on a remembering link submits INTO
    // the link's remembered row (created on the first submit, updated
    // after). An embed submission (`source: 'embed'`) on the same link is
    // an ordinary fresh row: the source is client-declared attribution, and
    // lying about it gains nothing — the token already IS the credential
    // for the remembered row, so the only effect of a false 'link' is to
    // reach what the token could reach anyway.
    const remembering = linkRemembers(token) && body.source === 'link';
    const existing = remembering ? await forms.findRemembered(token.id, formName.name) : null;

    // Hard per-deck ceiling — spam containment on a public write endpoint.
    // An UPDATE of a remembered row adds no row, so it passes a full deck.
    if (!existing && (await forms.countForDeck(presentationId)) >= FORM_RESPONSES_MAX_PER_DECK) {
      return c.json(err('responses_full', 'This deck has reached its response limit.'), 403);
    }

    const attribution = {
      workspaceId: token.workspaceId,
      presentationId,
      version: claimed.version,
      formName: formName.name,
      shareTokenId: token.id,
      source: body.source,
      placement: viewPlacement(body.placement),
      payload: body.payload,
      // A link without the upload capability never attaches a file, whatever
      // the body says (an id minted while the switch was on stays pending
      // and is purged).
      files: token.canUploadFiles ? body.files : undefined
    };

    if (remembering) {
      let upserted;
      try {
        upserted = await forms.upsertRemembered(attribution);
      } catch (e) {
        const refused = claimRefusal(c, e);
        if (refused) return refused;
        throw e;
      }
      const { row, created } = upserted;
      deps.logger.info(
        { presentationId, shareTokenId: token.id, responseId: row.id, formName: formName.name, created },
        created ? 'viewer form response created (remembered)' : 'viewer form response updated (remembered)'
      );
      deps.notifier.fire({ kind: created ? 'new' : 'edited', row, shareTokenName: token.name });
      // No edit secret on the wire: the LINK is the handle, and the
      // respondent wire never carries a revision or a history.
      return c.json(
        { response: await respondentWire(row), emailSent: false, remembered: true, edited: !created },
        created ? 201 : 200
      );
    }

    let createdRow;
    try {
      createdRow = await forms.create(attribution);
    } catch (e) {
      const refused = claimRefusal(c, e);
      if (refused) return refused;
      throw e;
    }
    const { row, editSecret } = createdRow;

    deps.logger.info(
      {
        presentationId,
        shareTokenId: token.id,
        responseId: row.id,
        formName: formName.name,
        version: claimed.version
      },
      'viewer form response created'
    );
    deps.notifier.fire({ kind: 'new', row, shareTokenName: token.name });
    // `emailSent` stays on the wire (the runtime and the tests read it) but
    // is now always false on create: the leg-3 auto-mail is gone with leg 3
    // — it bypassed the email limiter entirely and turned every replayed
    // submit into a mail to a stranger's real address (PRDCT-1331).
    return c.json(
      {
        response: await respondentWire(row),
        editSecret,
        emailSent: false,
        remembered: false,
        edited: false
      },
      201
    );
  });

  // ── GET (form-agnostic): the link's remembered rows, one per form ────────
  // PRDCT-2328: the runtime's ONE probe per page load on a remembering link,
  // resolved by the share secret alone. A link that does not remember
  // answers 404 without burning anything — no secret was guessed, the share
  // secret already resolved above. The respondent wire: no revision, no
  // history, no ids beyond the row's own.
  api.get('/viewer/:secret/forms/responses/remembered', async (c) => {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved.res;
    if (!linkRemembers(resolved.view.token)) {
      return c.json(err('not_found', 'This link does not remember responses.'), 404);
    }
    const rows = await forms.listRemembered(resolved.view.token.id);
    const files = await uploads.listForResponses(rows.map((r) => r.id));
    return c.json(
      { responses: rows.map((r) => formResponseToRespondentWire(r, files.get(r.id) ?? [])) },
      200
    );
  });

  // ── GET (form-agnostic): resolve an arriving edit secret ONCE per page ───
  // The runtime calls this a single time when a page arrives with an
  // `#slr=` fragment, whatever the number of forms on the page, and offers
  // the resume prompt only on the form the row names. Same capability, same
  // bucket policy as the form-bound read below; one request instead of N.
  api.get('/viewer/:secret/forms/responses/me', async (c) => {
    const resolved = await resolveOwnRow(c);
    if (!resolved.ok) return resolved.res;
    return c.json({ response: await respondentWire(resolved.row) }, 200);
  });

  // ── GET: the respondent's own row (prefill on return visits) ─────────────
  api.get('/viewer/:secret/forms/:form/responses/me', async (c) => {
    const resolved = await resolveOwnResponse(c);
    if (!resolved.ok) return resolved.res;
    return c.json({ response: await respondentWire(resolved.row) }, 200);
  });

  // ── PUT: update the own row (the one evolving answer) ────────────────────
  api.put('/viewer/:secret/forms/:form/responses/me', async (c) => {
    const resolved = await resolveOwnResponse(c);
    if (!resolved.ok) return resolved.res;
    const { view, row } = resolved;

    try {
      await deps.formSubmitLimiter.consume(`${clientIp(c)}:${view.token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many submissions — slow down.'), 429);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('validation_error', 'Body must be JSON'), 400);
    }
    const parsed = formUpdateBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: 'validation_error',
            message: 'Request validation failed',
            details: parsed.error.issues
          }
        },
        400
      );
    }
    if (JSON.stringify(parsed.data.payload).length > MAX_FORM_PAYLOAD_JSON_BYTES) {
      return c.json(
        err('payload_too_large', `payload must serialize under ${MAX_FORM_PAYLOAD_JSON_BYTES} bytes`),
        400
      );
    }
    // Re-stamp attribution from THIS navigation: an edit made through a
    // different link, source or placement must not keep the creator's.
    const claimed = resolveClaimedVersion(c, view, parsed.data.version);
    if (!claimed.ok) return claimed.res;
    let updated: FormResponseRow;
    try {
      updated =
        (await forms.updatePayload(row.id, parsed.data.payload, {
          version: claimed.version,
          shareTokenId: view.token.id,
          ...(parsed.data.source !== undefined ? { source: parsed.data.source } : {}),
          placement: viewPlacement(parsed.data.placement),
          files: view.token.canUploadFiles ? parsed.data.files : undefined
        })) ?? row;
    } catch (e) {
      const refused = claimRefusal(c, e);
      if (refused) return refused;
      throw e;
    }
    deps.logger.info(
      { presentationId: view.presentationId, shareTokenId: view.token.id, responseId: row.id },
      'viewer form response updated'
    );
    deps.notifier.fire({ kind: 'edited', row: updated, shareTokenName: view.token.name });
    return c.json({ response: await respondentWire(updated) }, 200);
  });

  // ── POST: upload ONE file into a form's file field (PRDCT-2403) ──────────
  // Raw streamed body (never multipart, never buffered): `?field=` is the
  // file input's name, `?name=` the file's display name, `?type=` its media
  // type. The runtime sends `Content-Type: application/octet-stream` whatever
  // the file is, so no JSON-sniffing middleware ever reads the body; the path
  // is exempt from the JSON body cap (api/index.ts) and capped mid-stream
  // here. Answers the PENDING upload's id, which the submit then names.
  api.post('/viewer/:secret/forms/:form/uploads', async (c) => {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved.res;
    const { token, presentationId } = resolved.view;
    const formName = parseFormName(c);
    if (!formName.ok) return formName.res;

    if (!token.canUploadFiles || token.purpose !== 'share' || uploads.caps.maxFileBytes === 0) {
      return c.json(err('uploads_disabled', 'This share link does not accept file uploads.'), 403);
    }
    try {
      await deps.formUploadLimiter.consume(`${clientIp(c)}:${token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many uploads — slow down.'), 429);
    }

    const field = formFileFieldNameSchema.safeParse(c.req.query('field'));
    if (!field.success) {
      return c.json(
        err('validation_error', 'field must be 1-128 characters with no control characters'),
        400
      );
    }
    const rawName = c.req.query('name') ?? '';
    if (rawName.length > 1024) {
      return c.json(err('validation_error', 'name must be at most 1024 characters'), 400);
    }
    const declaredType = (c.req.query('type') ?? '').slice(0, 255);
    const contentType = isValidMediaType(declaredType) ? declaredType : 'application/octet-stream';

    // Declared size first (a cheap refusal); the mid-stream cap is the law.
    const declared = Number(c.req.header('content-length') ?? '0');
    if (Number.isFinite(declared) && declared > uploads.caps.maxFileBytes) {
      return c.json(fileTooLarge(), 413);
    }
    if (!c.req.raw.body) {
      return c.json(err('empty_file', 'A file body is required.'), 400);
    }

    try {
      const row = await uploads.upload({
        workspaceId: token.workspaceId,
        presentationId,
        shareTokenId: token.id,
        formName: formName.name,
        fieldName: field.data,
        filename: sanitizeUploadName(rawName),
        contentType,
        body: Readable.fromWeb(c.req.raw.body as WebReadableStream)
      });
      deps.logger.info(
        { presentationId, shareTokenId: token.id, uploadId: row.id, sizeBytes: row.sizeBytes },
        'viewer form file uploaded'
      );
      return c.json(
        { file: { id: row.id, field: row.fieldName, name: row.filename, sizeBytes: row.sizeBytes } },
        201
      );
    } catch (e) {
      if (e instanceof FileTooLargeError) return c.json(fileTooLarge(), 413);
      if (e instanceof EmptyFileError)
        return c.json(err('empty_file', 'An uploaded file must not be empty.'), 400);
      if (e instanceof FormUploadsFullError) {
        deps.logger.warn({ presentationId }, 'form uploads refused: the deck reached its upload total');
        return c.json(err('uploads_full', 'This deck cannot take more uploaded files.'), 403);
      }
      throw e;
    }
  });

  function fileTooLarge() {
    const mb = Math.floor(uploads.caps.maxFileBytes / (1024 * 1024));
    return {
      error: {
        code: 'file_too_large',
        message: `A file must be at most ${mb} MB.`,
        details: { maxBytes: uploads.caps.maxFileBytes }
      }
    };
  }

  // ── DELETE: the respondent removes a file they just dropped ──────────────
  // PENDING uploads of THIS link and form only: a file a response already
  // holds leaves through the submit that stops naming it. Unknown, foreign
  // and attached ids all answer the same 404.
  api.delete('/viewer/:secret/forms/:form/uploads/:uploadId', async (c) => {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved.res;
    const formName = parseFormName(c);
    if (!formName.ok) return formName.res;
    try {
      await deps.formUploadLimiter.consume(`${clientIp(c)}:${resolved.view.token.id}`);
    } catch {
      return c.json(err('rate_limited', 'Too many requests — slow down.'), 429);
    }
    const id = z.uuid().safeParse(c.req.param('uploadId'));
    const removed = id.success
      ? await uploads.deletePending(id.data, resolved.view.token.id, formName.name)
      : false;
    if (!removed) return c.json(err('not_found', 'No pending upload matches.'), 404);
    return c.json({ deleted: true }, 200);
  });

  // ── POST: mail the respondent their own edit link (leg 2 opt-in) ─────────
  api.post('/viewer/:secret/forms/:form/responses/me/email', async (c) => {
    // The edit secret is REQUIRED here: the mail carries `#slr=<secret>`,
    // and a remembered row (PRDCT-2328) has no secret to mail — its link IS
    // the handle. Header-less calls take the fragment path's 404 + burn.
    const resolved = await resolveOwnResponse(c, { allowRemembered: false });
    if (!resolved.ok) return resolved.res;
    const { view } = resolved;

    if (!deps.email.delivers) {
      return c.json(err('email_unavailable', 'This instance does not send email.'), 400);
    }

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json(err('validation_error', 'Body must be JSON'), 400);
    }
    const parsed = formEmailBody.safeParse(raw);
    if (!parsed.success) {
      return c.json(err('validation_error', 'A valid email address is required'), 400);
    }
    const address = parsed.data.email.toLowerCase().trim();

    // Tight double-keyed wall: a public endpoint that sends mail is a spam
    // vector — per IP+token AND per target address (the emailKeyOf posture).
    try {
      await deps.formEmailLimiter.consume(`${clientIp(c)}:${view.token.id}`);
      await deps.formEmailLimiter.consume(`email:${address}`);
    } catch {
      return c.json(err('rate_limited', 'Too many emails — slow down.'), 429);
    }

    // The mail carries ONLY this respondent's own edit link — the secret
    // they already hold (it authenticated this very request).
    const editSecret = c.req.header(RESPONSE_SECRET_HEADER) ?? '';
    const emailSent = await sendEditLink(c, address, view, editSecret);
    return c.json({ emailSent }, 200);
  });
}

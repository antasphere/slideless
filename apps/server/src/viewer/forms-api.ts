import type { Context } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import type { RateLimiterAbstract } from 'rate-limiter-flexible';
import { z } from 'zod';
import { formNameSchema, formResponsePayloadSchema, formResponseSourceSchema } from '@slideless/contract';
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
  type FormResponseService
} from '../forms/service.js';
import { verifyRespondentAssertion } from './respondent.js';
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
 *  - IDENTITY: `respondent_user_id` is stamped ONLY from the signed
 *    serve-time assertion (viewer/respondent.ts); a stale/forged assertion
 *    degrades to anonymous, never fails the submit.
 *  - ABUSE: creates/updates burn a per-IP+token bucket; unknown share
 *    secrets burn per-IP; failed edit-secret lookups burn the same submit
 *    bucket; the email leg has its own tight per-IP+token AND per-address
 *    bucket; a hard per-deck response cap backstops it all. Responses are
 *    not audited (the viewer's documented non-goal); owner deletes are.
 *  - CORS: wildcard, like every token-session route — the opaque origin
 *    sends `Origin: null` and nothing here is cookie-authenticated.
 */

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
  /** The signed respondent assertion, echoed from the injected config. */
  assertion: z.string().max(1024).optional()
});

const formUpdateBody = z.object({
  payload: formResponsePayloadSchema
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
  /** MAC key for the unlock proof + respondent assertion (the auth secret). */
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
}

export function registerViewerFormRoutes(api: OpenAPIHono, deps: ViewerFormDeps): void {
  const { sharing, presentations, forms, authSecret, clientIp } = deps;

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

  /**
   * The respondent's own row: token session + edit secret, bound together —
   * the row must belong to THIS deck and THIS token. Any mismatch answers
   * the same 404 as a missing secret (no foreign-row oracle), and burns the
   * submit bucket like an invalid share secret would.
   */
  async function resolveOwnResponse(
    c: Context
  ): Promise<{ ok: true; view: TokenSessionView; row: FormResponseRow } | { ok: false; res: Response }> {
    const resolved = await resolveSubmitter(c);
    if (!resolved.ok) return resolved;
    const { view } = resolved;
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
    const { token, version: resolvedVersion, presentationId } = resolved.view;

    const formName = formNameSchema.safeParse(c.req.param('form'));
    if (!formName.success) {
      return c.json(err('validation_error', 'form name must be 1-64 chars of [A-Za-z0-9._-]'), 400);
    }

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
    // The response records the version the respondent SAW — same discipline
    // as annotations: a pinned token can only mean its pin; a latest-mode
    // token may claim the version its document was served with.
    let version = resolvedVersion;
    if (body.version !== undefined) {
      if (token.pinnedVersion !== null && body.version !== token.pinnedVersion) {
        return c.json(err('invalid_version', 'This share link is pinned to a different version'), 400);
      }
      if (body.version > resolvedVersion) {
        return c.json(err('invalid_version', 'version does not exist on this presentation'), 400);
      }
      version = body.version;
    }

    // Hard per-deck ceiling — spam containment on a public write endpoint.
    if ((await forms.countForDeck(presentationId)) >= FORM_RESPONSES_MAX_PER_DECK) {
      return c.json(err('responses_full', 'This deck has reached its response limit.'), 403);
    }

    // Identity is best-effort: a valid assertion stamps the user, anything
    // else (absent, stale, forged) degrades to anonymous.
    const respondentUserId =
      body.assertion !== undefined
        ? verifyRespondentAssertion(authSecret, token.id, body.assertion)
        : null;

    const { row, editSecret } = await forms.create({
      workspaceId: token.workspaceId,
      presentationId,
      version,
      formName: formName.data,
      shareTokenId: token.id,
      source: body.source,
      placement: viewPlacement(body.placement),
      respondentUserId,
      payload: body.payload
    });

    // Leg 3 courtesy: a recognized respondent gets their edit link mailed to
    // their account address with zero prompting. Best-effort, never blocks.
    let emailSent = false;
    if (respondentUserId !== null && deps.email.delivers) {
      const to = await forms.userEmail(respondentUserId);
      if (to !== null) emailSent = await sendEditLink(c, to, resolved.view, editSecret);
    }

    deps.logger.info(
      { presentationId, shareTokenId: token.id, responseId: row.id, formName: formName.data, version },
      'viewer form response created'
    );
    return c.json({ response: formResponseToRespondentWire(row), editSecret, emailSent }, 201);
  });

  // ── GET: the respondent's own row (prefill on return visits) ─────────────
  api.get('/viewer/:secret/forms/responses/me', async (c) => {
    const resolved = await resolveOwnResponse(c);
    if (!resolved.ok) return resolved.res;
    return c.json({ response: formResponseToRespondentWire(resolved.row) }, 200);
  });

  // ── PUT: update the own row (the one evolving answer) ────────────────────
  api.put('/viewer/:secret/forms/responses/me', async (c) => {
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
    const updated = (await forms.updatePayload(row.id, parsed.data.payload)) ?? row;
    deps.logger.info(
      { presentationId: view.presentationId, shareTokenId: view.token.id, responseId: row.id },
      'viewer form response updated'
    );
    return c.json({ response: formResponseToRespondentWire(updated) }, 200);
  });

  // ── POST: mail the respondent their own edit link (leg 2 opt-in) ─────────
  api.post('/viewer/:secret/forms/responses/me/email', async (c) => {
    const resolved = await resolveOwnResponse(c);
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

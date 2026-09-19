import { join } from 'node:path';
import { bodyLimit } from 'hono/body-limit';
import { createDb } from '@slideless/db';
import {
  apiKeyCreateRoute,
  apiKeyRevokeRoute,
  apiKeysListRoute,
  cliAuthCompleteRoute,
  meRoute,
  ssoCliConnectRoute
} from '@slideless/contract/routes';
import type { BootOverrides, BootResult, ToolDefinition } from '@antasphere/chassis-server';
import { makeClientIp, rateLimit } from '@antasphere/chassis-server/middleware';
import { deckEnvExtension, type DeckEnvShape } from './env.js';
import { INTRINSIC_VERSION } from './version.js';
import { findMigrationsFolder, publicDir } from './runtime.js';
import { CLI_KEY_SCOPES, OAUTH_SCOPES, requiredScopeFor } from './middleware/scopes.js';
import { deckBuckets } from './middleware/deck-rate-limits.js';
import { isDeckIdempotencyTarget } from './middleware/deck-idempotency.js';
import { hostGate } from './middleware/host-gate.js';
import { isDeckAuditExempt } from './audit/deck-exempt.js';
import { deckJobs } from './jobs/deck-jobs.js';
import { slidelessMcp } from './mcp/index.js';
import type { DeckEvents } from './platform/deck-events.js';
import { registerPresentationRoutes } from './api/presentations.js';
import { registerCollaboratorRoutes } from './api/collaborators.js';
import { blobReadScope, PresentationService } from './presentations/service.js';
import { AnnotationService } from './annotations/service.js';
import { CollaboratorService } from './collaborators/service.js';
import { ShareTokenService } from './sharing/service.js';
import { ShareTokenViewService } from './sharing/view-events.js';
import { ShareTokenDownloadService } from './sharing/download-events.js';
import { FormResponseService } from './forms/service.js';
import { FormResponseNotifier } from './forms/notify.js';
import { FormUploadService, formUploadCaps } from './forms/uploads.js';
import { isViewerFormUploadPath, registerViewerFormRoutes } from './viewer/forms-api.js';
import { registerViewerAttachmentRoutes } from './viewer/attachments-api.js';
import { registerViewerAnnotationRoutes, viewerApiCors } from './viewer/annotations-api.js';
import { viewerRoutes } from './viewer/routes.js';

/**
 * The Slideless tool definition: what the deck domain plugs into the chassis
 * composition (`createPlatform`, `@antasphere/chassis-server`). Every ORDER —
 * the boot sequence, the API app's middleware and route registration, the
 * root app's mounts — belongs to the chassis; this file only fills its named
 * slots, each invoked at the exact place the deck code always sat.
 */

/** Inline error body matching the wire shape. */
const err = (code: string, message: string) => ({ error: { code, message } });

/** The deck domain's services: what `services` builds and `BootResult.tool` exposes. */
export interface DeckDomain {
  /** Share tokens (Phase 4) — shared with the public viewer. */
  sharing: ShareTokenService;
  forms: FormResponseService;
  formUploads: FormUploadService;
  /** Owner notifications for form responses (PRDCT-2330). Test seam: `drain()` awaits in-flight owner mails. */
  formsNotifier: FormResponseNotifier;
  /** Per-deck dev grants (Phase 5) — shared with the user.created hook. */
  collaborators: CollaboratorService;
  presentations: PresentationService;
  annotations: AnnotationService;
}

/** The deck domain's test seams (`BootOverrides.tool`). */
export interface DeckOverrides {
  /**
   * Shrinks the owner-notification cooldown (forms/notify.ts) so integration
   * tests can watch the burst posture in milliseconds. Production always
   * runs the fixed default.
   */
  formsMailCooldownMs?: number;
}

type DeckBucket = keyof typeof deckBuckets;

export type SlidelessBootOverrides = BootOverrides<DeckOverrides>;
export type SlidelessBootResult = BootResult<DeckEnvShape, DeckDomain, DeckEvents>;

export const slidelessTool: ToolDefinition<DeckEnvShape, DeckDomain, DeckBucket, DeckEvents, DeckOverrides> =
  {
    runtime: {
      version: INTRINSIC_VERSION,
      findMigrationsDir: findMigrationsFolder,
      publicDir
    },
    db: createDb,
    env: deckEnvExtension,
    scopes: {
      oauth: OAUTH_SCOPES,
      cliKey: CLI_KEY_SCOPES,
      requiredScopeFor,
      contractRoutes: {
        meRoute,
        apiKeysListRoute,
        apiKeyCreateRoute,
        apiKeyRevokeRoute,
        cliAuthCompleteRoute,
        ssoCliConnectRoute
      }
    },

    services: ({ db, env, logger, storage, pepperRegistry, email, events, overrides }) => {
      // Share-token secrets ride the SAME versioned pepper registry as API keys
      // (ADR 008): sha256(secret + pepper), fail-closed across rotations.
      const sharing = new ShareTokenService(db, pepperRegistry);

      // Form file uploads (PRDCT-2403): what respondents drop into a form's file
      // fields — stored apart from the workspace's content-addressed files,
      // bounded by the three FORMS_* instance ceilings.
      const formUploads = new FormUploadService(
        db,
        storage,
        join(env.DATA_DIR, 'tmp'),
        logger,
        formUploadCaps(env)
      );
      // Form-response edit secrets: the same credential pattern one level down
      // (ADR 022) — one registry, one rotation story for every peppered secret.
      const forms = new FormResponseService(db, pepperRegistry, formUploads);
      // Owner mails on new and edited responses (PRDCT-2330): fire-and-forget
      // after the viewer write, per-deck switch, one mail per deck per window.
      const formsNotifier = new FormResponseNotifier({
        db,
        forms,
        email,
        env,
        logger,
        cooldownMs: overrides?.formsMailCooldownMs
      });

      // Per-deck collaborators (Phase 5). Claim-at-signup: user creation is the
      // moment the template redeems invitations, so a fresh account (created via
      // a workspace invitation or the collaborator claim endpoint) sweeps every
      // live pending grant addressed to its email. The event bus isolates
      // failures; the sweep is idempotent against the claim endpoint's own.
      const collaboratorService = new CollaboratorService(db);
      events.on('user.created', async ({ userId, email: userEmail }) => {
        const claimed = await collaboratorService.claimAllPendingForEmail(userEmail, userId);
        if (claimed > 0) {
          logger.info({ userId, claimed }, 'claimed pending collaborator grants at account creation');
        }
      });

      // Presentation domain (ADR 011): Phases 3 (upload/versioning/pull),
      // 4 (sharing + viewer), and 5 (collaborators/annotations) are all live.
      const presentationService = new PresentationService(db);
      const annotationService = new AnnotationService(db);

      return {
        sharing,
        forms,
        formUploads,
        formsNotifier,
        collaborators: collaboratorService,
        presentations: presentationService,
        annotations: annotationService
      };
    },

    // The form-upload purge needs the storage driver, which is probed after the
    // jobs are created; the job reads the service through `getTool` at RUN time (nightly).
    jobs: ({ env, db, logger, getTool }) =>
      deckJobs({
        env,
        db,
        logger,
        purgeFormUploads: async () => (await getTool()?.formUploads.purgeUnattached()) ?? 0
      }),

    rateLimiters: deckBuckets,

    api: {
      // The origin that is never trusted — the viewer origin, where
      // author-controlled deck script runs (PRDCT-1352). Unset = nothing installed.
      untrustedOrigins: (env) => (env.VIEWER_BASE_URL ? [new URL(env.VIEWER_BASE_URL).origin] : []),
      // `/api/v1/viewer/*` is the share-token annotation API, and it is a
      // DELIBERATE wildcard-CORS surface (viewer/annotations-api.ts): it is
      // called by the overlay client running inside the sandboxed viewer
      // iframe, whose origin is the opaque `null`. Nothing there is
      // cookie-authenticated — the share token in the path is the credential —
      // so it is not the ambient-credential class the cross-site guard closes, and
      // refusing `Origin: null` would break annotations outright.
      csrfExempt: (path) => path.startsWith('/api/v1/viewer/'),
      auditExempt: isDeckAuditExempt,
      idempotencyTargets: isDeckIdempotencyTarget,

      // The public viewer-token annotation surface (Phase 5): same posture — the
      // overlay calls cross-origin from the sandboxed opaque origin (Origin:
      // null), token-authed, never cookie-authed, so wildcard CORS is safe.
      early: (api) => {
        api.use('/viewer/*', viewerApiCors());
      },

      // Body size caps beside the chassis ones (its `/files` rule first, its
      // 1 MiB default last):
      //  - /presentations/assets: multipart deck-asset uploads — capped at
      //    MAX_FILE_SIZE_MB (+1 MiB multipart framing headroom) so an unbounded
      //    body can never balloon the buffering parse;
      //  - the rest of /presentations: JSON, but commit manifests are legal up to
      //    5000 entries × 1 KiB paths — a 16 MiB cap fits any contract-valid
      //    manifest while still bounding abuse.
      //  - the viewer's form file upload (PRDCT-2403): one raw streamed file per
      //    request, capped MID-STREAM by the form-upload ceiling in its handler.
      bodyLimit: ({ env }) => {
        const manifestBodyLimit = bodyLimit({
          maxSize: 16 * 1024 * 1024,
          onError: (c) => c.json(err('payload_too_large', 'Request body exceeds the 16 MiB limit'), 413)
        });
        const assetBodyLimit = bodyLimit({
          maxSize: env.MAX_FILE_SIZE_MB * 1024 * 1024 + 1024 * 1024,
          onError: (c) =>
            c.json(err('file_too_large', `Asset exceeds the ${env.MAX_FILE_SIZE_MB} MB instance cap`), 413)
        });
        return (path) => {
          if (isViewerFormUploadPath(path)) return 'exempt';
          if (path === '/api/v1/presentations/assets') return assetBodyLimit;
          if (path.startsWith('/api/v1/presentations')) return manifestBodyLimit;
          return undefined;
        };
      },

      // The form file upload is exempt from the JSON nesting cap: its body is a
      // FILE, never parsed, and a respondent's `.json` sent with a JSON content
      // type would otherwise be cloned into memory whole (up to the upload
      // ceiling) by the scan.
      jsonDepthExempt: isViewerFormUploadPath,

      // Collaborator claims are invitation acceptances in per-deck clothing —
      // the same public token-redemption surface, the same wall.
      rateLimits: (api, { limiters, clientIp }) => {
        api.use('/collaborators/claim', rateLimit(limiters.invitationAccept, clientIp));
        api.use('/collaborators/lookup', rateLimit(limiters.invitationAccept, clientIp));
      },

      filePolicy: ({ presentations: presentationService }) => ({
        // ADR 011 sharp edge closed: a blob referenced by a live deck version
        // manifest is not deletable through the generic files surface.
        blobInUse: (tx, workspaceId, sha256) => presentationService.blobInUse(tx, workspaceId, sha256),
        // SL-B1: the generic files surface authorizes per DECK, not per
        // workspace — the ADR 013 policy expressed as a WHERE predicate.
        blobReadScope
      }),

      routes: (api, ctx, deps) => {
        const { db, env, auth, email, audit, registry, logger, limiters, clientIp, instanceId, hubSso } = ctx;
        const presentationService = deps.presentations;
        const annotationService = deps.annotations;
        registerPresentationRoutes(api, {
          service: presentationService,
          sharing: deps.sharing,
          views: new ShareTokenViewService(db, logger),
          annotations: annotationService,
          forms: deps.forms,
          formUploads: deps.formUploads,
          fileService: ctx.fileService,
          storage: ctx.storage,
          registry,
          env,
          email,
          logger,
          instanceId
        });
        // Collaborator routes AFTER registerPresentationRoutes: the /presentations
        // requireAuth gates registered there must precede these handlers.
        registerCollaboratorRoutes(api, {
          db,
          env,
          auth,
          email,
          audit,
          registry,
          logger,
          presentations: presentationService,
          collaborators: deps.collaborators,
          // Cloud presence switch (internal/federation.md P6): closes the claim
          // endpoint's local-password account creation — invitees arrive through
          // the P3 SSO entrance instead. undefined on oss.
          hubSso
        });
        // The PUBLIC viewer-token annotation surface (Phase 5): token-authed,
        // deliberately outside requireAuth and the scope allowlist — see the
        // module's containment story. Registered before the 404 terminator.
        registerViewerAnnotationRoutes(api, {
          sharing: deps.sharing,
          presentations: presentationService,
          annotations: annotationService,
          logger,
          authSecret: ctx.authSecret,
          annotateLimiter: limiters.viewerAnnotate,
          passwordLimiter: limiters.viewerPassword,
          clientIp
        });
        // The PUBLIC viewer-token form surface (ADR 022): the annotation surface's
        // sibling — same containment story, same shared token-session resolver.
        registerViewerFormRoutes(api, {
          sharing: deps.sharing,
          presentations: presentationService,
          forms: deps.forms,
          logger,
          authSecret: ctx.authSecret,
          email,
          env,
          formSubmitLimiter: limiters.viewerFormSubmit,
          formEmailLimiter: limiters.viewerFormEmail,
          passwordLimiter: limiters.viewerPassword,
          clientIp,
          notifier: deps.formsNotifier,
          uploads: deps.formUploads,
          formUploadLimiter: limiters.viewerFormUpload
        });
        // The PUBLIC viewer-token attachments list (PRDCT-2278): the read-only
        // third sibling — same resolver, same containment. Unknown-secret probes
        // burn the annotation surface's per-IP bucket (nothing is written here,
        // the bucket only keeps the endpoint from being a cheaper secret oracle
        // than /v).
        registerViewerAttachmentRoutes(api, {
          sharing: deps.sharing,
          presentations: presentationService,
          logger,
          authSecret: ctx.authSecret,
          invalidSecretLimiter: limiters.viewerAnnotate,
          passwordLimiter: limiters.viewerPassword,
          clientIp
        });
      }
    },

    app: {
      // PRDCT-1352: the viewer-origin host gate, BEFORE every mount — the
      // boundary between the two hostnames must be decided before any route
      // (and any cookie-reading middleware) runs. Unset = NOTHING installed.
      rootMiddleware: (env) =>
        env.VIEWER_BASE_URL ? hostGate({ viewerBaseUrl: env.VIEWER_BASE_URL }) : undefined,
      // The dashboard CSP may frame the viewer origin (the preview iframe).
      cspFrameSrc: (env) => (env.VIEWER_BASE_URL ? [new URL(env.VIEWER_BASE_URL).origin] : []),
      // The public share-link viewer (Phase 4, ADR 012): anonymous, mounted in
      // the chassis app's public-route slot, serves user HTML ONLY under CSP: sandbox.
      publicRoutes: (
        { db, env, logger, storage, fileService, email, limiters, authSecret },
        { sharing, formUploads }
      ) =>
        viewerRoutes({
          sharing,
          views: new ShareTokenViewService(db, logger),
          downloads: new ShareTokenDownloadService(db, logger),
          presentations: new PresentationService(db),
          fileService,
          storage,
          logger,
          authSecret,
          passwordLimiter: limiters.viewerPassword,
          clientIp: makeClientIp(env.TRUST_PROXY),
          secureCookies: env.PUBLIC_BASE_URL.startsWith('https://'),
          viewDedupeWindowMs: env.VIEW_DEDUPE_WINDOW_MINUTES * 60_000,
          // The forms runtime's email opt-in flag. NOTHING identity-shaped is
          // handed to the viewer any more: ADR 022 leg 3 read the serving
          // request's session here and injected a signed assertion of the viewer's
          // identity into the deck document, which deck JS could lift
          // (PRDCT-1331). Never reintroduce a session read on this path.
          emailDelivers: email.delivers,
          formUploadCaps: formUploads.caps
        })
    },

    mcp: { ...slidelessMcp, defaultInstanceName: 'Slideless' }
  };

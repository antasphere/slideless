import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Context as HonoContext } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import {
  agentDocGetRoute,
  annotationCreateRoute,
  annotationDeleteRoute,
  annotationsInboxRoute,
  annotationsListRoute,
  annotationUpdateRoute,
  assetDownloadRoute,
  assetPrecheckRoute,
  assetUploadRoute,
  formResponseDeleteRoute,
  formResponseFileDownloadRoute,
  formResponseFilesZipRoute,
  formResponsesFilesZipRoute,
  formResponseGetRoute,
  formResponsesListRoute,
  formResponsesSummaryRoute,
  presentationDeleteRoute,
  presentationDuplicateRoute,
  presentationGetRoute,
  presentationsListRoute,
  presentationUpdateRoute,
  previewTokenCreateRoute,
  shareTokenCreateRoute,
  shareTokenRevokeRoute,
  shareTokenSendRoute,
  shareTokensListRoute,
  shareTokenUpdateRoute,
  shareTokenViewsListRoute,
  uploadSessionCommitRoute,
  uploadSessionCreateRoute,
  versionAttachmentDownloadRoute,
  versionAttachmentsZipRoute,
  versionCommitRoute,
  versionGetRoute,
  versionsListRoute,
  presentationProjectLinkRoute,
  presentationProjectUnlinkRoute,
  projectBrandClearRoute,
  projectBrandGetRoute,
  projectBrandSetRoute
} from '@slideless/contract/routes';
import {
  AGENT_DOC_PATH,
  attachmentPathOf,
  attachmentsOf,
  isTraversalSafeAssetPath,
  PREVIEW_SHARE_TOKEN_NAME,
  type ManifestEntry,
  type PresentationProjectRef,
  type Reference
} from '@slideless/contract';
import { projectRoleAtLeast, type Principal } from '@antasphere/chassis-contract';
import type { Context } from 'hono';
import type { PresentationRow, PresentationVersionRow, UploadSessionRow } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { DeckRegistry } from '../platform/deck-events.js';
import type { EmailDriver } from '@antasphere/chassis-server/email';
import { buildShareEmail } from '../email/deck-templates.js';
import type { FileService } from '@antasphere/chassis-server/files';
import { FileTooLargeError } from '@antasphere/chassis-server/files';
import { encodeContentDisposition } from '@antasphere/chassis-server/files';
import { serveBlob } from '@antasphere/chassis-server/files';
import type { StorageDriver } from '@antasphere/chassis-server/storage';
import { manifestHasForms } from '../forms/detect.js';
import { readReference } from '../presentations/reference-frontmatter.js';
import { attachmentsZipFilename, serveAttachmentsZip, serveZip } from '../presentations/attachments.js';
import { responseZipFolder, uniqueZipPath, zipSegment, type FormUploadService } from '../forms/uploads.js';
import { canAdministerDeck, type PresentationService } from '../presentations/service.js';
import {
  buildViewerUrl,
  PREVIEW_TOKEN_TTL_MS,
  shareTokenToWire,
  type ShareTokenService
} from '../sharing/service.js';
import { hashViewerPassword } from '../sharing/password.js';
import { shareTokenViewToWire, type ShareTokenViewService } from '../sharing/view-events.js';
import { annotationToWire, type AnnotationService } from '../annotations/service.js';
import { formResponseToWire, formResponseVersionToWire, type FormResponseService } from '../forms/service.js';
import { requireAuth, requireNonGuest } from '@antasphere/chassis-server/middleware';

/**
 * Presentation domain routes (ADR 011). Phase 3: the upload + versioning
 * pipeline (push protocol, pull, delete). Phase 4: sharing (the public
 * viewer's token-session routes live OUTSIDE this principal-gated surface —
 * viewer/routes.ts + viewer/annotations-api.ts). Phase 5: the owner/dev
 * annotation management surface below; the per-deck collaborator routes
 * live in api/collaborators.ts.
 */

const err = (code: string, message: string) => ({ error: { code, message } });

const presentationToWire = (p: PresentationRow, projects: PresentationProjectRef[] = []) => ({
  id: p.id,
  title: p.title,
  kind: p.kind,
  interactive: p.interactive,
  metadata: p.metadata,
  currentVersion: p.currentVersion,
  entryPath: p.entryPath,
  hasAgentDoc: p.hasAgentDoc,
  hasDownloads: p.hasDownloads,
  ownerUserId: p.ownerUserId,
  remixedFrom: p.remixedFrom,
  // Viewer entry loads recorded by recordEntryView (dashboard preview
  // tokens excluded at the viewer, so owner previews never count).
  totalViews: p.totalViews,
  notifyOnResponse: p.notifyOnResponse,
  // The mirror written at push (ADR 025) — already `{ type, …frontmatter }`.
  reference: (p.reference as Reference | null) ?? null,
  audience: p.audience,
  defaultReference: p.isDefaultReference,
  projects,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString()
});

const versionToWire = (v: Omit<PresentationVersionRow, 'manifest'>) => ({
  presentationId: v.presentationId,
  version: v.version,
  entryPath: v.entryPath,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
  hasAgentDoc: v.hasAgentDoc,
  hasDownloads: v.hasDownloads,
  reference: (v.reference as Reference | null) ?? null,
  referenceWarning: v.referenceWarning,
  createdBy: v.createdBy,
  createdByRole: v.createdByRole,
  createdAt: v.createdAt.toISOString()
});

const sessionToWire = (s: UploadSessionRow) => ({
  id: s.id,
  presentationId: s.presentationId,
  expiresAt: s.expiresAt.toISOString(),
  createdAt: s.createdAt.toISOString()
});

export interface PresentationRouteDeps {
  service: PresentationService;
  sharing: ShareTokenService;
  /** Per-view share-link analytics (PRDCT-1313), read surface only here. */
  views: ShareTokenViewService;
  annotations: AnnotationService;
  forms: FormResponseService;
  formUploads: FormUploadService;
  fileService: FileService;
  storage: StorageDriver;
  registry: DeckRegistry;
  env: Pick<Env, 'MAX_FILE_SIZE_MB' | 'PUBLIC_BASE_URL' | 'VIEWER_BASE_URL'>;
  email: EmailDriver;
  logger: Logger;
}

export function registerPresentationRoutes(api: OpenAPIHono, deps: PresentationRouteDeps): void {
  const {
    service,
    sharing,
    views,
    annotations,
    forms,
    formUploads,
    fileService,
    storage,
    registry,
    env,
    email,
    logger
  } = deps;
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;

  /** A deck's payload AS THIS CALLER reads it: its projects are the ones they can read (ADR 026). */
  const wireMany = async (principal: Principal, decks: PresentationRow[]) => {
    const projectsByDeck = await service.projectsOf(
      principal,
      decks.map((d) => d.id)
    );
    return decks.map((d) => presentationToWire(d, projectsByDeck.get(d.id) ?? []));
  };
  const wire = async (principal: Principal, deck: PresentationRow) => (await wireMany(principal, [deck]))[0]!;

  api.use('/presentations', requireAuth());
  api.use('/presentations/*', requireAuth());
  api.use('/annotations', requireAuth());
  // Guest capability limit (D2, both editions): deck CREATION is a
  // workspace-level act — a guest invited to review one deck must not mint
  // decks in the host workspace. The gate covers the whole create pipeline
  // (session reserve + commit); everything a guest's grant legitimizes —
  // asset upload/precheck for pushes, version commits, share tokens,
  // annotations — stays per-deck-gated by ADR 013's canWrite and is
  // untouched. Deck creation in a guest's OWN workspace is unaffected: the
  // principal there resolves from a non-guest membership.
  api.use('/presentations/uploads', requireNonGuest());
  api.use('/presentations/uploads/*', requireNonGuest());
  // The duplicate (PRDCT-2279) is deck creation by another door — the same
  // wall, before any deck lookup (a guest probing a foreign id learns
  // nothing: 403 guest_forbidden whether the id exists or not).
  api.use('/presentations/:id/duplicate', requireNonGuest());

  // ── Upload (push protocol) ─────────────────────────────────────────────────
  // Literal-segment siblings of /presentations/{id} first (see LESSONS.md on
  // param patterns swallowing literals): uploads, precheck, assets.

  api.openapi(uploadSessionCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const session = await service.createUploadSession(principal.workspaceId, principal.userId);
    c.set('audit', {
      action: 'presentation.upload_session_create',
      resourceType: 'upload_session',
      resourceId: session.id,
      metadata: { presentationId: session.presentationId }
    });
    return c.json({ uploadSession: sessionToWire(session) }, 201);
  });

  api.openapi(assetPrecheckRoute, async (c) => {
    const principal = c.get('principal')!;
    const { sha256 } = c.req.valid('json');
    // Scoped to what THIS principal may read (SL-B1): "already present" must
    // never double as a whole-workspace existence oracle, and a sha the
    // caller could not bind at commit time has to report as missing here.
    const missing = await service.precheckMissing(principal.workspaceId, principal, sha256);
    return c.json({ missing }, 200);
  });

  api.openapi(assetUploadRoute, async (c) => {
    const principal = c.get('principal')!;

    // The declared-size check and the usage event are the chassis entitlement
    // gate's (DECK_ROUTE_ENTITLEMENTS in @slideless/contract/routes, the
    // billing rail §7); the true size is still enforced after parse below
    // (and the multipart body limit bounds the parse itself).
    const form = c.req.valid('form');
    const file = form.file as unknown;
    // Hono's parseBody yields string | File per part; the bytes MUST be a
    // file part (a string field named `file` is a malformed client).
    if (!(file instanceof File)) {
      return c.json(err('invalid_form', 'The `file` field must be a file part'), 400);
    }
    // MVP shape (slide-sized assets): the multipart part is buffered to hash
    // before storing — the declared sha must be verified BEFORE any files row
    // exists, or a mismatch would still mint a blob the client never meant.
    const bytes = Buffer.from(await file.arrayBuffer());
    if (bytes.length > maxBytes) {
      return c.json(err('file_too_large', `file exceeds the ${maxBytes}-byte limit`), 413);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== form.sha256) {
      return c.json(
        err('sha256_mismatch', `Declared sha256 ${form.sha256} but the content hashes to ${actual}`),
        400
      );
    }

    try {
      const { file: row, deduplicated } = await fileService.upload({
        workspaceId: principal.workspaceId,
        createdBy: principal.userId,
        originalName: file.name || form.sha256,
        contentType: file.type || 'application/octet-stream',
        body: Readable.from(bytes),
        maxBytes
      });

      // `sizeBytes` here is what the gate meters (auditedSizeBytes): the
      // bytes kept, not the multipart body's declared length.
      c.set('audit', {
        action: 'presentation.asset_upload',
        resourceType: 'file',
        resourceId: row.id,
        metadata: { sha256: row.sha256, sizeBytes: row.sizeBytes, deduplicated }
      });

      return c.json({ sha256: row.sha256, sizeBytes: row.sizeBytes, deduplicated }, 201);
    } catch (e) {
      if (e instanceof FileTooLargeError) {
        return c.json(err('file_too_large', e.message), 413);
      }
      logger.error({ err: e }, 'asset upload failed');
      return c.json(err('upload_failed', 'Upload failed'), 400);
    }
  });

  api.openapi(uploadSessionCommitRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await service.commitUploadSession({
      workspaceId: principal.workspaceId,
      principal,
      sessionId: id,
      title: body.title,
      kind: body.kind,
      interactive: body.interactive,
      metadata: body.metadata,
      entryPath: body.entryPath,
      manifest: body.manifest as ManifestEntry[],
      projectIds: body.projectIds,
      // PRDCT-1333: scanned HERE, before the commit transaction, so blob
      // reads never happen while the session/deck rows are locked.
      hasForms: await manifestHasForms(storage, principal.workspaceId, body.manifest as ManifestEntry[]),
      // ADR 025: the AGENT.md frontmatter, read here for the same reason —
      // and it never refuses the push (an unusable one is a warning).
      reference: await readReference(storage, principal.workspaceId, body.manifest as ManifestEntry[])
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          return c.json(err('not_found', 'Upload session not found'), 404);
        case 'session_consumed':
          return c.json(err('session_consumed', 'This upload session was already committed'), 409);
        case 'session_expired':
          return c.json(err('session_expired', 'This upload session has expired — reserve a new one'), 410);
        case 'project_not_found':
          // One answer for "no such project", "not yours to read" and "not
          // yours to link into": nothing about a project is probeable here.
          return c.json(
            {
              error: {
                code: 'project_not_found',
                message: 'A project named in projectIds was not found, is archived, or needs the editor role',
                details: { projectId: f.projectId }
              }
            },
            404
          );
        case 'invalid_manifest':
          return c.json(err('invalid_manifest', f.message), 400);
        case 'missing_blobs':
          return c.json(
            {
              error: {
                code: 'missing_blobs',
                message: `The manifest references ${f.missing.length} blob(s) not uploaded to this workspace — upload them and retry`,
                details: { missing: f.missing }
              }
            },
            400
          );
      }
    }

    c.set('audit', {
      action: 'presentation.create',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: {
        title: result.presentation.title,
        fileCount: result.version.fileCount,
        referenceType: result.version.referenceType
      }
    });
    registry.events.emit('presentation.created', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id
    });
    return c.json(
      { presentation: await wire(principal, result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  api.openapi(versionCommitRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');

    const result = await service.commitVersion({
      workspaceId: principal.workspaceId,
      principal,
      presentationId: id,
      expectedBaseVersion: body.expectedBaseVersion,
      entryPath: body.entryPath,
      manifest: body.manifest as ManifestEntry[],
      title: body.title,
      hasForms: await manifestHasForms(storage, principal.workspaceId, body.manifest as ManifestEntry[]),
      // ADR 025: the AGENT.md frontmatter, read here for the same reason —
      // and it never refuses the push (an unusable one is a warning).
      reference: await readReference(storage, principal.workspaceId, body.manifest as ManifestEntry[])
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          // Covers the unauthorized case too (AUTH-5, PRDCT-1393): the
          // service answers not_found for a deck the principal cannot
          // write, so a push probe never confirms a foreign deck exists.
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'invalid_manifest':
          return c.json(err('invalid_manifest', f.message), 400);
        case 'missing_blobs':
          return c.json(
            {
              error: {
                code: 'missing_blobs',
                message: `The manifest references ${f.missing.length} blob(s) not uploaded to this workspace — upload them and retry`,
                details: { missing: f.missing }
              }
            },
            400
          );
        case 'version_conflict':
          return c.json(
            {
              error: {
                code: 'version_conflict',
                message: `expectedBaseVersion ${body.expectedBaseVersion} is stale — the deck is at version ${f.currentVersion}; pull and retry`,
                details: { currentVersion: f.currentVersion }
              }
            },
            409
          );
      }
    }

    c.set('audit', {
      action: 'presentation.version_commit',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: {
        version: result.version.version,
        fileCount: result.version.fileCount,
        referenceType: result.version.referenceType,
        ...(result.referenceLoss ? { referenceLoss: result.referenceLoss } : {})
      }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id,
      version: result.version.version
    });
    return c.json(
      { presentation: await wire(principal, result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  // ── Presentations ──────────────────────────────────────────────────────────
  // READ POSTURE (ADR 013): decks are private to their owner. Every read —
  // get, versions, version detail, asset download — requires canRead (owner,
  // workspace admin/owner, or an ACTIVE collaborator grant on that deck),
  // and a failed check answers 404, never 403: a deck a principal cannot
  // read must not reveal its existence. The list is scoped the same way.

  api.openapi(presentationsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit, type, default: defaultOnly, project } = c.req.valid('query');
    // `project` names a project the caller must be able to READ: 404
    // otherwise, under every `type`, like the project itself (ADR 026).
    if (project !== undefined && (await service.projectRoleOf(principal, project)) === null) {
      return c.json(err('project_not_found', 'Project not found'), 404);
    }
    // Scoped in the service (ADR 013): admins/owners see the whole
    // workspace; members see owned decks + active collaborations, plus —
    // under `type` — the workspace's published references (ADR 025).
    const { presentations, nextCursor } = await service.list(principal, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
      ...(type !== undefined ? { type } : {}),
      ...(defaultOnly === 'true' ? { defaultOnly: true } : {}),
      ...(project !== undefined ? { projectId: project } : {})
    });
    return c.json({ presentations: await wireMany(principal, presentations), nextCursor }, 200);
  });

  api.openapi(presentationGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    return c.json(await wire(principal, deck), 200);
  });

  api.openapi(presentationUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deck = await service.get(principal.workspaceId, id);
    // THE TIERED RULE (AUTH-5, PRDCT-1393 — and ADR 025, which is the first
    // time a principal can READ a deck without writing it). A caller who
    // cannot read the deck gets the 404 a missing deck answers; a 403
    // appears only AFTER a passed read check, where it confirms nothing the
    // caller does not already legitimately see.
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    // Who may change what: the plain properties are the deck WRITERS'; the
    // audience is whoever ADMINISTERS the deck (its owner, a workspace
    // admin/owner — never a dev collaborator); the workspace default is a
    // WORKSPACE decision, admin/owner only, the deck's own owner included.
    const touchesPlain =
      body.title !== undefined || body.metadata !== undefined || body.notifyOnResponse !== undefined;
    if (touchesPlain && !(await service.canWrite(principal, deck))) {
      return c.json(err('forbidden', 'You can read this deck but not change it'), 403);
    }
    if (body.audience !== undefined && !canAdministerDeck(principal, deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin can change who reads a reference'),
        403
      );
    }
    if (body.defaultReference !== undefined && principal.role !== 'owner' && principal.role !== 'admin') {
      return c.json(
        err('forbidden', "Only a workspace admin can set or clear the workspace's default reference"),
        403
      );
    }
    const result = await service.update(principal.workspaceId, id, {
      title: body.title,
      metadata: body.metadata,
      notifyOnResponse: body.notifyOnResponse,
      audience: body.audience,
      defaultReference: body.defaultReference
    });
    if (!result.ok) {
      switch (result.failure.code) {
        case 'not_found':
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'not_a_reference':
          return c.json(
            err(
              'not_a_reference',
              'audience and defaultReference apply to a reference: a deck whose AGENT.md frontmatter names a type'
            ),
            422
          );
        case 'audience_private':
          return c.json(
            err(
              'audience_private',
              'A default reference must be readable by the workspace: set audience to workspace first'
            ),
            409
          );
        case 'default_reference':
          return c.json(
            err(
              'default_reference',
              "This is the workspace's default reference: clear the default before making it private"
            ),
            409
          );
      }
    }
    c.set('audit', {
      action: 'presentation.update',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: {
        fields: Object.keys(body),
        ...(body.audience !== undefined ? { audience: body.audience } : {}),
        ...(body.defaultReference !== undefined ? { defaultReference: body.defaultReference } : {}),
        ...(result.displacedDefaultIds.length > 0 ? { displacedDefaultIds: result.displacedDefaultIds } : {})
      }
    });
    return c.json(await wire(principal, result.presentation), 200);
  });

  // ── Projects (ADR 026) ─────────────────────────────────────────────────────
  // The chassis owns the project; these routes are the deck's side of it.
  // Registered under `/projects/{id}/brand`, a shape the chassis' machine
  // allowlist deliberately leaves to the tool (middleware/scopes.ts).

  const notFound = () => err('not_found', 'Presentation not found');
  const projectNotFound = () => err('project_not_found', 'Project not found');
  const projectArchived = () => err('project_archived', 'The project is archived: unarchive it to change it');
  const guestForbidden = (c: Context) => c.json(err('guest_forbidden', c.get('guestForbiddenMessage')), 403);

  // Linking WIDENS who reads the deck, so it is the deck administrator's act
  // (canAdministerDeck), with editor or more on the project: an editor adds a
  // deck OF THEIR OWN. Order: the deck's 404, the deck's 403, then the
  // project's 404, 403, 409.
  api.openapi(presentationProjectLinkRoute, async (c) => {
    const principal = c.get('principal')!;
    if (principal.origin === 'guest') return guestForbidden(c);
    const { id, projectId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) return c.json(notFound(), 404);
    if (!canAdministerDeck(principal, deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin links a deck to a project'),
        403
      );
    }
    const role = await service.projectRoleOf(principal, projectId);
    if (role === null) return c.json(projectNotFound(), 404);
    if (!projectRoleAtLeast(role, 'editor')) {
      return c.json(err('insufficient_project_role', 'This needs the editor role on the project'), 403);
    }
    if ((await service.linkProject(deck, projectId, principal.userId)) === 'archived') {
      return c.json(projectArchived(), 409);
    }
    c.set('audit', {
      action: 'presentation.project_link',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { projectId }
    });
    return c.json(await wire(principal, deck), 200);
  });

  // Unlinking NARROWS who reads the deck: whoever administers the deck, or a
  // manager of the project. The deck administrator's unlink works on an
  // archived project too (taking one's own deck back is not a change OF the
  // project); a manager who does not administer the deck acts through the
  // project grant, which an archive switches off.
  api.openapi(presentationProjectUnlinkRoute, async (c) => {
    const principal = c.get('principal')!;
    if (principal.origin === 'guest') return guestForbidden(c);
    const { id, projectId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) return c.json(notFound(), 404);
    // The deck administrator severs the link by its EXISTENCE, without
    // reading the project: an owner removed from the project (or swept from
    // it) must still be able to take their deck back out, or the project's
    // members would keep reading and writing a deck its owner can no longer
    // see the link of. Everyone else acts through the project grant.
    if (!canAdministerDeck(principal, deck)) {
      const role = await service.projectRoleOf(principal, projectId);
      if (role === null) return c.json(projectNotFound(), 404);
      if (role !== 'manager') {
        return c.json(
          err('forbidden', 'Only the deck owner, a workspace admin or a project manager does this'),
          403
        );
      }
      if ((await service.projectArchivedAt(principal.workspaceId, projectId)) !== null) {
        return c.json(projectArchived(), 409);
      }
    }
    if (!(await service.unlinkProject(principal.workspaceId, deck.id, projectId))) {
      return c.json(err('not_linked', 'This deck is not in that project'), 404);
    }
    c.set('audit', {
      action: 'presentation.project_unlink',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { projectId }
    });
    return c.json(await wire(principal, deck), 200);
  });

  // The project's BRAND: the project's companion, a brand reference linked to
  // it. A guest is refused flat, like the chassis' own project routes.
  api.use('/projects/:id/brand', requireAuth());
  api.use('/projects/:id/brand', requireNonGuest());

  api.openapi(projectBrandGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    if ((await service.projectRoleOf(principal, id)) === null) return c.json(projectNotFound(), 404);
    // A project member reads the brand through the link itself (canReadDeck's
    // project branch); the check stays, so the answer never outruns the rule.
    const brand = await service.projectBrand(principal.workspaceId, id);
    if (!brand || !(await service.canRead(principal, brand))) return c.json({ brand: null }, 200);
    return c.json({ brand: await wire(principal, brand) }, 200);
  });

  api.openapi(projectBrandSetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { presentationId } = c.req.valid('json');
    const role = await service.projectRoleOf(principal, id);
    if (role === null) return c.json(projectNotFound(), 404);
    if (role !== 'manager') {
      return c.json(err('insufficient_project_role', 'This needs the manager role on the project'), 403);
    }
    const deck = await service.get(principal.workspaceId, presentationId);
    if (!deck || !(await service.canRead(principal, deck))) return c.json(notFound(), 404);
    const outcome = await service.setProjectBrand(principal.workspaceId, id, deck.id);
    switch (outcome) {
      case 'not_found':
        return c.json(notFound(), 404);
      case 'archived':
        return c.json(projectArchived(), 409);
      case 'not_a_brand':
        return c.json(err('not_a_brand', 'Only a brand reference can be a project’s brand'), 400);
      case 'not_linked':
        return c.json(err('not_linked', 'Link the deck to the project first'), 409);
    }
    c.set('audit', {
      action: 'project.brand_set',
      resourceType: 'project',
      resourceId: id,
      metadata: { presentationId: deck.id }
    });
    return c.json({ brand: await wire(principal, deck) }, 200);
  });

  api.openapi(projectBrandClearRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const role = await service.projectRoleOf(principal, id);
    if (role === null) return c.json(projectNotFound(), 404);
    if (role !== 'manager') {
      return c.json(err('insufficient_project_role', 'This needs the manager role on the project'), 403);
    }
    if ((await service.clearProjectBrand(principal.workspaceId, id)) === 'archived') {
      return c.json(projectArchived(), 409);
    }
    c.set('audit', { action: 'project.brand_clear', resourceType: 'project', resourceId: id });
    return c.json({ brand: null }, 200);
  });

  api.openapi(presentationDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    // AUTH-5 (PRDCT-1393): a deck the caller cannot read answers the same
    // 404 a missing one does — a delete probe is free and must not confirm
    // a foreign deck id exists (ADR 013's 404 posture).
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    // Owner-level only — a dev collaborator can push to a deck but never
    // destroy it (canAdministerDeck, not the collaborator-aware canWrite).
    // The 403 leaks nothing: the caller passed canRead, so the deck's
    // existence is already legitimately theirs to see.
    if (!canAdministerDeck(principal, deck)) {
      return c.json(err('forbidden', 'Only the deck owner or a workspace admin can delete it'), 403);
    }
    const deleted = await service.softDelete(deck);
    c.set('audit', {
      action: 'presentation.delete',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { title: deck.title }
    });
    return c.json(await wire(principal, deleted), 200);
  });

  // ── Duplicate (PRDCT-2279) ─────────────────────────────────────────────────
  // The master page's "Duplicate": a new deck in the caller's workspace from
  // one version of the source, no re-upload. The source is a READ (canRead:
  // 404, never 403 — a dev collaborator may copy the deck they were invited
  // to, into a deck of their own); creating is the workspace-level act the
  // guest wall above refuses. The service resolves the manifest under the
  // blob scope guard, so the copy binds only bytes the caller may read.
  api.openapi(presentationDuplicateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const source = await service.get(principal.workspaceId, id);
    if (!source || !(await service.canRead(principal, source))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const result = await service.duplicate({
      workspaceId: principal.workspaceId,
      principal,
      sourceId: id,
      version: body.version,
      title: body.title
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'no_versions':
          return c.json(err('no_versions', 'This presentation has no version to duplicate yet'), 400);
        case 'invalid_version':
          return c.json(
            err('invalid_version', `Version ${f.version} does not exist on this presentation`),
            400
          );
        case 'missing_blobs':
          // Unreachable for a readable source in practice (its live version's
          // blobs are readable by definition); kept for the transaction's
          // honesty — a blob deleted under a racing DELETE /files reports here.
          return c.json(
            {
              error: {
                code: 'missing_blobs',
                message: `The source version references ${f.missing.length} blob(s) this workspace no longer holds`,
                details: { missing: f.missing }
              }
            },
            400
          );
      }
    }
    c.set('audit', {
      action: 'presentation.duplicate',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: {
        sourceId: source.id,
        // The version the transaction actually copied (re-read FOR SHARE), not
        // the handler's earlier read: a push racing the copy must not mislabel it.
        sourceVersion: result.sourceVersion,
        title: result.presentation.title,
        fileCount: result.version.fileCount
      }
    });
    registry.events.emit('presentation.created', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id
    });
    return c.json(
      { presentation: await wire(principal, result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  // ── Pull ───────────────────────────────────────────────────────────────────

  api.openapi(versionsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const { versions, nextCursor } = await service.listVersions(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json(
      {
        versions: versions.map((v) => ({
          ...versionToWire(v),
          viewCount: v.viewCount,
          downloadCount: v.downloadCount
        })),
        nextCursor
      },
      200
    );
  });

  api.openapi(versionGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const row = await service.getVersion(principal.workspaceId, id, version);
    if (!row) return c.json(err('not_found', 'Version not found'), 404);
    const manifest = row.manifest as ManifestEntry[];
    // The attachments are DERIVED here (PRDCT-2278): the `downloads/`
    // convention has one implementation, and no client re-derives it.
    return c.json({ ...versionToWire(row), manifest, attachments: attachmentsOf(manifest) }, 200);
  });

  // ── Attachments, owner side (PRDCT-2278) ───────────────────────────────────
  // The master page's version history: one version's `downloads/` folder as
  // a streamed zip, or one file of it by name. canReadDeck like every deck
  // read (404, never 403 — ADR 013; guests keep their per-deck read as on
  // the asset route), `attachment` + `nosniff` always (user content never
  // renders on the app origin). The two literal siblings (`downloads.zip`,
  // `downloads/{name}`) register before nothing else contends for them.

  /** Deck + version + attachments, or the 404 to answer (one shape for both routes). */
  const versionForAttachments = async (
    c: HonoContext,
    id: string,
    version: number
  ): Promise<
    | { deck: PresentationRow; row: PresentationVersionRow; manifest: ManifestEntry[] }
    | { status: 404; body: ReturnType<typeof err> }
  > => {
    const principal = c.get('principal')!;
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return { status: 404, body: err('not_found', 'Presentation not found') };
    }
    const row = await service.getVersion(principal.workspaceId, id, version);
    if (!row) return { status: 404, body: err('not_found', 'Version not found') };
    return { deck, row, manifest: row.manifest as ManifestEntry[] };
  };

  api.openapi(versionAttachmentsZipRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version } = c.req.valid('param');
    const loaded = await versionForAttachments(c, id, version);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const attachments = attachmentsOf(loaded.manifest);
    if (attachments.length === 0) {
      return c.json(err('no_attachments', 'This version carries no attachments'), 404);
    }
    return serveAttachmentsZip(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      attachments,
      filename: attachmentsZipFilename(loaded.deck.title, loaded.row.version),
      mtime: loaded.row.createdAt,
      headOnly: c.req.method === 'HEAD'
    });
  });

  api.openapi(versionAttachmentDownloadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version, name } = c.req.valid('param');
    const loaded = await versionForAttachments(c, id, version);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    // The decoded name (a nested name arrived percent-encoded) must be a
    // traversal-safe relative path; the lookup is then an EXACT manifest
    // match on `downloads/<name>` — there is no filesystem underneath.
    if (!isTraversalSafeAssetPath(name)) {
      return c.json(err('not_found', 'Attachment not found'), 404);
    }
    const entry = loaded.manifest.find((e) => e.path === attachmentPathOf(name));
    if (!entry) return c.json(err('not_found', 'Attachment not found'), 404);
    const fileRow = await fileService.getBySha(principal.workspaceId, entry.sha256);
    if (!fileRow) return c.json(err('not_found', 'Asset content not available'), 404);
    const basename = name.split('/').pop() ?? name;
    return serveBlob(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      sha256: entry.sha256,
      sizeBytes: fileRow.sizeBytes,
      contentType: entry.contentType,
      filename: basename,
      headOnly: c.req.method === 'HEAD',
      // FORCED attachment (PRDCT-2278): an attachment is handed out, never
      // shown — even a type the safe-serving policy would render inline
      // (a PDF, an image) downloads here. nosniff rides serveBlob.
      contentDisposition: encodeContentDisposition('attachment', basename)
    });
  });

  api.openapi(assetDownloadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, sha256 } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    // Reference check: the blob must appear in one of THIS deck's manifests —
    // a deck id is never a handle to pull arbitrary workspace blobs.
    const entry = await service.findManifestEntry(principal.workspaceId, id, sha256);
    if (!entry) return c.json(err('not_found', 'Asset not referenced by this presentation'), 404);
    const fileRow = await fileService.getBySha(principal.workspaceId, sha256);
    if (!fileRow) return c.json(err('not_found', 'Asset content not available'), 404);

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      sha256,
      sizeBytes: fileRow.sizeBytes,
      // The deck's declared type wins over the files row (safe-serving keeps
      // active content as attachment + nosniff either way).
      contentType: entry.contentType,
      filename: entry.path.split('/').pop() ?? entry.path,
      headOnly: false
    });
  });

  api.openapi(agentDocGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { version } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    // currentVersion 0 = no versions committed yet — nothing to resolve.
    const target = version ?? deck.currentVersion;
    const row = target >= 1 ? await service.getVersion(principal.workspaceId, id, target) : null;
    if (!row) {
      return c.json(err('agent_doc_not_found', 'This version has no AGENT.md briefing'), 404);
    }
    const entry = (row.manifest as ManifestEntry[]).find((e) => e.path === AGENT_DOC_PATH);
    if (!entry) {
      return c.json(err('agent_doc_not_found', 'This version has no AGENT.md briefing'), 404);
    }
    const fileRow = await fileService.getBySha(principal.workspaceId, entry.sha256);
    if (!fileRow) return c.json(err('not_found', 'Asset content not available'), 404);

    return serveBlob(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      sha256: entry.sha256,
      sizeBytes: fileRow.sizeBytes,
      // Served as markdown regardless of the manifest's declared type: the
      // convention is a markdown briefing, and the safe-serving policy keeps
      // it attachment + nosniff on the app origin like every user blob.
      contentType: 'text/markdown; charset=utf-8',
      filename: AGENT_DOC_PATH,
      headOnly: false
    });
  });

  // ── Sharing (Phase 4) ──────────────────────────────────────────────────────
  // Managing a deck's share tokens is the deck writers' surface — the owner,
  // a workspace admin (decks are workspace data, ADR 006), or since Phase 5
  // an ACTIVE dev collaborator — READS INCLUDED: listings expose recipient
  // labels and access stats, so plain members do not see them. Machine
  // access rides the existing /presentations scope mapping (reads →
  // presentations:read, mutations → presentations:write; middleware/scopes.ts).

  /**
   * Deck + write-surface authorization, or the error response to return.
   *
   * AUTH-5 (PRDCT-1354, completed by PRDCT-1393): the refusal is a UNIFORM
   * 404, never a 403. A 403 here said "this deck exists, you just cannot
   * manage it" to any workspace member — an existence oracle over every
   * deck in the tenant, which is exactly what the ADR 013 read invariant
   * ("a failed read check answers 404, never 403 — deck existence is not
   * probeable") forbids on the read side. The WRITE side leaked the same
   * bit and answers the same way — since PRDCT-1393 on EVERY per-deck
   * route, not just this resolver: deck delete, annotation update/delete,
   * response delete, version commit, preview-token mint, and the
   * collaborator invite/remove all 404 a caller who fails the deck read
   * check. A 403 appears only AFTER a passed read check (the owner-level
   * refusals to an active dev collaborator), where it confirms nothing the
   * caller does not already legitimately see.
   */
  const deckForSharing = async (
    c: HonoContext,
    id: string
  ): Promise<{ deck: PresentationRow } | { status: 404; body: ReturnType<typeof err> }> => {
    const principal = c.get('principal')!;
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return { status: 404, body: err('not_found', 'Presentation not found') };
    }
    return { deck };
  };

  api.openapi(shareTokensListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const { tokens, nextCursor } = await sharing.list(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    // shareTokenToWire never exposes the secret or any hash — hasPassword only.
    return c.json({ shareTokens: tokens.map(shareTokenToWire), nextCursor }, 200);
  });

  // Per-view analytics of one token (PRDCT-1313). Deck-writers' surface like
  // the token list, but with the ANNOTATIONS-LIST posture: the contract
  // declares no 403, so an ordinary member gets the same 404 an outsider
  // would — neither the deck's nor the token's existence is advertised.
  api.openapi(shareTokenViewsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, tokenId } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const token = await sharing.get(principal.workspaceId, id, tokenId);
    if (!token) return c.json(err('not_found', 'Share token not found'), 404);
    const { views: rows, nextCursor } = await views.list(principal.workspaceId, id, tokenId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ views: rows.map(shareTokenViewToWire), nextCursor }, 200);
  });

  api.openapi(shareTokenCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);

    let pinnedVersion: number | null = null;
    if (body.versionMode === 'pinned') {
      // The contract refine guarantees pinnedVersion is present here.
      const v = body.pinnedVersion!;
      const versionRow = await service.getVersion(principal.workspaceId, id, v);
      if (!versionRow) {
        return c.json(err('invalid_version', `Version ${v} does not exist on this presentation`), 400);
      }
      pinnedVersion = v;
    }

    const { row, secret } = await sharing.create({
      workspaceId: principal.workspaceId,
      presentationId: id,
      createdBy: principal.userId,
      name: body.name,
      // SECURITY: the PUBLIC create path mints NORMAL tokens, always —
      // visible in the sharing panel, counted in view stats — whatever the
      // caller names them (even "Dashboard preview"). The 'preview' marker
      // is reachable only through the owner/admin-gated preview-token route
      // below; were it name- or body-derived, any deck writer (a dev
      // collaborator included) could mint a concealed, stat-silent link.
      purpose: 'share',
      pinnedVersion,
      canAnnotate: body.canAnnotate,
      canSubmitForms: body.canSubmitForms,
      canDownload: body.canDownload,
      showBar: body.showBar,
      // PRDCT-2328: the contract default is ON (a named link IS its
      // recipient's response); the column default stays OFF for every link
      // minted before the switch existed.
      remembersResponses: body.remembersResponses,
      canUploadFiles: body.canUploadFiles,
      canExportPdf: body.canExportPdf,
      badgePosition: body.badgePosition ?? null,
      expiresAt: body.expiresAt !== undefined ? new Date(body.expiresAt) : null,
      passwordHash: body.password !== undefined ? await hashViewerPassword(body.password) : null
    });
    // An explicit badge choice becomes the deck's remembered default, so the
    // next annotator link on this deck inherits it — but only when the link
    // actually annotates: a view-only create carrying the field must not
    // silently move every future annotator link's badge.
    if (body.badgePosition !== undefined && row.canAnnotate) {
      await service.rememberBadgePosition(principal.workspaceId, id, body.badgePosition);
    }

    c.set('audit', {
      action: 'presentation.share_token_create',
      resourceType: 'share_token',
      resourceId: row.id,
      metadata: {
        presentationId: id,
        name: row.name,
        versionMode: row.pinnedVersion === null ? 'latest' : 'pinned',
        pinnedVersion: row.pinnedVersion,
        canAnnotate: row.canAnnotate,
        canDownload: row.canDownload,
        showBar: row.showBar,
        remembersResponses: row.remembersResponses,
        canUploadFiles: row.canUploadFiles,
        canExportPdf: row.canExportPdf,
        badgePosition: row.badgePosition,
        hasPassword: row.passwordHash !== null,
        expiresAt: row.expiresAt?.toISOString() ?? null
      }
    });
    // The secret + URL appear ONLY in this response (hash-only storage).
    return c.json({ shareToken: shareTokenToWire(row), secret, url: buildViewerUrl(env, secret) }, 201);
  });

  // The dashboard's own transient preview token (ADR 012 Surface D). The
  // sandboxed iframe cannot ride the session cookie (opaque origin), so the
  // deck detail page needs a capability URL — but a token that is hidden
  // from the sharing panel and excluded from view stats is a concealment
  // primitive, so minting one is OWNER-LEVEL only (never a dev collaborator)
  // and every property is fixed server-side: purpose 'preview', a 1 h
  // expiry, no annotations, no password. Preview tokens are immutable
  // (update/send reject them below); the 1 h expiry is the hard cleanup.
  api.openapi(previewTokenCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deck = await service.get(principal.workspaceId, id);
    // AUTH-5 (PRDCT-1393): the failed deck check answers 404 — the mint
    // probe must not confirm the deck exists to a caller who cannot read
    // it. The 403 below is reserved for proven readers (dev collaborators).
    if (!deck || !(await service.canRead(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    if (!canAdministerDeck(principal, deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin can mint preview tokens'),
        403
      );
    }

    let pinnedVersion: number | null = null;
    if (body.version !== undefined) {
      const versionRow = await service.getVersion(principal.workspaceId, id, body.version);
      if (!versionRow) {
        return c.json(
          err('invalid_version', `Version ${body.version} does not exist on this presentation`),
          400
        );
      }
      pinnedVersion = body.version;
    }

    const { row, secret } = await sharing.create({
      workspaceId: principal.workspaceId,
      presentationId: id,
      createdBy: principal.userId,
      name: PREVIEW_SHARE_TOKEN_NAME, // cosmetic label — nothing keys on it
      purpose: 'preview',
      pinnedVersion,
      canAnnotate: false,
      // Owner previews must never create respondent rows — matching the
      // preview exclusion from view stats (and canAnnotate above).
      canSubmitForms: false,
      // …nor remember any (PRDCT-2328); the resolver refuses by purpose too.
      remembersResponses: false,
      // …nor take a file from the owner's own preview (PRDCT-2403).
      canUploadFiles: false,
      // PDF export ON: the owner prints their own deck from the preview as a
      // default link's recipient would (PRDCT-2668); nothing is counted.
      canExportPdf: true,
      // Downloads ON: the preview shows what a default link shows (the
      // recipient bar's download button included). Preview downloads are
      // never counted — the viewer keys the exclusion on `purpose`, like
      // views (PRDCT-2278).
      canDownload: true,
      // The bar too, for the same reason — though the dashboard's preview
      // iframe is a FRAME navigation, so the bar never mounts there anyway.
      showBar: true,
      badgePosition: null, // no overlay on previews — nothing to place
      expiresAt: new Date(Date.now() + PREVIEW_TOKEN_TTL_MS),
      passwordHash: null
    });

    c.set('audit', {
      action: 'presentation.preview_token_create',
      resourceType: 'share_token',
      resourceId: row.id,
      metadata: {
        presentationId: id,
        pinnedVersion: row.pinnedVersion,
        expiresAt: row.expiresAt?.toISOString() ?? null
      }
    });
    return c.json({ shareToken: shareTokenToWire(row), secret, url: buildViewerUrl(env, secret) }, 201);
  });

  api.openapi(shareTokenUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, tokenId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const token = await sharing.get(principal.workspaceId, id, tokenId);
    if (!token) return c.json(err('not_found', 'Share token not found'), 404);
    // Preview tokens are IMMUTABLE: mint a new one instead. Allowing any
    // patch (expiry above all) would let a hidden, stat-excluded token be
    // stretched beyond its 1 h life — the concealment channel again.
    if (token.purpose === 'preview') {
      return c.json(
        err('preview_token_immutable', 'Preview tokens cannot be modified — mint a new one'),
        400
      );
    }

    const set: Partial<typeof token> = {};
    // A bare pinnedVersion implies 'pinned' (least surprise); 'latest' clears.
    const mode = patch.versionMode ?? (patch.pinnedVersion !== undefined ? 'pinned' : undefined);
    if (mode === 'latest') {
      set.pinnedVersion = null;
    } else if (mode === 'pinned') {
      const v = patch.pinnedVersion;
      if (v === undefined) {
        return c.json(err('validation_error', 'pinnedVersion is required when versionMode is "pinned"'), 400);
      }
      const versionRow = await service.getVersion(principal.workspaceId, id, v);
      if (!versionRow) {
        return c.json(err('invalid_version', `Version ${v} does not exist on this presentation`), 400);
      }
      set.pinnedVersion = v;
    }
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.canAnnotate !== undefined) set.canAnnotate = patch.canAnnotate;
    if (patch.canSubmitForms !== undefined) set.canSubmitForms = patch.canSubmitForms;
    if (patch.canDownload !== undefined) set.canDownload = patch.canDownload;
    if (patch.showBar !== undefined) set.showBar = patch.showBar;
    if (patch.remembersResponses !== undefined) set.remembersResponses = patch.remembersResponses;
    if (patch.canUploadFiles !== undefined) set.canUploadFiles = patch.canUploadFiles;
    if (patch.canExportPdf !== undefined) set.canExportPdf = patch.canExportPdf;
    if (patch.badgePosition !== undefined) {
      set.badgePosition = patch.badgePosition;
      // Explicit slot → new deck default (explicit null just falls back),
      // gated on the link's EFFECTIVE annotate capability after this patch.
      const annotates = patch.canAnnotate ?? token.canAnnotate;
      if (patch.badgePosition !== null && annotates) {
        await service.rememberBadgePosition(principal.workspaceId, id, patch.badgePosition);
      }
    }
    if (patch.expiresAt !== undefined) {
      set.expiresAt = patch.expiresAt === null ? null : new Date(patch.expiresAt);
    }
    if (patch.password !== undefined) {
      // Setting a new password also invalidates outstanding unlock cookies
      // (their MAC covers a fingerprint of the current hash).
      set.passwordHash = patch.password === null ? null : await hashViewerPassword(patch.password);
    }

    const updated = Object.keys(set).length > 0 ? await sharing.update(token.id, set) : token;
    if (!updated) return c.json(err('not_found', 'Share token not found'), 404);

    c.set('audit', {
      action: 'presentation.share_token_update',
      resourceType: 'share_token',
      resourceId: token.id,
      metadata: {
        presentationId: id,
        changed: Object.keys(set),
        versionMode: updated.pinnedVersion === null ? 'latest' : 'pinned',
        pinnedVersion: updated.pinnedVersion
      }
    });
    return c.json(shareTokenToWire(updated), 200);
  });

  api.openapi(shareTokenRevokeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, tokenId } = c.req.valid('param');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const token = await sharing.get(principal.workspaceId, id, tokenId);
    if (!token) return c.json(err('not_found', 'Share token not found'), 404);
    // Preview tokens belong to the owner/admin preview surface end-to-end;
    // a dev collaborator neither mints nor revokes them.
    if (token.purpose === 'preview' && !canAdministerDeck(principal, loaded.deck)) {
      return c.json(
        err('forbidden', 'Only the deck owner or a workspace admin can revoke preview tokens'),
        403
      );
    }
    const revoked = (await sharing.revoke(token.id)) ?? token;
    c.set('audit', {
      action: 'presentation.share_token_revoke',
      resourceType: 'share_token',
      resourceId: token.id,
      metadata: { presentationId: id, name: token.name }
    });
    return c.json(shareTokenToWire(revoked), 200);
  });

  api.openapi(shareTokenSendRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, tokenId } = c.req.valid('param');
    const body = c.req.valid('json');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const token = await sharing.get(principal.workspaceId, id, tokenId);
    if (!token) return c.json(err('not_found', 'Share token not found'), 404);
    // A send ROTATES the token onto a fresh secret and mails it out — on a
    // hidden, stat-excluded preview token that would hand the caller a
    // working concealed link. Preview tokens are never sendable.
    if (token.purpose === 'preview') {
      return c.json(
        err('preview_token_immutable', 'Preview tokens cannot be sent — create a share token'),
        400
      );
    }
    if (token.revokedAt) {
      return c.json(err('token_revoked', 'This share token is revoked — create a new one'), 400);
    }
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      return c.json(
        err('token_expired', 'This share token has expired — extend it or create a new one'),
        400
      );
    }

    // No delivering driver: nothing sent, nothing rotated — the create-time
    // copyable URL stays the recipient's link (the invitation convention).
    if (!email.delivers) {
      return c.json({ shareToken: shareTokenToWire(token), emailSent: false }, 200);
    }

    // Hash-only storage: the original secret is unrecoverable, so a send
    // ROTATES the token onto a fresh secret and mails that (contract-
    // documented). Mint → mail → persist, in that order: a failed delivery
    // leaves the stored hash (and the old link) untouched.
    const minted = sharing.mintSecret();
    const viewerUrl = buildViewerUrl(env, minted.secret);
    const msg = buildShareEmail({
      senderName: principal.name,
      presentationTitle: loaded.deck.title,
      viewerUrl,
      message: body.message,
      expiresAt: token.expiresAt ?? undefined,
      hasPassword: token.passwordHash !== null
    });
    try {
      await email.send({ to: body.email, ...msg });
    } catch (e) {
      logger.error({ err: e }, 'share email failed (token unchanged, old link still valid)');
      return c.json({ shareToken: shareTokenToWire(token), emailSent: false }, 200);
    }
    const updated = (await sharing.update(token.id, { tokenHash: minted.tokenHash })) ?? token;

    c.set('audit', {
      action: 'presentation.share_token_send',
      resourceType: 'share_token',
      resourceId: token.id,
      metadata: { presentationId: id, recipient: body.email, rotated: true }
    });
    return c.json({ shareToken: shareTokenToWire(updated), emailSent: true }, 200);
  });

  // ── Annotations (Phase 5, owner/dev management surface) ───────────────────
  // Reading a deck's annotation stream is gated like share tokens: the deck
  // owner, a workspace admin, or an active dev collaborator (reviewer notes
  // are feedback addressed to the deck's writers, not workspace-public).
  // None of the four contracts declares a 403 (update/delete aligned by
  // PRDCT-1393), so an ordinary member gets the same 404 an outsider would —
  // neither the stream's nor the deck's existence is advertised.
  // The anonymous reviewer surface lives in viewer/annotations-api.ts.

  api.openapi(annotationsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit, version, status } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const { annotations: rows, nextCursor } = await annotations.list(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
      version,
      status
    });
    return c.json({ annotations: rows.map(annotationToWire), nextCursor }, 200);
  });

  api.openapi(annotationCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    if (body.version > deck.currentVersion) {
      return c.json(
        err('invalid_version', `Version ${body.version} does not exist on this presentation`),
        400
      );
    }
    const row = await annotations.create({
      workspaceId: principal.workspaceId,
      presentationId: id,
      version: body.version,
      shareTokenId: null,
      authorUserId: principal.userId,
      authorName: principal.name,
      selection: body.selection,
      body: body.body
    });
    c.set('audit', {
      action: 'presentation.annotation_create',
      resourceType: 'annotation',
      resourceId: row.id,
      metadata: { presentationId: id, version: row.version }
    });
    return c.json(annotationToWire(row), 201);
  });

  api.openapi(annotationUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, annotationId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const existing = await annotations.get(principal.workspaceId, id, annotationId);
    if (!existing) return c.json(err('not_found', 'Annotation not found'), 404);
    const updated = (await annotations.update(existing.id, patch)) ?? existing;
    c.set('audit', {
      action: 'presentation.annotation_update',
      resourceType: 'annotation',
      resourceId: existing.id,
      metadata: { presentationId: id, changed: Object.keys(patch) }
    });
    return c.json(annotationToWire(updated), 200);
  });

  api.openapi(annotationDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, annotationId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const existing = await annotations.get(principal.workspaceId, id, annotationId);
    if (!existing) return c.json(err('not_found', 'Annotation not found'), 404);
    const deleted = (await annotations.delete(existing.id)) ?? existing;
    c.set('audit', {
      action: 'presentation.annotation_delete',
      resourceType: 'annotation',
      resourceId: existing.id,
      metadata: { presentationId: id, version: existing.version }
    });
    return c.json(annotationToWire(deleted), 200);
  });

  // ── Form responses (ADR 022, owner/dev management surface) ───────────────
  // Gated exactly like annotations: responses are addressed to the deck's
  // WRITERS (owner, workspace admin, active dev collaborator). None of the
  // contracts declares a 403 (delete aligned by PRDCT-1393), so an ordinary
  // member gets the same 404 an outsider would — the response stream's
  // existence is not advertised. The anonymous submit surface lives in
  // viewer/forms-api.ts.
  // NOTE: the literal `/responses/summary` handler registers BEFORE the
  // `{responseId}` param handler (the literal-segment trap, LESSONS.md).

  api.openapi(formResponsesSummaryRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const { buckets, total } = await forms.summary(principal.workspaceId, id);
    return c.json(
      {
        buckets: buckets.map((b) => ({ ...b, lastResponseAt: b.lastResponseAt.toISOString() })),
        total
      },
      200
    );
  });

  api.openapi(formResponsesListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit, form, token, source, placement, since } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const { responses, nextCursor } = await forms.list(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
      form,
      token,
      source,
      placement,
      since: since !== undefined ? new Date(since) : undefined
    });
    return c.json({ responses: responses.map(formResponseToWire), nextCursor }, 200);
  });

  // ── The files of form responses (PRDCT-2403) ─────────────────────────────
  // What respondents uploaded into the form's file fields: one capability,
  // read the same way by the dashboard, the CLI and the MCP tool. Same gate
  // and 404 posture as the responses themselves. Always `attachment` +
  // `nosniff`, whatever type the respondent declared: an anonymous
  // stranger's bytes never render on the app origin, not even a PDF or an
  // image the generic policy would show inline. The literal `files.zip`
  // registers BEFORE the `{responseId}` param route.
  api.openapi(formResponsesFilesZipRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { form, token, source, placement, since } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const rows = await formUploads.listForDeck(principal.workspaceId, id, {
      form,
      token,
      source,
      placement,
      since: since !== undefined ? new Date(since) : undefined
    });
    if (rows.length === 0) return c.json(err('no_files', 'No uploaded files match.'), 404);
    const taken = new Set<string>();
    const entries = rows.map(({ file, responseCreatedAt }) => ({
      key: file.storageKey,
      name: uniqueZipPath(
        `${zipSegment(file.formName)}/${responseZipFolder(file.responseId!, responseCreatedAt)}/${zipSegment(file.fieldName)}/`,
        zipSegment(file.filename),
        taken
      ),
      mtime: file.createdAt
    }));
    c.set('audit', {
      action: 'presentation.form_response_files_download',
      resourceType: 'presentation',
      resourceId: id,
      metadata: { files: rows.length, ...(form !== undefined ? { formName: form } : {}) }
    });
    return serveZip(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      entries,
      filename: attachmentsZipFilename(deck.title, 0).replace(/-v0\.zip$/, '-form-files.zip'),
      headOnly: false,
      what: 'form files'
    });
  });

  // The owner's per-response read with its history (PRDCT-2329). Same
  // gate, same 404 posture; registered after the literal summary route.
  api.openapi(formResponseGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, responseId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const existing = await forms.get(principal.workspaceId, id, responseId);
    if (!existing) return c.json(err('not_found', 'Response not found'), 404);
    const versions = await forms.versions(existing.response.id);
    return c.json(
      { response: formResponseToWire(existing), versions: versions.map(formResponseVersionToWire) },
      200
    );
  });

  api.openapi(formResponseDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, responseId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const existing = await forms.get(principal.workspaceId, id, responseId);
    if (!existing) return c.json(err('not_found', 'Response not found'), 404);
    await forms.delete(existing.response.id);
    c.set('audit', {
      action: 'presentation.form_response_delete',
      resourceType: 'form_response',
      resourceId: existing.response.id,
      metadata: {
        presentationId: id,
        formName: existing.response.formName,
        files: existing.files?.length ?? 0
      }
    });
    return c.json(formResponseToWire(existing), 200);
  });

  // One response's files as one zip (`<field>/<file>`). Registered before the
  // single-file route: `files.zip` is its own segment, never a `{fileId}`.
  api.openapi(formResponseFilesZipRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, responseId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const existing = await forms.get(principal.workspaceId, id, responseId);
    if (!existing) return c.json(err('not_found', 'Response not found'), 404);
    const files = existing.files ?? [];
    if (files.length === 0) return c.json(err('no_files', 'This response holds no files.'), 404);
    const taken = new Set<string>();
    const entries = files.map((file) => ({
      key: file.storageKey,
      name: uniqueZipPath(`${zipSegment(file.fieldName)}/`, zipSegment(file.filename), taken),
      mtime: file.createdAt
    }));
    c.set('audit', {
      action: 'presentation.form_response_files_download',
      resourceType: 'form_response',
      resourceId: existing.response.id,
      metadata: { presentationId: id, files: files.length }
    });
    return serveZip(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      entries,
      filename: `${zipSegment(existing.response.formName)}-${responseZipFolder(existing.response.id, existing.response.createdAt)}.zip`,
      headOnly: false,
      what: 'form files'
    });
  });

  api.openapi(formResponseFileDownloadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, responseId, fileId } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck || !(await service.canWrite(principal, deck))) {
      return c.json(err('not_found', 'Presentation not found'), 404);
    }
    const file = await formUploads.getAttached(principal.workspaceId, id, responseId, fileId);
    if (!file) return c.json(err('not_found', 'File not found'), 404);
    return serveBlob(c, {
      storage,
      logger,
      workspaceId: principal.workspaceId,
      sha256: file.sha256,
      storageKey: file.storageKey,
      sizeBytes: file.sizeBytes,
      contentType: file.contentType,
      filename: file.filename,
      headOnly: false,
      // ALWAYS attachment (see the block comment above), never the generic
      // inline-for-passive-media policy.
      contentDisposition: encodeContentDisposition('attachment', file.filename)
    });
  });

  // Workspace-wide inbox: admins/owners see every live deck's annotations;
  // members see the decks they own plus their active collaborations.
  api.openapi(annotationsInboxRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit, version, status } = c.req.valid('query');
    const { annotations: rows, nextCursor } = await annotations.inbox(principal, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit,
      version,
      status
    });
    return c.json({ annotations: rows.map(annotationToWire), nextCursor }, 200);
  });
}

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Context as HonoContext } from 'hono';
import type { OpenAPIHono } from '@hono/zod-openapi';
import { ulid } from 'ulid';
import {
  annotationCreateRoute,
  annotationDeleteRoute,
  annotationsInboxRoute,
  annotationsListRoute,
  annotationUpdateRoute,
  assetDownloadRoute,
  assetPrecheckRoute,
  assetUploadRoute,
  collaboratorInviteRoute,
  collaboratorRemoveRoute,
  collaboratorsListRoute,
  presentationDeleteRoute,
  presentationGetRoute,
  presentationsListRoute,
  shareTokenCreateRoute,
  shareTokenRevokeRoute,
  shareTokenSendRoute,
  shareTokensListRoute,
  shareTokenUpdateRoute,
  uploadSessionCommitRoute,
  uploadSessionCreateRoute,
  versionCommitRoute,
  versionGetRoute,
  versionsListRoute
} from '@slideless/contract/routes';
import type { ManifestEntry } from '@slideless/contract';
import type { PresentationRow, PresentationVersionRow, UploadSessionRow } from '@slideless/db';
import type { Env } from '../env.js';
import type { Logger } from '../logger.js';
import type { PlatformRegistry } from '../platform/registry.js';
import type { EmailDriver } from '../email/driver.js';
import { buildShareEmail } from '../email/templates.js';
import type { FileService } from '../files/service.js';
import { FileTooLargeError } from '../files/service.js';
import { serveBlob } from '../files/serve.js';
import type { StorageDriver } from '../storage/driver.js';
import { canWriteDeck, type PresentationService } from '../presentations/service.js';
import { buildViewerUrl, shareTokenToWire, type ShareTokenService } from '../sharing/service.js';
import { hashViewerPassword } from '../sharing/password.js';
import { requireAuth } from '../middleware/auth-context.js';

/**
 * Presentation domain routes (ADR 011). Phase 3 implemented the upload +
 * versioning pipeline (push protocol, pull, delete); Phase 4 (sharing + the
 * public viewer, whose token-session routes live OUTSIDE this
 * principal-gated surface) and Phase 5 (collaborators/annotations) still
 * answer the 501 declared on their contract entries — implementers replace a
 * stub AND delete the 501 entry from the route contract in the same change.
 */

const err = (code: string, message: string) => ({ error: { code, message } });

const presentationToWire = (p: PresentationRow) => ({
  id: p.id,
  title: p.title,
  kind: p.kind,
  interactive: p.interactive,
  currentVersion: p.currentVersion,
  entryPath: p.entryPath,
  ownerUserId: p.ownerUserId,
  remixedFrom: p.remixedFrom,
  createdAt: p.createdAt.toISOString(),
  updatedAt: p.updatedAt.toISOString()
});

const versionToWire = (v: Omit<PresentationVersionRow, 'manifest'>) => ({
  presentationId: v.presentationId,
  version: v.version,
  entryPath: v.entryPath,
  sizeBytes: v.sizeBytes,
  fileCount: v.fileCount,
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
  fileService: FileService;
  storage: StorageDriver;
  registry: PlatformRegistry;
  env: Pick<Env, 'MAX_FILE_SIZE_MB' | 'EDITION' | 'APP_VERSION' | 'PUBLIC_BASE_URL' | 'VIEWER_BASE_URL'>;
  email: EmailDriver;
  logger: Logger;
  instanceId: () => Promise<string>;
}

export function registerPresentationRoutes(api: OpenAPIHono, deps: PresentationRouteDeps): void {
  const { service, sharing, fileService, storage, registry, env, email, logger } = deps;
  const maxBytes = env.MAX_FILE_SIZE_MB * 1024 * 1024;

  api.use('/presentations', requireAuth());
  api.use('/presentations/*', requireAuth());
  api.use('/annotations', requireAuth());

  const notImplemented = (phase: string) =>
    err('not_implemented', `Not implemented yet — this endpoint arrives with ${phase}`);

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
    const missing = await service.precheckMissing(principal.workspaceId, sha256);
    return c.json({ missing }, 200);
  });

  api.openapi(assetUploadRoute, async (c) => {
    const principal = c.get('principal')!;

    // Entitlement gate on the declared size first; the true size is enforced
    // after parse (and the multipart body limit bounds the parse itself).
    const declared = Number(c.req.header('content-length') ?? '0');
    const decision = await registry.entitlements.check(principal, {
      key: 'files.upload',
      quantity: declared,
      unit: 'bytes'
    });
    if (!decision.allowed) {
      return c.json(err('entitlement_denied', decision.reason), 413);
    }

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

      c.set('audit', {
        action: 'presentation.asset_upload',
        resourceType: 'file',
        resourceId: row.id,
        metadata: { sha256: row.sha256, sizeBytes: row.sizeBytes, deduplicated }
      });
      void registry.usage.emit({
        id: ulid(),
        meter: 'files.upload',
        quantity: row.sizeBytes,
        unit: 'bytes',
        occurredAt: new Date().toISOString(),
        workspaceId: principal.workspaceId,
        ...(principal.accountRef ? { accountRef: principal.accountRef } : {}),
        source: { instanceId: await deps.instanceId(), edition: env.EDITION, version: env.APP_VERSION }
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
      entryPath: body.entryPath,
      manifest: body.manifest as ManifestEntry[]
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
      metadata: { title: result.presentation.title, fileCount: result.version.fileCount }
    });
    registry.events.emit('presentation.created', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id
    });
    return c.json(
      { presentation: presentationToWire(result.presentation), version: versionToWire(result.version) },
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
      title: body.title
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'not_found':
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'forbidden':
          return c.json(err('forbidden', 'Only the deck owner or a workspace admin can commit'), 403);
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
      metadata: { version: result.version.version, fileCount: result.version.fileCount }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id,
      version: result.version.version
    });
    return c.json(
      { presentation: presentationToWire(result.presentation), version: versionToWire(result.version) },
      201
    );
  });

  // ── Presentations ──────────────────────────────────────────────────────────

  api.openapi(presentationsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { cursor, limit } = c.req.valid('query');
    const { presentations, nextCursor } = await service.list(principal.workspaceId, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ presentations: presentations.map(presentationToWire), nextCursor }, 200);
  });

  api.openapi(presentationGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    return c.json(presentationToWire(deck), 200);
  });

  api.openapi(presentationDeleteRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (!canWriteDeck(principal, deck)) {
      return c.json(err('forbidden', 'Only the deck owner or a workspace admin can delete it'), 403);
    }
    const deleted = await service.softDelete(deck);
    c.set('audit', {
      action: 'presentation.delete',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { title: deck.title }
    });
    return c.json(presentationToWire(deleted), 200);
  });

  // ── Pull ───────────────────────────────────────────────────────────────────

  api.openapi(versionsListRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    const { versions, nextCursor } = await service.listVersions(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json({ versions: versions.map(versionToWire), nextCursor }, 200);
  });

  api.openapi(versionGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    const row = await service.getVersion(principal.workspaceId, id, version);
    if (!row) return c.json(err('not_found', 'Version not found'), 404);
    return c.json({ ...versionToWire(row), manifest: row.manifest as ManifestEntry[] }, 200);
  });

  api.openapi(assetDownloadRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, sha256 } = c.req.valid('param');
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
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

  // ── Sharing (Phase 4) ──────────────────────────────────────────────────────
  // Managing a deck's share tokens is the deck OWNER's surface (or a
  // workspace admin — decks are workspace data, ADR 006), READS INCLUDED:
  // listings expose recipient labels and access stats, so plain members do
  // not see them. Dev collaborators join `canWriteDeck` in Phase 5 — that
  // helper is the authorization seam. Machine access rides the existing
  // /presentations scope mapping (reads → presentations:read, mutations →
  // presentations:write; middleware/scopes.ts).

  /** Deck + sharing-surface authorization, or the error response to return. */
  const deckForSharing = async (
    c: HonoContext,
    id: string
  ): Promise<{ deck: PresentationRow } | { status: 403 | 404; body: ReturnType<typeof err> }> => {
    const principal = c.get('principal')!;
    const deck = await service.get(principal.workspaceId, id);
    if (!deck) return { status: 404, body: err('not_found', 'Presentation not found') };
    if (!canWriteDeck(principal, deck)) {
      return {
        status: 403,
        body: err('forbidden', 'Only the deck owner or a workspace admin can manage its share tokens')
      };
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
      pinnedVersion,
      canAnnotate: body.canAnnotate,
      expiresAt: body.expiresAt !== undefined ? new Date(body.expiresAt) : null,
      passwordHash: body.password !== undefined ? await hashViewerPassword(body.password) : null
    });

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
        hasPassword: row.passwordHash !== null,
        expiresAt: row.expiresAt?.toISOString() ?? null
      }
    });
    // The secret + URL appear ONLY in this response (hash-only storage).
    return c.json(
      { shareToken: shareTokenToWire(row), secret, url: buildViewerUrl(env, secret) },
      201
    );
  });

  api.openapi(shareTokenUpdateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, tokenId } = c.req.valid('param');
    const patch = c.req.valid('json');
    const loaded = await deckForSharing(c, id);
    if ('status' in loaded) return c.json(loaded.body, loaded.status);
    const token = await sharing.get(principal.workspaceId, id, tokenId);
    if (!token) return c.json(err('not_found', 'Share token not found'), 404);

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
    if (token.revokedAt) {
      return c.json(err('token_revoked', 'This share token is revoked — create a new one'), 400);
    }
    if (token.expiresAt && token.expiresAt.getTime() <= Date.now()) {
      return c.json(err('token_expired', 'This share token has expired — extend it or create a new one'), 400);
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

  // ── Phase 5 stubs (contract-frozen 501s) ───────────────────────────────────

  api.openapi(collaboratorsListRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));
  api.openapi(collaboratorInviteRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));
  api.openapi(collaboratorRemoveRoute, (c) => c.json(notImplemented('Phase 5 (collaborators)'), 501));

  api.openapi(annotationsListRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationCreateRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationUpdateRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationDeleteRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
  api.openapi(annotationsInboxRoute, (c) => c.json(notImplemented('Phase 5 (annotations)'), 501));
}

import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  collaborators,
  files,
  presentations,
  presentationVersions,
  shareTokenDownloads,
  shareTokenViews,
  uploadSessions,
  type BadgePosition,
  type Db,
  type DbConn,
  type PresentationRow,
  type PresentationVersionRow,
  type UploadSessionRow,
  type VersionAuthorRole
} from '@slideless/db';
import { AGENT_DOC_PATH, isAttachmentPath, type ManifestEntry, type Principal } from '@slideless/contract';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/** A version list row: the summary columns plus its per-version counts (PRDCT-2308). */
export type VersionSummaryRow = Omit<PresentationVersionRow, 'manifest'> & {
  viewCount: number;
  downloadCount: number;
};

/** Upload sessions reserve the future deck id for ~1 h (ADR 011). */
export const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Commit failures as data, not exceptions — the handlers map each variant to
 * its contract status (400/404/409/410) without string matching. The two
 * commit paths get separate unions so each handler's switch stays exhaustive
 * against exactly the statuses its route declares.
 */
export type ManifestFailure =
  { code: 'invalid_manifest'; message: string } | { code: 'missing_blobs'; missing: string[] };

export type SessionCommitFailure =
  ManifestFailure | { code: 'not_found' } | { code: 'session_consumed' } | { code: 'session_expired' };

export type VersionCommitFailure =
  ManifestFailure | { code: 'not_found' } | { code: 'version_conflict'; currentVersion: number };

export interface CommitSuccess {
  ok: true;
  presentation: PresentationRow;
  version: PresentationVersionRow;
}
export type SessionCommitResult = CommitSuccess | { ok: false; failure: SessionCommitFailure };
export type VersionCommitResult = CommitSuccess | { ok: false; failure: VersionCommitFailure };

/** Duplicate failures (PRDCT-2279): the handler maps each to 404 / 400. */
export type DuplicateFailure =
  | { code: 'not_found' }
  | { code: 'no_versions' }
  | { code: 'invalid_version'; version: number }
  | { code: 'missing_blobs'; missing: string[] };
/** The success carries the source version the copy was actually made from (read in-transaction). */
export type DuplicateResult =
  (CommitSuccess & { sourceVersion: number }) | { ok: false; failure: DuplicateFailure };

/**
 * The presentation domain (ADR 011): decks with append-only immutable
 * versions whose manifests reference content-addressed blobs in the shared
 * `files` table. All multi-row writes are single transactions; the version
 * counter only ever advances under the optimistic-concurrency check.
 */
export class PresentationService {
  constructor(private readonly db: Db) {}

  // ── Upload sessions ────────────────────────────────────────────────────────

  async createUploadSession(workspaceId: string, userId: string): Promise<UploadSessionRow> {
    const [row] = await this.db
      .insert(uploadSessions)
      .values({
        workspaceId,
        // The reserved future deck id (no FK — the row exists only after commit).
        presentationId: randomUUID(),
        createdBy: userId,
        expiresAt: new Date(Date.now() + UPLOAD_SESSION_TTL_MS)
      })
      .returning();
    return row!;
  }

  // ── Precheck (content-addressed dedupe) ────────────────────────────────────

  /**
   * Which of these hashes the caller still has to upload. A soft-deleted
   * files row counts as missing: its blob was removed with it, and
   * re-uploading revives the row (files/service.ts upload semantics).
   *
   * Scoped to the caller's readable blobs (SL-B1), not the whole workspace,
   * for two reasons. It closes an existence oracle — an unscoped precheck
   * answers "does the workspace hold these exact bytes" for any sha a member
   * cares to guess. And it keeps the push protocol coherent with the commit
   * guard: a sha the caller may not bind must be reported as missing, or the
   * client would skip the upload and then have its commit refused with no
   * way out. Re-uploading bytes that already exist costs one PUT and stores
   * nothing new (content-addressed dedupe), and it registers the uploader.
   */
  async precheckMissing(workspaceId: string, principal: Principal, shas: string[]): Promise<string[]> {
    const unique = [...new Set(shas)];
    const scope = blobReadScope(principal);
    const present = await this.db
      .select({ sha256: files.sha256 })
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          inArray(files.sha256, unique),
          isNull(files.deletedAt),
          ...(scope ? [scope] : [])
        )
      );
    const found = new Set(present.map((r) => r.sha256));
    return unique.filter((sha) => !found.has(sha));
  }

  // ── Commits ────────────────────────────────────────────────────────────────

  /**
   * Structural manifest validation shared by both commit paths. Blob
   * existence is checked separately, inside the commit transaction.
   */
  private validateManifestShape(entryPath: string, manifest: ManifestEntry[]): ManifestFailure | null {
    const seen = new Set<string>();
    for (const entry of manifest) {
      if (seen.has(entry.path)) {
        return { code: 'invalid_manifest', message: `duplicate manifest path "${entry.path}"` };
      }
      seen.add(entry.path);
    }
    if (!seen.has(entryPath)) {
      return { code: 'invalid_manifest', message: `entryPath "${entryPath}" is not a manifest path` };
    }
    return null;
  }

  /**
   * Every referenced blob must exist LIVE in this workspace AND be readable
   * by the committer. The rows are locked FOR SHARE for the rest of the
   * commit transaction so a concurrent DELETE /files/{id} (which locks FOR
   * UPDATE before its in-use check) serializes against the commit instead of
   * racing it: whichever wins, the loser sees the winner's state
   * (missing_blobs 400 here, file_in_use 409 there) — never a manifest
   * referencing a deleted blob.
   *
   * The `blobReadScope` predicate is the SL-B1 commit guard: without it a
   * member who learned a foreign deck's sha could bind those bytes into a
   * deck of their own and re-publish them anonymously through a share link.
   * An unreadable sha resolves as MISSING rather than as its own failure
   * code — the refusal must not confirm that the workspace holds the bytes.
   * The scope is `undefined` for workspace admins/owners (operator view), so
   * their commits behave exactly as before.
   */
  private async lockAndResolveBlobs(
    tx: DbConn,
    workspaceId: string,
    principal: Principal,
    manifest: ManifestEntry[]
  ): Promise<{ missing: string[]; sizeBySha: Map<string, number> }> {
    const unique = [...new Set(manifest.map((e) => e.sha256))];
    const scope = blobReadScope(principal);
    const present = await tx
      .select({ sha256: files.sha256, sizeBytes: files.sizeBytes })
      .from(files)
      .where(
        and(
          eq(files.workspaceId, workspaceId),
          inArray(files.sha256, unique),
          isNull(files.deletedAt),
          ...(scope ? [scope] : [])
        )
      )
      .for('share');
    const sizeBySha = new Map(present.map((r) => [r.sha256, r.sizeBytes]));
    return { missing: unique.filter((sha) => !sizeBySha.has(sha)), sizeBySha };
  }

  /**
   * Stamp each manifest entry with the AUTHORITATIVE blob size from the locked
   * `files` rows — the client's declared `sizeBytes` is never trusted, since size
   * is a pure function of the content-addressed bytes. `contentType` stays the
   * author's per-deck declaration (safe-serving neutralizes it at the viewer).
   * Totals derive from the real sizes; duplicate paths sharing one blob each count
   * (the total is what pulling the whole folder yields). Every sha is guaranteed
   * present — missing blobs are rejected before this runs.
   */
  private stampManifest(
    manifest: ManifestEntry[],
    sizeBySha: Map<string, number>
  ): {
    manifest: ManifestEntry[];
    sizeBytes: number;
    fileCount: number;
    hasAgentDoc: boolean;
    hasDownloads: boolean;
  } {
    const stamped = manifest.map((e) => ({ ...e, sizeBytes: sizeBySha.get(e.sha256)! }));
    return {
      manifest: stamped,
      sizeBytes: stamped.reduce((sum, e) => sum + e.sizeBytes, 0),
      fileCount: stamped.length,
      // The reserved agent briefing: exact root path, case-sensitive like
      // every manifest path. Stamped here so reads never open the manifest.
      hasAgentDoc: stamped.some((e) => e.path === AGENT_DOC_PATH),
      // The reserved attachments folder (PRDCT-2278), the same way: any
      // entry under `downloads/` makes the version carry attachments.
      hasDownloads: stamped.some((e) => isAttachmentPath(e.path))
    };
  }

  /**
   * Commit an upload session: creates the deck (at the session's reserved id)
   * and its version 1, and consumes the session — one transaction, one-shot.
   * A failed commit (e.g. missing blobs) does NOT consume the session; the
   * client can upload the stragglers and retry.
   */
  async commitUploadSession(opts: {
    workspaceId: string;
    principal: Principal;
    sessionId: string;
    title: string;
    kind: PresentationRow['kind'];
    interactive: boolean;
    metadata?: Record<string, unknown> | undefined;
    entryPath: string;
    manifest: ManifestEntry[];
    /**
     * Whether any HTML in this manifest carries `data-slideless-form`
     * (forms/detect.ts, scanned by the caller before the transaction so the
     * blob reads never happen with row locks held). PRDCT-1333.
     */
    hasForms: boolean;
  }): Promise<SessionCommitResult> {
    const shapeFailure = this.validateManifestShape(opts.entryPath, opts.manifest);
    if (shapeFailure) return { ok: false, failure: shapeFailure };

    return this.db.transaction(async (tx): Promise<SessionCommitResult> => {
      // FOR UPDATE serializes concurrent commits of the same session: the
      // loser blocks here, then re-reads the winner's consumed_at → 409.
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(and(eq(uploadSessions.id, opts.sessionId), eq(uploadSessions.workspaceId, opts.workspaceId)))
        .for('update')
        .limit(1);
      // A foreign session id is a 404, not a 403 — session ids are unguessable
      // and revealing "exists but not yours" would leak across principals.
      if (!session || session.createdBy !== opts.principal.userId) {
        return { ok: false, failure: { code: 'not_found' } };
      }
      if (session.consumedAt) return { ok: false, failure: { code: 'session_consumed' } };
      if (session.expiresAt.getTime() < Date.now()) {
        return { ok: false, failure: { code: 'session_expired' } };
      }

      const { missing, sizeBySha } = await this.lockAndResolveBlobs(
        tx,
        opts.workspaceId,
        opts.principal,
        opts.manifest
      );
      if (missing.length > 0) return { ok: false, failure: { code: 'missing_blobs', missing } };
      const stamped = this.stampManifest(opts.manifest, sizeBySha);

      const [presentation] = await tx
        .insert(presentations)
        .values({
          id: session.presentationId,
          workspaceId: opts.workspaceId,
          ownerUserId: opts.principal.userId,
          title: opts.title,
          kind: opts.kind,
          interactive: opts.interactive,
          ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
          currentVersion: 1,
          entryPath: opts.entryPath,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: opts.hasForms,
          hasDownloads: stamped.hasDownloads
        })
        .returning();
      const [version] = await tx
        .insert(presentationVersions)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: presentation!.id,
          version: 1,
          entryPath: opts.entryPath,
          manifest: stamped.manifest,
          sizeBytes: stamped.sizeBytes,
          fileCount: stamped.fileCount,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: opts.hasForms,
          hasDownloads: stamped.hasDownloads,
          createdBy: opts.principal.userId,
          createdByRole: 'owner'
        })
        .returning();
      await tx
        .update(uploadSessions)
        .set({ consumedAt: new Date() })
        .where(eq(uploadSessions.id, session.id));

      return { ok: true, presentation: presentation!, version: version! };
    });
  }

  /**
   * Commit a new immutable version onto an existing deck. Optimistic
   * concurrency: the deck row is locked FOR UPDATE, currentVersion must equal
   * expectedBaseVersion (409 version_conflict otherwise), and the counter
   * bump + entry-path/title mirror + updated_at ride the same transaction as
   * the version insert. The UNIQUE (presentation_id, version) constraint
   * backstops append-only immutability.
   */
  async commitVersion(opts: {
    workspaceId: string;
    principal: Principal;
    presentationId: string;
    expectedBaseVersion: number;
    entryPath: string;
    manifest: ManifestEntry[];
    title?: string | undefined;
    /** See commitUploadSession — PRDCT-1333. */
    hasForms: boolean;
  }): Promise<VersionCommitResult> {
    const shapeFailure = this.validateManifestShape(opts.entryPath, opts.manifest);
    if (shapeFailure) return { ok: false, failure: shapeFailure };

    return this.db.transaction(async (tx): Promise<VersionCommitResult> => {
      const [deck] = await tx
        .select()
        .from(presentations)
        .where(
          and(
            eq(presentations.id, opts.presentationId),
            eq(presentations.workspaceId, opts.workspaceId),
            isNull(presentations.deletedAt)
          )
        )
        .for('update')
        .limit(1);
      if (!deck) return { ok: false, failure: { code: 'not_found' } };
      // Who may commit, and as which role (Phase 5): the deck owner and
      // workspace admins/owners commit as 'owner'; an ACTIVE per-deck dev
      // collaborator commits as 'dev' (checked inside the transaction so a
      // concurrent revoke serializes against the commit). Anyone else gets
      // the SAME not_found a missing deck answers (AUTH-5, PRDCT-1393): a
      // refused principal cannot read the deck either (canWrite coincides
      // with canRead), so a push probe must not confirm the deck exists.
      let authorRole: VersionAuthorRole;
      if (canAdministerDeck(opts.principal, deck)) {
        authorRole = 'owner';
      } else if (await isActiveDevCollaborator(tx, deck.id, opts.principal.userId)) {
        authorRole = 'dev';
      } else {
        return { ok: false, failure: { code: 'not_found' } };
      }
      if (deck.currentVersion !== opts.expectedBaseVersion) {
        return { ok: false, failure: { code: 'version_conflict', currentVersion: deck.currentVersion } };
      }

      const { missing, sizeBySha } = await this.lockAndResolveBlobs(
        tx,
        opts.workspaceId,
        opts.principal,
        opts.manifest
      );
      if (missing.length > 0) return { ok: false, failure: { code: 'missing_blobs', missing } };
      const stamped = this.stampManifest(opts.manifest, sizeBySha);

      const newVersion = deck.currentVersion + 1;
      const [version] = await tx
        .insert(presentationVersions)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: deck.id,
          version: newVersion,
          entryPath: opts.entryPath,
          manifest: stamped.manifest,
          sizeBytes: stamped.sizeBytes,
          fileCount: stamped.fileCount,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: opts.hasForms,
          hasDownloads: stamped.hasDownloads,
          createdBy: opts.principal.userId,
          // 'owner' for the deck owner / workspace admins, 'dev' for an
          // active per-deck collaborator (resolved above, in-transaction).
          createdByRole: authorRole
        })
        .returning();
      const [updated] = await tx
        .update(presentations)
        .set({
          currentVersion: newVersion,
          entryPath: opts.entryPath,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: opts.hasForms,
          hasDownloads: stamped.hasDownloads,
          updatedAt: new Date(),
          ...(opts.title !== undefined ? { title: opts.title } : {})
        })
        .where(eq(presentations.id, deck.id))
        .returning();

      return { ok: true, presentation: updated!, version: version! };
    });
  }

  // ── Duplicate (PRDCT-2279) ─────────────────────────────────────────────────

  /**
   * A new deck in the caller's workspace whose version 1 is the SOURCE
   * version's manifest, entry for entry, sha for sha: nothing is re-uploaded
   * and no `files` row is written — blobs are content-addressed per
   * workspace, so the copy references the bytes the source already holds.
   *
   * Authorization is layered like a push. The HANDLER answers the source's
   * read check (canReadDeck: 404, never 403 — ADR 013) and the guest wall
   * (deck creation is a workspace-level act, D2); this transaction then
   * resolves the manifest's shas under `blobReadScope` like every commit —
   * the SL-B1 guard — so a sha the caller may not read reports as missing
   * (never as its own code) and the copy can only bind bytes the caller
   * could bind by pushing them. The source row is re-read FOR SHARE inside
   * the transaction: a soft delete racing the duplicate serializes, and a
   * deck that vanished answers not_found rather than a copy of a deleted
   * deck. `hasForms` is COPIED from the source version row, not rescanned:
   * the bytes are the same bytes, and a rescan would open blobs under row
   * locks (PRDCT-1333). Lineage lands in `remixedFrom`.
   */
  async duplicate(opts: {
    workspaceId: string;
    principal: Principal;
    sourceId: string;
    /** The source version to copy; the source's current version when omitted. */
    version?: number | undefined;
    /** The copy's title; `<source title> (copy)` (capped at 300) when omitted. */
    title?: string | undefined;
  }): Promise<DuplicateResult> {
    return this.db.transaction(async (tx): Promise<DuplicateResult> => {
      const [source] = await tx
        .select()
        .from(presentations)
        .where(
          and(
            eq(presentations.id, opts.sourceId),
            eq(presentations.workspaceId, opts.workspaceId),
            isNull(presentations.deletedAt)
          )
        )
        .for('share')
        .limit(1);
      if (!source) return { ok: false, failure: { code: 'not_found' } };
      const wanted = opts.version ?? source.currentVersion;
      if (wanted < 1) return { ok: false, failure: { code: 'no_versions' } };
      const [sourceVersion] = await tx
        .select()
        .from(presentationVersions)
        .where(
          and(
            eq(presentationVersions.presentationId, source.id),
            eq(presentationVersions.workspaceId, opts.workspaceId),
            eq(presentationVersions.version, wanted)
          )
        )
        .limit(1);
      if (!sourceVersion) return { ok: false, failure: { code: 'invalid_version', version: wanted } };

      const manifest = sourceVersion.manifest as ManifestEntry[];
      const { missing, sizeBySha } = await this.lockAndResolveBlobs(
        tx,
        opts.workspaceId,
        opts.principal,
        manifest
      );
      if (missing.length > 0) return { ok: false, failure: { code: 'missing_blobs', missing } };
      const stamped = this.stampManifest(manifest, sizeBySha);

      const title = opts.title ?? duplicateTitle(source.title);
      const [presentation] = await tx
        .insert(presentations)
        .values({
          workspaceId: opts.workspaceId,
          ownerUserId: opts.principal.userId,
          title,
          kind: source.kind,
          interactive: source.interactive,
          metadata: source.metadata,
          currentVersion: 1,
          entryPath: sourceVersion.entryPath,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: sourceVersion.hasForms,
          hasDownloads: stamped.hasDownloads,
          remixedFrom: source.id
        })
        .returning();
      const [version] = await tx
        .insert(presentationVersions)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: presentation!.id,
          version: 1,
          entryPath: sourceVersion.entryPath,
          manifest: stamped.manifest,
          sizeBytes: stamped.sizeBytes,
          fileCount: stamped.fileCount,
          hasAgentDoc: stamped.hasAgentDoc,
          hasForms: sourceVersion.hasForms,
          hasDownloads: stamped.hasDownloads,
          createdBy: opts.principal.userId,
          // The copy is the caller's own deck: they own it, so they commit
          // its first version as 'owner' whatever their role on the source.
          createdByRole: 'owner'
        })
        .returning();
      return { ok: true, presentation: presentation!, version: version!, sourceVersion: wanted };
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────
  // Deck reads are PRIVATE, not workspace-wide (ADR 013, diverging from ADR
  // 006): a workspace admin/owner sees every deck (the operator view); a
  // plain member sees ONLY the decks they own or actively collaborate on.

  async list(
    principal: Principal,
    opts: { cursor?: string; limit: number }
  ): Promise<{ presentations: PresentationRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    // Visibility scope (ADR 013): admins/owners get the operator view; a
    // plain member's page is ownership OR an ACTIVE collaborator grant —
    // revoked/expired grants drop the deck from the listing immediately.
    const operatorView = principal.role === 'owner' || principal.role === 'admin';
    const visibility = operatorView
      ? []
      : [
          or(
            eq(presentations.ownerUserId, principal.userId),
            exists(
              this.db
                .select({ one: sql`1` })
                .from(collaborators)
                .where(
                  and(
                    eq(collaborators.presentationId, presentations.id),
                    eq(collaborators.userId, principal.userId),
                    eq(collaborators.status, 'active')
                  )
                )
            )
          )!
        ];
    const rows = await this.db
      .select()
      .from(presentations)
      .where(
        and(
          eq(presentations.workspaceId, principal.workspaceId),
          isNull(presentations.deletedAt),
          ...visibility,
          ...(cursorId
            ? [
                keysetBefore({
                  table: presentations,
                  id: presentations.id,
                  createdAt: presentations.createdAt,
                  workspaceId: presentations.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(presentations.createdAt), desc(presentations.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { presentations: page, nextCursor };
  }

  async get(workspaceId: string, id: string): Promise<PresentationRow | null> {
    const [row] = await this.db
      .select()
      .from(presentations)
      .where(
        and(
          eq(presentations.id, id),
          eq(presentations.workspaceId, workspaceId),
          isNull(presentations.deletedAt)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Update mutable deck properties (PATCH /presentations/{id}). `metadata`
   * replaces the stored object wholesale — merge is a client concern (the
   * caller read the deck to know what to send). Null when the deck is gone
   * (the handler's 404; write authorization is the handler's canWriteDeck).
   */
  async update(
    workspaceId: string,
    id: string,
    patch: { title?: string | undefined; metadata?: Record<string, unknown> | undefined }
  ): Promise<PresentationRow | null> {
    const [row] = await this.db
      .update(presentations)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
        updatedAt: new Date()
      })
      .where(
        and(
          eq(presentations.id, id),
          eq(presentations.workspaceId, workspaceId),
          isNull(presentations.deletedAt)
        )
      )
      .returning();
    return row ?? null;
  }

  /**
   * Remember the deck's badge slot for annotator links. Written whenever a
   * share token is created or patched with an EXPLICIT badgePosition, so
   * the next link on this deck inherits the last deliberate choice.
   */
  async rememberBadgePosition(workspaceId: string, id: string, position: BadgePosition): Promise<void> {
    await this.db
      .update(presentations)
      .set({ annotationBadgePosition: position, updatedAt: new Date() })
      .where(and(eq(presentations.id, id), eq(presentations.workspaceId, workspaceId)));
  }

  /** Handler-facing wrapper over the module-level canWriteDeck (needs a conn). */
  canWrite(principal: Principal, deck: PresentationRow): Promise<boolean> {
    return canWriteDeck(this.db, principal, deck);
  }

  /** Handler-facing wrapper over the module-level canReadDeck (needs a conn). */
  canRead(principal: Principal, deck: PresentationRow): Promise<boolean> {
    return canReadDeck(this.db, principal, deck);
  }

  /**
   * Version listings deliberately never SELECT the manifest jsonb (ADR 011):
   * the columns are enumerated, `manifest` excluded. The row id feeds the
   * keyset cursor only — it is not part of the wire shape. Each row carries
   * its views and downloads (PRDCT-2308), counted from the link-analytics
   * events of the page's versions in one grouped query per table.
   */
  async listVersions(
    workspaceId: string,
    presentationId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ versions: VersionSummaryRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select({
        id: presentationVersions.id,
        workspaceId: presentationVersions.workspaceId,
        presentationId: presentationVersions.presentationId,
        version: presentationVersions.version,
        entryPath: presentationVersions.entryPath,
        sizeBytes: presentationVersions.sizeBytes,
        fileCount: presentationVersions.fileCount,
        hasAgentDoc: presentationVersions.hasAgentDoc,
        hasForms: presentationVersions.hasForms,
        hasDownloads: presentationVersions.hasDownloads,
        createdBy: presentationVersions.createdBy,
        createdByRole: presentationVersions.createdByRole,
        createdAt: presentationVersions.createdAt
      })
      .from(presentationVersions)
      .where(
        and(
          eq(presentationVersions.presentationId, presentationId),
          eq(presentationVersions.workspaceId, workspaceId),
          ...(cursorId
            ? [
                keysetBefore({
                  table: presentationVersions,
                  id: presentationVersions.id,
                  createdAt: presentationVersions.createdAt,
                  // Scope the cursor subquery to THIS deck (tighter than the
                  // workspace: a foreign deck's cursor cannot position here).
                  workspaceId: presentationVersions.presentationId,
                  cursorId,
                  workspace: presentationId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(presentationVersions.createdAt), desc(presentationVersions.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    const counts = await this.versionCounts(
      workspaceId,
      presentationId,
      page.map((v) => v.version)
    );
    return {
      versions: page.map((v) => ({
        ...v,
        viewCount: counts.views.get(v.version) ?? 0,
        downloadCount: counts.downloads.get(v.version) ?? 0
      })),
      nextCursor
    };
  }

  /**
   * Views and downloads per version (PRDCT-2308), from the two link-analytics
   * event tables grouped by the version each event was served from — one
   * index-backed query per table (migration 0041), scoped to the page's
   * versions. Retention-bounded like the events themselves: a purged event
   * is not counted, while the deck's totalViews counter keeps its lifetime
   * figure. Owner previews write no event, so they never count here either.
   */
  private async versionCounts(
    workspaceId: string,
    presentationId: string,
    versions: number[]
  ): Promise<{ views: Map<number, number>; downloads: Map<number, number> }> {
    const views = new Map<number, number>();
    const downloads = new Map<number, number>();
    if (versions.length === 0) return { views, downloads };
    const viewRows = await this.db
      .select({ version: shareTokenViews.version, n: sql<number>`count(*)::int` })
      .from(shareTokenViews)
      .where(
        and(
          eq(shareTokenViews.presentationId, presentationId),
          eq(shareTokenViews.workspaceId, workspaceId),
          inArray(shareTokenViews.version, versions)
        )
      )
      .groupBy(shareTokenViews.version);
    for (const r of viewRows) views.set(r.version, r.n);
    const downloadRows = await this.db
      .select({ version: shareTokenDownloads.version, n: sql<number>`count(*)::int` })
      .from(shareTokenDownloads)
      .where(
        and(
          eq(shareTokenDownloads.presentationId, presentationId),
          eq(shareTokenDownloads.workspaceId, workspaceId),
          inArray(shareTokenDownloads.version, versions)
        )
      )
      .groupBy(shareTokenDownloads.version);
    for (const r of downloadRows) downloads.set(r.version, r.n);
    return { views, downloads };
  }

  async getVersion(
    workspaceId: string,
    presentationId: string,
    version: number
  ): Promise<PresentationVersionRow | null> {
    const [row] = await this.db
      .select()
      .from(presentationVersions)
      .where(
        and(
          eq(presentationVersions.presentationId, presentationId),
          eq(presentationVersions.workspaceId, workspaceId),
          eq(presentationVersions.version, version)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * The manifest entry for a blob within THIS deck (any version) — the asset
   * download's reference check: a deck id must never become a handle to pull
   * arbitrary workspace blobs. Containment rides the manifest GIN index.
   */
  async findManifestEntry(
    workspaceId: string,
    presentationId: string,
    sha256: string
  ): Promise<ManifestEntry | null> {
    const [row] = await this.db
      .select({ manifest: presentationVersions.manifest })
      .from(presentationVersions)
      .where(
        and(
          eq(presentationVersions.presentationId, presentationId),
          eq(presentationVersions.workspaceId, workspaceId),
          sql`${presentationVersions.manifest} @> ${JSON.stringify([{ sha256 }])}::jsonb`
        )
      )
      // Newest version's manifest wins when a sha appears in several.
      .orderBy(desc(presentationVersions.version))
      .limit(1);
    if (!row) return null;
    const entries = row.manifest as ManifestEntry[];
    return entries.find((e) => e.sha256 === sha256) ?? null;
  }

  // ── Delete ─────────────────────────────────────────────────────────────────

  /** Soft delete; versions and (Phase 4) share tokens stop resolving. */
  async softDelete(deck: PresentationRow): Promise<PresentationRow> {
    const [row] = await this.db
      .update(presentations)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(presentations.id, deck.id), isNull(presentations.deletedAt)))
      .returning();
    return row ?? deck;
  }

  // ── Blob-delete guard (ADR 011 sharp edge) ─────────────────────────────────

  /**
   * True when any version of any LIVE deck in the workspace references this
   * blob — the generic DELETE /files/{id} must refuse it (409 file_in_use).
   * Runs inside the file-delete transaction (on `conn`) with the files row
   * already locked FOR UPDATE, so it serializes against commits' FOR SHARE.
   * Soft-deleted decks do not pin blobs: their manifests are tolerated to
   * dangle (the deck no longer resolves; a future GC reclaims properly).
   */
  async blobInUse(conn: DbConn, workspaceId: string, sha256: string): Promise<boolean> {
    const res = await conn.execute(sql`
      SELECT 1
      FROM presentation_versions pv
      JOIN presentations p ON p.id = pv.presentation_id
      WHERE pv.workspace_id = ${workspaceId}
        AND p.deleted_at IS NULL
        AND pv.manifest @> ${JSON.stringify([{ sha256 }])}::jsonb
      LIMIT 1
    `);
    return (res.rows?.length ?? 0) > 0;
  }
}

/** The wire cap on a deck title (`plainText(1, 300)`), in UTF-16 code units like zod's `max`. */
const TITLE_MAX_UNITS = 300;

/**
 * The title a copy gets when the caller names none: the source's, suffixed,
 * within the cap. The cut is by CODE POINT, never by code unit: a title made
 * of astral characters (emoji) can be legal at 300 units, and a unit-wise
 * slice would split a surrogate pair — the lone surrogate then lands in
 * Postgres as U+FFFD (verifier round 1). Code points are dropped from the
 * end until the suffixed title fits the unit cap.
 */
export function duplicateTitle(sourceTitle: string): string {
  const suffix = ' (copy)';
  const points = Array.from(sourceTitle);
  let keep = points.length;
  while (keep > 0 && points.slice(0, keep).join('').length + suffix.length > TITLE_MAX_UNITS) keep -= 1;
  return `${points.slice(0, keep).join('')}${suffix}`;
}

/**
 * OWNER-LEVEL control of a deck: its owner, or a workspace admin/owner
 * (decks are WORKSPACE data — ADR 006 — and an orphaned deck, owner_user_id
 * NULL after account deletion, must stay manageable). This is the gate for
 * the owner-only acts: deleting the deck and inviting/revoking its
 * collaborators. Dev collaborators deliberately do NOT pass this.
 */
export function canAdministerDeck(principal: Principal, deck: PresentationRow): boolean {
  if (deck.ownerUserId === principal.userId) return true;
  return principal.role === 'owner' || principal.role === 'admin';
}

/** True when the user holds an ACTIVE per-deck dev grant (Phase 5). */
export async function isActiveDevCollaborator(
  conn: DbConn,
  presentationId: string,
  userId: string
): Promise<boolean> {
  const [row] = await conn
    .select({ id: collaborators.id })
    .from(collaborators)
    .where(
      and(
        eq(collaborators.presentationId, presentationId),
        eq(collaborators.userId, userId),
        eq(collaborators.status, 'active')
      )
    )
    .limit(1);
  return Boolean(row);
}

/**
 * WRITE access to a deck (Phase 5 shape): owner-level control OR an active
 * dev collaborator. Devs can push versions (createdByRole 'dev'), pull, and
 * manage the deck's share tokens and annotations — but never delete the deck
 * or touch its collaborator list (canAdministerDeck above). Works for
 * machine principals too: an API key acts as its owning user, so a dev's key
 * writes exactly what the dev's session could.
 */
export async function canWriteDeck(
  conn: DbConn,
  principal: Principal,
  deck: PresentationRow
): Promise<boolean> {
  if (canAdministerDeck(principal, deck)) return true;
  return isActiveDevCollaborator(conn, deck.id, principal.userId);
}

/**
 * READ access to a deck (ADR 013 — decks are PRIVATE to their owner):
 * the deck owner, a workspace admin/owner (the instance-operator view), or
 * the holder of an ACTIVE collaborator grant on THIS deck. This deliberately
 * diverges from ADR 006's "workspace data" read posture: collaborators are
 * routinely EXTERNAL parties (a reviewer/client invited to exactly one
 * deck), so workspace membership alone must never be a handle to read every
 * deck — and revoking a grant must cut content access off immediately.
 *
 * Today this coincides with canWriteDeck; it is a SEPARATE policy on purpose
 * (a future read-only collaborator role widens reads without widening
 * writes). Handlers answer 404 — never 403 — when this returns false: a deck
 * a principal cannot read must not reveal its existence (the codebase's
 * standing not-found posture).
 */
export async function canReadDeck(
  conn: DbConn,
  principal: Principal,
  deck: PresentationRow
): Promise<boolean> {
  if (canAdministerDeck(principal, deck)) return true;
  return isActiveDevCollaborator(conn, deck.id, principal.userId);
}

/**
 * READ access to a BLOB, as a WHERE predicate over a `files` row (SL-B1).
 *
 * ADR 013 made deck reads private but left the generic `/files` surface
 * authorizing on `workspace_id` alone — so every plain member (and every
 * `presentations:read` key) could list and stream the bytes of every deck in
 * the workspace, which is exactly the hole ADR 013 was written to close, one
 * layer down. The blob surface now carries the same policy:
 *
 *  1. a workspace **admin/owner** keeps the ADR 006 operator view (predicate
 *     `undefined` — no extra WHERE, every blob in the workspace), and
 *  2. everyone else sees a blob iff they **uploaded** it (`file_uploaders`,
 *     which unlike `files.created_by` survives content-addressed dedupe) or
 *     it is referenced by the manifest of a LIVE version of a deck they can
 *     read (own, or hold an ACTIVE grant on — `canReadDeck` in SQL form).
 *
 * Soft-deleted decks stop conferring blob reads, exactly as they stop
 * resolving. Containment rides the `presentation_versions` manifest GIN
 * index (the same probe the blob-delete guard uses). Handlers answer 404,
 * never 403 — a blob a principal cannot read must not be probeable either.
 *
 * This predicate is ALSO the commit guard: `lockAndResolveBlobs` resolves
 * only shas the caller may read, so a manifest naming a foreign deck's blob
 * cannot bind it (the sha reports as `missing_blobs`, which keeps the
 * refusal non-probeable too).
 */
export function blobReadScope(principal: Principal): SQL | undefined {
  if (principal.role === 'owner' || principal.role === 'admin') return undefined;
  const userId = principal.userId;
  return sql`(
    EXISTS (
      SELECT 1 FROM file_uploaders fu
      WHERE fu.file_id = ${files.id} AND fu.user_id = ${userId}
    )
    OR EXISTS (
      SELECT 1
      FROM presentation_versions pv
      JOIN presentations p ON p.id = pv.presentation_id
      WHERE pv.workspace_id = ${files.workspaceId}
        AND p.deleted_at IS NULL
        AND (
          p.owner_user_id = ${userId}
          OR EXISTS (
            SELECT 1 FROM collaborators c
            WHERE c.presentation_id = p.id
              AND c.user_id = ${userId}
              AND c.status = 'active'
          )
        )
        AND pv.manifest @> jsonb_build_array(jsonb_build_object('sha256', ${files.sha256}))
    )
  )`;
}

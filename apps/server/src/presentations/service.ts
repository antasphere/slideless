import { randomUUID } from 'node:crypto';
import { and, desc, eq, exists, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import { files, type Db, type DbConn } from '@antasphere/chassis-db';
import {
  collaborators,
  presentations,
  presentationVersions,
  shareTokenDownloads,
  shareTokenViews,
  uploadSessions,
  type BadgePosition,
  type PresentationRow,
  type PresentationVersionRow,
  type UploadSessionRow,
  type VersionAuthorRole
} from '@slideless/db';
import type { Principal } from '@antasphere/chassis-contract';
import {
  AGENT_DOC_PATH,
  isAttachmentPath,
  type Audience,
  type ManifestEntry,
  type PresentationsListType,
  type Reference
} from '@slideless/contract';
import { cursorRowId, keysetBefore, pageOf } from '@antasphere/chassis-server/util';

/** A version list row: the summary columns plus its per-version counts (PRDCT-2308). */
export type VersionSummaryRow = Omit<PresentationVersionRow, 'manifest'> & {
  viewCount: number;
  downloadCount: number;
};

/** Two-int advisory lock namespace serializing default-reference sets per (workspace, type) — ADR 025. 7432001-6 are taken (see forms/uploads.ts, api/workspaces.ts). */
const DEFAULT_REFERENCE_LOCK = 7432007;

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
  /**
   * What a re-push took from a reference (ADR 025), for the audit row: a
   * dev collaborator's push can close a published brand or drop the house
   * default, and the version's warning must not be the only trace.
   */
  referenceLoss?: { audienceReset: boolean; defaultDropped: boolean };
}
export type SessionCommitResult = CommitSuccess | { ok: false; failure: SessionCommitFailure };
export type VersionCommitResult = CommitSuccess | { ok: false; failure: VersionCommitFailure };

/**
 * What the handler read from the bundle's AGENT.md frontmatter BEFORE the
 * commit transaction (presentations/reference-frontmatter.ts — PRDCT-1333:
 * no blob read with row locks held). `reference` null = an ordinary deck;
 * `warning` names what was unusable. Neither ever refuses a commit.
 */
export interface CommitReference {
  reference: Reference | null;
  warning: string | null;
}

/** PATCH failures (ADR 025): the handler maps each to 404 / 422 / 409. */
export type UpdateFailure =
  | { code: 'not_found' }
  | { code: 'not_a_reference' }
  | { code: 'audience_private' }
  | { code: 'default_reference' };
export type UpdateResult =
  | {
      ok: true;
      presentation: PresentationRow;
      /** The decks that lost the default to this set (normally zero or one) — for the audit row. */
      displacedDefaultIds: string[];
    }
  | { ok: false; failure: UpdateFailure };

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
    /** The AGENT.md frontmatter, read by the caller before the transaction (ADR 025). */
    reference: CommitReference;
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
          hasDownloads: stamped.hasDownloads,
          // A new reference is born PRIVATE and never the default (the
          // column defaults): publishing is an act, not a file (ADR 025).
          referenceType: opts.reference.reference?.type ?? null,
          reference: opts.reference.reference
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
          referenceType: opts.reference.reference?.type ?? null,
          reference: opts.reference.reference,
          referenceWarning: opts.reference.warning,
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
    /** See commitUploadSession — ADR 025. */
    reference: CommitReference;
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
      // push probe must not confirm the deck exists. Since ADR 025 a member
      // may READ a workspace reference without writing it; they get this
      // uniform not_found too — safe, and it tells them nothing new.
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

      // The mirror moves with the version (ADR 025). The deck row is locked
      // FOR UPDATE above, so the audience/default reset below cannot race a
      // PATCH. FAIL-CLOSED on a reference that stops being one: the audience
      // returns to private and the default is dropped IN THIS COMMIT — left
      // on `workspace`, a frontmatter pushed back months later would reopen
      // the deck to the whole workspace without anyone choosing it. A type
      // change keeps the audience (still a reference) but drops the default:
      // the workspace may already hold a default of the new type.
      const newType = opts.reference.reference?.type ?? null;
      const stoppedBeingReference = deck.referenceType !== null && newType === null;
      const typeChanged = deck.referenceType !== null && newType !== null && newType !== deck.referenceType;
      const mirrorNotes: string[] = [];
      if (stoppedBeingReference) {
        mirrorNotes.push(
          `This deck was a ${deck.referenceType} reference and this version carries no usable frontmatter: ` +
            'it is an ordinary deck again' +
            (deck.audience === 'workspace' ? ', its audience went back to private' : '') +
            (deck.isDefaultReference ? `, and it is no longer the default ${deck.referenceType}` : '') +
            '.'
        );
      } else if (typeChanged && deck.isDefaultReference) {
        mirrorNotes.push(
          `The reference type changed from ${deck.referenceType} to ${newType}: the deck is no longer the default ${deck.referenceType}.`
        );
      }
      const referenceWarning = [opts.reference.warning, ...mirrorNotes].filter(Boolean).join(' ') || null;

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
          referenceType: newType,
          reference: opts.reference.reference,
          referenceWarning,
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
          referenceType: newType,
          reference: opts.reference.reference,
          ...(stoppedBeingReference ? { audience: 'private' as const, isDefaultReference: false } : {}),
          ...(typeChanged ? { isDefaultReference: false } : {}),
          updatedAt: new Date(),
          ...(opts.title !== undefined ? { title: opts.title } : {})
        })
        .where(eq(presentations.id, deck.id))
        .returning();

      const audienceReset = stoppedBeingReference && deck.audience === 'workspace';
      const defaultDropped = (stoppedBeingReference || typeChanged) && deck.isDefaultReference;
      return {
        ok: true,
        presentation: updated!,
        version: version!,
        ...(audienceReset || defaultDropped ? { referenceLoss: { audienceReset, defaultDropped } } : {})
      };
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
          // A duplicate of a reference is a reference (ADR 025): the copied
          // VERSION's mirror, the same bytes. Private and never the default
          // (the column defaults) — the copy is the caller's own deck.
          referenceType: sourceVersion.referenceType,
          reference: sourceVersion.reference,
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
          referenceType: sourceVersion.referenceType,
          reference: sourceVersion.reference,
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
    opts: { cursor?: string; limit: number; type?: PresentationsListType; defaultOnly?: boolean }
  ): Promise<{ presentations: PresentationRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    // The `type` scope (ADR 025): absent = ORDINARY decks only (references
    // leave the default listing); a type = the references of that type;
    // `reference` = every reference. `defaultOnly` implies references.
    const type = opts.type ?? (opts.defaultOnly ? 'reference' : undefined);
    const typeScope =
      type === undefined
        ? isNull(presentations.referenceType)
        : type === 'reference'
          ? isNotNull(presentations.referenceType)
          : eq(presentations.referenceType, type);
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
            ),
            // The ADR 013 amendment, in the list's WHERE: a reference whose
            // audience is `workspace` is every NON-GUEST member's to read.
            // The same three clauses as canReadDeck and blobReadScope — a
            // guest membership exists for principal resolution only (D2).
            ...(principal.origin !== 'guest'
              ? [and(isNotNull(presentations.referenceType), eq(presentations.audience, 'workspace'))]
              : [])
          )!
        ];
    const rows = await this.db
      .select()
      .from(presentations)
      .where(
        and(
          eq(presentations.workspaceId, principal.workspaceId),
          isNull(presentations.deletedAt),
          typeScope,
          ...(opts.defaultOnly ? [eq(presentations.isDefaultReference, true)] : []),
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
   * caller read the deck to know what to send). WHO may change which field
   * is the handler's (the tiered rule); WHAT a change means is here.
   *
   * `audience` and `defaultReference` (ADR 025) apply to a reference only
   * (`not_a_reference`). The two must agree: a default reference is a
   * workspace reference, so setting the default on a private one refuses
   * `audience_private` and switching a default back to private refuses
   * `default_reference` — both sent together are judged on the END state.
   * The deck row is locked FOR UPDATE so the checks cannot race a commit
   * that reclassifies the deck. Setting a default clears the previous one of
   * that type in the SAME transaction, serialized per (workspace, type) by
   * a transaction-scoped advisory lock; the partial unique index
   * `presentations_default_reference_uniq` is the backstop should two sets
   * ever interleave anyway.
   */
  async update(
    workspaceId: string,
    id: string,
    patch: {
      title?: string | undefined;
      metadata?: Record<string, unknown> | undefined;
      /** The owner-notification switch for form responses (PRDCT-2330). */
      notifyOnResponse?: boolean | undefined;
      audience?: Audience | undefined;
      defaultReference?: boolean | undefined;
    }
  ): Promise<UpdateResult> {
    return this.db.transaction(async (tx): Promise<UpdateResult> => {
      const [deck] = await tx
        .select()
        .from(presentations)
        .where(
          and(
            eq(presentations.id, id),
            eq(presentations.workspaceId, workspaceId),
            isNull(presentations.deletedAt)
          )
        )
        .for('update')
        .limit(1);
      if (!deck) return { ok: false, failure: { code: 'not_found' } };

      const touchesReference = patch.audience !== undefined || patch.defaultReference !== undefined;
      if (touchesReference && deck.referenceType === null) {
        return { ok: false, failure: { code: 'not_a_reference' } };
      }
      const nextAudience = patch.audience ?? deck.audience;
      const nextDefault = patch.defaultReference ?? deck.isDefaultReference;
      if (touchesReference && nextDefault && nextAudience !== 'workspace') {
        // Which refusal: the caller asked for the default on a private
        // reference, or asked to privatize the standing default.
        return {
          ok: false,
          failure: { code: patch.defaultReference === true ? 'audience_private' : 'default_reference' }
        };
      }
      let displacedDefaultIds: string[] = [];
      if (nextDefault && !deck.isDefaultReference) {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(${DEFAULT_REFERENCE_LOCK}, hashtext(${`${workspaceId}:${deck.referenceType}`}))`
        );
        const displaced = await tx
          .update(presentations)
          .set({ isDefaultReference: false, updatedAt: new Date() })
          .where(
            and(
              eq(presentations.workspaceId, workspaceId),
              eq(presentations.referenceType, deck.referenceType!),
              eq(presentations.isDefaultReference, true),
              ne(presentations.id, deck.id)
            )
          )
          .returning({ id: presentations.id });
        displacedDefaultIds = displaced.map((r) => r.id);
      }

      const [row] = await tx
        .update(presentations)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.metadata !== undefined ? { metadata: patch.metadata } : {}),
          ...(patch.notifyOnResponse !== undefined ? { notifyOnResponse: patch.notifyOnResponse } : {}),
          ...(patch.audience !== undefined ? { audience: patch.audience } : {}),
          ...(patch.defaultReference !== undefined ? { isDefaultReference: patch.defaultReference } : {}),
          updatedAt: new Date()
        })
        .where(eq(presentations.id, deck.id))
        .returning();
      return { ok: true, presentation: row!, displacedDefaultIds };
    });
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
        referenceType: presentationVersions.referenceType,
        reference: presentationVersions.reference,
        referenceWarning: presentationVersions.referenceWarning,
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

  /**
   * Soft delete; versions and (Phase 4) share tokens stop resolving. A
   * default reference may be deleted, and the delete drops the default
   * (ADR 025): the flag is cleared on the row itself, beside the partial
   * unique index that already ignores deleted rows.
   */
  async softDelete(deck: PresentationRow): Promise<PresentationRow> {
    const [row] = await this.db
      .update(presentations)
      .set({ deletedAt: new Date(), isDefaultReference: false, updatedAt: new Date() })
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
 * A SEPARATE policy from canWriteDeck on purpose, and since ADR 025 the two
 * DIVERGE: a workspace reference widens reads without widening writes (a
 * future read-only collaborator role would do the same). Handlers answer 404 — never 403 — when this returns false: a deck
 * a principal cannot read must not reveal its existence (the codebase's
 * standing not-found posture).
 */
export async function canReadDeck(
  conn: DbConn,
  principal: Principal,
  deck: PresentationRow
): Promise<boolean> {
  if (canAdministerDeck(principal, deck)) return true;
  if (isWorkspaceReference(deck) && principal.origin !== 'guest') return true;
  return isActiveDevCollaborator(conn, deck.id, principal.userId);
}

/**
 * The ADR 013 amendment (ADR 025): a REFERENCE whose audience is `workspace`
 * is readable by every non-guest member of its workspace — the explicit
 * visibility field ADR 013's "Revisit when" asked for. Three clauses, and
 * each one is load-bearing: the TYPE (an ordinary deck can never be opened
 * this way, whatever its audience column says), the AUDIENCE (a private
 * reference keeps the ADR 013 rule untouched), and — at the call sites —
 * the GUEST refusal (a guest membership exists for principal resolution
 * only, D2). Same workspace and not deleted are the caller's: every deck
 * reaches here through `get(workspaceId, id)`. READ ONLY: canWriteDeck and
 * canAdministerDeck do not know this branch. `blobReadScope` and `list()`
 * carry the same three clauses in SQL — change one, change all three.
 */
export function isWorkspaceReference(deck: Pick<PresentationRow, 'referenceType' | 'audience'>): boolean {
  return deck.referenceType !== null && deck.audience === 'workspace';
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
  // The ADR 013 amendment, in SQL (see isWorkspaceReference): the bytes of a
  // workspace reference follow the reference's rule, so a non-guest member
  // may read them — and BIND them (the wanted consequence: the house logo
  // goes into a member's own deck without a re-upload, and precheckMissing
  // answers "present" for it). Omitted entirely for a guest.
  const workspaceReference =
    principal.origin !== 'guest'
      ? sql`OR (p.reference_type IS NOT NULL AND p.audience = 'workspace')`
      : sql``;
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
          ${workspaceReference}
        )
        AND pv.manifest @> jsonb_build_array(jsonb_build_object('sha256', ${files.sha256}))
    )
  )`;
}

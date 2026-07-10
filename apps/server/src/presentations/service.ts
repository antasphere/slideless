import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  collaborators,
  files,
  presentations,
  presentationVersions,
  uploadSessions,
  type Db,
  type DbConn,
  type PresentationRow,
  type PresentationVersionRow,
  type UploadSessionRow,
  type VersionAuthorRole
} from '@slideless/db';
import type { ManifestEntry, Principal } from '@slideless/contract';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/** Upload sessions reserve the future deck id for ~1 h (ADR 011). */
export const UPLOAD_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Commit failures as data, not exceptions — the handlers map each variant to
 * its contract status (400/403/404/409/410) without string matching. The two
 * commit paths get separate unions so each handler's switch stays exhaustive
 * against exactly the statuses its route declares.
 */
export type ManifestFailure =
  | { code: 'invalid_manifest'; message: string }
  | { code: 'missing_blobs'; missing: string[] };

export type SessionCommitFailure =
  | ManifestFailure
  | { code: 'not_found' }
  | { code: 'session_consumed' }
  | { code: 'session_expired' };

export type VersionCommitFailure =
  | ManifestFailure
  | { code: 'not_found' }
  | { code: 'forbidden' }
  | { code: 'version_conflict'; currentVersion: number };

export interface CommitSuccess {
  ok: true;
  presentation: PresentationRow;
  version: PresentationVersionRow;
}
export type SessionCommitResult = CommitSuccess | { ok: false; failure: SessionCommitFailure };
export type VersionCommitResult = CommitSuccess | { ok: false; failure: VersionCommitFailure };

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
   * Which of these hashes have no LIVE blob in the workspace yet. A
   * soft-deleted files row counts as missing: its blob was removed with it,
   * and re-uploading revives the row (files/service.ts upload semantics).
   */
  async precheckMissing(workspaceId: string, shas: string[]): Promise<string[]> {
    const unique = [...new Set(shas)];
    const present = await this.db
      .select({ sha256: files.sha256 })
      .from(files)
      .where(
        and(eq(files.workspaceId, workspaceId), inArray(files.sha256, unique), isNull(files.deletedAt))
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
   * Every referenced blob must exist LIVE in this workspace. The rows are
   * locked FOR SHARE for the rest of the commit transaction so a concurrent
   * DELETE /files/{id} (which locks FOR UPDATE before its in-use check)
   * serializes against the commit instead of racing it: whichever wins, the
   * loser sees the winner's state (missing_blobs 400 here, file_in_use 409
   * there) — never a manifest referencing a deleted blob.
   */
  private async lockAndResolveBlobs(
    tx: DbConn,
    workspaceId: string,
    manifest: ManifestEntry[]
  ): Promise<{ missing: string[]; sizeBySha: Map<string, number> }> {
    const unique = [...new Set(manifest.map((e) => e.sha256))];
    const present = await tx
      .select({ sha256: files.sha256, sizeBytes: files.sizeBytes })
      .from(files)
      .where(
        and(eq(files.workspaceId, workspaceId), inArray(files.sha256, unique), isNull(files.deletedAt))
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
  ): { manifest: ManifestEntry[]; sizeBytes: number; fileCount: number } {
    const stamped = manifest.map((e) => ({ ...e, sizeBytes: sizeBySha.get(e.sha256)! }));
    return {
      manifest: stamped,
      sizeBytes: stamped.reduce((sum, e) => sum + e.sizeBytes, 0),
      fileCount: stamped.length
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
    entryPath: string;
    manifest: ManifestEntry[];
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

      const { missing, sizeBySha } = await this.lockAndResolveBlobs(tx, opts.workspaceId, opts.manifest);
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
          currentVersion: 1,
          entryPath: opts.entryPath
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
      // concurrent revoke serializes against the commit). Anyone else: 403.
      let authorRole: VersionAuthorRole;
      if (canAdministerDeck(opts.principal, deck)) {
        authorRole = 'owner';
      } else if (await isActiveDevCollaborator(tx, deck.id, opts.principal.userId)) {
        authorRole = 'dev';
      } else {
        return { ok: false, failure: { code: 'forbidden' } };
      }
      if (deck.currentVersion !== opts.expectedBaseVersion) {
        return { ok: false, failure: { code: 'version_conflict', currentVersion: deck.currentVersion } };
      }

      const { missing, sizeBySha } = await this.lockAndResolveBlobs(tx, opts.workspaceId, opts.manifest);
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
          updatedAt: new Date(),
          ...(opts.title !== undefined ? { title: opts.title } : {})
        })
        .where(eq(presentations.id, deck.id))
        .returning();

      return { ok: true, presentation: updated!, version: version! };
    });
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  async list(
    workspaceId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ presentations: PresentationRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(presentations)
      .where(
        and(
          eq(presentations.workspaceId, workspaceId),
          isNull(presentations.deletedAt),
          ...(cursorId
            ? [
                keysetBefore({
                  table: presentations,
                  id: presentations.id,
                  createdAt: presentations.createdAt,
                  workspaceId: presentations.workspaceId,
                  cursorId,
                  workspace: workspaceId
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

  /** Handler-facing wrapper over the module-level canWriteDeck (needs a conn). */
  canWrite(principal: Principal, deck: PresentationRow): Promise<boolean> {
    return canWriteDeck(this.db, principal, deck);
  }

  /**
   * Version listings deliberately never SELECT the manifest jsonb (ADR 011):
   * the columns are enumerated, `manifest` excluded. The row id feeds the
   * keyset cursor only — it is not part of the wire shape.
   */
  async listVersions(
    workspaceId: string,
    presentationId: string,
    opts: { cursor?: string; limit: number }
  ): Promise<{ versions: Array<Omit<PresentationVersionRow, 'manifest'>>; nextCursor: string | null }> {
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
    return { versions: page, nextCursor };
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

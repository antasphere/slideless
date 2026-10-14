import { and, asc, desc, eq, exists, isNull, or, sql } from 'drizzle-orm';
import type { Db, DbConn } from '@antasphere/chassis-db';
import type { WebhookEmitter } from '@antasphere/chassis-server';
import { annotations, collaborators, presentations, type AnnotationRow } from '@slideless/db';
import type { Principal } from '@antasphere/chassis-contract';
import { cursorRowId, keysetBefore, pageOf } from '@antasphere/chassis-server/util';
import { emitDeckEvent } from '../presentations/deck-webhooks.js';

/**
 * Reviewer annotations (Phase 5). Rows anchor to (presentation, version)
 * with an opaque jsonb `selection`; authored either by a signed-in principal
 * (`author_user_id`) or by an anonymous reviewer through a share token
 * (`share_token_id` + free-text `author_name`). Two surfaces read/write
 * them: the token-authed viewer overlay (viewer/annotations-api.ts, public)
 * and the authenticated owner/dev management routes (api/presentations.ts).
 */

export interface AnnotationFilters {
  version?: number | undefined;
  status?: 'open' | 'resolved' | undefined;
}

/**
 * One `annotation.*` event (PRDCT-3483) on the write's own connection. The
 * `link` subject is the link a viewer annotated through, `[]` for a member's.
 */
function emitAnnotationEvent(
  webhooks: WebhookEmitter,
  conn: DbConn,
  type: 'annotation.created' | 'annotation.resolved' | 'annotation.deleted',
  row: AnnotationRow
): Promise<string | null> {
  return emitDeckEvent(webhooks, conn, {
    workspaceId: row.workspaceId,
    type,
    deckId: row.presentationId,
    linkId: row.shareTokenId,
    data: {
      deckId: row.presentationId,
      version: row.version,
      annotationId: row.id,
      linkId: row.shareTokenId,
      authorName: row.authorName
    }
  });
}

export class AnnotationService {
  constructor(
    private readonly db: Db,
    /** The webhook emitter (PRDCT-3483): each annotation event rides its write's transaction. */
    private readonly webhooks: WebhookEmitter
  ) {}

  async create(opts: {
    workspaceId: string;
    presentationId: string;
    version: number;
    shareTokenId: string | null;
    authorUserId: string | null;
    authorName: string | null;
    selection: Record<string, unknown>;
    body: string;
  }): Promise<AnnotationRow> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(annotations)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: opts.presentationId,
          version: opts.version,
          shareTokenId: opts.shareTokenId,
          authorUserId: opts.authorUserId,
          authorName: opts.authorName,
          selection: opts.selection,
          body: opts.body
        })
        .returning();
      if (!row) throw new Error('annotation insert failed');
      await emitAnnotationEvent(this.webhooks, tx, 'annotation.created', row);
      return row;
    });
  }

  async get(
    workspaceId: string,
    presentationId: string,
    annotationId: string
  ): Promise<AnnotationRow | null> {
    const [row] = await this.db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.id, annotationId),
          eq(annotations.presentationId, presentationId),
          eq(annotations.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** Per-deck listing (owner/dev surface), newest first, keyset-paginated. */
  async list(
    workspaceId: string,
    presentationId: string,
    opts: AnnotationFilters & { cursor?: string | undefined; limit: number }
  ): Promise<{ annotations: AnnotationRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select()
      .from(annotations)
      .where(
        and(
          eq(annotations.presentationId, presentationId),
          eq(annotations.workspaceId, workspaceId),
          ...(opts.version !== undefined ? [eq(annotations.version, opts.version)] : []),
          ...(opts.status !== undefined ? [eq(annotations.status, opts.status)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: annotations,
                  id: annotations.id,
                  createdAt: annotations.createdAt,
                  // Scope the cursor subquery to THIS deck (the share-token
                  // precedent): a foreign deck's cursor cannot position here.
                  workspaceId: annotations.presentationId,
                  cursorId,
                  workspace: presentationId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(annotations.createdAt), desc(annotations.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { annotations: page, nextCursor };
  }

  /**
   * The reviewer-session listing (public token surface): ONLY the notes this
   * share token authored, on one version, oldest first (display order).
   * Deliberately token-scoped — per-recipient tokens isolate recipients, so
   * one reviewer never sees another reviewer's notes (or their identity).
   */
  async listForToken(shareTokenId: string, version: number, limit = 200): Promise<AnnotationRow[]> {
    return this.db
      .select()
      .from(annotations)
      .where(and(eq(annotations.shareTokenId, shareTokenId), eq(annotations.version, version)))
      .orderBy(asc(annotations.createdAt), asc(annotations.id))
      .limit(limit);
  }

  /**
   * Workspace-wide inbox, scoped to what the principal may manage: workspace
   * admins/owners see every live deck's annotations; plain members see the
   * decks they own plus the decks they actively dev-collaborate on.
   * Soft-deleted decks drop out (their annotations are dormant, not gone).
   */
  async inbox(
    principal: Principal,
    opts: AnnotationFilters & { cursor?: string | undefined; limit: number }
  ): Promise<{ annotations: AnnotationRow[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const liveDeck = and(eq(presentations.id, annotations.presentationId), isNull(presentations.deletedAt));
    const adminSees = principal.role === 'owner' || principal.role === 'admin';
    const visibility = adminSees
      ? liveDeck
      : and(
          liveDeck,
          or(
            eq(presentations.ownerUserId, principal.userId),
            exists(
              this.db
                .select({ one: sql`1` })
                .from(collaborators)
                .where(
                  and(
                    eq(collaborators.presentationId, annotations.presentationId),
                    eq(collaborators.userId, principal.userId),
                    eq(collaborators.status, 'active')
                  )
                )
            )
          )
        );

    const rows = await this.db
      .select({ annotation: annotations })
      .from(annotations)
      .innerJoin(presentations, visibility!)
      .where(
        and(
          eq(annotations.workspaceId, principal.workspaceId),
          ...(opts.version !== undefined ? [eq(annotations.version, opts.version)] : []),
          ...(opts.status !== undefined ? [eq(annotations.status, opts.status)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: annotations,
                  id: annotations.id,
                  createdAt: annotations.createdAt,
                  workspaceId: annotations.workspaceId,
                  cursorId,
                  workspace: principal.workspaceId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(annotations.createdAt), desc(annotations.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(
      rows.map((r) => r.annotation),
      opts.limit
    );
    return { annotations: page, nextCursor };
  }

  /** Apply a body/status patch; returns the updated row (null = gone). */
  async update(
    annotationId: string,
    patch: { body?: string | undefined; status?: 'open' | 'resolved' | undefined }
  ): Promise<AnnotationRow | null> {
    const set: Partial<AnnotationRow> = { updatedAt: new Date() };
    if (patch.body !== undefined) set.body = patch.body;
    if (patch.status !== undefined) set.status = patch.status;
    return this.db.transaction(async (tx) => {
      // The status BEFORE this write, under the row lock: only the move from
      // open to resolved is `annotation.resolved` (PRDCT-3483), never a
      // repeat, a body edit or a reopen.
      const [before] = await tx
        .select({ status: annotations.status })
        .from(annotations)
        .where(eq(annotations.id, annotationId))
        .for('update')
        .limit(1);
      const [row] = await tx.update(annotations).set(set).where(eq(annotations.id, annotationId)).returning();
      if (!row) return null;
      if (before?.status !== 'resolved' && row.status === 'resolved') {
        await emitAnnotationEvent(this.webhooks, tx, 'annotation.resolved', row);
      }
      return row;
    });
  }

  /** Hard delete; returns the final snapshot (null = already gone). */
  async delete(annotationId: string): Promise<AnnotationRow | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx.delete(annotations).where(eq(annotations.id, annotationId)).returning();
      if (!row) return null;
      await emitAnnotationEvent(this.webhooks, tx, 'annotation.deleted', row);
      return row;
    });
  }
}

/**
 * Wire mapping for the authenticated owner/dev surface (the contract shape).
 *
 * ⚠️ RAW CONTENT — `body`, `authorName`, and `selection` are stored and
 * returned EXACTLY as the (possibly anonymous) author supplied them: no HTML
 * escaping or sanitization happens server-side. Any consumer that renders
 * these fields into markup (the dashboard first of all) MUST HTML-escape
 * them, or an annotation becomes a stored-XSS vector against deck owners.
 */
export function annotationToWire(a: AnnotationRow): {
  id: string;
  presentationId: string;
  version: number;
  shareTokenId: string | null;
  authorUserId: string | null;
  authorName: string | null;
  selection: Record<string, unknown>;
  body: string;
  status: 'open' | 'resolved';
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: a.id,
    presentationId: a.presentationId,
    version: a.version,
    shareTokenId: a.shareTokenId,
    authorUserId: a.authorUserId,
    authorName: a.authorName,
    selection: a.selection as Record<string, unknown>,
    body: a.body,
    status: a.status,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString()
  };
}

/**
 * Wire mapping for the PUBLIC reviewer session (viewer/annotations-api.ts):
 * a deliberate subset — never author_user_id, share_token_id, workspace or
 * presentation ids. The reviewer sees only what they themselves supplied.
 *
 * ⚠️ RAW CONTENT — same warning as annotationToWire above: `body`,
 * `authorName`, and `selection` come back unescaped; every rendering
 * surface MUST HTML-escape them before putting them in markup.
 */
export function annotationToReviewerWire(a: AnnotationRow): {
  id: string;
  version: number;
  authorName: string | null;
  selection: Record<string, unknown>;
  body: string;
  status: 'open' | 'resolved';
  createdAt: string;
} {
  return {
    id: a.id,
    version: a.version,
    authorName: a.authorName,
    selection: a.selection as Record<string, unknown>,
    body: a.body,
    status: a.status,
    createdAt: a.createdAt.toISOString()
  };
}

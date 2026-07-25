import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gte, inArray, max } from 'drizzle-orm';
import {
  formResponses,
  shareTokens,
  user,
  type Db,
  type FormResponseRow,
  type FormResponseSource
} from '@slideless/db';
import type { FormResponsePayload } from '@slideless/contract';
import type { PepperRegistry } from '../apikeys/peppers.js';
import { cursorRowId, keysetBefore, pageOf } from '../pagination.js';

/**
 * Deck-embedded form responses (ADR 022). A row is one respondent's
 * EVOLVING answer to one named form, submitted anonymously through a share
 * token; the respondent's handle on their own row is a 48-byte EDIT SECRET
 * — the share-token credential pattern one level down: returned exactly
 * once at create, stored only as sha256(secret + pepper), resolved by
 * probing the unique hash index under every registered pepper version
 * (O(rotations), fails closed on a dropped version).
 *
 * `payload` is opaque jsonb: the viewer API enforces shape and size, this
 * service never reads meaning. Two surfaces touch the table: the
 * token-session viewer API (create/read-own/update-own — anonymous, the
 * edit secret is the auth) and the authenticated owner surface
 * (list/summary/delete in api/presentations.ts, canWrite-gated).
 */

/** Hard ceiling on responses per deck — spam containment on a public write. */
export const FORM_RESPONSES_MAX_PER_DECK = 10_000;

export const FORM_EDIT_SECRET_BYTES = 48; // 64 base64url chars

function hashSecret(secret: string, pepper: string): string {
  return createHash('sha256')
    .update(secret + pepper)
    .digest('hex');
}

export interface FormResponseCreate {
  workspaceId: string;
  presentationId: string;
  version: number;
  formName: string;
  shareTokenId: string;
  source: FormResponseSource;
  placement: string | null;
  /** ONLY from a verified respondent assertion (viewer/respondent.ts). */
  respondentUserId: string | null;
  payload: FormResponsePayload;
}

export interface FormResponseFilters {
  form?: string | undefined;
  token?: string | undefined;
  source?: FormResponseSource | undefined;
  placement?: string | undefined;
  since?: Date | undefined;
}

/**
 * Owner-listing row: the response plus its joined attribution labels. The
 * top-level `id` mirrors `response.id` so the shared keyset pager (pageOf)
 * can cut pages on the joined shape.
 */
export interface FormResponseListed {
  id: string;
  response: FormResponseRow;
  shareTokenName: string | null;
  respondentEmail: string | null;
}

export interface FormResponseSummaryBucket {
  formName: string;
  shareTokenId: string | null;
  shareTokenName: string | null;
  source: FormResponseSource;
  placement: string | null;
  count: number;
  lastResponseAt: Date;
}

export class FormResponseService {
  constructor(
    private readonly db: Db,
    private readonly peppers: PepperRegistry
  ) {}

  /**
   * Create a response and mint its edit secret (returned once, never
   * stored). The caller has already validated payload shape/size, the
   * capability, and the per-deck cap.
   */
  async create(opts: FormResponseCreate): Promise<{ row: FormResponseRow; editSecret: string }> {
    const editSecret = randomBytes(FORM_EDIT_SECRET_BYTES).toString('base64url');
    const pepper = this.peppers.get(this.peppers.current);
    if (pepper === undefined) {
      throw new Error(`pepper registry has no current version ${this.peppers.current}`);
    }
    const [row] = await this.db
      .insert(formResponses)
      .values({
        workspaceId: opts.workspaceId,
        presentationId: opts.presentationId,
        version: opts.version,
        formName: opts.formName,
        shareTokenId: opts.shareTokenId,
        source: opts.source,
        placement: opts.placement,
        respondentUserId: opts.respondentUserId,
        responseSecretHash: hashSecret(editSecret, pepper),
        payload: opts.payload
      })
      .returning();
    if (!row) throw new Error('form response insert failed');
    return { row, editSecret };
  }

  /**
   * Resolve a presented edit secret to its response row, or null. Pure
   * lookup — whether the row still matches the presenting token session is
   * POLICY, judged by the viewer API.
   */
  async resolveByEditSecret(secret: string): Promise<FormResponseRow | null> {
    if (secret.length < 20 || secret.length > 128) return null;
    const candidates: string[] = [];
    for (const version of this.peppers.versions) {
      const pepper = this.peppers.get(version);
      if (pepper !== undefined) candidates.push(hashSecret(secret, pepper));
    }
    if (candidates.length === 0) return null;
    const [row] = await this.db
      .select()
      .from(formResponses)
      .where(inArray(formResponses.responseSecretHash, candidates))
      .limit(1);
    return row ?? null;
  }

  /** Replace the payload (the respondent's one evolving answer). */
  async updatePayload(responseId: string, payload: FormResponsePayload): Promise<FormResponseRow | null> {
    const [row] = await this.db
      .update(formResponses)
      .set({ payload, updatedAt: new Date() })
      .where(eq(formResponses.id, responseId))
      .returning();
    return row ?? null;
  }

  /** Responses on the deck (all forms) — the per-deck cap check. */
  async countForDeck(presentationId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(formResponses)
      .where(eq(formResponses.presentationId, presentationId));
    return row?.value ?? 0;
  }

  async get(
    workspaceId: string,
    presentationId: string,
    responseId: string
  ): Promise<FormResponseListed | null> {
    const [row] = await this.db
      .select({
        id: formResponses.id,
        response: formResponses,
        shareTokenName: shareTokens.name,
        respondentEmail: user.email
      })
      .from(formResponses)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponses.shareTokenId))
      .leftJoin(user, eq(user.id, formResponses.respondentUserId))
      .where(
        and(
          eq(formResponses.id, responseId),
          eq(formResponses.presentationId, presentationId),
          eq(formResponses.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** Per-deck owner listing, newest first, keyset-paginated, filterable. */
  async list(
    workspaceId: string,
    presentationId: string,
    opts: FormResponseFilters & { cursor?: string | undefined; limit: number }
  ): Promise<{ responses: FormResponseListed[]; nextCursor: string | null }> {
    const cursorId = cursorRowId(opts.cursor);
    const rows = await this.db
      .select({
        id: formResponses.id,
        response: formResponses,
        shareTokenName: shareTokens.name,
        respondentEmail: user.email
      })
      .from(formResponses)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponses.shareTokenId))
      .leftJoin(user, eq(user.id, formResponses.respondentUserId))
      .where(
        and(
          eq(formResponses.presentationId, presentationId),
          eq(formResponses.workspaceId, workspaceId),
          ...(opts.form !== undefined ? [eq(formResponses.formName, opts.form)] : []),
          ...(opts.token !== undefined ? [eq(formResponses.shareTokenId, opts.token)] : []),
          ...(opts.source !== undefined ? [eq(formResponses.source, opts.source)] : []),
          ...(opts.placement !== undefined ? [eq(formResponses.placement, opts.placement)] : []),
          ...(opts.since !== undefined ? [gte(formResponses.createdAt, opts.since)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: formResponses,
                  id: formResponses.id,
                  createdAt: formResponses.createdAt,
                  // Scope the cursor subquery to THIS deck (the annotations
                  // precedent): a foreign deck's cursor cannot position here.
                  workspaceId: formResponses.presentationId,
                  cursorId,
                  workspace: presentationId
                })
              ]
            : [])
        )
      )
      .orderBy(desc(formResponses.createdAt), desc(formResponses.id))
      .limit(opts.limit + 1);
    const { page, nextCursor } = pageOf(rows, opts.limit);
    return { responses: page, nextCursor };
  }

  /**
   * Grouped counts per form × link × source × placement — the one-call
   * "what came in, from where" overview. Bounded by the per-deck response
   * cap, so the aggregation never scans more than the cap allows.
   */
  async summary(
    workspaceId: string,
    presentationId: string
  ): Promise<{ buckets: FormResponseSummaryBucket[]; total: number }> {
    const rows = await this.db
      .select({
        formName: formResponses.formName,
        shareTokenId: formResponses.shareTokenId,
        shareTokenName: shareTokens.name,
        source: formResponses.source,
        placement: formResponses.placement,
        count: count(),
        lastResponseAt: max(formResponses.createdAt)
      })
      .from(formResponses)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponses.shareTokenId))
      .where(
        and(eq(formResponses.presentationId, presentationId), eq(formResponses.workspaceId, workspaceId))
      )
      .groupBy(
        formResponses.formName,
        formResponses.shareTokenId,
        shareTokens.name,
        formResponses.source,
        formResponses.placement
      )
      .orderBy(formResponses.formName, desc(count()), desc(max(formResponses.createdAt)));
    const buckets = rows.map((r) => ({
      formName: r.formName,
      shareTokenId: r.shareTokenId,
      shareTokenName: r.shareTokenName,
      source: r.source,
      placement: r.placement,
      count: r.count,
      // max() over a non-empty group is never null; the fallback keeps types honest.
      lastResponseAt: r.lastResponseAt ?? new Date(0)
    }));
    const total = buckets.reduce((sum, b) => sum + b.count, 0);
    return { buckets, total };
  }

  /** Hard delete (owner moderation); returns the final snapshot (null = gone). */
  async delete(responseId: string): Promise<FormResponseRow | null> {
    const [row] = await this.db.delete(formResponses).where(eq(formResponses.id, responseId)).returning();
    return row ?? null;
  }

  /** Account email for the leg-3 auto-mailed edit link; null when the user is gone. */
  async userEmail(userId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    return row?.email ?? null;
  }
}

/**
 * Wire mapping for the authenticated owner surface (the contract shape).
 *
 * ⚠️ RAW CONTENT — every `payload` key and value is stored and returned
 * EXACTLY as the anonymous respondent supplied it: no HTML escaping or
 * sanitization happens server-side. Any consumer that renders payload
 * fields into markup (the dashboard first of all) MUST HTML-escape them,
 * and CSV exports must guard formula injection, or a response becomes a
 * stored-XSS / formula vector against deck owners.
 */
export function formResponseToWire(r: FormResponseListed): {
  id: string;
  presentationId: string;
  version: number;
  formName: string;
  shareTokenId: string | null;
  shareTokenName: string | null;
  source: FormResponseSource;
  placement: string | null;
  respondentUserId: string | null;
  respondentEmail: string | null;
  payload: Record<string, string | string[]>;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: r.response.id,
    presentationId: r.response.presentationId,
    version: r.response.version,
    formName: r.response.formName,
    shareTokenId: r.response.shareTokenId,
    shareTokenName: r.shareTokenName,
    source: r.response.source,
    placement: r.response.placement,
    respondentUserId: r.response.respondentUserId,
    respondentEmail: r.respondentEmail,
    payload: r.response.payload,
    createdAt: r.response.createdAt.toISOString(),
    updatedAt: r.response.updatedAt.toISOString()
  };
}

/**
 * Wire mapping for the PUBLIC token session (viewer/forms-api.ts): a
 * deliberate subset — never share_token_id, respondent_user_id, workspace
 * or presentation ids. The respondent sees only what they themselves
 * supplied (plus their row's identity-free envelope).
 *
 * ⚠️ RAW CONTENT — same warning as formResponseToWire above.
 */
export function formResponseToRespondentWire(r: FormResponseRow): {
  id: string;
  formName: string;
  version: number;
  payload: Record<string, string | string[]>;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: r.id,
    formName: r.formName,
    version: r.version,
    payload: r.payload,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString()
  };
}

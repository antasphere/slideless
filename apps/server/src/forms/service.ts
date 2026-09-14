import { createHash, randomBytes } from 'node:crypto';
import { and, asc, count, desc, eq, gte, inArray, lt, max, sql } from 'drizzle-orm';
import {
  formResponseMailState,
  formResponseVersions,
  formResponses,
  shareTokens,
  type Db,
  type FormResponseRow,
  type FormResponseSource,
  type FormResponseVersionRow,
  type ShareTokenRow
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

/**
 * Retention of a response's history (PRDCT-2329): at most this many
 * revisions per response. Past it the OLDEST revisions after the first are
 * pruned, so revision 1 (what was first said) and the latest 99 always
 * survive. A cap on edits instead would punish the respondent for the
 * owner's retention; no cap at all is the silent unbounded growth the
 * ticket forbids (682 B realistic, 33 KB worst case per row).
 */
export const FORM_RESPONSE_MAX_REVISIONS = 100;

/**
 * Whether a share link REMEMBERS its answers (PRDCT-2328): the switch, on a
 * live 'share' token that allows forms. Preview tokens are refused here by
 * PURPOSE, whatever their column says — an owner's own preview must never
 * create or resolve a remembered row (ADR 022 decision 6's posture). The
 * injector uses the same rule for the one boolean it hands the document.
 */
export function linkRemembers(
  token: Pick<ShareTokenRow, 'remembersResponses' | 'purpose' | 'canSubmitForms'>
): boolean {
  return token.remembersResponses && token.purpose === 'share' && token.canSubmitForms;
}

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
  payload: FormResponsePayload;
  /**
   * The link's ONE remembered row for this form (PRDCT-2328). Only the
   * remembering create path sets it; the partial unique index refuses a
   * second one per (link, form).
   */
  remembered?: boolean;
}

/**
 * Attribution re-stamped on an update (PRDCT-1332): an edited row used to
 * keep the CREATOR's link, source, placement and version forever, so every
 * edit through a different link silently mis-attributed itself.
 */
export interface FormResponseAttribution {
  version: number;
  shareTokenId: string;
  source?: FormResponseSource;
  placement: string | null;
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
}

/** One revision with its link's label joined (PRDCT-2329). */
export interface FormResponseVersionListed {
  version: FormResponseVersionRow;
  shareTokenName: string | null;
}

/**
 * The owner-mail cooldown verdict (PRDCT-2330): send now, carrying what was
 * held back since the previous mail, or hold (counted for the next one).
 */
export type OwnerMailClaim = { send: true; pendingNew: number; pendingEdited: number } | { send: false };

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
    const row = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(formResponses)
        .values({
          workspaceId: opts.workspaceId,
          presentationId: opts.presentationId,
          version: opts.version,
          formName: opts.formName,
          shareTokenId: opts.shareTokenId,
          source: opts.source,
          placement: opts.placement,
          responseSecretHash: hashSecret(editSecret, pepper),
          payload: opts.payload,
          remembered: opts.remembered === true,
          revision: 1
        })
        .returning();
      if (!inserted) throw new Error('form response insert failed');
      // Revision 1 is the create (PRDCT-2329): the history starts with what
      // was first said, in the same transaction as the row.
      await tx.insert(formResponseVersions).values({
        responseId: inserted.id,
        revision: 1,
        version: inserted.version,
        shareTokenId: inserted.shareTokenId,
        source: inserted.source,
        placement: inserted.placement,
        payload: inserted.payload,
        createdAt: inserted.createdAt
      });
      return inserted;
    });
    return { row, editSecret };
  }

  /**
   * The link's remembered row for one form (PRDCT-2328), or null. Keyed by
   * the partial unique index, never by "the latest row on the link": embed
   * submissions and fragment-secret rows on the same link are never
   * remembered and never resolve here.
   */
  async findRemembered(shareTokenId: string, formName: string): Promise<FormResponseRow | null> {
    const [row] = await this.db
      .select()
      .from(formResponses)
      .where(
        and(
          eq(formResponses.shareTokenId, shareTokenId),
          eq(formResponses.formName, formName),
          eq(formResponses.remembered, true)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /** Every remembered row of a link, one per form — the runtime's one probe per page load. */
  async listRemembered(shareTokenId: string): Promise<FormResponseRow[]> {
    return this.db
      .select()
      .from(formResponses)
      .where(and(eq(formResponses.shareTokenId, shareTokenId), eq(formResponses.remembered, true)))
      .orderBy(asc(formResponses.formName));
  }

  /**
   * Submit through a remembering link (PRDCT-2328): update the link's
   * remembered row for this form, or create it as remembered. Two tabs
   * submitting the first answer at once race into the partial unique
   * index; the loser re-reads the winner's row and updates it, so the link
   * never ends up with two remembered rows and no submit is lost.
   */
  async upsertRemembered(
    opts: FormResponseCreate
  ): Promise<{ row: FormResponseRow; created: boolean; editSecret: string | null }> {
    const existing = await this.findRemembered(opts.shareTokenId, opts.formName);
    if (existing) {
      const updated = await this.updatePayload(existing.id, opts.payload, {
        version: opts.version,
        shareTokenId: opts.shareTokenId,
        source: opts.source,
        placement: opts.placement
      });
      return { row: updated ?? existing, created: false, editSecret: null };
    }
    try {
      const { row, editSecret } = await this.create({ ...opts, remembered: true });
      return { row, created: true, editSecret };
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const winner = await this.findRemembered(opts.shareTokenId, opts.formName);
      if (!winner) throw e;
      const updated = await this.updatePayload(winner.id, opts.payload, {
        version: opts.version,
        shareTokenId: opts.shareTokenId,
        source: opts.source,
        placement: opts.placement
      });
      return { row: updated ?? winner, created: false, editSecret: null };
    }
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

  /**
   * Replace the payload (the respondent's one evolving answer) and re-stamp
   * the attribution of the navigation that made the edit.
   */
  async updatePayload(
    responseId: string,
    payload: FormResponsePayload,
    attribution: FormResponseAttribution
  ): Promise<FormResponseRow | null> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(formResponses)
        .set({
          payload,
          version: attribution.version,
          shareTokenId: attribution.shareTokenId,
          ...(attribution.source !== undefined ? { source: attribution.source } : {}),
          placement: attribution.placement,
          // PRDCT-2329: every edit is a new revision, never an overwrite of
          // the history — the row is the latest state, the versions table
          // keeps what it replaced.
          revision: sql`${formResponses.revision} + 1`,
          updatedAt: new Date()
        })
        .where(eq(formResponses.id, responseId))
        .returning();
      if (!row) return null;
      await tx.insert(formResponseVersions).values({
        responseId: row.id,
        revision: row.revision,
        version: row.version,
        shareTokenId: row.shareTokenId,
        source: row.source,
        placement: row.placement,
        payload: row.payload,
        createdAt: row.updatedAt
      });
      // Retention: keep revision 1 and the latest FORM_RESPONSE_MAX_REVISIONS-1.
      if (row.revision > FORM_RESPONSE_MAX_REVISIONS) {
        const floor = row.revision - FORM_RESPONSE_MAX_REVISIONS + 2;
        await tx
          .delete(formResponseVersions)
          .where(
            and(
              eq(formResponseVersions.responseId, row.id),
              lt(formResponseVersions.revision, floor),
              sql`${formResponseVersions.revision} > 1`
            )
          );
      }
      return row;
    });
  }

  /** The owner's history read (PRDCT-2329): every kept revision, newest first, the link label joined. */
  async versions(responseId: string): Promise<FormResponseVersionListed[]> {
    return this.db
      .select({ version: formResponseVersions, shareTokenName: shareTokens.name })
      .from(formResponseVersions)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponseVersions.shareTokenId))
      .where(eq(formResponseVersions.responseId, responseId))
      .orderBy(desc(formResponseVersions.revision));
  }

  /**
   * The owner-mail cooldown (PRDCT-2330), one row per deck: the first event
   * after a quiet window mails now and carries what was held back since the
   * previous mail; an event inside the window is counted and held. Under a
   * row lock so two concurrent submits cannot both claim the send.
   */
  async claimOwnerMail(
    presentationId: string,
    kind: 'new' | 'edited',
    windowMs: number,
    now: Date = new Date()
  ): Promise<OwnerMailClaim> {
    return this.db.transaction(async (tx) => {
      const [state] = await tx
        .select()
        .from(formResponseMailState)
        .where(eq(formResponseMailState.presentationId, presentationId))
        .for('update')
        .limit(1);
      if (!state) {
        await tx
          .insert(formResponseMailState)
          .values({ presentationId, lastSentAt: now, pendingNew: 0, pendingEdited: 0 })
          .onConflictDoNothing();
        return { send: true, pendingNew: 0, pendingEdited: 0 };
      }
      if (state.lastSentAt.getTime() + windowMs <= now.getTime()) {
        await tx
          .update(formResponseMailState)
          .set({ lastSentAt: now, pendingNew: 0, pendingEdited: 0 })
          .where(eq(formResponseMailState.presentationId, presentationId));
        return { send: true, pendingNew: state.pendingNew, pendingEdited: state.pendingEdited };
      }
      await tx
        .update(formResponseMailState)
        .set(
          kind === 'new'
            ? { pendingNew: sql`${formResponseMailState.pendingNew} + 1` }
            : { pendingEdited: sql`${formResponseMailState.pendingEdited} + 1` }
        )
        .where(eq(formResponseMailState.presentationId, presentationId));
      return { send: false };
    });
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
        shareTokenName: shareTokens.name
      })
      .from(formResponses)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponses.shareTokenId))
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
        shareTokenName: shareTokens.name
      })
      .from(formResponses)
      .leftJoin(shareTokens, eq(shareTokens.id, formResponses.shareTokenId))
      .where(
        and(
          eq(formResponses.presentationId, presentationId),
          eq(formResponses.workspaceId, workspaceId),
          ...(opts.form !== undefined ? [eq(formResponses.formName, opts.form)] : []),
          ...(opts.token !== undefined ? [eq(formResponses.shareTokenId, opts.token)] : []),
          ...(opts.source !== undefined ? [eq(formResponses.source, opts.source)] : []),
          ...(opts.placement !== undefined ? [eq(formResponses.placement, opts.placement)] : []),
          // Activity, not creation (PRDCT-2329, from PRDCT-1339 §1): an
          // edited response has updated_at >= created_at, so "since" reads
          // "created or edited at or after" and an edit resurfaces.
          ...(opts.since !== undefined ? [gte(formResponses.updatedAt, opts.since)] : []),
          ...(cursorId
            ? [
                keysetBefore({
                  table: formResponses,
                  id: formResponses.id,
                  // Last activity is the listing's order (the pager compares
                  // whichever column it is handed).
                  createdAt: formResponses.updatedAt,
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
      .orderBy(desc(formResponses.updatedAt), desc(formResponses.id))
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
        // The bucket's LAST ACTIVITY: updated_at is never older than
        // created_at, so its max is greatest(max(created), max(updated)).
        lastResponseAt: max(formResponses.updatedAt)
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
      .orderBy(formResponses.formName, desc(count()), desc(max(formResponses.updatedAt)));
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
  payload: Record<string, string | string[]>;
  revision: number;
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
    payload: r.response.payload,
    revision: r.response.revision,
    createdAt: r.response.createdAt.toISOString(),
    updatedAt: r.response.updatedAt.toISOString()
  };
}

/** Wire mapping of one revision for the OWNER surface (PRDCT-2329). Same RAW CONTENT warning. */
export function formResponseVersionToWire(v: FormResponseVersionListed): {
  revision: number;
  version: number;
  shareTokenId: string | null;
  shareTokenName: string | null;
  source: FormResponseSource;
  placement: string | null;
  payload: Record<string, string | string[]>;
  createdAt: string;
} {
  return {
    revision: v.version.revision,
    version: v.version.version,
    shareTokenId: v.version.shareTokenId,
    shareTokenName: v.shareTokenName,
    source: v.version.source,
    placement: v.version.placement,
    payload: v.version.payload,
    createdAt: v.version.createdAt.toISOString()
  };
}

/**
 * Postgres 23505 on the partial unique index — the remembering create race.
 * Drizzle wraps the driver error (DrizzleQueryError → cause), so the code
 * is read down the cause chain, never on the top error alone.
 */
function isUniqueViolation(e: unknown): boolean {
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && typeof cur === 'object' && cur !== null; depth++) {
    if ((cur as { code?: unknown }).code === '23505') return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

/**
 * Wire mapping for the PUBLIC token session (viewer/forms-api.ts): a
 * deliberate subset — never share_token_id, respondent_user_id, workspace
 * or presentation ids, and NEVER the revision number or the history
 * (PRDCT-2329: the respondent sees only the latest; the owner sees the
 * versions). The respondent sees only what they themselves supplied (plus
 * their row's identity-free envelope).
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

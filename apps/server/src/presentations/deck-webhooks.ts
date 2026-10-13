import type { Db, DbConn } from '@antasphere/chassis-db';
import type { WebhookEmitter } from '@antasphere/chassis-server';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { ShareTokenRow } from '@slideless/db';
import { projectIdsOf } from './projects.js';

/**
 * The deck's webhook events (PRDCT-3483), said the one way: every event of
 * the catalog (`@slideless/contract`, `DECK_WEBHOOK_EVENTS`) carries the
 * `deck` subject and the `project` subject (the deck's CURRENT project ids,
 * read on the write's own connection), and the events that declare `link`
 * carry the share link's id, or an empty list when the act had no link (a
 * member's own annotation, a form response whose link was deleted since).
 *
 * `emitDeckEvent` runs on the connection it is handed: a service passes the
 * transaction of the write the event reports, so the event is durable with
 * the write and never exists for a rolled-back one. The chassis emitter
 * judges the data against the catalog's schema and never throws for it.
 */
export interface DeckEventEmit {
  workspaceId: string;
  type: string;
  deckId: string;
  /** The share link the act went through; null or absent = none (the `link` subject is then `[]`). */
  linkId?: string | null | undefined;
  /** Projects named beside the current ones (the project a deck was just taken out of). */
  alsoProjectIds?: readonly string[] | undefined;
  data: Record<string, unknown>;
}

export async function emitDeckEvent(
  webhooks: WebhookEmitter,
  conn: DbConn,
  event: DeckEventEmit
): Promise<string | null> {
  const current = await projectIdsOf(conn, event.deckId);
  const project = event.alsoProjectIds ? [...new Set([...current, ...event.alsoProjectIds])] : current;
  return webhooks.emit(conn, {
    workspaceId: event.workspaceId,
    type: event.type,
    subjects: { deck: event.deckId, project, link: event.linkId ?? [] },
    data: event.data
  });
}

/** The facts every `share_link.*` event carries (the contract's `shareLinkFacts`). */
export function shareLinkFacts(token: ShareTokenRow): {
  deckId: string;
  linkId: string;
  name: string;
  purpose: string;
  pinnedVersion: number | null;
  expiresAt: string | null;
  hasPassword: boolean;
} {
  return {
    deckId: token.presentationId,
    linkId: token.id,
    name: token.name,
    purpose: token.purpose,
    pinnedVersion: token.pinnedVersion,
    expiresAt: token.expiresAt?.toISOString() ?? null,
    hasPassword: token.passwordHash !== null
  };
}

/**
 * The deck events whose write this tool does not run in a transaction it
 * can reach: the share links (`sharing/service.ts` runs its own statements
 * on its own handle) and the attachment downloads (the download record
 * swallows its own failure). Emitted on the `db` handle right AFTER the
 * write, so the event can be lost with a crash between the two, never sent
 * for a write that did not land; a failure is logged and never turns the
 * act into an error (the write already happened).
 */
export class DeckWebhooks {
  constructor(
    private readonly db: Db,
    private readonly webhooks: WebhookEmitter,
    private readonly logger: Logger
  ) {}

  async emitAfterWrite(event: DeckEventEmit): Promise<void> {
    try {
      await emitDeckEvent(this.webhooks, this.db, event);
    } catch (err) {
      this.logger.error(
        { err, type: event.type, deckId: event.deckId },
        'webhooks: a deck event emit failed'
      );
    }
  }

  /**
   * A `share_link.*` event INSIDE the write's transaction (the share-token
   * service's write hook): the event is durable with the mint, the change,
   * the revoke or the send it reports. A dashboard preview link never emits.
   */
  async shareLinkIn(
    tx: DbConn,
    type: 'share_link.created' | 'share_link.updated' | 'share_link.revoked' | 'share_link.sent',
    token: ShareTokenRow,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    if (token.purpose === 'preview') return;
    await emitDeckEvent(this.webhooks, tx, {
      workspaceId: token.workspaceId,
      type,
      deckId: token.presentationId,
      linkId: token.id,
      data: { ...shareLinkFacts(token), ...extra }
    });
  }

  /** A `share_link.*` event after a write the service made on its own handle; a dashboard preview link never emits. */
  async shareLink(
    type: 'share_link.created' | 'share_link.updated' | 'share_link.revoked' | 'share_link.sent',
    token: ShareTokenRow,
    extra: Record<string, unknown> = {}
  ): Promise<void> {
    if (token.purpose === 'preview') return;
    await this.emitAfterWrite({
      workspaceId: token.workspaceId,
      type,
      deckId: token.presentationId,
      linkId: token.id,
      data: { ...shareLinkFacts(token), ...extra }
    });
  }
}

import { eq } from 'drizzle-orm';
import { presentations, user, type Db, type FormResponseRow } from '@slideless/db';
import { deckMasterUrl } from '@slideless/contract';
import type { Logger } from '../logger.js';
import type { Env } from '../env.js';
import type { EmailDriver } from '../email/driver.js';
import { buildFormResponseEditedEmail, buildFormResponseEmail } from '../email/templates.js';
import type { FormResponseService } from './service.js';

/**
 * Owner notifications for form responses (PRDCT-2330): a mail to the DECK
 * OWNER when a response arrives, a different one when a response is
 * edited. Posture, in order:
 *
 *  - never blocks a submit: `fire()` is fire-and-forget, a failure is a
 *    log line and the respondent's 201/200 has already gone out;
 *  - the `none` driver does nothing (nothing is even looked up);
 *  - the per-deck switch (`presentations.notify_on_response`) is read at
 *    send time, so flipping it off silences the next event;
 *  - the recipient is the owner's account address, re-read from the user
 *    row by id — never a stored copy; a deck whose owner is gone mails
 *    nobody;
 *  - one mail per deck per COOLDOWN window: events inside the window are
 *    counted (forms/service.ts claimOwnerMail) and the next mail after
 *    the window carries the counts, so a burst of 500 RSVPs is one mail
 *    now and one later saying "499 other new responses arrived";
 *  - the mail carries the deck, the form, the link's label, the moment and
 *    a button to the deck's page — NEVER the answers.
 *
 * Nothing here touches the viewer's trust boundary: the notifier runs
 * server-side after the write, reads owner-side rows only, and the
 * respondent learns nothing about it.
 */

/** One mail per deck per this window (the burst posture). */
export const FORM_OWNER_MAIL_COOLDOWN_MS = 10 * 60 * 1000;

export interface FormResponseEvent {
  kind: 'new' | 'edited';
  row: FormResponseRow;
  /** The link's owner-facing label at the time of the write (null once the link is gone). */
  shareTokenName: string | null;
}

export interface FormResponseNotifierDeps {
  db: Db;
  forms: FormResponseService;
  email: EmailDriver;
  env: Pick<Env, 'PUBLIC_BASE_URL'>;
  logger: Logger;
  /** Test seam: shrink the cooldown; production runs the fixed default. */
  cooldownMs?: number | undefined;
}

export class FormResponseNotifier {
  private readonly cooldownMs: number;
  /** In-flight sends, so a test (or a graceful stop) can await them. */
  private readonly inflight = new Set<Promise<boolean>>();

  constructor(private readonly deps: FormResponseNotifierDeps) {
    this.cooldownMs = deps.cooldownMs ?? FORM_OWNER_MAIL_COOLDOWN_MS;
  }

  /** Fire-and-forget: the caller never waits, a failure never surfaces to the respondent. */
  fire(event: FormResponseEvent): void {
    const p = this.notify(event).catch((e: unknown) => {
      this.deps.logger.error(
        { err: e, presentationId: event.row.presentationId, responseId: event.row.id, kind: event.kind },
        'form response owner notification failed'
      );
      return false;
    });
    this.inflight.add(p);
    void p.finally(() => this.inflight.delete(p));
  }

  /** Await every in-flight send (tests; shutdown). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** True when a mail went out for this event. */
  async notify(event: FormResponseEvent): Promise<boolean> {
    const { db, email, env, logger } = this.deps;
    if (!email.delivers) return false;
    const [deck] = await db
      .select({
        id: presentations.id,
        title: presentations.title,
        ownerUserId: presentations.ownerUserId,
        notifyOnResponse: presentations.notifyOnResponse,
        deletedAt: presentations.deletedAt
      })
      .from(presentations)
      .where(eq(presentations.id, event.row.presentationId))
      .limit(1);
    if (!deck || deck.deletedAt !== null || !deck.notifyOnResponse || deck.ownerUserId === null) return false;
    const [owner] = await db
      .select({ email: user.email })
      .from(user)
      .where(eq(user.id, deck.ownerUserId))
      .limit(1);
    if (!owner) return false;

    const claim = await this.deps.forms.claimOwnerMail(deck.id, event.kind, this.cooldownMs);
    if (!claim.send) {
      logger.debug({ presentationId: deck.id, kind: event.kind }, 'form response owner mail held (cooldown)');
      return false;
    }

    const params = {
      presentationTitle: deck.title,
      formName: event.row.formName,
      shareTokenName: event.shareTokenName,
      at: event.kind === 'edited' ? event.row.updatedAt : event.row.createdAt,
      deckUrl: deckMasterUrl(env.PUBLIC_BASE_URL, deck.id),
      pendingNew: claim.pendingNew,
      pendingEdited: claim.pendingEdited
    };
    const mail =
      event.kind === 'edited'
        ? buildFormResponseEditedEmail({ ...params, revision: event.row.revision })
        : buildFormResponseEmail(params);
    await email.send({ to: owner.email, ...mail });
    logger.info(
      { presentationId: deck.id, responseId: event.row.id, kind: event.kind },
      'form response owner mail sent'
    );
    return true;
  }
}

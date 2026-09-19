import { PRODUCT_NAME, esc, shell } from '@antasphere/chassis-server/email';

/**
 * The deck domain's transactional mails: share link, collaborator invite and
 * the three form-response mails. Same convention as the chassis builders
 * (env-free, every value a parameter); the HTML shell and the escaper are the
 * chassis ones.
 */

export interface ShareEmailParams {
  /** Display name of the sharer (the deck owner/admin who hit send). */
  senderName: string;
  /** Deck title — escaped before it reaches the HTML. */
  presentationTitle: string;
  /** The per-recipient viewer URL (carries the token secret). */
  viewerUrl: string;
  /** Optional personal note from the sender. */
  message?: string | undefined;
  /** Link expiry, when the token has one. */
  expiresAt?: Date | undefined;
  /** Tell the recipient a password is required (sent out of band). */
  hasPassword: boolean;
}

/**
 * Share-a-presentation email (Phase 4). English only for now — template
 * i18n is a noted follow-up (the platform's email builders are all
 * single-language today; localize them together).
 */
export function buildShareEmail(p: ShareEmailParams): { subject: string; html: string; text: string } {
  const subject = `${p.senderName} shared "${p.presentationTitle}" with you`;
  const note = p.message
    ? `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6;border-left:3px solid #e4e4e7;padding-left:12px">${esc(p.message)}</p>`
    : '';
  const passwordNote = p.hasPassword
    ? `<p style="margin:0 0 16px;color:#3f3f46;font-size:13px">This link is password protected — ${esc(p.senderName)} will give you the password separately.</p>`
    : '';
  const expiryNote = p.expiresAt ? ` This link expires on ${p.expiresAt.toUTCString()}.` : '';
  const html = shell(
    `${esc(p.senderName)} shared a presentation`,
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       ${esc(p.senderName)} shared <strong>${esc(p.presentationTitle)}</strong> with you on ${PRODUCT_NAME}.</p>
     ${note}${passwordNote}
     <p style="margin:0 0 24px">
       <a href="${p.viewerUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Open presentation</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link is personal to you.${expiryNote} If the button does not work, open:<br>
       <span style="word-break:break-all">${p.viewerUrl}</span></p>`
  );
  const text =
    `${p.senderName} shared "${p.presentationTitle}" with you on ${PRODUCT_NAME}.\n\n` +
    (p.message ? `${p.message}\n\n` : '') +
    (p.hasPassword
      ? `This link is password protected — the sender will give you the password separately.\n\n`
      : '') +
    `Open it: ${p.viewerUrl}\n\nThis link is personal to you.${expiryNote}`;
  return { subject, html, text };
}

export interface CollaboratorInviteEmailParams {
  inviteeEmail: string;
  inviterName: string;
  presentationTitle: string;
  claimUrl: string;
  expiresAt: Date;
}

/**
 * Per-deck collaborator invite (Phase 5). The claim URL in this mail carries
 * the EMAIL-ONLY token (the inviter never sees it — ADR 009 honesty), so a
 * claim through it proves mailbox control.
 */
export function buildCollaboratorInviteEmail(p: CollaboratorInviteEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `${p.inviterName} invited you to collaborate on "${p.presentationTitle}"`;
  const html = shell(
    `Collaborate on ${esc(p.presentationTitle)}`,
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       ${esc(p.inviterName)} invited you (${esc(p.inviteeEmail)}) to collaborate on
       <strong>${esc(p.presentationTitle)}</strong> on ${PRODUCT_NAME} — you will be able to
       push new versions and manage its share links.</p>
     <p style="margin:0 0 24px">
       <a href="${p.claimUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Accept and start collaborating</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This invite expires on ${p.expiresAt.toUTCString()}. If the button does not work, open:<br>
       <span style="word-break:break-all">${p.claimUrl}</span></p>`
  );
  const text = `${p.inviterName} invited you to collaborate on "${p.presentationTitle}" on ${PRODUCT_NAME}.\n\nAccept: ${p.claimUrl}\n\nExpires ${p.expiresAt.toUTCString()}.`;
  return { subject, html, text };
}

export interface FormResponseNoticeParams {
  /** Deck title — owner text, escaped before it reaches the HTML. */
  presentationTitle: string;
  /** The form's `data-slideless-form` name (owner-slug charset, escaped anyway). */
  formName: string;
  /** The share link's owner-facing label, or null when the link is gone. Owner text, escaped. */
  shareTokenName: string | null;
  /** When the response landed / the edit was made. */
  at: Date;
  /** The deck's own page on the app origin (the responses live there). */
  deckUrl: string;
  /**
   * Activity the owner was NOT mailed about, because it fell inside the
   * per-deck cooldown window since the previous mail (PRDCT-2330): counted
   * and carried by this mail so nothing goes unsaid. Zero when this mail
   * is the first in a while.
   */
  pendingNew: number;
  pendingEdited: number;
}

/** The "since the last mail" sentence, or '' when nothing was held back. */
function pendingSentence(p: FormResponseNoticeParams): string {
  const parts: string[] = [];
  if (p.pendingNew > 0) parts.push(`${p.pendingNew} other new response${p.pendingNew === 1 ? '' : 's'}`);
  if (p.pendingEdited > 0) parts.push(`${p.pendingEdited} other edit${p.pendingEdited === 1 ? '' : 's'}`);
  return parts.length === 0 ? '' : ` Since the previous mail, ${parts.join(' and ')} arrived too.`;
}

function responseNoticeMeta(p: FormResponseNoticeParams): string {
  const link = p.shareTokenName === null ? 'a link since deleted' : `the link "${esc(p.shareTokenName)}"`;
  return `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       Deck: <strong>${esc(p.presentationTitle)}</strong><br>
       Form: <strong>${esc(p.formName)}</strong><br>
       Through: ${link}<br>
       When: ${p.at.toUTCString()}</p>`;
}

/**
 * To the DECK OWNER: a new form response arrived (PRDCT-2330). Carries the
 * deck, the form, the link and the moment — NEVER the answers themselves:
 * a respondent's text is third-party data that does not belong in an inbox
 * (PRDCT-1337's data-protection thread); the owner reads it in the product.
 */
export function buildFormResponseEmail(p: FormResponseNoticeParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `New response on "${p.presentationTitle}"`;
  const html = shell(
    'A new response arrived',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       Someone answered the <strong>${esc(p.formName)}</strong> form of your ${PRODUCT_NAME} deck.${esc(pendingSentence(p))}</p>
     ${responseNoticeMeta(p)}
     <p style="margin:0 0 24px">
       <a href="${p.deckUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Open the responses</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       The answers stay in ${PRODUCT_NAME}; this mail never carries them. Switch these mails off per deck from the responses panel.<br>
       <span style="word-break:break-all">${p.deckUrl}</span></p>`
  );
  const text =
    `A new response arrived on "${p.presentationTitle}" (form "${p.formName}", through ${p.shareTokenName === null ? 'a link since deleted' : `the link "${p.shareTokenName}"`}) at ${p.at.toUTCString()}.${pendingSentence(p)}\n\n` +
    `Open the responses: ${p.deckUrl}\n\nThe answers stay in ${PRODUCT_NAME}; this mail never carries them.`;
  return { subject, html, text };
}

export interface FormResponseEditedParams extends FormResponseNoticeParams {
  /** The revision number the edit produced (2 for the first edit). */
  revision: number;
}

/**
 * To the DECK OWNER: an EXISTING response was edited (PRDCT-2330) — a
 * different mail from the new-response one, because "an answer changed" is
 * a different signal from "an answer arrived". Same rule: never the answers.
 */
export function buildFormResponseEditedEmail(p: FormResponseEditedParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `A response on "${p.presentationTitle}" was edited`;
  const html = shell(
    'An existing response was edited',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       An answer already given on the <strong>${esc(p.formName)}</strong> form of your ${PRODUCT_NAME} deck
       was changed — this is revision ${p.revision} of that response. The earlier revisions are kept;
       the responses panel shows the history.${esc(pendingSentence(p))}</p>
     ${responseNoticeMeta(p)}
     <p style="margin:0 0 24px">
       <a href="${p.deckUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Open the responses</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       The answers stay in ${PRODUCT_NAME}; this mail never carries them. Switch these mails off per deck from the responses panel.<br>
       <span style="word-break:break-all">${p.deckUrl}</span></p>`
  );
  const text =
    `A response on "${p.presentationTitle}" (form "${p.formName}", through ${p.shareTokenName === null ? 'a link since deleted' : `the link "${p.shareTokenName}"`}) was edited at ${p.at.toUTCString()} — revision ${p.revision}; earlier revisions are kept.${pendingSentence(p)}\n\n` +
    `Open the responses: ${p.deckUrl}\n\nThe answers stay in ${PRODUCT_NAME}; this mail never carries them.`;
  return { subject, html, text };
}

export interface ResponseLinkEmailParams {
  /** The respondent's personal edit link (share URL + fragment secret). */
  editUrl: string;
}

/**
 * The form-response edit link (ADR 022): mailed on the respondent's explicit
 * opt-in, or automatically to a recognized signed-in respondent's account
 * address. Carries ONLY the recipient's own capability URL — whoever holds
 * it can view and update exactly that one response.
 */
export function buildResponseLinkEmail(p: ResponseLinkEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Your ${PRODUCT_NAME} form response`;
  const html = shell(
    'Your response was recorded',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       Keep this personal link to view or update your answer later — anyone
       who has it can edit this one response, so treat it like a password.</p>
     <p style="margin:0 0 24px">
       <a href="${p.editUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         View or update my response</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       If the button does not work, open:<br>
       <span style="word-break:break-all">${p.editUrl}</span></p>`
  );
  const text = `Your ${PRODUCT_NAME} form response was recorded.\n\nView or update it: ${p.editUrl}\n\nAnyone holding this link can edit this one response — treat it like a password.`;
  return { subject, html, text };
}

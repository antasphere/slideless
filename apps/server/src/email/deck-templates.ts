/**
 * The deck domain's transactional mails: share link, collaborator invite and
 * the three form-response mails. Same convention as the chassis builders
 * (env-free, every value a parameter, `pnpm preview:emails` renders them
 * standalone); the layout and the blocks are the chassis's shell, so these
 * mails and the account mails are one family. This file holds what they SAY.
 */
import {
  button,
  esc,
  facts,
  fine,
  fmtDate,
  makeShell,
  para,
  quote,
  spelledLink
} from '@antasphere/chassis-server/email';
import { MAIL_BRAND } from './brand.js';

const PRODUCT_NAME = MAIL_BRAND.name;
const shell = makeShell(MAIL_BRAND);

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
  const expiry = p.expiresAt ? ` It stays open until ${fmtDate(p.expiresAt)}.` : '';
  const html = shell({
    preheader: p.message ?? `Open "${p.presentationTitle}" in your browser. Nothing to install.`,
    eyebrow: 'A deck for you',
    title: esc(p.presentationTitle),
    body:
      para(
        `<strong>${esc(p.senderName)}</strong> shared this presentation with you. It opens in your browser, nothing to install.`
      ) +
      (p.message ? quote(esc(p.message)) : '') +
      button(p.viewerUrl, 'Open the presentation') +
      (p.hasPassword
        ? fine(`The link asks for a password. ${esc(p.senderName)} will give it to you separately.`)
        : '') +
      fine(`This link was made for you alone, so keep it to yourself.${expiry}`) +
      spelledLink(p.viewerUrl)
  });
  const text =
    `${p.senderName} shared "${p.presentationTitle}" with you on ${PRODUCT_NAME}.\n\n` +
    (p.message ? `"${p.message}"\n\n` : '') +
    `Open the presentation: ${p.viewerUrl}\n\n` +
    (p.hasPassword
      ? `The link asks for a password. ${p.senderName} will give it to you separately.\n\n`
      : '') +
    `This link was made for you alone, so keep it to yourself.${expiry}`;
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
  const html = shell({
    preheader: `Work on "${p.presentationTitle}" together: publish new versions, manage who sees it.`,
    eyebrow: 'Work on a deck together',
    title: esc(p.presentationTitle),
    body:
      para(
        `<strong>${esc(p.inviterName)}</strong> invited you to work on this presentation with them on ${PRODUCT_NAME}.
         Once you accept, you can publish new versions of it and manage the links it is shared through.`
      ) +
      button(p.claimUrl, 'Accept and open the deck') +
      fine(
        `This invitation was sent to ${esc(p.inviteeEmail)} and stays open until ${fmtDate(p.expiresAt)}.`
      ) +
      spelledLink(p.claimUrl)
  });
  const text = `${p.inviterName} invited you to collaborate on "${p.presentationTitle}" on ${PRODUCT_NAME}.\n\nAccept and open the deck: ${p.claimUrl}\n\nThe invitation stays open until ${fmtDate(p.expiresAt)}.`;
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

/** What was held back since the last mail, as a sentence, or '' when nothing was. */
function pendingSentence(p: FormResponseNoticeParams): string {
  const parts: string[] = [];
  if (p.pendingNew > 0) parts.push(`${p.pendingNew} more response${p.pendingNew === 1 ? '' : 's'}`);
  if (p.pendingEdited > 0) parts.push(`${p.pendingEdited} more edit${p.pendingEdited === 1 ? '' : 's'}`);
  return parts.length === 0 ? '' : ` Since we last wrote, ${parts.join(' and ')} came in too.`;
}

/** Where the response came through, in words. */
const throughLink = (p: FormResponseNoticeParams): string =>
  p.shareTokenName === null ? 'a link you have since deleted' : `the link "${p.shareTokenName}"`;

function responseNoticeFacts(p: FormResponseNoticeParams): string {
  return facts([
    ['Deck', esc(p.presentationTitle)],
    ['Form', esc(p.formName)],
    ['Through', p.shareTokenName === null ? 'A link you have since deleted' : esc(p.shareTokenName)],
    ['When', fmtDate(p.at)]
  ]);
}

const RESPONSES_STAY = `The answers themselves never travel by email: they wait for you in ${PRODUCT_NAME}. You can switch these notices off for this deck from its responses panel.`;

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
  const html = shell({
    preheader: `Someone answered the ${p.formName} form.${pendingSentence(p)}`,
    eyebrow: 'New response',
    title: 'Someone answered your form',
    body:
      para(
        `A new answer just came in on <strong>${esc(p.presentationTitle)}</strong>.${esc(pendingSentence(p))}`
      ) +
      responseNoticeFacts(p) +
      button(p.deckUrl, 'Read the responses') +
      fine(RESPONSES_STAY) +
      spelledLink(p.deckUrl)
  });
  const text =
    `Someone answered the "${p.formName}" form of "${p.presentationTitle}", through ${throughLink(p)}, on ${fmtDate(p.at)}.${pendingSentence(p)}\n\n` +
    `Read the responses: ${p.deckUrl}\n\n${RESPONSES_STAY}`;
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
  const html = shell({
    preheader: `An answer on the ${p.formName} form changed. The earlier versions are kept.`,
    eyebrow: 'Response edited',
    title: 'Someone changed their answer',
    body:
      para(
        `An answer already given on <strong>${esc(p.presentationTitle)}</strong> was updated. This is version ${p.revision}
         of that response; the earlier ones are kept, and the responses panel shows the whole history.${esc(pendingSentence(p))}`
      ) +
      responseNoticeFacts(p) +
      button(p.deckUrl, 'See what changed') +
      fine(RESPONSES_STAY) +
      spelledLink(p.deckUrl)
  });
  const text =
    `Someone changed their answer on the "${p.formName}" form of "${p.presentationTitle}", through ${throughLink(p)}, on ${fmtDate(p.at)}. This is version ${p.revision}; the earlier ones are kept.${pendingSentence(p)}\n\n` +
    `See what changed: ${p.deckUrl}\n\n${RESPONSES_STAY}`;
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
  const html = shell({
    preheader: 'Your answer is in. Keep this link to read or change it later.',
    eyebrow: 'Your response',
    title: 'Got it, your answer is in',
    body:
      para('Thank you. Keep this link if you want to read your answer again or change it later:') +
      button(p.editUrl, 'See or change my answer') +
      fine('Anyone who has this link can edit this one response, so treat it like a password.') +
      spelledLink(p.editUrl)
  });
  const text = `Your answer is in. Keep this link to read it again or change it later:\n\n${p.editUrl}\n\nAnyone who has this link can edit this one response, so treat it like a password.`;
  return { subject, html, text };
}

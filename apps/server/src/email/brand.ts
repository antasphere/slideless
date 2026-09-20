import { IDENTITY } from '@slideless/contract';
import type { MailBrand } from '@antasphere/chassis-server/email';

/** The name and the footer line every Slideless mail is set under. */
export const MAIL_BRAND: MailBrand = {
  name: IDENTITY.displayName,
  tagline: 'Presentations made of HTML, hosted and shared. An Antasphere tool.'
};

/** The account mails' words that are Slideless's own: the tool definition's `copy.mail` slot. */
export const MAIL_COPY = {
  tagline: MAIL_BRAND.tagline,
  invitePitch: 'Join to see the decks the team publishes there, and to publish your own.',
  invitePreheader: 'their decks, and a place for yours.'
};

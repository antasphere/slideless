/**
 * Transactional email builders. Env-free by design (ported convention from
 * a predecessor template): every env-dependent value (urls, names) arrives as
 * a parameter, so a preview script can render these standalone.
 *
 * Products: change PRODUCT_NAME and the accent color, keep the builders.
 */
export const PRODUCT_NAME = 'Slideless';

/** User-controlled values never reach email HTML unescaped. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shell = (title: string, bodyHtml: string) => `<!doctype html>
<html><body style="margin:0;padding:0;background:#f4f4f5;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border-radius:12px;overflow:hidden">
<tr><td style="background:#18181b;padding:20px 32px">
  <span style="color:#ffffff;font-size:16px;font-weight:600">${PRODUCT_NAME}</span>
</td></tr>
<tr><td style="padding:32px">
  <h1 style="margin:0 0 16px;font-size:20px;color:#18181b">${title}</h1>
  ${bodyHtml}
</td></tr>
<tr><td style="padding:16px 32px;border-top:1px solid #e4e4e7">
  <span style="color:#a1a1aa;font-size:12px">${PRODUCT_NAME}</span>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

export interface InviteEmailParams {
  inviteeEmail: string;
  inviterName: string;
  workspaceName: string;
  acceptUrl: string;
  expiresAt: Date;
}

export function buildInviteEmail(p: InviteEmailParams): { subject: string; html: string; text: string } {
  const subject = `${p.inviterName} invited you to ${p.workspaceName}`;
  const html = shell(
    `Join ${esc(p.workspaceName)}`,
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       ${esc(p.inviterName)} invited you (${esc(p.inviteeEmail)}) to join
       <strong>${esc(p.workspaceName)}</strong> on ${PRODUCT_NAME}.</p>
     <p style="margin:0 0 24px">
       <a href="${p.acceptUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Accept invitation</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If the button does not work, open:<br>
       <span style="word-break:break-all">${p.acceptUrl}</span></p>`
  );
  const text = `${p.inviterName} invited you to join ${p.workspaceName} on ${PRODUCT_NAME}.\n\nAccept: ${p.acceptUrl}\n\nExpires ${p.expiresAt.toUTCString()}.`;
  return { subject, html, text };
}

export interface PasswordResetEmailParams {
  resetUrl: string;
  expiresAt: Date;
}

export function buildPasswordResetEmail(p: PasswordResetEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Reset your ${PRODUCT_NAME} password`;
  const html = shell(
    'Reset your password',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       We received a request to reset your ${PRODUCT_NAME} password. Click below to choose a new one.</p>
     <p style="margin:0 0 24px">
       <a href="${p.resetUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Reset password</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email —
       your password stays unchanged.<br>
       <span style="word-break:break-all">${p.resetUrl}</span></p>`
  );
  const text = `Reset your ${PRODUCT_NAME} password: ${p.resetUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

export interface ChangeEmailConfirmEmailParams {
  newEmail: string;
  confirmUrl: string;
  expiresAt: Date;
}

/** To the OLD address: a verified user must confirm the change first (two-leg flow). */
export function buildChangeEmailConfirmEmail(p: ChangeEmailConfirmEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Confirm your ${PRODUCT_NAME} email change`;
  const html = shell(
    'Confirm your email change',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       We received a request to change your ${PRODUCT_NAME} email to
       <strong>${esc(p.newEmail)}</strong>. Confirm below — a verification link will then be
       sent to the new address.</p>
     <p style="margin:0 0 24px">
       <a href="${p.confirmUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Confirm email change</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email —
       your address stays unchanged.<br>
       <span style="word-break:break-all">${p.confirmUrl}</span></p>`
  );
  const text = `Confirm changing your ${PRODUCT_NAME} email to ${p.newEmail}: ${p.confirmUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

export interface VerifyEmailEmailParams {
  verifyUrl: string;
  expiresAt: Date;
}

/** To the NEW address: the final leg of every email change (and any plain verification). */
export function buildVerifyEmailEmail(p: VerifyEmailEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const subject = `Verify your ${PRODUCT_NAME} email address`;
  const html = shell(
    'Verify your email address',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px;line-height:1.6">
       Click below to verify this address for your ${PRODUCT_NAME} account.</p>
     <p style="margin:0 0 24px">
       <a href="${p.verifyUrl}" style="display:inline-block;background:#18181b;color:#ffffff;
          text-decoration:none;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:600">
         Verify email</a></p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">
       This link expires on ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.<br>
       <span style="word-break:break-all">${p.verifyUrl}</span></p>`
  );
  const text = `Verify your ${PRODUCT_NAME} email address: ${p.verifyUrl}\n\nExpires ${p.expiresAt.toUTCString()}. If you did not request this, ignore this email.`;
  return { subject, html, text };
}

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
    (p.hasPassword ? `This link is password protected — the sender will give you the password separately.\n\n` : '') +
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

export interface OtpEmailParams {
  otp: string;
  type: string;
}

export function buildOtpEmail(p: OtpEmailParams): { subject: string; html: string; text: string } {
  const subject = `${p.otp} is your ${PRODUCT_NAME} code`;
  const html = shell(
    'Your sign-in code',
    `<p style="margin:0 0 16px;color:#3f3f46;font-size:14px">Enter this code to continue:</p>
     <p style="margin:0 0 16px;font-size:28px;font-weight:700;letter-spacing:6px;
        color:#18181b;border:2px dashed #e4e4e7;border-radius:8px;padding:16px;text-align:center">${p.otp}</p>
     <p style="margin:0;color:#a1a1aa;font-size:12px">If you did not request this, ignore this email.</p>`
  );
  const text = `Your ${PRODUCT_NAME} code: ${p.otp}`;
  return { subject, html, text };
}

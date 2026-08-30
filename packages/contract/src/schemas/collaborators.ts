import { z } from 'zod';
import { plainText } from './common.js';

/**
 * Per-deck dev grants: an email is invited to develop one deck. The grant
 * starts 'pending' with a claim token (copyable link, like invitations);
 * claiming at sign-in/sign-up binds the user id and flips it 'active'.
 */

export const collaboratorRoleSchema = z.enum(['owner', 'dev']);
export type CollaboratorRole = z.infer<typeof collaboratorRoleSchema>;

export const collaboratorStatusSchema = z.enum(['pending', 'active', 'revoked']);
export type CollaboratorStatus = z.infer<typeof collaboratorStatusSchema>;

export const collaboratorSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  email: z.string(),
  /** Null until the invitee claimed the grant. */
  userId: z.string().nullable(),
  role: collaboratorRoleSchema,
  status: collaboratorStatusSchema,
  /** Null once the inviter's account was deleted. */
  invitedBy: z.string().nullable(),
  claimedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});
export type Collaborator = z.infer<typeof collaboratorSchema>;

export const collaboratorsListSchema = z.object({
  collaborators: z.array(collaboratorSchema),
  nextCursor: z.string().nullable()
});

export const collaboratorInviteSchema = z.object({
  email: z.email()
});
export type CollaboratorInvite = z.infer<typeof collaboratorInviteSchema>;

/** The copyable claim link is ALWAYS returned — SMTP is never required. */
export const collaboratorInvitedSchema = z.object({
  collaborator: collaboratorSchema,
  claimUrl: z.string(),
  emailSent: z.boolean()
});
export type CollaboratorInvited = z.infer<typeof collaboratorInvitedSchema>;

/**
 * Public claim-token resolution (drives the claim page — the invitations
 * pattern). Deliberately carries NO account-existence signal: it answered an
 * instance-global "does this email have an account?" for any admin who
 * minted an invite naming the address — a free, side-effect-less oracle
 * (PRDCT-1437 door 2). The claim page offers sign-in and create-account
 * neutrally; the claim endpoint itself answers `account_exists` when a
 * create collides.
 */
export const collaboratorLookupSchema = z.object({
  email: z.string(),
  presentationTitle: z.string(),
  role: collaboratorRoleSchema,
  expiresAt: z.string()
});
export type CollaboratorLookup = z.infer<typeof collaboratorLookupSchema>;

export const collaboratorClaimSchema = z.object({
  token: z.string().min(16),
  /** Required when the invited email has no account yet. */
  name: plainText(1, 120).optional(),
  password: z.string().min(12).max(256).optional()
});
export type CollaboratorClaim = z.infer<typeof collaboratorClaimSchema>;

export const collaboratorClaimedSchema = z.object({
  collaborator: collaboratorSchema,
  workspaceId: z.string(),
  userId: z.string()
});
export type CollaboratorClaimed = z.infer<typeof collaboratorClaimedSchema>;

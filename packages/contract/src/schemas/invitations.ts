import { z } from 'zod';
import { workspaceRoleSchema } from './common.js';

export const invitationSchema = z.object({
  id: z.string(),
  email: z.string(),
  role: workspaceRoleSchema,
  invitedBy: z.string(),
  expiresAt: z.string(),
  acceptedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  createdAt: z.string()
});
export type InvitationInfo = z.infer<typeof invitationSchema>;

export const invitationsListSchema = z.object({
  invitations: z.array(invitationSchema),
  nextCursor: z.string().nullable()
});

export const invitationCreateSchema = z.object({
  email: z.email(),
  role: workspaceRoleSchema.default('member')
});
export type InvitationCreate = z.infer<typeof invitationCreateSchema>;

/**
 * The copyable acceptance link is ALWAYS returned — SMTP is never required
 * to get a teammate in. `emailSent` says whether a mail also went out.
 */
export const invitationCreatedSchema = z.object({
  invitation: invitationSchema,
  acceptUrl: z.string(),
  emailSent: z.boolean()
});
export type InvitationCreated = z.infer<typeof invitationCreatedSchema>;

export const invitationLookupSchema = z.object({
  email: z.string(),
  role: workspaceRoleSchema,
  workspaceName: z.string(),
  expiresAt: z.string(),
  /** True when an account with the invited email already exists (sign in to accept). */
  accountExists: z.boolean()
});
export type InvitationLookup = z.infer<typeof invitationLookupSchema>;

export const invitationAcceptSchema = z.object({
  token: z.string().min(16),
  /** Required when the invited email has no account yet. */
  name: z.string().min(1).max(120).optional(),
  password: z.string().min(12).max(256).optional()
});
export type InvitationAccept = z.infer<typeof invitationAcceptSchema>;

export const invitationAcceptedSchema = z.object({
  workspaceId: z.string(),
  userId: z.string(),
  role: workspaceRoleSchema
});

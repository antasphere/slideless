import { z } from 'zod';
import { workspaceRoleSchema } from './common.js';

export const memberSchema = z.object({
  id: z.string(),
  userId: z.string(),
  email: z.string(),
  name: z.string(),
  role: workspaceRoleSchema,
  isActive: z.boolean(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable()
});
export type Member = z.infer<typeof memberSchema>;

export const membersListSchema = z.object({
  members: z.array(memberSchema),
  nextCursor: z.string().nullable()
});

export const memberUpdateSchema = z.object({
  role: workspaceRoleSchema.optional(),
  isActive: z.boolean().optional()
});
export type MemberUpdate = z.infer<typeof memberUpdateSchema>;

/** Admin-generated password reset link for a member (the SMTP-free recovery path). */
export const memberResetLinkSchema = z.object({
  resetUrl: z.string(),
  expiresAt: z.string()
});
export type MemberResetLink = z.infer<typeof memberResetLinkSchema>;

/** Admin-generated email change link for a member (the SMTP-free email-change path). */
export const memberChangeEmailLinkRequestSchema = z.object({
  newEmail: z.email()
});
export type MemberChangeEmailLinkRequest = z.infer<typeof memberChangeEmailLinkRequestSchema>;

export const memberChangeEmailLinkSchema = z.object({
  verifyUrl: z.string(),
  newEmail: z.string(),
  expiresAt: z.string()
});
export type MemberChangeEmailLink = z.infer<typeof memberChangeEmailLinkSchema>;

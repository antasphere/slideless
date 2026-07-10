import { z } from 'zod';

/**
 * Reviewer notes tied to a specific deck version. Authored either by a
 * signed-in principal (owner/dev/agent) or by an anonymous reviewer through
 * a share token — the token-session create/list surface itself ships with
 * the public viewer (Phase 4); this file is the owner-facing shape.
 */

export const annotationStatusSchema = z.enum(['open', 'resolved']);
export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;

/** Client anchor payload (slide/element/rect) — opaque JSON to the server. */
export const annotationSelectionSchema = z.record(z.string(), z.unknown());

export const annotationSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  /** The deck version the note anchors to. */
  version: z.number().int(),
  /** Set when the note came in through a share token (reviewer side). */
  shareTokenId: z.string().nullable(),
  /** Set when a signed-in principal authored the note. */
  authorUserId: z.string().nullable(),
  /** Free-text display name for anonymous reviewers. */
  authorName: z.string().nullable(),
  selection: annotationSelectionSchema,
  body: z.string(),
  status: annotationStatusSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type Annotation = z.infer<typeof annotationSchema>;

export const annotationsListSchema = z.object({
  annotations: z.array(annotationSchema),
  nextCursor: z.string().nullable()
});

export const annotationCreateSchema = z.object({
  version: z.number().int().min(1),
  selection: annotationSelectionSchema,
  body: z.string().min(1).max(10000)
});
export type AnnotationCreate = z.infer<typeof annotationCreateSchema>;

export const annotationUpdateSchema = z
  .object({
    body: z.string().min(1).max(10000).optional(),
    status: annotationStatusSchema.optional()
  })
  .refine((v) => v.body !== undefined || v.status !== undefined, {
    message: 'at least one of body or status is required'
  });
export type AnnotationUpdate = z.infer<typeof annotationUpdateSchema>;

/** Filters for the per-deck listing and the workspace-wide inbox. */
export const annotationsListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  version: z.coerce.number().int().min(1).optional(),
  status: annotationStatusSchema.optional()
});

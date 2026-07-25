import { z } from 'zod';

/**
 * Deck-embedded form responses (ADR 022). The deck HTML is the form
 * (`<form data-slideless-form="name">`); anonymous viewers submit through
 * the token-session viewer surface (contract-free by the viewer convention
 * — apps/server viewer/forms-api.ts), and this file carries the OWNER
 * shapes: the responses listing, the grouped summary, and the filters.
 *
 * `payload` is OPAQUE to the server beyond shape and size: a flat object of
 * string / string-array values (the FormData serialization), never
 * interpreted — the annotations.selection posture. Identity, if the author
 * wants it, is just fields in the form.
 */

/**
 * A form's `data-slideless-form` name: the same owner-chosen-slug charset as
 * view placements — the name renders in owner tooling (dashboard, CLI
 * tables, CSV), so the gate is what keeps arbitrary deck-authored text out.
 */
export const formNameSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'form name must be 1-64 chars of [A-Za-z0-9._-]');

/**
 * How the serving document reached the respondent: a direct share-link view
 * ('link') or an official embed's iframe ('embed'). Stamped from the
 * injection context and echoed by the runtime — attribution-grade like the
 * view-events placement, never an authz signal.
 */
export const formResponseSourceSchema = z.enum(['link', 'embed']);
export type FormResponseSourceValue = z.infer<typeof formResponseSourceSchema>;

/** Payload field caps (shape only — the byte cap lives at the viewer API). */
export const FORM_PAYLOAD_MAX_FIELDS = 128;
export const FORM_PAYLOAD_MAX_KEY_CHARS = 128;

/**
 * The serialized FormData shape: flat, string or string[] values (repeated
 * input names become arrays). Field-count and key-length caps live here;
 * the serialized-bytes cap is enforced in-handler (the
 * MAX_SELECTION_JSON_BYTES precedent).
 */
export const formResponsePayloadSchema = z
  .record(z.string().min(1).max(FORM_PAYLOAD_MAX_KEY_CHARS), z.union([z.string(), z.array(z.string())]))
  .refine((v) => Object.keys(v).length <= FORM_PAYLOAD_MAX_FIELDS, {
    message: `payload must have at most ${FORM_PAYLOAD_MAX_FIELDS} fields`
  });
export type FormResponsePayload = z.infer<typeof formResponsePayloadSchema>;

export const formResponseSchema = z.object({
  id: z.string(),
  presentationId: z.string(),
  /** The deck version the respondent saw. */
  version: z.number().int(),
  formName: z.string(),
  /** The share link it came through; null once that token is deleted. */
  shareTokenId: z.string().nullable(),
  /** The link's owner-facing label, joined for attribution; null when gone. */
  shareTokenName: z.string().nullable(),
  source: formResponseSourceSchema,
  /** Sanitized `?p=` label of the serving document; null when absent/illegal. */
  placement: z.string().nullable(),
  /** Set ONLY when a signed-in viewer's serve-time assertion verified. */
  respondentUserId: z.string().nullable(),
  /** The asserted respondent's account email, joined for attribution. */
  respondentEmail: z.string().nullable(),
  payload: formResponsePayloadSchema,
  createdAt: z.string(),
  updatedAt: z.string()
});
export type FormResponse = z.infer<typeof formResponseSchema>;

export const formResponsesListSchema = z.object({
  responses: z.array(formResponseSchema),
  nextCursor: z.string().nullable()
});
export type FormResponsesList = z.infer<typeof formResponsesListSchema>;

/** Filters for the owner listing — every attribution axis is sliceable. */
export const formResponsesListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** Only this form's responses. */
  form: formNameSchema.optional(),
  /** Only responses that came through this share link. */
  token: z.uuid().optional(),
  source: formResponseSourceSchema.optional(),
  placement: z.string().max(64).optional(),
  /** Only responses created at or after this instant. */
  since: z.iso.datetime().optional()
});
export type FormResponsesListQuery = z.infer<typeof formResponsesListQuerySchema>;

/**
 * One summary bucket: responses grouped by form × link × source × placement
 * — the agent's one-call answer to "what came in, from where".
 */
export const formResponsesSummaryBucketSchema = z.object({
  formName: z.string(),
  shareTokenId: z.string().nullable(),
  shareTokenName: z.string().nullable(),
  source: formResponseSourceSchema,
  placement: z.string().nullable(),
  count: z.number().int(),
  lastResponseAt: z.string()
});
export type FormResponsesSummaryBucket = z.infer<typeof formResponsesSummaryBucketSchema>;

export const formResponsesSummarySchema = z.object({
  buckets: z.array(formResponsesSummaryBucketSchema),
  /** Total responses on the deck (all forms). */
  total: z.number().int()
});
export type FormResponsesSummary = z.infer<typeof formResponsesSummarySchema>;

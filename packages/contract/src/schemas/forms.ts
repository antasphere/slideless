import { z } from 'zod';
import { hasNulDeep, noControlChars } from '@antasphere/chassis-contract';

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
  })
  // The payload lands in a jsonb column, which refuses NUL (SQLSTATE 22P05):
  // a share-link respondent needs no account, so an unvalidated NUL was an
  // anonymous 500 + error-level log line (SL-B4, PRDCT-1358). Keys and
  // values alike.
  .refine((v) => !hasNulDeep(v), {
    message: 'payload must not contain NUL characters in keys or values'
  });
export type FormResponsePayload = z.infer<typeof formResponsePayloadSchema>;

/**
 * A form FILE FIELD's name (PRDCT-2403): the file input's `name`, the same
 * caps as a payload key, and no control characters (it lands in a text
 * column, a zip entry path and a directory name on the owner's disk).
 */
export const formFileFieldNameSchema = noControlChars(z.string().min(1).max(FORM_PAYLOAD_MAX_KEY_CHARS));

/** The longest display name an uploaded file keeps. */
export const FORM_FILE_NAME_MAX_CHARS = 255;

/**
 * The files a submit names, per file field: ids the upload route answered
 * on the SAME link and form. On an update the map is the FULL new set — an
 * attached file left out is removed; the key absent altogether leaves the
 * response's files untouched. The per-response count ceiling is the
 * instance's (`FORMS_MAX_FILES_PER_RESPONSE`), enforced in-handler.
 */
export const formSubmitFilesSchema = z.record(formFileFieldNameSchema, z.array(z.uuid()).max(1000));
export type FormSubmitFiles = z.infer<typeof formSubmitFilesSchema>;

/**
 * One file a respondent uploaded into a form's file field (PRDCT-2403), on
 * the OWNER wire.
 *
 * ⚠️ RAW CONTENT — `field`, `name` and `contentType` are respondent-side
 * input (the name is reduced to a basename with no control characters, and
 * that is all). Escape them wherever they render; never join `name` into a
 * filesystem path (the CLI writes through its contained-write helper).
 * The bytes are served `attachment` + `nosniff`, never rendered.
 */
export const formResponseFileSchema = z.object({
  id: z.string(),
  /** The file input's `name` in the form. */
  field: z.string(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int(),
  sha256: z.string(),
  createdAt: z.string()
});
export type FormResponseFile = z.infer<typeof formResponseFileSchema>;

/** A revision's record of the files it held: names and sizes, never a handle on bytes. */
export const formResponseFileSnapshotSchema = z.object({
  id: z.string(),
  field: z.string(),
  name: z.string(),
  sizeBytes: z.number().int()
});
export type FormResponseFileSnapshot = z.infer<typeof formResponseFileSnapshotSchema>;

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
  // NO respondent identity on this wire. ADR 022 leg 3 put the viewer's
  // account id and email here; the identity was minted into the deck
  // document and provably forgeable by deck JS, and the email made the
  // listing an exfiltration shape for any `presentations:read` machine key
  // (PRDCT-1331, audit §1). A response is anonymous unless the AUTHOR asked
  // for a name in the form.
  payload: formResponsePayloadSchema,
  /**
   * The current revision number (PRDCT-2329): 1 for a response never
   * edited, +1 per edit. The history behind it is the detail route's
   * `versions`; the respondent-facing wire carries neither.
   */
  revision: z.number().int().min(1),
  /**
   * The files the response holds now (PRDCT-2403), in upload order; empty
   * when the form has no file field. Download one through
   * `…/responses/{responseId}/files/{fileId}`, a response's set through
   * `…/responses/{responseId}/files.zip`, a whole deck's through
   * `…/responses/files.zip`.
   */
  files: z.array(formResponseFileSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});
export type FormResponse = z.infer<typeof formResponseSchema>;

/**
 * One revision of a response (PRDCT-2329): the answer as it was at that
 * revision, with the attribution of the navigation that wrote it. The
 * link's owner-facing name is joined for display; there is NO respondent
 * identity here either, per revision as per response.
 */
export const formResponseVersionSchema = z.object({
  revision: z.number().int().min(1),
  /** The deck version the respondent saw when writing this revision. */
  version: z.number().int(),
  shareTokenId: z.string().nullable(),
  shareTokenName: z.string().nullable(),
  source: formResponseSourceSchema,
  placement: z.string().nullable(),
  payload: formResponsePayloadSchema,
  /** The files the response held at this revision; null on revisions from before file fields existed. */
  files: z.array(formResponseFileSnapshotSchema).nullable(),
  createdAt: z.string()
});
export type FormResponseVersion = z.infer<typeof formResponseVersionSchema>;

/** The owner's per-response read: the current row plus its history, newest revision first. */
export const formResponseDetailSchema = z.object({
  response: formResponseSchema,
  versions: z.array(formResponseVersionSchema)
});
export type FormResponseDetail = z.infer<typeof formResponseDetailSchema>;

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
  // Sanitized on WRITE by the view-events placement rule; the read filter
  // must validate too, or a NUL in the query param reaches the WHERE
  // comparison and Postgres refuses it (22021 → a 500 for a plain client
  // mistake — SL-B4's read-filter member).
  placement: noControlChars(z.string().max(64)).optional(),
  /**
   * Only responses with activity at or after this instant: created OR
   * edited (PRDCT-2329, from PRDCT-1339 §1 — keyed on creation alone, an
   * edited response never resurfaced in any window).
   */
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
  /** The latest activity in the bucket: a create or an edit, whichever is later. */
  lastResponseAt: z.string()
});
export type FormResponsesSummaryBucket = z.infer<typeof formResponsesSummaryBucketSchema>;

/** Filters of the whole-deck files zip: the listing's own, minus the paging. */
export const formResponseFilesZipQuerySchema = z.object({
  form: formNameSchema.optional(),
  token: z.uuid().optional(),
  source: formResponseSourceSchema.optional(),
  placement: noControlChars(z.string().max(64)).optional(),
  since: z.iso.datetime().optional()
});
export type FormResponseFilesZipQuery = z.infer<typeof formResponseFilesZipQuerySchema>;

export const formResponsesSummarySchema = z.object({
  buckets: z.array(formResponsesSummaryBucketSchema),
  /** Total responses on the deck (all forms). */
  total: z.number().int()
});
export type FormResponsesSummary = z.infer<typeof formResponsesSummarySchema>;

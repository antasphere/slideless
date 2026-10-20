import { z } from 'zod';
import { MAX_OPAQUE_JSON_DEPTH, hasNulDeep, jsonDepthOf, plainText } from '@antasphere/chassis-contract';
import { ANSWERS_KEY } from '../bindings.js';
import {
  documentBindingSchema,
  presentationProjectIdsSchema,
  presentationSchema,
  presentationVersionSchema
} from './presentations.js';

/**
 * DATA-BOUND TEMPLATES (PRDCT-3641): a template ships its data contract, a
 * document is an instance of a template plus versioned data.
 *
 * The contract is two reserved root files of a TEMPLATE bundle (a deck whose
 * AGENT.md frontmatter says `type: Template`): `schema.json`, a JSON Schema
 * (draft 2020-12) with a `version`, and `data.json`, a sample the schema
 * accepts. Both are read once at push and mirrored on the version row, like
 * the frontmatter; a template's HTML files bind to the schema's fields with
 * the mustache subset of `bindings.ts`, resolved at push into the stored
 * version of each document.
 *
 * A DOCUMENT is a presentation that names its template and the template
 * version it is pinned to. Its data is validated against the pinned schema
 * on every write; every write is a new presentation version whose files are
 * the template's, the HTML resolved, plus `data.json` at the root holding the
 * data as rendered. The `answers` branch of the data is the server's: the
 * forms' latest response per form lands there, keyed by field name.
 */

/** The reserved root file of a template: its JSON Schema. */
export const DATA_SCHEMA_PATH = 'schema.json';
/** The reserved root file of a template: the sample its editor previews with; on a document, the data the version was rendered from. */
export const DATA_FILE_PATH = 'data.json';

/** Serialized caps, in JSON.stringify characters (the metadata cap's precedent). */
export const DATA_SCHEMA_MAX_LENGTH = 256 * 1024;
export const DOCUMENT_DATA_MAX_LENGTH = 1024 * 1024;
/** The largest HTML file the renderer resolves bindings in; a bigger one is refused at the template's push. */
export const BOUND_FILE_MAX_BYTES = 8 * 1024 * 1024;

const jsonObject = z.record(z.string(), z.unknown());

/**
 * A JSON Schema as a template may carry it: an object with a `version` (the
 * contract's own version, bumped on any change), optionally `$id`, every other
 * keyword the validator's. Depth and NUL are checked here because the object
 * lands in a jsonb column and is walked by the extractor.
 */
export const dataSchemaSchema = jsonObject
  .refine((v) => typeof v['version'] === 'string' && (v['version'] as string).trim().length > 0, {
    message: 'schema.json must carry a non-empty "version" string'
  })
  .refine((v) => jsonDepthOf(v) <= MAX_OPAQUE_JSON_DEPTH, {
    message: `schema.json must nest at most ${MAX_OPAQUE_JSON_DEPTH} levels deep`
  })
  .refine((v) => !hasNulDeep(v), { message: 'schema.json must not contain NUL characters' })
  .refine((v) => JSON.stringify(v).length <= DATA_SCHEMA_MAX_LENGTH, {
    message: `schema.json must serialize to at most ${DATA_SCHEMA_MAX_LENGTH} characters`
  });
export type DataSchema = z.infer<typeof dataSchemaSchema>;

/**
 * The data a client pushes: a plain JSON object the pinned schema accepts.
 * The reserved `answers` branch is refused here: the server writes it.
 */
export const documentDataInputSchema = jsonObject
  .refine((v) => !Object.prototype.hasOwnProperty.call(v, ANSWERS_KEY), {
    message: `"${ANSWERS_KEY}" is reserved: the forms' answers are written by the server`
  })
  .refine((v) => jsonDepthOf(v) <= MAX_OPAQUE_JSON_DEPTH, {
    message: `data must nest at most ${MAX_OPAQUE_JSON_DEPTH} levels deep`
  })
  .refine((v) => !hasNulDeep(v), { message: 'data must not contain NUL characters' })
  .refine((v) => JSON.stringify(v).length <= DOCUMENT_DATA_MAX_LENGTH, {
    message: `data must serialize to at most ${DOCUMENT_DATA_MAX_LENGTH} characters`
  });
export type DocumentDataInput = z.infer<typeof documentDataInputSchema>;

/**
 * A merge patch (RFC 7386): any JSON value is a legal patch, but a document's
 * root is an object, so the patch is an object too; `null` deletes a key.
 * `answers` stays refused.
 */
export const documentDataMergePatchSchema = jsonObject
  .refine((v) => !Object.prototype.hasOwnProperty.call(v, ANSWERS_KEY), {
    message: `"${ANSWERS_KEY}" is reserved: the forms' answers are written by the server`
  })
  .refine((v) => jsonDepthOf(v) <= MAX_OPAQUE_JSON_DEPTH, {
    message: `the patch must nest at most ${MAX_OPAQUE_JSON_DEPTH} levels deep`
  })
  .refine((v) => !hasNulDeep(v), { message: 'the patch must not contain NUL characters' })
  .refine((v) => JSON.stringify(v).length <= DOCUMENT_DATA_MAX_LENGTH, {
    message: `the patch must serialize to at most ${DOCUMENT_DATA_MAX_LENGTH} characters`
  });
export type DocumentDataMergePatch = z.infer<typeof documentDataMergePatchSchema>;

/** One place the data fails its schema: a JSON pointer and the validator's sentence. */
export const dataValidationIssueSchema = z.object({
  /** JSON pointer into the data (`/tickets/0/headline`); `` for the root. */
  path: z.string(),
  message: z.string()
});
export type DataValidationIssue = z.infer<typeof dataValidationIssueSchema>;

/** One binding the schema does not describe, where it sits. */
export const unknownBindingSchema = z.object({
  path: z.string(),
  file: z.string(),
  line: z.number().int().min(1)
});
export type UnknownBinding = z.infer<typeof unknownBindingSchema>;

/** The template's contract, as `GET /presentations/{id}/schema` answers it. */
export const templateDataContractSchema = z.object({
  presentationId: z.string(),
  /** The template version the contract was read from. */
  version: z.number().int().min(1),
  /** The schema's own `version` string. */
  schemaVersion: z.string(),
  schema: jsonObject,
  /** The sample `data.json`, or null when the template ships none. */
  sample: jsonObject.nullable(),
  /** Every absolute field path the template's HTML binds, sorted. */
  bindings: z.array(z.string())
});
export type TemplateDataContract = z.infer<typeof templateDataContractSchema>;

/** `PUT /presentations/{id}/schema`: a new template version with these files replaced. */
export const templateSchemaSetSchema = z.object({
  schema: dataSchemaSchema,
  /** The new sample; omitted keeps the current one, `null` removes it. */
  sample: documentDataInputSchema.nullable().optional()
});
export type TemplateSchemaSet = z.infer<typeof templateSchemaSetSchema>;

/** `POST /presentations/{id}/instances`. */
export const documentCreateSchema = z.object({
  title: plainText(1, 300).optional(),
  data: documentDataInputSchema,
  projectIds: presentationProjectIdsSchema.optional()
});
export type DocumentCreate = z.infer<typeof documentCreateSchema>;

export const documentDataSourceSchema = z.enum(['create', 'push', 'answer', 'upgrade']);
export type DocumentDataSource = z.infer<typeof documentDataSourceSchema>;

/** `GET /presentations/{id}/data`: the current data, the answers branch included. */
export const documentDataSchema = z.object({
  presentationId: z.string(),
  /** The document's current presentation version (the one the data was rendered into). */
  version: z.number().int().min(0),
  template: documentBindingSchema,
  data: jsonObject
});
export type DocumentData = z.infer<typeof documentDataSchema>;

/** One data version of the push history: who, when, what changed, and the data as it was. */
export const documentDataVersionSchema = z.object({
  presentationId: z.string(),
  version: z.number().int().min(1),
  source: documentDataSourceSchema,
  /** The template version this version was rendered against. */
  templateVersion: z.number().int().min(1),
  /** The top-level keys that changed against the previous version (`answers.<form>` for an answer). */
  changed: z.array(z.string()),
  /** The share link's recipient label on an `answer` version; null otherwise. */
  answeredBy: z.string().nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.string()
});
export type DocumentDataVersion = z.infer<typeof documentDataVersionSchema>;

export const documentDataVersionDetailSchema = documentDataVersionSchema.extend({
  data: jsonObject
});
export type DocumentDataVersionDetail = z.infer<typeof documentDataVersionDetailSchema>;

export const documentDataVersionsListSchema = z.object({
  versions: z.array(documentDataVersionSchema),
  nextCursor: z.string().nullable()
});
export type DocumentDataVersionsList = z.infer<typeof documentDataVersionsListSchema>;

/** The answer of one form as the data holds it: the fields, then who and when. */
export const documentFormAnswerSchema = z.object({
  form: z.string(),
  fields: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  answeredAt: z.string(),
  /** The share link's recipient label, or null (an unnamed link). */
  answeredBy: z.string().nullable(),
  linkId: z.string().nullable(),
  responseId: z.string(),
  revision: z.number().int().min(1)
});
export type DocumentFormAnswer = z.infer<typeof documentFormAnswerSchema>;

/** `GET /presentations/{id}/answers`: every form answered, in the data's order. */
export const documentAnswersSchema = z.object({
  presentationId: z.string(),
  version: z.number().int().min(0),
  answers: z.array(documentFormAnswerSchema)
});
export type DocumentAnswers = z.infer<typeof documentAnswersSchema>;

/** `POST /presentations/{id}/upgrade`: the template version to move to (its current one when omitted). */
export const documentUpgradeSchema = z
  .object({
    toVersion: z.number().int().min(1).max(2_147_483_647).optional(),
    /** The data to move with, replacing the current one (the answers carried over), judged by the new schema. */
    data: documentDataInputSchema.optional(),
    /** A merge patch applied before the move, judged by the new schema: the way to add what a new version requires. */
    merge: documentDataMergePatchSchema.optional()
  })
  .refine((v) => v.data === undefined || v.merge === undefined, 'data and merge are exclusive');
export type DocumentUpgrade = z.infer<typeof documentUpgradeSchema>;

/** The answer of every write that minted a document version. */
export const documentWrittenSchema = z.object({
  presentation: presentationSchema,
  version: presentationVersionSchema,
  data: documentDataSchema
});
export type DocumentWritten = z.infer<typeof documentWrittenSchema>;

/** The `$answered` key under each form's branch: the server's record of who and when. */
export const ANSWERED_KEY = '$answered';

/** The shape of `answers.<form>.$answered` inside the data. */
export interface AnsweredMeta {
  at: string;
  by: string | null;
  link: string | null;
  response: string;
  revision: number;
}

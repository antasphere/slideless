import {
  BOUND_FILE_MAX_BYTES,
  DATA_FILE_PATH,
  DATA_SCHEMA_MAX_LENGTH,
  DATA_SCHEMA_PATH,
  DOCUMENT_DATA_MAX_LENGTH,
  dataSchemaSchema,
  documentDataInputSchema,
  hasBindingMarkers,
  schemaShapeIssues,
  unsafePatternsOf,
  type BindingError,
  type DataValidationIssue,
  type ManifestEntry,
  type Reference,
  type UnknownBinding
} from '@slideless/contract';
import { blobKey, type StorageDriver } from '@antasphere/chassis-server/storage';
import { validationBudget } from '../documents/validate-budget.js';
import type { PresentationRow } from '@slideless/db';

/**
 * PUSH-TIME TEMPLATE CONTRACT (PRDCT-3641).
 *
 * A TEMPLATE (a deck whose AGENT.md frontmatter says `type: Template`) may
 * ship its data contract as two reserved root files: `schema.json`, a JSON
 * Schema with a `version`, and `data.json`, a sample the schema accepts. Both
 * are read ONCE at push, before the commit transaction (the frontmatter's
 * place and style, PRDCT-1333: no blob read with row locks held), and
 * mirrored on the version row; every HTML file of the template is read too,
 * its bindings parsed and resolved against the schema.
 *
 * THE POSTURE differs from the frontmatter's: this reader REFUSES. A
 * template whose schema is not one, whose sample fails it, whose pages bind
 * a field the schema lacks, or whose page cannot be parsed is a template
 * nobody can instantiate, and the author is the one pushing: the push is
 * the moment to say so, with the file and the line. An ordinary deck, and a
 * template without `schema.json`, carry no contract and nothing is read.
 *
 * Cost shape: authenticated, once per commit of a template, every HTML
 * file read whole (capped at BOUND_FILE_MAX_BYTES; a bigger one is refused,
 * since the renderer must hold it to resolve it at every push).
 */

export interface TemplateContract {
  schema: Record<string, unknown>;
  /** The schema's own `version` string. */
  schemaVersion: string;
  sample: Record<string, unknown> | null;
  /** Every absolute field path the HTML files bind, sorted. */
  bindings: string[];
}

export type ContractRefusal =
  | { code: 'schema_invalid'; message: string }
  | { code: 'sample_invalid'; message: string; issues: DataValidationIssue[] }
  | { code: 'binding_syntax'; message: string; errors: BindingError[] }
  | { code: 'binding_unknown'; message: string; unknown: UnknownBinding[] }
  | { code: 'bound_file_too_large'; message: string }
  /** The validation worker could not do its job (round 5, F3): a 500, never the author's fault. */
  | { code: 'validator_failed'; message: string };

export type ContractRead =
  { contract: TemplateContract | null; refusal: null } | { contract: null; refusal: ContractRefusal };

const NONE: ContractRead = { contract: null, refusal: null };

/** True for the manifest entries the renderer resolves: the HTML files, by declared type (the viewer's own rule). */
export function isBoundFileEntry(entry: ManifestEntry): boolean {
  return entry.contentType.toLowerCase().split(';')[0]!.trim().startsWith('text/html');
}

/** Reads a blob whole, up to `cap` bytes; `null` past the cap. */
export async function readBlobCapped(
  storage: StorageDriver,
  key: string,
  cap: number
): Promise<Buffer | null> {
  const stream = await storage.getStream(key);
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
      total += buf.length;
      if (total > cap) return null;
      chunks.push(buf);
    }
  } finally {
    stream.destroy();
  }
  return Buffer.concat(chunks);
}

function parseJsonObject(buf: Buffer): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(buf.toString('utf8'));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Reads the contract of a manifest about to be committed. `null` contract
 * with `null` refusal = the version carries none (not a template, or no
 * schema.json). Never throws: a blob that cannot be read here is about to
 * fail the commit's own missing-blob check anyway.
 */
export async function readTemplateContract(
  storage: StorageDriver,
  workspaceId: string,
  manifest: ManifestEntry[],
  reference: Reference | null
): Promise<ContractRead> {
  if (reference?.type !== 'template') return NONE;
  const schemaEntry = manifest.find((e) => e.path === DATA_SCHEMA_PATH);
  if (!schemaEntry) return NONE;

  let schemaBuf: Buffer | null;
  try {
    schemaBuf = await readBlobCapped(
      storage,
      blobKey(workspaceId, schemaEntry.sha256),
      DATA_SCHEMA_MAX_LENGTH * 4
    );
  } catch {
    return NONE;
  }
  if (!schemaBuf) {
    return refuse({
      code: 'schema_invalid',
      message: `${DATA_SCHEMA_PATH} is larger than the ${DATA_SCHEMA_MAX_LENGTH}-character cap`
    });
  }
  const schemaRaw = parseJsonObject(schemaBuf);
  if (!schemaRaw)
    return refuse({ code: 'schema_invalid', message: `${DATA_SCHEMA_PATH} is not a JSON object` });
  const schemaParsed = dataSchemaSchema.safeParse(schemaRaw);
  if (!schemaParsed.success) {
    return refuse({
      code: 'schema_invalid',
      message: `${DATA_SCHEMA_PATH}: ${schemaParsed.error.issues[0]?.message ?? 'invalid'}`
    });
  }
  const schema = schemaParsed.data;
  // A keyword holding a value of the wrong shape is no JSON Schema: the
  // validator would read it its own way and no document could be made
  // (the PRDCT-3641 double check), so it is refused here, with the place.
  const malformed = schemaShapeIssues(schema);
  if (malformed.length > 0) {
    const first = malformed[0]!;
    return refuse({
      code: 'schema_invalid',
      message: `${DATA_SCHEMA_PATH} at ${first.at}: ${first.message}`
    });
  }
  // A pattern that could take exponential time runs on the request thread
  // at every write (verifier round 2, F5): refused at the template's push.
  const unsafe = unsafePatternsOf(schema);
  if (unsafe.length > 0) {
    const first = unsafe[0]!;
    return refuse({
      code: 'schema_invalid',
      message: `${DATA_SCHEMA_PATH} at ${first.at}: the pattern "${first.pattern.slice(0, 60)}" could take exponential time on a crafted value; write it without nested repetition`
    });
  }

  let sample: Record<string, unknown> | null = null;
  const sampleEntry = manifest.find((e) => e.path === DATA_FILE_PATH);
  if (sampleEntry) {
    let sampleBuf: Buffer | null;
    try {
      sampleBuf = await readBlobCapped(
        storage,
        blobKey(workspaceId, sampleEntry.sha256),
        DOCUMENT_DATA_MAX_LENGTH * 4
      );
    } catch {
      return NONE;
    }
    if (!sampleBuf) {
      return refuse({
        code: 'sample_invalid',
        message: `${DATA_FILE_PATH} is larger than the ${DOCUMENT_DATA_MAX_LENGTH}-character cap`,
        issues: []
      });
    }
    const sampleRaw = parseJsonObject(sampleBuf);
    if (!sampleRaw)
      return refuse({
        code: 'sample_invalid',
        message: `${DATA_FILE_PATH} is not a JSON object`,
        issues: []
      });
    const sampleParsed = documentDataInputSchema.safeParse(sampleRaw);
    if (!sampleParsed.success) {
      return refuse({
        code: 'sample_invalid',
        message: `${DATA_FILE_PATH}: ${sampleParsed.error.issues[0]?.message ?? 'invalid'}`,
        issues: []
      });
    }
    const judged = await validationBudget().validate(schema, sampleParsed.data);
    if (!judged.ok) {
      return refuse(
        judged.reason === 'timeout'
          ? { code: 'schema_invalid', message: `${DATA_SCHEMA_PATH}: ${judged.message}` }
          : { code: 'validator_failed', message: judged.message }
      );
    }
    const issues = judged.value;
    if (issues.length > 0) {
      return refuse({
        code: 'sample_invalid',
        message: `${DATA_FILE_PATH} does not follow ${DATA_SCHEMA_PATH}: ${describeIssue(issues[0]!)}`,
        issues
      });
    }
    sample = sampleParsed.data;
  }

  const bound = new Set<string>();
  const unknown: UnknownBinding[] = [];
  const syntax: BindingError[] = [];
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (!isBoundFileEntry(entry) || seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    let buf: Buffer | null;
    try {
      buf = await readBlobCapped(storage, blobKey(workspaceId, entry.sha256), BOUND_FILE_MAX_BYTES);
    } catch {
      return NONE;
    }
    if (!buf) {
      return refuse({
        code: 'bound_file_too_large',
        message: `${entry.path} is larger than the ${BOUND_FILE_MAX_BYTES / (1024 * 1024)} MB a template page may be`
      });
    }
    const source = buf.toString('utf8');
    if (!hasBindingMarkers(source)) continue;
    const judged = await validationBudget().extract(source, schema, entry.path);
    if (!judged.ok) {
      return refuse(
        judged.reason === 'timeout'
          ? {
              code: 'schema_invalid',
              message: `${DATA_SCHEMA_PATH} against ${entry.path}: ${judged.message}`
            }
          : { code: 'validator_failed', message: judged.message }
      );
    }
    if ('errors' in judged.value) {
      syntax.push(...judged.value.errors);
      continue;
    }
    const extracted = judged.value.extracted;
    for (const p of extracted.bound) bound.add(p);
    for (const u of extracted.unknown) unknown.push({ path: u.path, file: entry.path, line: u.line });
  }
  if (syntax.length > 0) {
    const first = syntax[0]!;
    return refuse({
      code: 'binding_syntax',
      message: `${first.file ?? 'a page'} line ${first.line}: ${first.message}`,
      errors: syntax
    });
  }
  if (unknown.length > 0) {
    const first = unknown[0]!;
    return refuse({
      code: 'binding_unknown',
      message: `${first.file} line ${first.line} binds "${first.path}", which ${DATA_SCHEMA_PATH} does not describe`,
      unknown
    });
  }
  return {
    contract: {
      schema,
      schemaVersion: String(schema['version']).trim(),
      sample,
      bindings: [...bound].sort()
    },
    refusal: null
  };
}

function refuse(refusal: ContractRefusal): ContractRead {
  return { contract: null, refusal };
}

export function describeIssue(issue: DataValidationIssue): string {
  return issue.path ? `${issue.path}: ${issue.message}` : issue.message;
}

/** The 400 body of a refused template push: the code, one sentence, and the details that name the file and the line. */
export function contractRefusalBody(
  refusal: ContractRefusal
):
  | { error: { code: string; message: string } }
  | { error: { code: string; message: string; details: Record<string, unknown> } } {
  switch (refusal.code) {
    case 'sample_invalid':
      return { error: { code: refusal.code, message: refusal.message, details: { issues: refusal.issues } } };
    case 'binding_syntax':
      return { error: { code: refusal.code, message: refusal.message, details: { errors: refusal.errors } } };
    case 'binding_unknown':
      return {
        error: { code: refusal.code, message: refusal.message, details: { unknown: refusal.unknown } }
      };
    default:
      return { error: { code: refusal.code, message: refusal.message } };
  }
}

/** What a deck knows about its template, on the wire; null on anything but a document. */
export function documentBindingOf(
  p: Pick<PresentationRow, 'templateId' | 'templateVersion' | 'documentData'>,
  schemaVersion?: string
): { templateId: string; templateVersion: number; schemaVersion: string } | null {
  if (p.templateId === null || p.templateVersion === null) return null;
  return { templateId: p.templateId, templateVersion: p.templateVersion, schemaVersion: schemaVersion ?? '' };
}

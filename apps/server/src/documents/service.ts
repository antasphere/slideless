import { Readable } from 'node:stream';
import { sql } from 'drizzle-orm';
import type { Db, DbConn } from '@antasphere/chassis-db';
import type { Principal } from '@antasphere/chassis-contract';
import {
  ANSWERS_KEY,
  DATA_FILE_PATH,
  DATA_SCHEMA_PATH,
  BOUND_FILE_MAX_BYTES,
  DOCUMENT_DATA_MAX_LENGTH,
  answersOf,
  applyMergePatch,
  hasBindingMarkers,
  parseBindings,
  renderBindings,
  validateDataAgainstSchema,
  withAnswersOf,
  withFormAnswer,
  withoutAnswers,
  type AnsweredMeta,
  type DataValidationIssue,
  type DocumentFormAnswer,
  type ManifestEntry
} from '@slideless/contract';
import type { PresentationRow, PresentationVersionRow } from '@slideless/db';
import type { FileService } from '@antasphere/chassis-server/files';
import type { Logger } from '@antasphere/chassis-server/logger';
import { blobKey, type StorageDriver } from '@antasphere/chassis-server/storage';
import { manifestHasForms } from '../forms/detect.js';
import { isBoundFileEntry, readBlobCapped } from '../presentations/data-contract.js';
import {
  canReadDeck,
  canWriteDeck,
  type DocumentCommitResult,
  type PresentationService
} from '../presentations/service.js';

/**
 * DOCUMENTS (PRDCT-3641): a document is a deck made from a template with
 * data. Every write here is the same motion: take the template version the
 * document is pinned to (or moves to), the data (validated against that
 * version's schema, the `answers` branch the server's), render every bound
 * page of the template against it, store the rendered pages as blobs, and
 * commit a presentation version whose manifest is the template's with the
 * pages replaced and `data.json` at the root. Nothing downstream knows: the
 * viewer, the thumbnails, the pull and the agent index serve a plain deck.
 *
 * The writes of one document are serialized by a transaction-scoped
 * advisory lock on the document's id, so a merge patch always applies to
 * the data the previous write left, and the render it stores is the render
 * of the data it commits.
 */

/** Two-int advisory lock namespace serializing the writes of one document. 7432001-7 are taken (see presentations/service.ts). */
const DOCUMENT_WRITE_LOCK = 7432008;

/** The id of the data block the rendered entry carries: `<script type="application/json" id="slideless-data">`. */
export const DATA_BLOCK_ID = 'slideless-data';

export type DocumentFailure =
  | { code: 'not_found' }
  | { code: 'forbidden' }
  | { code: 'not_a_document' }
  | { code: 'not_a_data_template' }
  | { code: 'template_gone' }
  | { code: 'template_version_invalid'; version: number }
  | { code: 'already_on_version'; version: number }
  | { code: 'data_invalid'; issues: DataValidationIssue[] }
  | { code: 'data_too_large' }
  | { code: 'render_failed'; message: string }
  | { code: 'missing_blobs'; missing: string[] }
  | { code: 'invalid_manifest'; message: string }
  | { code: 'project_not_found'; projectId: string };

export type DocumentWrite =
  | { ok: true; presentation: PresentationRow; version: PresentationVersionRow }
  | { ok: false; failure: DocumentFailure };

/** The template version a document binds to, with its contract. */
export interface TemplateVersionContract {
  row: PresentationVersionRow;
  schema: Record<string, unknown>;
  schemaVersion: string;
  sample: Record<string, unknown> | null;
  bindings: string[];
}

export interface DocumentServiceDeps {
  db: Db;
  storage: StorageDriver;
  fileService: FileService;
  presentations: PresentationService;
  logger: Logger;
  /** Kicked after every write: the new version's still image (PRDCT-2725). */
  onVersion?: (() => void) | undefined;
}

export class DocumentService {
  constructor(private readonly deps: DocumentServiceDeps) {}

  // ── The template's contract ────────────────────────────────────────────────

  /** The contract of one template version; null when that version carries none. */
  async contractOf(
    workspaceId: string,
    templateId: string,
    version: number
  ): Promise<TemplateVersionContract | null> {
    const row = await this.deps.presentations.getVersion(workspaceId, templateId, version);
    if (!row || !row.dataSchema) return null;
    return {
      row,
      schema: row.dataSchema,
      schemaVersion: String(row.dataSchema['version'] ?? '').trim(),
      sample: row.dataSample ?? null,
      bindings: row.dataBindings ?? []
    };
  }

  // ── Rendering ──────────────────────────────────────────────────────────────

  /**
   * The template version's manifest with every bound page resolved against
   * the data and stored as a new blob (uploaded by `uploader`, so the blob is
   * theirs under the read scope), `schema.json` dropped and `data.json`
   * replaced by the data as rendered. The entry page also carries the data
   * block, so a pull or an export keeps what was shown.
   */
  private async render(opts: {
    workspaceId: string;
    template: TemplateVersionContract;
    data: Record<string, unknown>;
    uploader: string;
  }): Promise<{ manifest: ManifestEntry[]; entryPath: string } | { failure: DocumentFailure }> {
    const source = opts.template.row.manifest as ManifestEntry[];
    const entryPath = opts.template.row.entryPath;
    const out: ManifestEntry[] = [];
    const rendered = new Map<string, ManifestEntry>();
    for (const entry of source) {
      if (entry.path === DATA_SCHEMA_PATH || entry.path === DATA_FILE_PATH) continue;
      const bound = isBoundFileEntry(entry);
      const isEntry = entry.path === entryPath;
      if (!bound || (!isEntry && rendered.has(entry.sha256))) {
        out.push(bound ? { ...rendered.get(entry.sha256)!, path: entry.path } : entry);
        continue;
      }
      let buf: Buffer | null;
      try {
        buf = await readBlobCapped(
          this.deps.storage,
          blobKey(opts.workspaceId, entry.sha256),
          BOUND_FILE_MAX_BYTES
        );
      } catch (e) {
        return {
          failure: {
            code: 'render_failed',
            message: `${entry.path} could not be read: ${(e as Error).message}`
          }
        };
      }
      if (!buf)
        return {
          failure: { code: 'render_failed', message: `${entry.path} is larger than the renderer holds` }
        };
      let text = buf.toString('utf8');
      if (hasBindingMarkers(text)) {
        const { parsed, errors } = parseBindings(text, entry.path);
        if (errors.length > 0) {
          const first = errors[0]!;
          return {
            failure: { code: 'render_failed', message: `${entry.path} line ${first.line}: ${first.message}` }
          };
        }
        text = renderBindings(parsed, opts.data);
      }
      if (isEntry) text = withDataBlock(text, opts.data);
      const stored = await this.store(
        opts.workspaceId,
        Buffer.from(text, 'utf8'),
        entry.contentType,
        entry.path,
        opts.uploader
      );
      const next: ManifestEntry = {
        path: entry.path,
        sha256: stored.sha256,
        sizeBytes: stored.sizeBytes,
        contentType: entry.contentType
      };
      if (!isEntry) rendered.set(entry.sha256, next);
      out.push(next);
    }
    const dataBytes = Buffer.from(JSON.stringify(opts.data, null, 2) + '\n', 'utf8');
    const dataStored = await this.store(
      opts.workspaceId,
      dataBytes,
      'application/json',
      DATA_FILE_PATH,
      opts.uploader
    );
    out.push({
      path: DATA_FILE_PATH,
      sha256: dataStored.sha256,
      sizeBytes: dataStored.sizeBytes,
      contentType: 'application/json'
    });
    return { manifest: out, entryPath };
  }

  private async store(
    workspaceId: string,
    bytes: Buffer,
    contentType: string,
    originalName: string,
    uploader: string
  ): Promise<{ sha256: string; sizeBytes: number }> {
    const { file } = await this.deps.fileService.upload({
      workspaceId,
      createdBy: uploader,
      originalName,
      contentType,
      body: Readable.from([bytes]),
      maxBytes: Math.max(bytes.length, 1)
    });
    return { sha256: file.sha256, sizeBytes: file.sizeBytes };
  }

  // ── The writes ─────────────────────────────────────────────────────────────

  /** `POST /presentations/{templateId}/instances`. */
  async createInstance(opts: {
    workspaceId: string;
    principal: Principal;
    templateId: string;
    data: Record<string, unknown>;
    title?: string | undefined;
    projectIds?: string[] | undefined;
  }): Promise<DocumentWrite> {
    const { presentations, db } = this.deps;
    const template = await presentations.get(opts.workspaceId, opts.templateId);
    if (!template || !(await canReadDeck(db, opts.principal, template))) return fail({ code: 'not_found' });
    if (template.referenceType !== 'template' || template.currentVersion < 1)
      return fail({ code: 'not_a_data_template' });
    const contract = await this.contractOf(opts.workspaceId, template.id, template.currentVersion);
    if (!contract) return fail({ code: 'not_a_data_template' });
    const data = withoutAnswers(opts.data);
    const issues = validateDataAgainstSchema(contract.schema, data);
    if (issues.length > 0) return fail({ code: 'data_invalid', issues });
    const rendered = await this.render({
      workspaceId: opts.workspaceId,
      template: contract,
      data,
      uploader: opts.principal.userId
    });
    if ('failure' in rendered) return fail(rendered.failure);
    const result = await presentations.createDocument({
      workspaceId: opts.workspaceId,
      principal: opts.principal,
      template,
      templateVersion: template.currentVersion,
      title: opts.title ?? template.title,
      entryPath: rendered.entryPath,
      manifest: rendered.manifest,
      hasForms: await manifestHasForms(this.deps.storage, opts.workspaceId, rendered.manifest),
      data,
      projectIds: opts.projectIds
    });
    return this.landed(result);
  }

  /** `PUT /presentations/{id}/data`: the whole data replaced, the answers carried over. */
  replaceData(opts: {
    workspaceId: string;
    principal: Principal;
    id: string;
    data: Record<string, unknown>;
  }): Promise<DocumentWrite> {
    return this.write(opts, (current) => withAnswersOf(opts.data, current));
  }

  /** `PATCH /presentations/{id}/data`: a merge patch on the data without its answers, the answers carried over. */
  mergeData(opts: {
    workspaceId: string;
    principal: Principal;
    id: string;
    patch: Record<string, unknown>;
  }): Promise<DocumentWrite> {
    return this.write(opts, (current) => {
      const merged = applyMergePatch(withoutAnswers(current ?? {}), opts.patch);
      const next =
        merged !== null && typeof merged === 'object' && !Array.isArray(merged)
          ? (merged as Record<string, unknown>)
          : {};
      return withAnswersOf(next, current);
    });
  }

  /** `POST /presentations/{id}/upgrade`: the same data rendered against a newer template version. */
  upgrade(opts: {
    workspaceId: string;
    principal: Principal;
    id: string;
    toVersion?: number | undefined;
  }): Promise<DocumentWrite> {
    return this.write(opts, (current) => current ?? {}, { toVersion: opts.toVersion ?? 'latest' });
  }

  /**
   * A form answered through a share link: the response's fields land under
   * `answers.<form>` with who (the link's label) and when, and the document
   * is rendered again. Committed by the server as the owner; a document
   * whose owner's account is gone keeps the response and skips the mirror,
   * said in the log. Never throws into the respondent's answer: the caller
   * catches and logs.
   */
  async applyAnswer(opts: {
    workspaceId: string;
    presentationId: string;
    formName: string;
    fields: Record<string, string | string[]>;
    link: { id: string; name: string | null };
    responseId: string;
    revision: number;
    at: Date;
  }): Promise<DocumentWrite | null> {
    const meta: AnsweredMeta = {
      at: opts.at.toISOString(),
      by: opts.link.name,
      link: opts.link.id,
      response: opts.responseId,
      revision: opts.revision
    };
    return this.locked(opts.workspaceId, opts.presentationId, async (tx, deck) => {
      if (deck.templateId === null || deck.templateVersion === null) return null;
      const contract = await this.contractOf(opts.workspaceId, deck.templateId, deck.templateVersion);
      if (!contract) return fail({ code: 'template_gone' });
      const owner = deck.ownerUserId;
      if (owner === null) {
        this.deps.logger.warn(
          { presentationId: deck.id },
          'documents: the owner is gone, the answer stays in the responses only'
        );
        return null;
      }
      const data = withFormAnswer(deck.documentData ?? {}, opts.formName, opts.fields, meta);
      if (JSON.stringify(data).length > DOCUMENT_DATA_MAX_LENGTH) return fail({ code: 'data_too_large' });
      const rendered = await this.render({
        workspaceId: opts.workspaceId,
        template: contract,
        data,
        uploader: owner
      });
      if ('failure' in rendered) return fail(rendered.failure);
      const result = await this.deps.presentations.commitDocumentVersion({
        workspaceId: opts.workspaceId,
        committer: { system: { ownerUserId: owner } },
        presentationId: deck.id,
        entryPath: rendered.entryPath,
        manifest: rendered.manifest,
        hasForms: await manifestHasForms(this.deps.storage, opts.workspaceId, rendered.manifest),
        data,
        previousData: deck.documentData ?? null,
        templateVersion: deck.templateVersion,
        source: 'answer',
        answered: {
          by: opts.link.name,
          linkId: opts.link.id,
          formName: opts.formName,
          responseId: opts.responseId,
          revision: opts.revision
        },
        conn: tx
      });
      return this.landed(result);
    });
  }

  /**
   * The one write motion: under the document's lock, the current data is
   * read, `next` computes what to validate, the pinned (or the target)
   * template version's schema judges it, the pages are rendered and the
   * version committed on the same transaction.
   */
  private async write(
    opts: { workspaceId: string; principal: Principal; id: string },
    next: (current: Record<string, unknown> | null) => Record<string, unknown>,
    move: { toVersion: number | 'latest' } | null = null
  ): Promise<DocumentWrite> {
    const { db, presentations } = this.deps;
    const result = await this.locked(
      opts.workspaceId,
      opts.id,
      async (tx, deck): Promise<DocumentWrite | null> => {
        if (!(await canReadDeck(db, opts.principal, deck))) return fail({ code: 'not_found' });
        if (!(await canWriteDeck(db, opts.principal, deck))) return fail({ code: 'forbidden' });
        if (deck.templateId === null || deck.templateVersion === null)
          return fail({ code: 'not_a_document' });
        let templateVersion = deck.templateVersion;
        if (move) {
          const template = await presentations.get(opts.workspaceId, deck.templateId);
          if (!template || !(await canReadDeck(db, opts.principal, template)))
            return fail({ code: 'template_gone' });
          templateVersion = move.toVersion === 'latest' ? template.currentVersion : move.toVersion;
          if (templateVersion === deck.templateVersion)
            return fail({ code: 'already_on_version', version: templateVersion });
        }
        const contract = await this.contractOf(opts.workspaceId, deck.templateId, templateVersion);
        if (!contract) {
          return fail(
            move ? { code: 'template_version_invalid', version: templateVersion } : { code: 'template_gone' }
          );
        }
        const current = deck.documentData ?? null;
        const data = next(current);
        if (JSON.stringify(data).length > DOCUMENT_DATA_MAX_LENGTH) return fail({ code: 'data_too_large' });
        const issues = validateDataAgainstSchema(contract.schema, withoutAnswers(data));
        if (issues.length > 0) return fail({ code: 'data_invalid', issues });
        const rendered = await this.render({
          workspaceId: opts.workspaceId,
          template: contract,
          data,
          uploader: opts.principal.userId
        });
        if ('failure' in rendered) return fail(rendered.failure);
        const committed = await presentations.commitDocumentVersion({
          workspaceId: opts.workspaceId,
          committer: { principal: opts.principal },
          presentationId: deck.id,
          entryPath: rendered.entryPath,
          manifest: rendered.manifest,
          hasForms: await manifestHasForms(this.deps.storage, opts.workspaceId, rendered.manifest),
          data,
          previousData: current,
          templateVersion,
          source: move ? 'upgrade' : 'push',
          conn: tx
        });
        return this.landed(committed);
      }
    );
    return result ?? fail({ code: 'not_found' });
  }

  /** Runs `body` in a transaction holding the document's write lock, the deck row re-read under it. */
  private async locked<T>(
    workspaceId: string,
    presentationId: string,
    body: (tx: DbConn, deck: PresentationRow) => Promise<T | null>
  ): Promise<T | null> {
    return this.deps.db.transaction(async (tx) => {
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(${DOCUMENT_WRITE_LOCK}, hashtext(${presentationId}))`
      );
      const deck = await this.deps.presentations.get(workspaceId, presentationId);
      if (!deck) return null;
      return body(tx, deck);
    });
  }

  private landed(result: DocumentCommitResult): DocumentWrite {
    if (!result.ok) return fail(result.failure);
    this.deps.onVersion?.();
    return { ok: true, presentation: result.presentation, version: result.version };
  }

  // ── The template's schema, edited through the API ──────────────────────────

  /**
   * `PUT /presentations/{id}/schema`: a new template version whose manifest
   * is the current one with `schema.json` replaced and `data.json` replaced,
   * kept or removed. The commit path then reads the contract again from the
   * blobs, like a push: the binding check, the sample check and the version
   * rule all apply.
   */
  async templateManifestWith(opts: {
    workspaceId: string;
    template: PresentationRow;
    uploader: string;
    schema: Record<string, unknown>;
    sample: Record<string, unknown> | null | undefined;
  }): Promise<{ manifest: ManifestEntry[]; entryPath: string } | null> {
    const current = await this.deps.presentations.getVersion(
      opts.workspaceId,
      opts.template.id,
      opts.template.currentVersion
    );
    if (!current) return null;
    const manifest = (current.manifest as ManifestEntry[]).filter(
      (e) => e.path !== DATA_SCHEMA_PATH && (opts.sample === undefined || e.path !== DATA_FILE_PATH)
    );
    const schemaStored = await this.store(
      opts.workspaceId,
      Buffer.from(JSON.stringify(opts.schema, null, 2) + '\n'),
      'application/json',
      DATA_SCHEMA_PATH,
      opts.uploader
    );
    manifest.push({
      path: DATA_SCHEMA_PATH,
      sha256: schemaStored.sha256,
      sizeBytes: schemaStored.sizeBytes,
      contentType: 'application/json'
    });
    if (opts.sample) {
      const sampleStored = await this.store(
        opts.workspaceId,
        Buffer.from(JSON.stringify(opts.sample, null, 2) + '\n'),
        'application/json',
        DATA_FILE_PATH,
        opts.uploader
      );
      manifest.push({
        path: DATA_FILE_PATH,
        sha256: sampleStored.sha256,
        sizeBytes: sampleStored.sizeBytes,
        contentType: 'application/json'
      });
    }
    return { manifest, entryPath: current.entryPath };
  }

  // ── Reads ──────────────────────────────────────────────────────────────────

  /** The answers of a document's current data, as the wire lists them. */
  answersOf(deck: PresentationRow): DocumentFormAnswer[] {
    return answersOf(deck.documentData ?? {}).map((a) => ({
      form: a.form,
      fields: a.fields,
      answeredAt: a.meta.at,
      answeredBy: a.meta.by,
      linkId: a.meta.link,
      responseId: a.meta.response,
      revision: a.meta.revision
    }));
  }
}

const fail = (failure: DocumentFailure): DocumentWrite => ({ ok: false, failure });

/**
 * The data block in the rendered entry: a JSON script before `</head>` (else
 * before `<body`, else at the top), `</` and `<!--` escaped so no data value
 * can close the script early. The viewer's sandbox leaves the deck's own
 * script free to read it; an export or a pull keeps it with the page.
 */
export function withDataBlock(html: string, data: Record<string, unknown>): string {
  const json = JSON.stringify(data).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
  const block = `<script type="application/json" id="${DATA_BLOCK_ID}">${json}</script>`;
  const head = html.search(/<\/head\s*>/i);
  if (head !== -1) return html.slice(0, head) + block + html.slice(head);
  const body = html.search(/<body[\s>]/i);
  if (body !== -1) return html.slice(0, body) + block + html.slice(body);
  return block + html;
}

export { ANSWERS_KEY };

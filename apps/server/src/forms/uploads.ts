import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { and, asc, eq, gte, inArray, isNull, lt, sql, sum } from 'drizzle-orm';
import {
  formResponseFiles,
  formResponses,
  type Db,
  type DbConn,
  type FormResponseFileRow,
  type FormResponseFileSnapshot
} from '@slideless/db';
import { FORM_FILE_NAME_MAX_CHARS, type FormSubmitFiles } from '@slideless/contract';
import type { Logger } from '../logger.js';
import { spoolUpload } from '../files/spool.js';
import type { StorageDriver } from '../storage/driver.js';

/**
 * FORM FILE UPLOADS (PRDCT-2403) — the bytes a share-link respondent drops
 * into a form's file field.
 *
 * Containment story:
 *  - APART FROM `files`: these bytes never enter the workspace's
 *    content-addressed pool. No dedupe (so "already present" is never an
 *    existence oracle for an anonymous caller), no `file_uploaders`
 *    possession, no `blobReadScope` question, no in-use guard: each upload
 *    owns its bytes under its own `storage_key`, and nothing a deck version
 *    commit can resolve ever points at them.
 *  - PENDING THEN ATTACHED: the runtime uploads a file when it is dropped
 *    (one request per file, with progress) and the submit then NAMES the
 *    uploads. A pending row is claimable only through the link it came
 *    through, on the form it names, on the deck the link serves — the id is
 *    a 122-bit random handed to the uploader alone, single-use.
 *  - BOUNDED: a per-file ceiling (mid-stream, whatever Content-Length said),
 *    a per-response count ceiling, and a per-deck byte total re-checked
 *    under a per-deck advisory lock at insert — the bound on what a link can
 *    write to the instance's disk. The author's own constraints (accepted
 *    extensions, min/max) are the runtime's, like `required` on a text
 *    field: the server never reads a form's markup.
 *  - REMOVAL IS BLOB FIRST, ROW SECOND: a row whose blob delete failed stays
 *    and is retried by the sweep; a crash between the two leaves a row the
 *    sweep finds, never a blob nothing names.
 *  - SERVED `attachment` + `nosniff`, owner surface only (api/presentations.ts).
 *    The respondent wire carries names and sizes, never a way to read bytes
 *    back: a remembering link's secret must not become a file-sharing URL.
 */

/** Two-int advisory lock namespace (7432001-4 are taken: migrations, last-owner ×2, hub grant). */
const DECK_UPLOADS_LOCK_NAMESPACE = 7432005;

/** A pending upload nobody submitted is purged past this age. */
export const FORM_UPLOAD_PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export class FormUploadsFullError extends Error {
  constructor() {
    super("this deck's form uploads have reached their total size limit");
  }
}

export class EmptyFileError extends Error {
  constructor() {
    super('an uploaded file must not be empty');
  }
}

/** A submit named an upload that is not claimable here (unknown, foreign link/form/deck, or already attached elsewhere). */
export class FormFilesClaimError extends Error {
  constructor(
    public readonly code: 'invalid_files' | 'too_many_files',
    message: string
  ) {
    super(message);
  }
}

/**
 * The display name an upload keeps: the BASENAME of what the browser sent
 * (either separator — a Windows path is one segment to POSIX), control
 * characters and NUL removed, no leading dots (a dotfile on the owner's
 * disk), capped, `file` when nothing survives. Still untrusted text: every
 * sink escapes it, and the CLI never joins it into a path.
 */
export function sanitizeUploadName(raw: string): string {
  const base = raw.split(/[\\/]/).pop() ?? '';
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/^\.+/, '')
    .trim();
  if (cleaned === '') return 'file';
  if (cleaned.length <= FORM_FILE_NAME_MAX_CHARS) return cleaned;
  // Keep the extension when capping: it is what tells the owner what the file is.
  const dot = cleaned.lastIndexOf('.');
  const ext = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : '';
  return cleaned.slice(0, FORM_FILE_NAME_MAX_CHARS - ext.length) + ext;
}

/**
 * One SEGMENT of a zip entry path built from respondent-side text (a field
 * name, a file name): no separators, no control characters, never `.` or
 * `..`, never empty, no trailing dots or spaces (Windows). The archive is
 * unpacked on the owner's disk by tools we do not control, so nothing a
 * respondent typed may steer where an entry lands.
 */
export function zipSegment(raw: string): string {
  const cleaned = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/^\.+/, '_')
    .replace(/[\s.]+$/, '')
    .slice(0, 200);
  return cleaned === '' ? '_' : cleaned;
}

/** `name.ext` → `name (2).ext` until the path is free in `taken` (case-insensitively: macOS, Windows). */
export function uniqueZipPath(dir: string, filename: string, taken: Set<string>): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = `${dir}${filename}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${dir}${stem} (${n})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/** The folder one response's files sit in inside the whole-deck zip: when it was first sent, then its id's head. */
export function responseZipFolder(responseId: string, createdAt: Date): string {
  const stamp = createdAt.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return `${stamp}-${responseId.slice(0, 8)}`;
}

export function formFileSnapshot(rows: FormResponseFileRow[]): FormResponseFileSnapshot[] {
  return rows.map((r) => ({ id: r.id, field: r.fieldName, name: r.filename, sizeBytes: r.sizeBytes }));
}

export interface FormUploadCaps {
  /** Per-file ceiling in bytes; 0 = uploads are off on this instance. */
  maxFileBytes: number;
  maxFilesPerResponse: number;
  maxDeckBytes: number;
}

export function formUploadCaps(env: {
  FORMS_MAX_UPLOAD_MB: number;
  MAX_FILE_SIZE_MB: number;
  FORMS_MAX_FILES_PER_RESPONSE: number;
  FORMS_MAX_UPLOADS_MB_PER_DECK: number;
}): FormUploadCaps {
  const mb = 1024 * 1024;
  return {
    maxFileBytes: Math.min(env.FORMS_MAX_UPLOAD_MB, env.MAX_FILE_SIZE_MB) * mb,
    maxFilesPerResponse: env.FORMS_MAX_FILES_PER_RESPONSE,
    maxDeckBytes: env.FORMS_MAX_UPLOADS_MB_PER_DECK * mb
  };
}

export class FormUploadService {
  constructor(
    private readonly db: Db,
    private readonly storage: StorageDriver,
    private readonly spoolDir: string,
    private readonly logger: Logger,
    readonly caps: FormUploadCaps
  ) {}

  /** Bytes the deck's form uploads weigh now, pending included (they hold disk too). */
  async deckBytes(presentationId: string, conn: DbConn = this.db): Promise<number> {
    const [row] = await conn
      .select({ value: sum(formResponseFiles.sizeBytes) })
      .from(formResponseFiles)
      .where(eq(formResponseFiles.presentationId, presentationId));
    return Number(row?.value ?? 0);
  }

  /**
   * Store one uploaded file as a PENDING row. The caller has resolved the
   * token session and burnt the rate bucket; this enforces the byte caps.
   * Throws FileTooLargeError (mid-stream), EmptyFileError, FormUploadsFullError.
   */
  async upload(opts: {
    workspaceId: string;
    presentationId: string;
    shareTokenId: string;
    formName: string;
    fieldName: string;
    filename: string;
    contentType: string;
    body: Readable;
  }): Promise<FormResponseFileRow> {
    const spool = await spoolUpload(opts.body, this.caps.maxFileBytes, this.spoolDir);
    try {
      if (spool.sizeBytes === 0) throw new EmptyFileError();
      const id = randomUUID();
      const storageKey = `forms/${opts.workspaceId}/${opts.presentationId}/${id}`;
      // Cheap refusal before the bytes move; the authoritative check is the
      // locked one below.
      if ((await this.deckBytes(opts.presentationId)) + spool.sizeBytes > this.caps.maxDeckBytes) {
        throw new FormUploadsFullError();
      }
      await this.storage.put(storageKey, createReadStream(spool.path), {
        contentType: opts.contentType,
        sizeBytes: spool.sizeBytes
      });
      try {
        return await this.db.transaction(async (tx) => {
          // COUNT-then-INSERT is a race on its own (the PRDCT-1335 item 1
          // lesson on the response cap): serialize per deck so N concurrent
          // uploads cannot all pass a nearly-full total.
          await tx.execute(
            sql`select pg_advisory_xact_lock(${DECK_UPLOADS_LOCK_NAMESPACE}, hashtext(${opts.presentationId}))`
          );
          if ((await this.deckBytes(opts.presentationId, tx)) + spool.sizeBytes > this.caps.maxDeckBytes) {
            throw new FormUploadsFullError();
          }
          const [row] = await tx
            .insert(formResponseFiles)
            .values({
              id,
              workspaceId: opts.workspaceId,
              presentationId: opts.presentationId,
              shareTokenId: opts.shareTokenId,
              formName: opts.formName,
              fieldName: opts.fieldName,
              filename: opts.filename,
              contentType: opts.contentType,
              sizeBytes: spool.sizeBytes,
              sha256: spool.sha256,
              storageKey
            })
            .returning();
          if (!row) throw new Error('form upload insert failed');
          return row;
        });
      } catch (e) {
        // No row names these bytes: remove them now or nothing ever will.
        await this.storage.delete(storageKey).catch((err: unknown) => {
          this.logger.error({ err, storageKey }, 'form upload rollback: blob delete failed, blob orphaned');
        });
        throw e;
      }
    } finally {
      await spool.cleanup();
    }
  }

  /** The respondent removes a file they just dropped: PENDING rows of THIS link and form only. */
  async deletePending(id: string, shareTokenId: string, formName: string): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(formResponseFiles)
      .where(
        and(
          eq(formResponseFiles.id, id),
          eq(formResponseFiles.shareTokenId, shareTokenId),
          eq(formResponseFiles.formName, formName),
          isNull(formResponseFiles.responseId)
        )
      )
      .limit(1);
    if (!row) return false;
    await this.remove([row]);
    return true;
  }

  /**
   * Inside the response's own transaction: make the response hold exactly
   * the files the submit names. Already-attached ids stay, pending ids are
   * claimed (same link, same form, same deck — anything else refuses the
   * whole submit), attached files left out are DETACHED and returned so the
   * caller removes their bytes after the commit. Returns the resulting set,
   * in upload order, for the revision's snapshot.
   */
  async claimInTx(
    tx: DbConn,
    opts: {
      responseId: string;
      presentationId: string;
      shareTokenId: string;
      formName: string;
      files: FormSubmitFiles;
    }
  ): Promise<{ current: FormResponseFileRow[]; detached: FormResponseFileRow[] }> {
    const wanted = new Map<string, string>(); // id → field
    for (const [field, ids] of Object.entries(opts.files)) {
      for (const id of ids) {
        if (wanted.has(id)) {
          throw new FormFilesClaimError('invalid_files', 'a file can be named once per response');
        }
        wanted.set(id, field);
      }
    }
    if (wanted.size > this.caps.maxFilesPerResponse) {
      throw new FormFilesClaimError(
        'too_many_files',
        `a response can hold at most ${this.caps.maxFilesPerResponse} files`
      );
    }

    const attached = await tx
      .select()
      .from(formResponseFiles)
      .where(eq(formResponseFiles.responseId, opts.responseId))
      .for('update');
    const attachedIds = new Set(attached.map((r) => r.id));
    const toClaim = [...wanted.keys()].filter((id) => !attachedIds.has(id));

    if (toClaim.length > 0) {
      const claimed = await tx
        .update(formResponseFiles)
        .set({ responseId: opts.responseId, attachedAt: new Date() })
        .where(
          and(
            inArray(formResponseFiles.id, toClaim),
            isNull(formResponseFiles.responseId),
            eq(formResponseFiles.shareTokenId, opts.shareTokenId),
            eq(formResponseFiles.formName, opts.formName),
            eq(formResponseFiles.presentationId, opts.presentationId)
          )
        )
        .returning();
      if (claimed.length !== toClaim.length) {
        // Throwing rolls the whole submit back, the partial claim included.
        throw new FormFilesClaimError(
          'invalid_files',
          'a named file is not an upload of this link and form, or was already submitted'
        );
      }
      // The field a file answers is the one the upload named; a submit that
      // files it under another field is refused rather than silently moved.
      for (const row of claimed) {
        if (row.fieldName !== wanted.get(row.id)) {
          throw new FormFilesClaimError('invalid_files', 'a file was uploaded for another field');
        }
      }
    }
    for (const row of attached) {
      const field = wanted.get(row.id);
      if (field !== undefined && field !== row.fieldName) {
        throw new FormFilesClaimError('invalid_files', 'a file was uploaded for another field');
      }
    }

    const detached = attached.filter((r) => !wanted.has(r.id));
    if (detached.length > 0) {
      await tx
        .update(formResponseFiles)
        .set({ responseId: null, attachedAt: null })
        .where(
          inArray(
            formResponseFiles.id,
            detached.map((r) => r.id)
          )
        );
    }
    const current = await this.listForResponse(opts.responseId, tx);
    return { current, detached };
  }

  async listForResponse(responseId: string, conn: DbConn = this.db): Promise<FormResponseFileRow[]> {
    return conn
      .select()
      .from(formResponseFiles)
      .where(eq(formResponseFiles.responseId, responseId))
      .orderBy(asc(formResponseFiles.createdAt), asc(formResponseFiles.id));
  }

  /** Files of many responses at once (the owner listing's one extra query), keyed by response id. */
  async listForResponses(responseIds: string[]): Promise<Map<string, FormResponseFileRow[]>> {
    const out = new Map<string, FormResponseFileRow[]>();
    if (responseIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(formResponseFiles)
      .where(inArray(formResponseFiles.responseId, responseIds))
      .orderBy(asc(formResponseFiles.createdAt), asc(formResponseFiles.id));
    for (const row of rows) {
      const list = out.get(row.responseId!) ?? [];
      list.push(row);
      out.set(row.responseId!, list);
    }
    return out;
  }

  /** One attached file of one response of one deck — every id bound, or null. */
  async getAttached(
    workspaceId: string,
    presentationId: string,
    responseId: string,
    fileId: string
  ): Promise<FormResponseFileRow | null> {
    const [row] = await this.db
      .select()
      .from(formResponseFiles)
      .where(
        and(
          eq(formResponseFiles.id, fileId),
          eq(formResponseFiles.responseId, responseId),
          eq(formResponseFiles.presentationId, presentationId),
          eq(formResponseFiles.workspaceId, workspaceId)
        )
      )
      .limit(1);
    return row ?? null;
  }

  /**
   * Every attached file of a deck's responses with what names its folder in
   * the whole-deck zip, oldest response first. Bounded by the per-deck
   * response cap × the per-response file cap in theory and by the per-deck
   * byte total in practice.
   */
  async listForDeck(
    workspaceId: string,
    presentationId: string,
    filters: { form?: string | undefined; token?: string | undefined; since?: Date | undefined }
  ): Promise<{ file: FormResponseFileRow; responseCreatedAt: Date }[]> {
    return this.db
      .select({ file: formResponseFiles, responseCreatedAt: formResponses.createdAt })
      .from(formResponseFiles)
      .innerJoin(formResponses, eq(formResponses.id, formResponseFiles.responseId))
      .where(
        and(
          eq(formResponses.presentationId, presentationId),
          eq(formResponses.workspaceId, workspaceId),
          ...(filters.form !== undefined ? [eq(formResponses.formName, filters.form)] : []),
          ...(filters.token !== undefined ? [eq(formResponses.shareTokenId, filters.token)] : []),
          ...(filters.since !== undefined ? [gte(formResponses.updatedAt, filters.since)] : [])
        )
      )
      .orderBy(
        asc(formResponses.createdAt),
        asc(formResponses.id),
        asc(formResponseFiles.createdAt),
        asc(formResponseFiles.id)
      );
  }

  /**
   * Remove UNATTACHED files for good: blob first, row second, under the
   * row's lock. Every caller detaches first (an edit, a response delete's
   * `set null`, a never-submitted upload), and the lock plus the re-check is
   * what keeps the sweep from deleting the bytes of a day-old pending upload
   * a submit is claiming at the same instant: the claim's UPDATE waits on
   * the lock, then finds no row and refuses the submit, instead of attaching
   * a row whose bytes are gone. Best-effort per file — a storage failure
   * keeps the row for the sweep to retry and never fails the request it
   * follows.
   */
  async remove(rows: Pick<FormResponseFileRow, 'id'>[]): Promise<number> {
    let removed = 0;
    for (const { id } of rows) {
      try {
        const done = await this.db.transaction(async (tx) => {
          const [locked] = await tx
            .select()
            .from(formResponseFiles)
            .where(and(eq(formResponseFiles.id, id), isNull(formResponseFiles.responseId)))
            .for('update')
            .limit(1);
          if (!locked) return false;
          await this.storage.delete(locked.storageKey);
          await tx.delete(formResponseFiles).where(eq(formResponseFiles.id, id));
          return true;
        });
        if (done) removed++;
      } catch (err) {
        this.logger.error({ err, fileId: id }, 'form upload removal failed — left for the purge sweep');
      }
    }
    return removed;
  }

  /**
   * The sweep (`form-upload-purge`, nightly): every row no response holds,
   * once older than the pending window — uploads never submitted, files an
   * edit removed whose immediate removal failed, and rows a response or deck
   * delete detached through the `set null` cascade.
   */
  async purgeUnattached(now: Date = new Date(), batch = 500): Promise<number> {
    const cutoff = new Date(now.getTime() - FORM_UPLOAD_PENDING_TTL_MS);
    let total = 0;
    for (;;) {
      const rows = await this.db
        .select()
        .from(formResponseFiles)
        .where(and(isNull(formResponseFiles.responseId), lt(formResponseFiles.createdAt, cutoff)))
        .orderBy(asc(formResponseFiles.createdAt))
        .limit(batch);
      if (rows.length === 0) return total;
      const removed = await this.remove(rows);
      total += removed;
      // Nothing removable in a full batch (storage down): stop, never spin.
      if (removed === 0) return total;
    }
  }
}

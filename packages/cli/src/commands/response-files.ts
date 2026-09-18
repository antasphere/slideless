import { createWriteStream } from 'node:fs';
import { stat, unlink } from 'node:fs/promises';
import { basename, resolve, win32 } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Command } from 'commander';
import { PlatformApiError, type FormResponseFilesZipParams } from '@slideless/sdk';
import type { FormResponse, FormResponseFile } from '@slideless/contract';
import {
  CliUsageError,
  fmtBytes,
  printJson,
  requireApiKey,
  resolveContext,
  table,
  type CliContext,
  type CliIo
} from '../context.js';
import { readCapped, sha256Hex } from '../download.js';
import { streamContained, writeContained } from '../safe-write.js';

/**
 * `slideless response-files` (PRDCT-2403): the files respondents uploaded
 * into a deck form's file fields, brought to the owner's disk.
 *
 * The files of a response are ONE API capability; this command is one of its
 * three clients (with the dashboard and the MCP tool) and calls the same
 * three routes. Everything about a file except its id, size and hash is
 * RESPONDENT input — an anonymous stranger chose the file name and, through
 * the deck's HTML, possibly the field name — and the instance itself may be
 * older than this CLI or hostile (PRDCT-1353). So, in the folder mode:
 *
 *  - no server-provided string is ever joined into a path: each of the four
 *    segments (`<form>/<response>/<field>/<name>`) is reduced to one inert
 *    plain name by `safePathSegment`, and the write goes through
 *    `safe-write.ts` (lexical containment, `realpath` parent check,
 *    `O_NOFOLLOW`, forced 0644) — the reduction is the first guard, the
 *    contained write is the one that holds if the reduction is ever wrong;
 *  - each download is capped at the wire's `sizeBytes` and its sha256 is
 *    verified BEFORE anything touches the disk, exactly as `pull` does for
 *    deck assets.
 *
 * The zip mode streams the server's archive to one file; a name the server
 * chose for it is reduced the same way and written contained in the current
 * directory, a path the caller typed is used verbatim.
 */

/** The longest segment kept: well under every filesystem's 255-byte name limit for multi-byte names. */
const MAX_SEGMENT_CHARS = 120;

/**
 * Reduce one hostile string to ONE inert path segment. Never refuses (one
 * oddly named upload must not abort a whole deck's download): what cannot be
 * kept is replaced.
 *
 * Control characters go first (C0, DEL, C1), then both POSIX and Windows
 * separators are resolved the way `safeDownloadName` does — the basename —
 * so `../../x` is `x` and `C:\Users\me\cv.pdf` is `cv.pdf`. The characters
 * Windows forbids become `_`, a leading run of dots becomes `_` (no dotfile,
 * no `.`/`..`), trailing dots and spaces go (Windows drops them silently,
 * which would alias two names), and an empty result is `_`.
 */
export function safePathSegment(raw: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control characters IS the job here.
  const printable = raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, '');
  const name = basename(win32.basename(printable));
  const cleaned = truncateKeepingExtension(
    name
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/^\.+/, '_')
      .replace(/[\s.]+$/, ''),
    MAX_SEGMENT_CHARS
  );
  return cleaned === '' || cleaned === '.' || cleaned === '..' ? '_' : cleaned;
}

function truncateKeepingExtension(name: string, max: number): string {
  if (name.length <= max) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : '';
  return `${name.slice(0, max - ext.length).replace(/[\s.]+$/, '')}${ext}`;
}

/**
 * `dir/name.ext` → `dir/name (2).ext` until the path is free in `taken`.
 * Case-insensitive: macOS and Windows would otherwise write `CV.pdf` over
 * `cv.pdf`. Two respondents' files never collide (each response has its own
 * folder); two files of one field with the same name do.
 */
export function uniqueRelPath(dir: string, filename: string, taken: Set<string>): string {
  const dot = filename.lastIndexOf('.');
  const stem = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  const prefix = dir === '' ? '' : `${dir}/`;
  let candidate = `${prefix}${filename}`;
  for (let n = 2; taken.has(candidate.toLowerCase()); n++) {
    candidate = `${prefix}${stem} (${n})${ext}`;
  }
  taken.add(candidate.toLowerCase());
  return candidate;
}

/**
 * The folder one response's files sit in: when it was first sent, then the
 * head of its id — the same `20260914-2000-77777777` the server's whole-deck
 * zip uses, so the two modes produce the same tree.
 */
export function responseFolder(response: { id: string; createdAt: string }): string {
  const at = new Date(response.createdAt);
  const head = response.id.slice(0, 8);
  if (Number.isNaN(at.getTime())) return safePathSegment(head);
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
  return safePathSegment(`${stamp}-${head}`);
}

/** The filename a Content-Disposition header carries (RFC 5987 form first), or null. */
export function contentDispositionName(header: string | null): string | null {
  if (!header) return null;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if (star?.[1]) {
    try {
      return decodeURIComponent(star[1].trim());
    } catch {
      // A malformed percent-sequence: fall through to the plain form.
    }
  }
  const plain = header.match(/filename\s*=\s*"([^"]*)"/i) ?? header.match(/filename\s*=\s*([^;]+)/i);
  return plain?.[1] ? plain[1].trim() : null;
}

interface PlannedFile {
  response: FormResponse;
  file: FormResponseFile;
  /** Relative to the destination root, already reduced and deduplicated. */
  relPath: string;
}

interface WrittenFile {
  responseId: string;
  formName: string;
  fileId: string;
  field: string;
  name: string;
  sizeBytes: number;
  sha256: string;
  path: string;
}

/** A server from before file fields answers without `files`. */
function filesOf(response: FormResponse): FormResponseFile[] {
  return (response as { files?: FormResponseFile[] }).files ?? [];
}

function plan(responses: FormResponse[], singleResponse: boolean): PlannedFile[] {
  const taken = new Set<string>();
  const planned: PlannedFile[] = [];
  for (const response of responses) {
    for (const file of filesOf(response)) {
      const field = safePathSegment(file.field);
      const dir = singleResponse
        ? field
        : `${safePathSegment(response.formName)}/${responseFolder(response)}/${field}`;
      planned.push({ response, file, relPath: uniqueRelPath(dir, safePathSegment(file.name), taken) });
    }
  }
  return planned;
}

async function downloadInto(ctx: CliContext, deckId: string, root: string, p: PlannedFile): Promise<string> {
  const { response, file } = p;
  if (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 0) {
    throw new Error(`Refusing ${file.name}: the response declares no valid size for it.`);
  }
  const res = await ctx.client.downloadFormResponseFile(deckId, response.id, file.id);
  const bytes = await readCapped(res, file.sizeBytes, file.name, "the response's");
  const digest = sha256Hex(bytes);
  if (digest !== file.sha256.toLowerCase()) {
    throw new Error(
      `Refusing ${file.name}: the downloaded bytes hash to ${digest}, but the response ` +
        `claims ${file.sha256}.`
    );
  }
  return writeContained(root, p.relPath, bytes);
}

export function registerResponseFilesCommand(program: Command, io: CliIo): void {
  program
    .command('response-files <id> [responseId]')
    .description(
      "Download the files respondents uploaded into a deck's form file fields: every file of the " +
        "deck's responses, or one response's when its id is given. Into a folder by default " +
        '(each file size-capped and sha256-verified), or as one zip with --zip. File and field ' +
        "names are the respondent's raw input."
    )
    .option('--form <name>', 'only files of this form (the data-slideless-form name)')
    .option('--link <tokenId>', 'only files of responses that came through this share token')
    .option('--source <source>', 'only files of direct-link or embedded submissions (link | embed)')
    .option('--placement <label>', 'only files of responses whose serving document carried this ?p= label')
    .option('--since <datetime>', 'only files of responses created or edited at or after this ISO instant')
    .option(
      '--out <dir>',
      'folder to download into (default ./form-files-<deck id head>, or ./response-files-<response id head>)'
    )
    .option(
      '--zip [path]',
      "stream the server's zip to disk instead (default: the server's file name, in the current directory)"
    )
    .action(
      async (
        id: string,
        responseId: string | undefined,
        opts: {
          form?: string;
          link?: string;
          source?: string;
          placement?: string;
          since?: string;
          out?: string;
          zip?: string | boolean;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        if (opts.out !== undefined && opts.zip !== undefined) {
          throw new CliUsageError('Pass either --out <dir> or --zip [path], not both.');
        }
        if (
          responseId !== undefined &&
          (opts.form || opts.link || opts.source !== undefined || opts.placement || opts.since)
        ) {
          throw new CliUsageError(
            '--form, --link, --source, --placement and --since slice a whole deck; they cannot be ' +
              'combined with a responseId.'
          );
        }
        const filters: FormResponseFilesZipParams = {};
        if (opts.form) filters.form = opts.form;
        if (opts.link) filters.token = opts.link;
        if (opts.source !== undefined) {
          if (opts.source !== 'link' && opts.source !== 'embed') {
            throw new CliUsageError('--source must be link or embed');
          }
          filters.source = opts.source;
        }
        if (opts.placement) filters.placement = opts.placement;
        if (opts.since) {
          if (Number.isNaN(Date.parse(opts.since))) {
            throw new CliUsageError('--since must be an ISO datetime, e.g. 2026-01-31T00:00:00Z');
          }
          filters.since = new Date(opts.since).toISOString();
        }

        if (opts.zip !== undefined) {
          return zipMode(ctx, io, id, responseId, filters, opts.zip);
        }

        // Folder mode. The listing IS the manifest: it names every file with
        // its size and hash, so each one is fetched and verified on its own.
        const responses: FormResponse[] = [];
        if (responseId !== undefined) {
          responses.push((await ctx.client.formResponse(id, responseId)).response);
        } else {
          let cursor: string | null = null;
          do {
            const page = await ctx.client.formResponses(id, {
              ...filters,
              limit: 100,
              ...(cursor ? { cursor } : {})
            });
            responses.push(...page.responses);
            cursor = page.nextCursor;
          } while (cursor);
        }
        const planned = plan(responses, responseId !== undefined);
        const root = resolve(
          opts.out ??
            (responseId !== undefined
              ? `response-files-${safePathSegment(responseId.slice(0, 8))}`
              : `form-files-${safePathSegment(id.slice(0, 8))}`)
        );
        if (planned.length === 0) {
          // An empty result is not an error anywhere in this CLI; nothing is
          // created on disk either.
          if (ctx.json) return printJson(io, { mode: 'folder', path: null, files: [], totalBytes: 0 });
          io.out.write(
            responseId !== undefined ? 'This response holds no files.\n' : 'No uploaded files match.\n'
          );
          return;
        }
        const written: WrittenFile[] = [];
        for (const p of planned) {
          const path = await downloadInto(ctx, id, root, p);
          written.push({
            responseId: p.response.id,
            formName: p.response.formName,
            fileId: p.file.id,
            field: p.file.field,
            name: p.file.name,
            sizeBytes: p.file.sizeBytes,
            sha256: p.file.sha256,
            path
          });
        }
        const totalBytes = written.reduce((sum, f) => sum + f.sizeBytes, 0);
        if (ctx.json) return printJson(io, { mode: 'folder', path: root, files: written, totalBytes });
        io.out.write(
          table(
            planned.map((p) => [
              p.relPath,
              fmtBytes(p.file.sizeBytes),
              p.response.id,
              // The name as the respondent sent it, when the path could not keep it.
              p.relPath.endsWith(`/${p.file.name}`) ? '' : `(sent as ${JSON.stringify(p.file.name)})`
            ])
          )
        );
        io.out.write(
          `Downloaded ${written.length} file${written.length === 1 ? '' : 's'} ` +
            `(${fmtBytes(totalBytes)}) → ${root}\n`
        );
      }
    );
}

async function zipMode(
  ctx: CliContext,
  io: CliIo,
  id: string,
  responseId: string | undefined,
  filters: FormResponseFilesZipParams,
  zip: string | boolean
): Promise<void> {
  let res: Response;
  try {
    res =
      responseId !== undefined
        ? await ctx.client.downloadFormResponseFilesZip(id, responseId)
        : await ctx.client.downloadFormResponsesFilesZip(id, filters);
  } catch (e) {
    // The zip routes answer 404 `no_files` when nothing matches: the same
    // empty result the folder mode reports, not a failure.
    if (e instanceof PlatformApiError && e.code === 'no_files') {
      if (ctx.json) return printJson(io, { mode: 'zip', path: null, sizeBytes: 0 });
      io.out.write(
        responseId !== undefined ? 'This response holds no files.\n' : 'No uploaded files match.\n'
      );
      return;
    }
    throw e;
  }
  if (!res.body) throw new Error('The zip response carried no body');
  const source = Readable.fromWeb(res.body as unknown as WebReadableStream);

  let path: string;
  let sizeBytes: number;
  if (typeof zip === 'string') {
    // The caller typed this path — honour it verbatim (as `export --out` does).
    path = resolve(zip);
    try {
      await pipeline(source, createWriteStream(path));
    } catch (e) {
      // A truncated archive must not look like a finished one.
      await unlink(path).catch(() => undefined);
      throw e;
    }
    sizeBytes = (await stat(path)).size;
  } else {
    // The SERVER chose this name (it carries the deck title or the form
    // name): reduce it to one inert segment, force the extension, and write
    // it contained in the current directory — never through a symlink.
    const served = contentDispositionName(res.headers.get('content-disposition'));
    const fallback = `form-files-${safePathSegment((responseId ?? id).slice(0, 8))}.zip`;
    let name = served ? safePathSegment(served) : fallback;
    if (name === '_') name = fallback;
    if (!/\.zip$/i.test(name)) name = `${name}.zip`;
    ({ path, sizeBytes } = await streamContained(resolve('.'), name, source));
  }
  if (ctx.json) return printJson(io, { mode: 'zip', path, sizeBytes });
  io.out.write(`Form files written to ${path} (${fmtBytes(sizeBytes)})\n`);
}

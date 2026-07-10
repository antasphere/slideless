import { createWriteStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import type { Command } from 'commander';
import { PlatformApiError, type ListParams } from '@slideless/sdk';
import { printJson, requireApiKey, resolveContext, type CliIo } from '../context.js';

/**
 * The platform substrate commands inherited from the template: instance
 * discovery, the raw workspace-files surface, and the full export download.
 */

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function registerFileCommands(program: Command, io: CliIo): void {
  program
    .command('instance')
    .description('Show instance discovery (public: name, version, auth methods)')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const info = await ctx.client.instance();
      if (ctx.json) return printJson(io, info);
      io.out.write(
        `${info.name}  v${info.version} (${info.edition})\n` +
          `  setup required: ${info.setupRequired}\n` +
          `  auth methods:   ${info.auth.methods.join(', ')}\n`
      );
    });

  program
    .command('export')
    .description('Download the full workspace export as a zip (key needs data:export)')
    .option('-o, --out <path>', 'write to this path (defaults to export-<date>.zip)')
    .action(async (opts: { out?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      const res = await ctx.client.downloadExport();
      if (!res.body) {
        throw new Error('The export response carried no body');
      }
      const out = opts.out ?? `export-${new Date().toISOString().slice(0, 10)}.zip`;
      // Stream to disk — exports can be large, never buffer (unlike files
      // download, whose objects are capped by MAX_FILE_SIZE_MB).
      await pipeline(Readable.fromWeb(res.body as unknown as WebReadableStream), createWriteStream(out));
      if (ctx.json) return printJson(io, { path: out });
      io.out.write(`Export written to ${out}\n`);
    });

  const files = program.command('files').description('Manage workspace files');

  files
    .command('list')
    .description('List files in the workspace (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.files(params);
      const rows = [...first.files];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.files({ ...params, cursor });
          rows.push(...page.files);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      // The wire shape, so scripts can thread nextCursor (--all drains it to null).
      if (ctx.json) return printJson(io, { files: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No files.\n');
        return;
      }
      for (const f of rows) {
        io.out.write(`${f.id}  ${fmtBytes(f.sizeBytes).padStart(9)}  ${f.originalName}\n`);
      }
      if (nextCursor) {
        io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
      }
    });

  files
    .command('upload <path>')
    .description('Upload a local file')
    .option('--name <name>', 'stored file name (defaults to the local basename)')
    .option('--content-type <type>', 'content type', 'application/octet-stream')
    .action(async (path: string, opts: { name?: string; contentType: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      const bytes = await readFile(path);
      const name = opts.name ?? basename(path);
      const result = await ctx.client.uploadFile(name, new Uint8Array(bytes), opts.contentType);
      if (ctx.json) return printJson(io, result);
      io.out.write(
        `Uploaded ${result.file.originalName} (${fmtBytes(result.file.sizeBytes)})` +
          `${result.deduplicated ? ' [deduplicated]' : ''}\n  id: ${result.file.id}\n`
      );
    });

  files
    .command('download <id>')
    .description('Download a file by id')
    .option('--out <path>', 'write to this path (defaults to the stored name)')
    .action(async (id: string, opts: { out?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const apiKey = requireApiKey(ctx);
      const meta = await ctx.client.file(id);
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const res = await fetchImpl(ctx.client.fileContentUrl(id), {
        headers: { authorization: `Bearer ${apiKey}` }
      });
      if (!res.ok) {
        throw new PlatformApiError(res.status, 'download_failed', `Download failed with ${res.status}`);
      }
      const buf = Buffer.from(await res.arrayBuffer());
      const out = opts.out ?? meta.originalName;
      await writeFile(out, buf);
      io.out.write(`Downloaded ${meta.originalName} → ${out} (${fmtBytes(buf.length)})\n`);
    });

  files
    .command('rm <id>')
    .description('Delete a file by id')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      await ctx.client.deleteFile(id);
      if (ctx.json) return printJson(io, { deleted: id });
      io.out.write(`Deleted ${id}\n`);
    });
}

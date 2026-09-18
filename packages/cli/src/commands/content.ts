import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { PlatformApiError } from '@slideless/sdk';
import {
  AGENT_DOC_PATH,
  deckMasterUrl,
  DOWNLOADS_DIR,
  isAttachmentPath,
  isSafeAssetPath,
  type ManifestEntry,
  type PresentationKind
} from '@slideless/contract';
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
import { detectEntry, readLink, scanDeck, writeLink, LINK_FILENAME, type DeckScan } from '../manifest.js';
import { readCapped, sha256Hex } from '../download.js';
import { writeContained } from '../safe-write.js';
import { startDevServer } from '../devserver.js';
import { isInteractive, openInBrowser, shouldOpenAfterPush } from '../open.js';

/**
 * Authoring commands: push (the 3-step upload protocol, answering with the
 * deck's master page and opening it on a first push), open (the master page
 * of the linked deck), pull (byte-exact round trip), pull-annotations,
 * annotation resolve/reopen, and dev (local sandboxed preview).
 */

const UPLOAD_CONCURRENCY = 4;

/**
 * The per-blob cap the instance documents (`MAX_FILE_SIZE_MB`, 100 by
 * default). Discovery (`GET /api/v1/instance`) does not carry the value on
 * the wire today; when it does, the CLI reads it from `limits.maxFileSizeMb`
 * and this constant is the fallback for older instances.
 */
const DEFAULT_MAX_FILE_SIZE_MB = 100;

/** The instance's per-file cap in bytes: discovery's `limits.maxFileSizeMb` when present, else the documented default. */
async function resolveFileCapBytes(ctx: CliContext): Promise<number> {
  const info = (await ctx.client.instance().catch(() => null)) as {
    limits?: { maxFileSizeMb?: unknown };
  } | null;
  const mb = info?.limits?.maxFileSizeMb;
  const capMb = typeof mb === 'number' && Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_FILE_SIZE_MB;
  return capMb * 1024 * 1024;
}

/**
 * Refuse a file over the instance cap BEFORE the upload session, the
 * precheck or any upload: the instance answers 413 to the oversized blob,
 * but only after its bytes have travelled, and after the smaller files of
 * the same push were already stored. Names the file and the cap.
 */
function refuseOverCap(scan: DeckScan, capBytes: number): void {
  const over = scan.files.find((f) => f.sizeBytes > capBytes);
  if (!over) return;
  throw new CliUsageError(
    `${over.path} is ${fmtBytes(over.sizeBytes)}, over this instance's ${fmtBytes(capBytes)} per-file cap ` +
      '(MAX_FILE_SIZE_MB) — nothing was uploaded. Shrink or drop the file and push again.'
  );
}

/** The attachments of a scan (the `downloads/` entries) and their total size. */
function attachmentsOfScan(scan: DeckScan): { count: number; sizeBytes: number } {
  const files = scan.files.filter((f) => f.attachment);
  return { count: files.length, sizeBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0) };
}

/** The one-line attachments summary printed after a push whose folder carries some. */
function attachmentsLine(a: { count: number; sizeBytes: number }): string {
  return `  Attachments: ${a.count} file${a.count === 1 ? '' : 's'}, ${fmtBytes(a.sizeBytes)} (${DOWNLOADS_DIR}/)\n`;
}

/** One-line nudge printed after a push whose bundle ships no AGENT.md. */
const AGENT_DOC_HINT =
  `  tip: no ${AGENT_DOC_PATH} in this bundle — ship one so agents can brief themselves ` +
  `before rendering (read back with \`slideless agent-doc\`)\n`;

/** The authoring contract's marker (`<form data-slideless-form="name">`), quoted or bare. */
const FORM_NAME_RE = /data-slideless-form\s*=\s*["']?([A-Za-z0-9._-]{1,64})/gi;

/**
 * Best-effort local scan of the pushed HTML and scripts for embedded forms
 * (ADR 022; scripts too, mirroring the server's commit-time detection —
 * a bundled deck injects its form from `app.js`):
 * the CLI reads the bytes it just pushed and collects the form names so the
 * push output can point at `slideless responses`. Purely a hint; any
 * failure yields an empty list and never breaks the push.
 */
async function detectFormNames(scan: DeckScan): Promise<string[]> {
  try {
    const names = new Set<string>();
    for (const file of scan.files) {
      if (file.contentType !== 'text/html' && file.contentType !== 'text/javascript') continue;
      const html = await readFile(file.absPath, 'utf8');
      for (const match of html.matchAll(FORM_NAME_RE)) names.add(match[1]!);
    }
    return [...names];
  } catch {
    return [];
  }
}

/** The one-line collection pointer printed when a pushed deck embeds forms. */
function formsDetectedLine(names: string[], deckId: string): string {
  return `  Forms detected: ${names.join(', ')}. Collect responses with: slideless responses ${deckId}\n`;
}

function toManifest(scan: DeckScan): ManifestEntry[] {
  return scan.files.map((f) => ({
    path: f.path,
    sha256: f.sha256,
    sizeBytes: f.sizeBytes,
    contentType: f.contentType
  }));
}

/** Upload every blob the server reports missing, a few at a time. */
async function uploadMissing(ctx: CliContext, scan: DeckScan): Promise<number> {
  const shas = [...new Set(scan.files.map((f) => f.sha256))];
  const { missing } = await ctx.client.precheckAssets(shas);
  const missingSet = new Set(missing);
  // One representative file per missing hash (dedupe by content).
  const queue = [
    ...new Map(scan.files.filter((f) => missingSet.has(f.sha256)).map((f) => [f.sha256, f])).values()
  ];
  let index = 0;
  const workers = Array.from({ length: Math.min(UPLOAD_CONCURRENCY, queue.length) }, async () => {
    while (index < queue.length) {
      const file = queue[index++]!;
      const bytes = await readFile(file.absPath);
      await ctx.client.uploadAsset(file.sha256, new Uint8Array(bytes), file.contentType);
    }
  });
  await Promise.all(workers);
  return queue.length;
}

export function registerContentCommands(program: Command, io: CliIo): void {
  program
    .command('push [path]')
    .description(
      'Upload a deck folder (or single HTML file) as a new deck, or as a new version of the deck ' +
        `linked via ${LINK_FILENAME} / --id`
    )
    .option('--title <title>', 'deck title (default: existing title, or the folder name)')
    .option('--entry <path>', 'entry document (default: index.html, or the only .html)')
    .option('--kind <kind>', 'presentation | app | plan (new decks only)', 'presentation')
    .option('--interactive', 'mark the deck as embedding interactive content (new decks only)', false)
    .option('--id <deckId>', 'push a new version of this existing deck')
    .option('--new', `force a NEW deck even when ${LINK_FILENAME} links one`, false)
    .option('--open', "open the deck's page in the browser after the push (default: on the first push only)")
    .option('--no-open', 'never open the browser')
    .action(
      async (
        path: string | undefined,
        opts: {
          title?: string;
          entry?: string;
          kind: string;
          interactive: boolean;
          id?: string;
          new: boolean;
          /** --open → true, --no-open → false, neither → undefined. */
          open?: boolean;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const target = path ?? '.';
        const scan = await scanDeck(target);
        const entryPath = detectEntry(scan, opts.entry);
        const manifest = toManifest(scan);
        const totalBytes = scan.files.reduce((sum, f) => sum + f.sizeBytes, 0);
        const attachments = attachmentsOfScan(scan);

        // New deck vs new version: --id wins, then the link file (which must
        // point at THIS instance), then a fresh deck.
        const link = await readLink(scan.rootDir);
        let existingId: string | null = opts.id ?? null;
        if (!existingId && !opts.new && link) {
          if (link.baseUrl === ctx.baseUrl) {
            existingId = link.presentationId;
          } else {
            throw new CliUsageError(
              `${LINK_FILENAME} links this folder to ${link.baseUrl}, but you are pushing to ` +
                `${ctx.baseUrl}. Pass --new to create a fresh deck here, or --id <deckId> to ` +
                'target one explicitly.'
            );
          }
        }

        // The cap, before the first write of either branch (discovery is a
        // public read): a refusal here costs no upload.
        refuseOverCap(scan, await resolveFileCapBytes(ctx));

        if (existingId) {
          const deck = await ctx.client.presentation(existingId);
          const uploaded = await uploadMissing(ctx, scan);
          let committed;
          try {
            committed = await ctx.client.commitVersion(existingId, {
              expectedBaseVersion: deck.currentVersion,
              entryPath,
              manifest,
              ...(opts.title ? { title: opts.title } : {})
            });
          } catch (e) {
            if (e instanceof PlatformApiError && e.code === 'version_conflict') {
              throw new CliUsageError(
                'Someone pushed a new version while this push was running — rerun to retry on top of it.'
              );
            }
            throw e;
          }
          await writeLink(scan.rootDir, { presentationId: existingId, baseUrl: ctx.baseUrl });
          const formNames = await detectFormNames(scan);
          const url = deckMasterUrl(ctx.baseUrl, committed.presentation.id);
          if (ctx.json) {
            return printJson(
              io,
              formNames.length > 0
                ? { ...committed, url, attachments, formsDetected: formNames }
                : { ...committed, url, attachments }
            );
          }
          io.out.write(
            `Pushed "${committed.presentation.title}" → version ${committed.version.version} ` +
              `(${scan.files.length} files, ${fmtBytes(totalBytes)}, ${uploaded} uploaded)\n` +
              `  id: ${committed.presentation.id}\n` +
              `  url: ${url}\n`
          );
          if (attachments.count > 0) io.out.write(attachmentsLine(attachments));
          if (formNames.length > 0) io.out.write(formsDetectedLine(formNames, committed.presentation.id));
          if (!committed.version.hasAgentDoc) io.out.write(AGENT_DOC_HINT);
          openAfterPush(ctx, url, { created: false, flag: opts.open });
          return;
        }

        const kind = opts.kind as PresentationKind;
        if (!['presentation', 'app', 'plan'].includes(kind)) {
          throw new CliUsageError('--kind must be presentation, app, or plan');
        }
        const title = opts.title ?? scan.rootDir.split('/').filter(Boolean).pop() ?? 'Untitled deck';
        const { uploadSession } = await ctx.client.createUploadSession();
        const uploaded = await uploadMissing(ctx, scan);
        const committed = await ctx.client.commitUploadSession(uploadSession.id, {
          title,
          kind,
          interactive: opts.interactive,
          entryPath,
          manifest
        });
        await writeLink(scan.rootDir, {
          presentationId: committed.presentation.id,
          baseUrl: ctx.baseUrl
        });
        const formNames = await detectFormNames(scan);
        const url = deckMasterUrl(ctx.baseUrl, committed.presentation.id);
        if (ctx.json) {
          return printJson(
            io,
            formNames.length > 0
              ? { ...committed, url, attachments, formsDetected: formNames }
              : { ...committed, url, attachments }
          );
        }
        io.out.write(
          `Created "${committed.presentation.title}" at version 1 ` +
            `(${scan.files.length} files, ${fmtBytes(totalBytes)}, ${uploaded} uploaded)\n` +
            `  id: ${committed.presentation.id}\n` +
            `  url: ${url}\n` +
            `  linked: ${join(scan.rootDir, LINK_FILENAME)}\n`
        );
        if (attachments.count > 0) io.out.write(attachmentsLine(attachments));
        if (formNames.length > 0) io.out.write(formsDetectedLine(formNames, committed.presentation.id));
        if (!committed.version.hasAgentDoc) io.out.write(AGENT_DOC_HINT);
        openAfterPush(ctx, url, { created: true, flag: opts.open });
      }
    );

  program
    .command('open [path]')
    .description(`Open the linked deck's page in the browser (reads ${LINK_FILENAME}; --json prints the URL)`)
    .action(async (path: string | undefined, _opts, cmd: Command) => {
      // Backendless like `dev`: the link file carries the instance base URL,
      // so the master URL composes offline — no key, no instance resolution.
      const { json } = resolveContextForDev(cmd, io);
      const rootDir = resolve(path ?? '.');
      const link = await readLink(rootDir);
      if (!link) {
        throw new CliUsageError(
          `No ${LINK_FILENAME} in ${rootDir} — push the folder once (\`slideless push\`) to link it to a deck.`
        );
      }
      // The link file can arrive with a cloned folder, and the platform
      // opener dispatches ANY scheme to its handler (javascript:, file:, a
      // custom protocol). A deck's instance is always http(s); refuse the rest
      // before it reaches the opener (the argv discipline in open.ts covers
      // the shell, not the scheme).
      if (!isHttpUrl(link.baseUrl)) {
        throw new CliUsageError(
          `${LINK_FILENAME} names ${JSON.stringify(link.baseUrl)} as the instance, which is not an ` +
            'http(s) URL — refusing to open it. Fix the file or push the folder again.'
        );
      }
      const url = deckMasterUrl(link.baseUrl, link.presentationId);
      if (json) return printJson(io, { presentationId: link.presentationId, baseUrl: link.baseUrl, url });
      io.out.write(`${url}\n`);
      openInBrowser(io, url);
    });

  program
    .command('agent-doc [id]')
    .description(`Print a deck's ${AGENT_DOC_PATH} briefing (id defaults to the ${LINK_FILENAME} link in .)`)
    .option('--at <version>', 'read this version instead of the latest', (v: string) => parseInt(v, 10))
    .option('--out <file>', 'write to a file instead of stdout')
    .action(async (id: string | undefined, opts: { at?: number; out?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);

      let deckId = id ?? null;
      if (!deckId) {
        const link = await readLink(resolve('.'));
        if (!link) {
          throw new CliUsageError(
            `No deck id given and no ${LINK_FILENAME} found — run \`slideless agent-doc <id>\`.`
          );
        }
        deckId = link.presentationId;
      }

      let content: string;
      try {
        content = await ctx.client.agentDoc(deckId, opts.at);
      } catch (e) {
        if (e instanceof PlatformApiError && e.code === 'agent_doc_not_found') {
          throw new CliUsageError(
            `This deck ships no ${AGENT_DOC_PATH}` +
              `${opts.at !== undefined ? ` at version ${opts.at}` : ''} — add one at the bundle root and push.`
          );
        }
        throw e;
      }

      if (opts.out) {
        const target = resolve(opts.out);
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, content);
        if (ctx.json) return printJson(io, { presentationId: deckId, path: target });
        io.out.write(`Wrote ${AGENT_DOC_PATH} of ${deckId} → ${target}\n`);
        return;
      }
      if (ctx.json) return printJson(io, { presentationId: deckId, content });
      io.out.write(content.endsWith('\n') ? content : `${content}\n`);
    });

  program
    .command('pull [id] [path]')
    .description(
      `Download a deck version to a folder (id defaults to the ${LINK_FILENAME} link in the target)`
    )
    .option('--at <version>', 'pull this version instead of the latest', (v: string) => parseInt(v, 10))
    .action(async (id: string | undefined, path: string | undefined, opts: { at?: number }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);

      // The link file binds a folder to a deck ON ONE INSTANCE. Pulling with
      // a mismatching baseUrl is the mistake push already refuses (CLI-13):
      // overwriting a folder's contents — and its link — with a same-id deck
      // from a FOREIGN instance.
      const linkMismatch = (linked: string): CliUsageError =>
        new CliUsageError(
          `${LINK_FILENAME} links this folder to ${linked}, but you are pulling from ` +
            `${ctx.baseUrl}. Pull into a different folder, or delete ${LINK_FILENAME} first.`
        );

      let deckId = id ?? null;
      let dest = path ?? null;
      if (!deckId) {
        const link = await readLink(resolve(dest ?? '.'));
        if (!link) {
          throw new CliUsageError(
            `No deck id given and no ${LINK_FILENAME} found — run \`slideless pull <id> [path]\`.`
          );
        }
        if (link.baseUrl !== ctx.baseUrl) throw linkMismatch(link.baseUrl);
        deckId = link.presentationId;
        dest = dest ?? '.';
      }
      dest = dest ?? deckId;
      {
        const link = await readLink(resolve(dest));
        if (link && link.baseUrl !== ctx.baseUrl) throw linkMismatch(link.baseUrl);
      }

      const deck = await ctx.client.presentation(deckId);
      const version = opts.at ?? deck.currentVersion;
      if (version < 1) throw new CliUsageError('This deck has no committed versions yet.');
      const detail = await ctx.client.presentationVersion(deckId, version);

      const destRoot = resolve(dest);
      await mkdir(destRoot, { recursive: true });
      // Every manifest path is re-validated locally (the instance may be
      // older than this CLI, or hostile), every blob is size-capped and
      // hash-verified against the manifest BEFORE it touches the disk, and
      // every write is symlink-refusing + contained (safe-write.ts).
      for (const entry of detail.manifest) {
        if (!isSafeAssetPath(entry.path)) {
          throw new Error(`Refusing to write unsafe manifest path: ${entry.path}`);
        }
        const res = await ctx.client.downloadPresentationAsset(deckId, entry.sha256);
        const bytes = await readCapped(res, entry.sizeBytes, entry.path);
        const digest = sha256Hex(bytes);
        if (digest !== entry.sha256) {
          throw new Error(
            `Refusing ${entry.path}: the downloaded bytes hash to ${digest}, but the manifest ` +
              `claims ${entry.sha256}.`
          );
        }
        await writeContained(destRoot, entry.path, bytes);
      }
      await writeLink(destRoot, { presentationId: deckId, baseUrl: ctx.baseUrl });
      if (ctx.json) {
        return printJson(io, {
          presentation: deck,
          version: detail,
          path: destRoot,
          files: detail.manifest.length
        });
      }
      const pulledAttachments = detail.manifest.filter((e) => isAttachmentPath(e.path)).length;
      io.out.write(
        `Pulled "${deck.title}" v${version} → ${destRoot} (${detail.manifest.length} files` +
          `${pulledAttachments > 0 ? `, ${pulledAttachments} attachment${pulledAttachments === 1 ? '' : 's'}` : ''})\n`
      );
    });

  program
    .command('pull-annotations [id]')
    .description(`List a deck's annotations (id defaults to the ${LINK_FILENAME} link in .)`)
    .option('--version <n>', 'only notes anchored to this version', (v: string) => parseInt(v, 10))
    .option('--status <status>', 'open | resolved')
    .option('--out <file>', 'write the annotations as JSON to this file')
    .action(
      async (
        id: string | undefined,
        opts: { version?: number; status?: string; out?: string },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        let deckId = id ?? null;
        if (!deckId) {
          const link = await readLink(resolve('.'));
          if (!link) {
            throw new CliUsageError(`No deck id given and no ${LINK_FILENAME} in the current folder.`);
          }
          deckId = link.presentationId;
        }
        if (opts.status && opts.status !== 'open' && opts.status !== 'resolved') {
          throw new CliUsageError('--status must be open or resolved');
        }
        const params = {
          ...(opts.version !== undefined ? { version: opts.version } : {}),
          ...(opts.status ? { status: opts.status as 'open' | 'resolved' } : {})
        };
        const rows = [];
        let cursor: string | null = null;
        do {
          const page = await ctx.client.annotations(deckId, {
            ...params,
            ...(cursor ? { cursor } : {})
          });
          rows.push(...page.annotations);
          cursor = page.nextCursor;
        } while (cursor);

        if (opts.out) {
          await writeFile(resolve(opts.out), `${JSON.stringify(rows, null, 2)}\n`);
        }
        if (ctx.json) return printJson(io, { annotations: rows });
        if (rows.length === 0) {
          io.out.write('No annotations.\n');
          return;
        }
        io.out.write(
          table(
            rows.map((a) => [
              a.id,
              `v${a.version}`,
              a.status,
              a.authorName ?? a.authorUserId ?? 'unknown',
              a.body.length > 60 ? `${a.body.slice(0, 57)}...` : a.body
            ])
          )
        );
        if (opts.out) io.out.write(`Written to ${opts.out}\n`);
      }
    );

  const annotation = program
    .command('annotation')
    .description('Update deck annotations (pull-annotations lists them)');

  annotation
    .command('resolve <id> <annotationId>')
    .description('Mark an annotation resolved')
    .action((id: string, annotationId: string, _opts, cmd: Command) =>
      setAnnotationStatus(cmd, io, id, annotationId, 'resolved')
    );

  annotation
    .command('reopen <id> <annotationId>')
    .description('Reopen a resolved annotation')
    .action((id: string, annotationId: string, _opts, cmd: Command) =>
      setAnnotationStatus(cmd, io, id, annotationId, 'open')
    );

  program
    .command('dev [path]')
    .description(
      'Serve the deck folder locally with the exact viewer sandbox headers + live reload (no backend)'
    )
    .option('--port <n>', 'port to serve on', (v: string) => parseInt(v, 10), 4173)
    .option('--entry <path>', 'entry document (default: index.html, or the only .html)')
    .option('--no-open', 'do not open the browser')
    .action(
      async (
        path: string | undefined,
        opts: { port: number; entry?: string; open: boolean },
        cmd: Command
      ) => {
        const ctx = resolveContextForDev(cmd, io);
        const target = path ?? '.';
        const scan = await scanDeck(target);
        const entryPath = detectEntry(scan, opts.entry);
        const server = await startDevServer({
          root: scan.rootDir,
          entryPath,
          port: opts.port
        });
        if (ctx.json) {
          io.out.write(`${JSON.stringify({ url: server.url, entry: entryPath })}\n`);
        } else {
          io.out.write(
            `Serving ${scan.rootDir} at ${server.url} (entry: ${entryPath})\n` +
              'Live reload on; sandbox headers match the public viewer. Ctrl-C to stop.\n'
          );
        }
        if (opts.open) openInBrowser(io, server.url);
        // Serve until the process is interrupted.
        await new Promise<void>((resolvePromise) => {
          const stop = () => {
            void server.close().finally(() => resolvePromise());
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      }
    );
}

/**
 * The push's browser open (open.ts has the matrix): a first push opens the
 * master page, a later push prints it, `--open` / `--no-open` decide, and a
 * `--json` or piped run never opens. The human line says what happened so
 * a person who did not expect a browser knows which flag turns it off.
 */
function openAfterPush(
  ctx: CliContext,
  url: string,
  input: { created: boolean; flag: boolean | undefined }
): void {
  if (!shouldOpenAfterPush({ ...input, json: ctx.json, interactive: isInteractive(ctx.io) })) return;
  ctx.io.out.write('  opened in your browser (--no-open to skip)\n');
  openInBrowser(ctx.io, url);
}

/** One PATCH behind both status verbs: `annotation resolve` / `annotation reopen`. */
async function setAnnotationStatus(
  cmd: Command,
  io: CliIo,
  id: string,
  annotationId: string,
  status: 'open' | 'resolved'
): Promise<void> {
  const ctx = resolveContext(cmd, io);
  await requireApiKey(ctx);
  const updated = await ctx.client.updateAnnotation(id, annotationId, { status });
  if (ctx.json) return printJson(io, updated);
  io.out.write(`Annotation ${updated.id} ${status === 'resolved' ? 'resolved' : 'reopened'}.\n`);
}

/** Whether a link file's instance is an http(s) origin the opener may be handed. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** `dev` is backendless: only the --json flag matters, never URL/key. */
function resolveContextForDev(cmd: Command, _io: CliIo): { json: boolean } {
  const opts = cmd.optsWithGlobals() as { json?: boolean };
  return { json: Boolean(opts.json) };
}

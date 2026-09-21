import type { Command } from 'commander';
import type { ListParams, PresentationListParams } from '@slideless/sdk';
import { CliUsageError, drainPages, fmtBytes, printJson, table, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext } from '../cli.js';
import { provenanceOf } from '../references.js';
import { provenanceLine } from './content.js';
import { withProjectRefusal, projectsLine, projectsOf } from './projects.js';

/** Deck management: list / get / versions / meta / delete. */

/**
 * `--set k=v` value parsing: JSON when it parses (numbers, booleans, arrays,
 * objects, quoted strings), the raw string otherwise — so `--set priority=3`
 * stores a number and `--set client=Acme` stores a string.
 */
function parseSetPair(pair: string): [string, unknown] {
  const eq = pair.indexOf('=');
  if (eq <= 0) throw new CliUsageError(`--set expects key=value, got "${pair}"`);
  const key = pair.slice(0, eq);
  const raw = pair.slice(eq + 1);
  try {
    return [key, JSON.parse(raw)];
  } catch {
    return [key, raw];
  }
}

const collect = (value: string, all: string[]): string[] => [...all, value];

export function registerDeckCommands(program: Command, io: CliIo): void {
  program
    .command('list')
    .description('List presentations (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .option('--project <id>', 'only the decks in this project')
    .action(
      async (opts: { cursor?: string; limit?: number; all: boolean; project?: string }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const params: PresentationListParams = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        if (opts.project !== undefined) params.project = opts.project;
        const listed = (p: PresentationListParams) =>
          withProjectRefusal(opts.project, () => ctx.client.presentations(p));
        const first = await listed(params);
        const rows = opts.all
          ? await drainPages({ rows: first.presentations, nextCursor: first.nextCursor }, async (cursor) => {
              const page = await listed({ ...params, cursor });
              return { rows: page.presentations, nextCursor: page.nextCursor };
            })
          : [...first.presentations];
        const nextCursor = opts.all ? null : first.nextCursor;
        if (ctx.json) return printJson(io, { presentations: rows, nextCursor });
        if (rows.length === 0) {
          io.out.write('No presentations.\n');
          return;
        }
        // The projects column appears only when a row has something in it:
        // a workspace that uses no project keeps byte-for-byte the table it
        // has always had (the title stays the last, unpadded cell).
        const anyProjects = rows.some((p) => projectsOf(p).length > 0);
        io.out.write(
          table(
            rows.map((p) => [
              p.id,
              `v${p.currentVersion}`,
              p.kind,
              p.title,
              ...(anyProjects ? [projectsLine(projectsOf(p))] : [])
            ])
          )
        );
        if (nextCursor) {
          io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
      }
    );

  program
    .command('get <id>')
    .description('Show one presentation (metadata + latest version)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deck = await ctx.client.presentation(id);
      if (ctx.json) return printJson(io, deck);
      const metaKeys = Object.keys(deck.metadata);
      const references = provenanceOf(deck.metadata);
      const reference = deck.reference
        ? `${deck.reference.type} · ${deck.audience}${deck.defaultReference ? ' · the workspace default' : ''}`
        : 'no (an ordinary deck)';
      io.out.write(
        `${deck.title}\n` +
          `  id:        ${deck.id}\n` +
          `  kind:      ${deck.kind}${deck.interactive ? ' (interactive)' : ''}\n` +
          `  version:   ${deck.currentVersion}\n` +
          `  entry:     ${deck.entryPath}\n` +
          `  agent doc: ${deck.hasAgentDoc ? 'yes (slideless agent-doc)' : 'no'}\n` +
          `  reference: ${reference}\n` +
          (projectsOf(deck).length > 0 ? `  projects:  ${projectsLine(projectsOf(deck))}\n` : '') +
          (references.length > 0 ? `  made from: ${provenanceLine(references)}\n` : '') +
          `  metadata:  ${metaKeys.length === 0 ? '(none)' : `${metaKeys.length} key(s) — slideless meta ${deck.id}`}\n` +
          `  owner:     ${deck.ownerUserId ?? '(deleted user)'}\n` +
          `  created:   ${deck.createdAt}\n` +
          `  updated:   ${deck.updatedAt}\n`
      );
    });

  program
    .command('meta <id>')
    .description("Show or edit a deck's metadata object (the seam for building your own dashboard)")
    .option(
      '--set <key=value>',
      'set one key (repeatable; values parse as JSON when valid, else string)',
      collect,
      []
    )
    .option('--unset <key>', 'remove one key (repeatable)', collect, [])
    .option('--replace <object>', 'replace the WHOLE metadata object with this JSON')
    .action(async (id: string, opts: { set: string[]; unset: string[]; replace?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const editing = opts.set.length > 0 || opts.unset.length > 0 || opts.replace !== undefined;
      if (opts.replace !== undefined && (opts.set.length > 0 || opts.unset.length > 0)) {
        throw new CliUsageError('--replace cannot be combined with --set/--unset');
      }

      if (!editing) {
        const deck = await ctx.client.presentation(id);
        if (ctx.json) return printJson(io, deck.metadata);
        io.out.write(`${JSON.stringify(deck.metadata, null, 2)}\n`);
        return;
      }

      let metadata: Record<string, unknown>;
      if (opts.replace !== undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(opts.replace);
        } catch {
          throw new CliUsageError('--replace expects valid JSON');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new CliUsageError('--replace expects a JSON object');
        }
        metadata = parsed as Record<string, unknown>;
      } else {
        // Read-modify-write: the server's PATCH replaces wholesale, so the
        // merge happens here on the freshly read object.
        const deck = await ctx.client.presentation(id);
        metadata = { ...deck.metadata };
        for (const pair of opts.set) {
          const [key, value] = parseSetPair(pair);
          metadata[key] = value;
        }
        for (const key of opts.unset) delete metadata[key];
      }

      const updated = await ctx.client.updatePresentation(id, { metadata });
      if (ctx.json) return printJson(io, updated.metadata);
      io.out.write(
        `Updated metadata of "${updated.title}" (${Object.keys(updated.metadata).length} key(s)):\n` +
          `${JSON.stringify(updated.metadata, null, 2)}\n`
      );
    });

  program
    .command('versions <id>')
    .description("List a deck's version history (newest first, cursor-paginated)")
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (id: string, opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.presentationVersions(id, params);
      const rows = [...first.versions];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.presentationVersions(id, { ...params, cursor });
          rows.push(...page.versions);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { versions: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No versions.\n');
        return;
      }
      io.out.write(
        table(
          rows.map((v) => [
            `v${v.version}`,
            v.createdAt,
            fmtBytes(v.sizeBytes),
            `${v.fileCount} file${v.fileCount === 1 ? '' : 's'}`,
            `${v.createdBy ?? '(deleted user)'} (${v.createdByRole})`
          ])
        )
      );
      if (nextCursor) {
        io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
      }
    });

  program
    .command('delete <id>')
    .description('Delete a presentation (soft delete; versions and share links stop resolving)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deck = await ctx.client.deletePresentation(id);
      if (ctx.json) return printJson(io, deck);
      io.out.write(`Deleted "${deck.title}" (${deck.id}).\n`);
    });
}

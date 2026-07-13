import type { Command } from 'commander';
import type { ListParams } from '@slideless/sdk';
import { printJson, requireApiKey, resolveContext, table, type CliIo } from '../context.js';

/** Deck management: list / get / delete. */

export function registerDeckCommands(program: Command, io: CliIo): void {
  program
    .command('list')
    .description('List presentations (newest first, cursor-paginated)')
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.presentations(params);
      const rows = [...first.presentations];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.presentations({ ...params, cursor });
          rows.push(...page.presentations);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { presentations: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No presentations.\n');
        return;
      }
      io.out.write(table(rows.map((p) => [p.id, `v${p.currentVersion}`, p.kind, p.title])));
      if (nextCursor) {
        io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
      }
    });

  program
    .command('get <id>')
    .description('Show one presentation (metadata + latest version)')
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deck = await ctx.client.presentation(id);
      if (ctx.json) return printJson(io, deck);
      io.out.write(
        `${deck.title}\n` +
          `  id:       ${deck.id}\n` +
          `  kind:     ${deck.kind}${deck.interactive ? ' (interactive)' : ''}\n` +
          `  version:  ${deck.currentVersion}\n` +
          `  entry:    ${deck.entryPath}\n` +
          `  owner:    ${deck.ownerUserId ?? '(deleted user)'}\n` +
          `  created:  ${deck.createdAt}\n` +
          `  updated:  ${deck.updatedAt}\n`
      );
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

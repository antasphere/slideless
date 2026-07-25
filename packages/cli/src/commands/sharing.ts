import type { Command } from 'commander';
import type { ListParams } from '@slideless/sdk';
import { badgePositionSchema, type BadgePositionValue, type ShareTokenCreate } from '@slideless/contract';
import { CliUsageError, printJson, requireApiKey, resolveContext, table, type CliIo } from '../context.js';

const BADGE_POSITIONS = badgePositionSchema.options.join(' | ');

function parseBadgePosition(v: string): BadgePositionValue {
  const parsed = badgePositionSchema.safeParse(v);
  if (!parsed.success) {
    throw new CliUsageError(`--badge-position must be one of: ${BADGE_POSITIONS}`);
  }
  return parsed.data;
}

/**
 * Sharing (per-recipient tokens) + per-deck dev collaborators.
 * The share URL / secret appears ONCE at creation — the CLI prints it and it
 * is never retrievable again (hash-only storage server-side).
 */

function shareOptionsOf(opts: {
  name?: string;
  toVersion?: number;
  annotator: boolean;
  badgePosition?: BadgePositionValue;
  expires?: string;
  password?: string;
}): ShareTokenCreate {
  if (opts.expires && Number.isNaN(Date.parse(opts.expires))) {
    throw new CliUsageError('--expires must be an ISO datetime, e.g. 2026-12-31T23:59:59Z');
  }
  return {
    name: opts.name ?? 'cli',
    versionMode: opts.toVersion !== undefined ? 'pinned' : 'latest',
    ...(opts.toVersion !== undefined ? { pinnedVersion: opts.toVersion } : {}),
    canAnnotate: opts.annotator,
    ...(opts.badgePosition !== undefined ? { badgePosition: opts.badgePosition } : {}),
    ...(opts.expires ? { expiresAt: new Date(opts.expires).toISOString() } : {}),
    ...(opts.password ? { password: opts.password } : {})
  };
}

export function registerSharingCommands(program: Command, io: CliIo): void {
  program
    .command('share <id>')
    .description('Create a per-recipient share link (prints the viewer URL — shown once)')
    .option('--name <name>', 'owner-facing recipient label', 'cli')
    .option('--to-version <n>', 'pin the recipient to this version', (v: string) => parseInt(v, 10))
    .option('--annotator', 'let the recipient annotate', false)
    .option(
      '--badge-position <slot>',
      `annotation badge slot (${BADGE_POSITIONS}); remembered as the deck default`,
      parseBadgePosition
    )
    .option('--expires <datetime>', 'ISO expiry, e.g. 2026-12-31T23:59:59Z')
    .option('--password <password>', 'viewer password (min 4 chars)')
    .action(
      async (
        id: string,
        opts: {
          name: string;
          toVersion?: number;
          annotator: boolean;
          badgePosition?: BadgePositionValue;
          expires?: string;
          password?: string;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const created = await ctx.client.createShareToken(id, shareOptionsOf(opts));
        if (ctx.json) return printJson(io, created);
        io.out.write(
          `${created.url}\n` +
            `  token: ${created.shareToken.id} ("${created.shareToken.name}", ` +
            `${created.shareToken.versionMode}${created.shareToken.pinnedVersion ? ` v${created.shareToken.pinnedVersion}` : ''}` +
            `${created.shareToken.canAnnotate ? ', annotator' : ''}` +
            `${created.shareToken.hasPassword ? ', password' : ''})\n` +
            '  The URL is shown once — copy it now.\n'
        );
      }
    );

  program
    .command('unshare <id>')
    .description('Revoke one share token (--token) or ALL active tokens of the deck')
    .option('--token <tokenId>', 'revoke only this token')
    .action(async (id: string, opts: { token?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (opts.token) {
        const revoked = await ctx.client.revokeShareToken(id, opts.token);
        if (ctx.json) return printJson(io, revoked);
        io.out.write(`Revoked share token ${revoked.id} ("${revoked.name}").\n`);
        return;
      }
      const revoked: string[] = [];
      let cursor: string | null = null;
      do {
        const page = await ctx.client.shareTokens(id, cursor ? { cursor } : {});
        for (const token of page.shareTokens) {
          if (!token.revokedAt) {
            await ctx.client.revokeShareToken(id, token.id);
            revoked.push(token.id);
          }
        }
        cursor = page.nextCursor;
      } while (cursor);
      if (ctx.json) return printJson(io, { revoked });
      io.out.write(
        revoked.length === 0
          ? 'No active share tokens to revoke.\n'
          : `Revoked ${revoked.length} share token${revoked.length === 1 ? '' : 's'}.\n`
      );
    });

  program
    .command('share-email <id>')
    .description('Create a personal share link per recipient and email it (one token per address)')
    .requiredOption('--to <email...>', 'recipient email(s)')
    .option('--to-version <n>', 'pin recipients to this version', (v: string) => parseInt(v, 10))
    .option('--annotator', 'let recipients annotate', false)
    .option(
      '--badge-position <slot>',
      `annotation badge slot (${BADGE_POSITIONS}); remembered as the deck default`,
      parseBadgePosition
    )
    .option('--expires <datetime>', 'ISO expiry')
    .option('--password <password>', 'viewer password (tell recipients separately)')
    .option('--message <text>', 'personal note included in the email')
    .action(
      async (
        id: string,
        opts: {
          to: string[];
          toVersion?: number;
          annotator: boolean;
          badgePosition?: BadgePositionValue;
          expires?: string;
          password?: string;
          message?: string;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const results: Array<{ email: string; tokenId: string; emailSent: boolean }> = [];
        for (const email of opts.to) {
          const created = await ctx.client.createShareToken(id, shareOptionsOf({ ...opts, name: email }));
          const sent = await ctx.client.sendShareToken(id, created.shareToken.id, {
            email,
            ...(opts.message ? { message: opts.message } : {})
          });
          results.push({ email, tokenId: created.shareToken.id, emailSent: sent.emailSent });
        }
        if (ctx.json) return printJson(io, { sent: results });
        io.out.write(
          table(results.map((r) => [r.email, r.tokenId, r.emailSent ? 'sent' : 'NOT SENT (no email driver)']))
        );
      }
    );

  program
    .command('pin <id> <tokenId>')
    .description('Pin a share token to a version, or set it back to following the latest')
    .option('--to-version <n>', 'freeze the recipient on this version', (v: string) => parseInt(v, 10))
    .option('--latest', 'follow the latest version again', false)
    .action(
      async (id: string, tokenId: string, opts: { toVersion?: number; latest: boolean }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        if (opts.latest === (opts.toVersion !== undefined)) {
          throw new CliUsageError('Pass exactly one of --to-version <n> or --latest.');
        }
        const patch =
          opts.toVersion !== undefined
            ? ({ versionMode: 'pinned', pinnedVersion: opts.toVersion } as const)
            : ({ versionMode: 'latest' } as const);
        const updated = await ctx.client.updateShareToken(id, tokenId, patch);
        if (ctx.json) return printJson(io, updated);
        io.out.write(
          updated.versionMode === 'pinned'
            ? `Token ${updated.id} pinned to v${updated.pinnedVersion}.\n`
            : `Token ${updated.id} now follows the latest version.\n`
        );
      }
    );

  program
    .command('tokens <id>')
    .description("List a deck's share tokens with access stats (newest first, cursor-paginated)")
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (id: string, opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.shareTokens(id, params);
      const rows = [...first.shareTokens];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.shareTokens(id, { ...params, cursor });
          rows.push(...page.shareTokens);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { shareTokens: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No share tokens.\n');
        return;
      }
      io.out.write(
        table(
          rows.map((t) => [
            t.id,
            t.name,
            `${t.accessCount} open${t.accessCount === 1 ? '' : 's'}`,
            t.lastAccessedAt ?? 'never',
            t.versionMode === 'pinned' ? `pinned v${t.pinnedVersion}` : 'latest',
            [t.canAnnotate ? 'annotator' : null, t.hasPassword ? 'password' : null]
              .filter(Boolean)
              .join(', ') || '-',
            t.expiresAt ? `expires ${t.expiresAt}` : '-',
            t.revokedAt ? 'revoked' : 'active'
          ])
        )
      );
      if (nextCursor) {
        io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
      }
    });

  program
    .command('views <id> [tokenId]')
    .description(
      'Per-view stats of a share link: when it was opened, the referring site, the ?p= placement ' +
        'label, and the browser family (no IPs, no full URLs — never stored). Omit tokenId to see ' +
        'which links exist.'
    )
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(
      async (
        id: string,
        tokenId: string | undefined,
        opts: { cursor?: string; limit?: number; all: boolean },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);

        // No tokenId: show the deck's tokens so the caller knows what to
        // drill into — same shape as `tokens`, plus the drill-in hint.
        if (!tokenId) {
          const tokens: Array<{ id: string; name: string; accessCount: number; revokedAt: string | null }> =
            [];
          let cursor: string | null = opts.cursor ?? null;
          do {
            const page = await ctx.client.shareTokens(id, cursor ? { cursor } : {});
            tokens.push(...page.shareTokens);
            cursor = page.nextCursor;
          } while (cursor);
          if (ctx.json) return printJson(io, { shareTokens: tokens });
          if (tokens.length === 0) {
            io.out.write('No share tokens on this deck yet — nothing to drill into.\n');
            return;
          }
          io.out.write(
            table(
              tokens.map((t) => [
                t.id,
                t.name,
                `${t.accessCount} open${t.accessCount === 1 ? '' : 's'}`,
                t.revokedAt ? 'revoked' : 'active'
              ])
            )
          );
          io.out.write(`Pick one: slideless views ${id} <tokenId>\n`);
          return;
        }

        const params: ListParams = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        const first = await ctx.client.shareTokenViews(id, tokenId, params);
        const rows = [...first.views];
        if (opts.all) {
          let cursor = first.nextCursor;
          while (cursor) {
            const page = await ctx.client.shareTokenViews(id, tokenId, { ...params, cursor });
            rows.push(...page.views);
            cursor = page.nextCursor;
          }
        }
        const nextCursor = opts.all ? null : first.nextCursor;
        if (ctx.json) return printJson(io, { views: rows, nextCursor });
        if (rows.length === 0) {
          io.out.write('No recorded views yet (only counted opens appear — see the docs).\n');
          return;
        }
        io.out.write(
          table(
            rows.map((v) => [
              v.occurredAt,
              v.referrerHost ?? 'direct',
              v.placement ? `p:${v.placement}` : '-',
              v.uaFamily ?? '-',
              `v${v.version}`
            ])
          )
        );
        if (nextCursor) {
          io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
      }
    );

  program
    .command('invite <id>')
    .description('Invite a dev collaborator to one deck (prints the claim link)')
    .requiredOption('--email <email>', 'invitee email')
    .action(async (id: string, opts: { email: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const invited = await ctx.client.inviteCollaborator(id, { email: opts.email });
      if (ctx.json) return printJson(io, invited);
      io.out.write(
        `Invited ${opts.email} as a dev collaborator (grant ${invited.collaborator.id}).\n` +
          `  claim link: ${invited.claimUrl}\n` +
          `  email: ${invited.emailSent ? 'sent' : 'NOT sent (no email driver) — share the link yourself'}\n`
      );
    });

  program
    .command('uninvite <id> <collaboratorId>')
    .description('Revoke a collaborator grant (pending or active)')
    .action(async (id: string, collaboratorId: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const revoked = await ctx.client.removeCollaborator(id, collaboratorId);
      if (ctx.json) return printJson(io, revoked);
      io.out.write(`Revoked collaborator grant ${revoked.id} (${revoked.email}).\n`);
    });
}

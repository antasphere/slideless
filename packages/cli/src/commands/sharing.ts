import type { Command } from 'commander';
import type { ShareTokenCreate } from '@slideless/contract';
import { CliUsageError, printJson, requireApiKey, resolveContext, table, type CliIo } from '../context.js';

/**
 * Sharing (per-recipient tokens) + per-deck dev collaborators.
 * The share URL / secret appears ONCE at creation — the CLI prints it and it
 * is never retrievable again (hash-only storage server-side).
 */

function shareOptionsOf(opts: {
  name?: string;
  toVersion?: number;
  annotator: boolean;
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
    .option('--expires <datetime>', 'ISO expiry, e.g. 2026-12-31T23:59:59Z')
    .option('--password <password>', 'viewer password (min 4 chars)')
    .action(
      async (
        id: string,
        opts: { name: string; toVersion?: number; annotator: boolean; expires?: string; password?: string },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        requireApiKey(ctx);
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
      requireApiKey(ctx);
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
          expires?: string;
          password?: string;
          message?: string;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        requireApiKey(ctx);
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
        requireApiKey(ctx);
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
    .command('invite <id>')
    .description('Invite a dev collaborator to one deck (prints the claim link)')
    .requiredOption('--email <email>', 'invitee email')
    .action(async (id: string, opts: { email: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
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
      requireApiKey(ctx);
      const revoked = await ctx.client.removeCollaborator(id, collaboratorId);
      if (ctx.json) return printJson(io, revoked);
      io.out.write(`Revoked collaborator grant ${revoked.id} (${revoked.email}).\n`);
    });
}

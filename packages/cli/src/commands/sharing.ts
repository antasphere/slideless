import type { Command } from 'commander';
import type { FormResponseListParams, ListParams } from '@slideless/sdk';
import {
  badgePositionSchema,
  buildEmbedSnippets,
  EMBED_PLACEMENT_RE,
  type BadgePositionValue,
  type FormResponse,
  type ShareTokenCreate
} from '@slideless/contract';
import { CliUsageError, printJson, requireApiKey, resolveContext, table, type CliIo } from '../context.js';
import { readSecretFromStdin } from '../stdin.js';

/** Env fallback for the viewer password — never forces a secret into argv. */
const SHARE_PASSWORD_ENV = 'SLIDELESS_SHARE_PASSWORD';

/**
 * The viewer password, from exactly one source: `--password-stdin` (piped),
 * `--password` (visible in `ps` and the shell history — kept for existing
 * scripts), or the SLIDELESS_SHARE_PASSWORD environment variable.
 */
async function resolveSharePassword(
  io: CliIo,
  opts: { password?: string; passwordStdin?: boolean }
): Promise<string | undefined> {
  if (opts.passwordStdin && opts.password !== undefined) {
    throw new CliUsageError('Pass either --password or --password-stdin, not both.');
  }
  if (opts.passwordStdin) return readSecretFromStdin(io, 'share password');
  if (opts.password !== undefined) return opts.password;
  const fromEnv = io.env[SHARE_PASSWORD_ENV];
  return fromEnv ? fromEnv : undefined;
}

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
  /** Commander --no-forms negation: true by default, false when passed. */
  forms: boolean;
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
    canSubmitForms: opts.forms,
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
    .option('--no-forms', "disallow submitting the deck's embedded forms through this link")
    .option(
      '--badge-position <slot>',
      `annotation badge slot (${BADGE_POSITIONS}); remembered as the deck default`,
      parseBadgePosition
    )
    .option('--expires <datetime>', 'ISO expiry, e.g. 2026-12-31T23:59:59Z')
    .option('--password <password>', `viewer password (min 4 chars; or ${SHARE_PASSWORD_ENV})`)
    .option('--password-stdin', 'read the viewer password from stdin (keeps it out of argv)', false)
    .option('--embed', 'also print the website embed snippets (script+div and plain iframe)', false)
    .option(
      '--placement <label>',
      'placement label baked into the embed snippets (per-view analytics dimension; slug of [A-Za-z0-9._-], max 64)'
    )
    .action(
      async (
        id: string,
        opts: {
          name: string;
          toVersion?: number;
          annotator: boolean;
          forms: boolean;
          badgePosition?: BadgePositionValue;
          expires?: string;
          password?: string;
          passwordStdin: boolean;
          embed: boolean;
          placement?: string;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        if (opts.placement !== undefined && !EMBED_PLACEMENT_RE.test(opts.placement)) {
          throw new CliUsageError('--placement must be 1-64 characters of letters, digits, ".", "_" or "-"');
        }
        const password = await resolveSharePassword(io, opts);
        const created = await ctx.client.createShareToken(
          id,
          shareOptionsOf({ ...opts, ...(password !== undefined ? { password } : {}) })
        );
        // Snippets are producible only NOW (secrets are hash-only at rest);
        // the JSON envelope always carries them so agents that also build
        // websites can pipe the snippet without a second command.
        const embed = buildEmbedSnippets({
          viewerUrl: created.url,
          appOrigin: ctx.baseUrl,
          placement: opts.placement
        });
        if (ctx.json) return printJson(io, { ...created, embed });
        io.out.write(
          `${created.url}\n` +
            `  token: ${created.shareToken.id} ("${created.shareToken.name}", ` +
            `${created.shareToken.versionMode}${created.shareToken.pinnedVersion ? ` v${created.shareToken.pinnedVersion}` : ''}` +
            `${created.shareToken.canAnnotate ? ', annotator' : ''}` +
            `${created.shareToken.hasPassword ? ', password' : ''})\n` +
            '  The URL is shown once — copy it now.\n'
        );
        if (opts.embed || opts.placement !== undefined) {
          io.out.write(
            `\nEmbed (script, responsive):\n${embed.script}\n` +
              `\nEmbed (plain iframe):\n${embed.iframe}\n` +
              '\nPassword-protected links do not render inside embeds; docs: sharing/embedding.\n'
          );
        }
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
    .option('--no-forms', "disallow submitting the deck's embedded forms through these links")
    .option(
      '--badge-position <slot>',
      `annotation badge slot (${BADGE_POSITIONS}); remembered as the deck default`,
      parseBadgePosition
    )
    .option('--expires <datetime>', 'ISO expiry')
    .option('--password <password>', `viewer password (tell recipients separately; or ${SHARE_PASSWORD_ENV})`)
    .option('--password-stdin', 'read the viewer password from stdin (keeps it out of argv)', false)
    .option('--message <text>', 'personal note included in the email')
    .action(
      async (
        id: string,
        opts: {
          to: string[];
          toVersion?: number;
          annotator: boolean;
          forms: boolean;
          badgePosition?: BadgePositionValue;
          expires?: string;
          password?: string;
          passwordStdin: boolean;
          message?: string;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const password = await resolveSharePassword(io, opts);
        const results: Array<{ email: string; tokenId: string; emailSent: boolean }> = [];
        for (const email of opts.to) {
          const created = await ctx.client.createShareToken(
            id,
            shareOptionsOf({ ...opts, name: email, ...(password !== undefined ? { password } : {}) })
          );
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
    .command('responses <id>')
    .description(
      "A deck's embedded-form responses: what viewers submitted through share links and embeds, " +
        'newest first. With no filters, prints the per-form summary (form, link, source, ' +
        'placement, count, last activity), then the most recent rows. Payload cells are the ' +
        "respondent's raw input."
    )
    .option('--form <name>', 'only this form (the data-slideless-form name)')
    .option('--link <tokenId>', 'only responses that came through this share token')
    .option('--source <source>', 'only direct-link or embedded submissions (link | embed)')
    .option('--placement <label>', 'only responses whose serving document carried this ?p= label')
    .option('--since <datetime>', 'only responses created at or after this ISO instant')
    .option('--csv', 'output the listed rows as CSV (one column per payload field)', false)
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(
      async (
        id: string,
        opts: {
          form?: string;
          link?: string;
          source?: string;
          placement?: string;
          since?: string;
          csv: boolean;
          cursor?: string;
          limit?: number;
          all: boolean;
        },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        if (ctx.json && opts.csv) {
          throw new CliUsageError('Pass either --json or --csv, not both.');
        }
        const params: FormResponseListParams = {};
        if (opts.cursor) params.cursor = opts.cursor;
        if (opts.limit !== undefined) params.limit = opts.limit;
        if (opts.form) params.form = opts.form;
        if (opts.link) params.token = opts.link;
        if (opts.source !== undefined) {
          if (opts.source !== 'link' && opts.source !== 'embed') {
            throw new CliUsageError('--source must be link or embed');
          }
          params.source = opts.source;
        }
        if (opts.placement) params.placement = opts.placement;
        if (opts.since) {
          if (Number.isNaN(Date.parse(opts.since))) {
            throw new CliUsageError('--since must be an ISO datetime, e.g. 2026-01-31T00:00:00Z');
          }
          params.since = new Date(opts.since).toISOString();
        }
        const filtered = Boolean(opts.form || opts.link || opts.source || opts.placement || opts.since);

        const fetchRows = async (): Promise<{ rows: FormResponse[]; nextCursor: string | null }> => {
          const first = await ctx.client.formResponses(id, params);
          const rows = [...first.responses];
          if (opts.all) {
            let cursor = first.nextCursor;
            while (cursor) {
              const page = await ctx.client.formResponses(id, { ...params, cursor });
              rows.push(...page.responses);
              cursor = page.nextCursor;
            }
          }
          return { rows, nextCursor: opts.all ? null : first.nextCursor };
        };

        if (opts.csv) {
          const { rows, nextCursor } = await fetchRows();
          io.out.write(responsesCsv(rows));
          // The hint goes to stderr so it never corrupts a piped CSV.
          if (nextCursor) io.err.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
          return;
        }

        if (filtered) {
          const { rows, nextCursor } = await fetchRows();
          if (ctx.json) return printJson(io, { responses: rows, nextCursor });
          if (rows.length === 0) {
            io.out.write('No matching responses.\n');
            return;
          }
          io.out.write(table(rows.map(responseRow)));
          if (nextCursor) io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
          return;
        }

        // No filters: the grouped overview first ("what came in, from
        // where"), then the most recent rows, then the drill-in hint.
        const summary = await ctx.client.formResponsesSummary(id);
        if (summary.total === 0 && !ctx.json) {
          io.out.write(
            'No form responses yet. Forms are <form data-slideless-form="name"> elements in the deck HTML.\n'
          );
          return;
        }
        const { rows, nextCursor } = await fetchRows();
        if (ctx.json) return printJson(io, { summary, responses: rows, nextCursor });
        io.out.write(
          table(
            summary.buckets.map((b) => [
              b.formName,
              b.shareTokenName ?? '-',
              b.source,
              b.placement ? `p:${b.placement}` : '-',
              `${b.count} response${b.count === 1 ? '' : 's'}`,
              b.lastResponseAt
            ])
          )
        );
        io.out.write(`Total: ${summary.total} response${summary.total === 1 ? '' : 's'}\n`);
        if (rows.length > 0) {
          io.out.write('\nRecent responses:\n');
          io.out.write(table(rows.map(responseRow)));
          if (nextCursor) io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
        }
        io.out.write(
          `\nSlice: slideless responses ${id} --form <name> [--link <tokenId>] [--source link|embed] ` +
            '[--placement <label>] [--since <ISO>]; export with --csv\n'
        );
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

// ── Form responses rendering ─────────────────────────────────────────────────

/** One human table row per response; the payload preview stays plain text. */
function responseRow(r: FormResponse): string[] {
  const preview = JSON.stringify(r.payload);
  return [
    r.createdAt,
    r.formName,
    r.shareTokenName ?? r.shareTokenId ?? '-',
    r.source,
    r.placement ? `p:${r.placement}` : '-',
    preview.length > 60 ? `${preview.slice(0, 57)}...` : preview
  ];
}

/**
 * CSV of the listed rows: the attribution columns plus one column per
 * payload field (union across rows, in first-seen order). Repeated-input
 * array values are joined with "; ".
 */
function responsesCsv(rows: FormResponse[]): string {
  const payloadKeys: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    for (const key of Object.keys(r.payload)) {
      if (!seen.has(key)) {
        seen.add(key);
        payloadKeys.push(key);
      }
    }
  }
  const header = ['formName', 'source', 'placement', 'link', 'createdAt', ...payloadKeys];
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) {
    const cells = [
      r.formName,
      r.source,
      r.placement ?? '',
      r.shareTokenName ?? r.shareTokenId ?? '',
      r.createdAt,
      ...payloadKeys.map((key) => {
        const value = r.payload[key];
        return value === undefined ? '' : Array.isArray(value) ? value.join('; ') : value;
      })
    ];
    lines.push(cells.map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/**
 * RFC 4180 quoting plus the formula-injection guard: payload values are RAW
 * respondent input, so any cell starting with '=', '+', '-' or '@' gets a
 * leading apostrophe before it can reach a spreadsheet as a formula.
 *
 * The test runs on the TRIMMED value: Excel, LibreOffice and Sheets all skip
 * leading whitespace before deciding a cell is a formula, so `" =cmd|…"`
 * (space, tab, CR, LF, and the whole Unicode space class) walked straight
 * past a `^[=+\-@]` test on the raw string. The apostrophe still prefixes
 * the value VERBATIM — the guard changes what a spreadsheet does with the
 * cell, never what the cell says.
 */
function csvCell(raw: string): string {
  // eslint-disable-next-line no-control-regex -- the leading-whitespace class must cover C0.
  const guarded = /^[\s\u0000-\u0020\u00a0\u180e\u2000-\u200b\u202f\u205f\u3000\ufeff]*[=+\-@]/.test(raw)
    ? `'${raw}`
    : raw;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

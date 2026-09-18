import type { Command } from 'commander';
import type { FormResponseListParams, ListParams } from '@slideless/sdk';
import {
  badgePositionSchema,
  buildEmbedSnippets,
  EMBED_PLACEMENT_RE,
  type BadgePositionValue,
  type FormResponse,
  type FormResponseFile,
  type ShareToken,
  type ShareTokenCreate
} from '@slideless/contract';
import {
  CliUsageError,
  fmtBytes,
  printJson,
  requireApiKey,
  resolveContext,
  table,
  type CliIo
} from '../context.js';
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
  /** Commander --no-download negation: true by default, false when passed (PRDCT-2278). */
  download: boolean;
  /** Commander --no-bar negation: true by default, false when passed (PRDCT-2281). */
  bar: boolean;
  /** Commander --no-uploads negation: true by default, false when passed (PRDCT-2403). */
  uploads: boolean;
  /**
   * Tri-state (PRDCT-2328): `--remember` true, `--no-remember` false,
   * neither = derived from the name. A link minted FOR someone (a name
   * given, or share-email's per-address links) remembers by default; the
   * unnamed quick link ("cli") does not, because a link nobody named is a
   * link for nobody in particular — the broadcast shape that must not
   * collapse a thousand people into one row.
   */
  remember?: boolean | undefined;
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
    canDownload: opts.download,
    showBar: opts.bar,
    canUploadFiles: opts.uploads,
    remembersResponses: opts.remember ?? opts.name !== undefined,
    ...(opts.badgePosition !== undefined ? { badgePosition: opts.badgePosition } : {}),
    ...(opts.expires ? { expiresAt: new Date(opts.expires).toISOString() } : {}),
    ...(opts.password ? { password: opts.password } : {})
  };
}

export function registerSharingCommands(program: Command, io: CliIo): void {
  program
    .command('share <id>')
    .description('Create a per-recipient share link (prints the viewer URL — shown once)')
    .option(
      '--name <name>',
      'owner-facing recipient label (default "cli"; a NAMED link remembers its answers)'
    )
    .option(
      '--remember',
      "the link remembers its respondent's form answers: reopening it brings them back, every submit updates them (default for a named link)"
    )
    .option(
      '--no-remember',
      'every submit through this link is a fresh response, nothing is brought back (default for an unnamed link)'
    )
    .option('--to-version <n>', 'pin the recipient to this version', (v: string) => parseInt(v, 10))
    .option('--annotator', 'let the recipient annotate', false)
    .option('--no-forms', "disallow submitting the deck's embedded forms through this link")
    .option(
      '--no-download',
      "disallow downloading the version's attachments (its downloads/ folder) through this link"
    )
    .option('--no-bar', 'hand out a bare deck: no recipient bar (title, version, downloads) over it')
    .option(
      '--no-uploads',
      "disallow uploading files into the deck's form file fields through this link (the rest of the form still submits)"
    )
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
          name?: string;
          remember?: boolean;
          toVersion?: number;
          annotator: boolean;
          forms: boolean;
          download: boolean;
          bar: boolean;
          uploads: boolean;
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
            `${created.shareToken.hasPassword ? ', password' : ''}` +
            `${created.shareToken.canDownload ? '' : ', no downloads'}` +
            // Strict false: a server from before the switch answers without the field.
            `${created.shareToken.showBar === false ? ', no bar' : ''}` +
            `${created.shareToken.canSubmitForms === false ? ', no forms' : ''}` +
            `${created.shareToken.canUploadFiles === false ? ', no uploads' : ''}` +
            // Strict true: the state is printed so it is never unverifiable (PRDCT-1337's lesson).
            `${created.shareToken.remembersResponses === true ? ', remembers answers' : ''})\n` +
            '  The URL is shown once — copy it now.\n' +
            (created.shareToken.remembersResponses === true
              ? '  This link remembers its answers: whoever holds it can read and change them. Do not post it publicly.\n'
              : '')
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
    .option(
      '--no-remember',
      "every submit through these links is a fresh response (default: each link remembers its recipient's answers)"
    )
    .option('--to-version <n>', 'pin recipients to this version', (v: string) => parseInt(v, 10))
    .option('--annotator', 'let recipients annotate', false)
    .option('--no-forms', "disallow submitting the deck's embedded forms through these links")
    .option('--no-download', "disallow downloading the version's attachments through these links")
    .option('--no-bar', 'hand out bare decks: no recipient bar over them')
    .option('--no-uploads', "disallow uploading files into the deck's form file fields through these links")
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
          remember: boolean;
          toVersion?: number;
          annotator: boolean;
          forms: boolean;
          download: boolean;
          bar: boolean;
          uploads: boolean;
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
            // Downloads: the per-link switch and the count of files taken
            // through the link (one per file, one per zip; never a view).
            t.canDownload ? `${t.downloadCount} download${t.downloadCount === 1 ? '' : 's'}` : 'no downloads',
            // Every switch whose state matters is SHOWN (PRDCT-1337: --no-forms
            // used to be unverifiable from the CLI). Strict compares: a server
            // from before a switch answers without its field.
            [
              t.canAnnotate ? 'annotator' : null,
              t.hasPassword ? 'password' : null,
              t.canSubmitForms === false ? 'no forms' : null,
              t.canUploadFiles === false ? 'no uploads' : null,
              t.remembersResponses === true ? 'remembers answers' : null
            ]
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
    .command('response <id> <responseId>')
    .description(
      'One form response with its edit history (PRDCT-2329): the current answer, then every kept ' +
        'revision newest first, with the link and the moment each was written through.'
    )
    .action(async (id: string, responseId: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const detail = await ctx.client.formResponse(id, responseId);
      if (ctx.json) return printJson(io, detail);
      const r = detail.response;
      io.out.write(
        `${r.formName} · ${r.shareTokenName ?? r.shareTokenId ?? '-'} · ${r.source}` +
          `${r.placement ? ` · p:${r.placement}` : ''} · v${r.version}\n` +
          `  created ${r.createdAt} · last edited ${r.updatedAt} · revision ${r.revision}\n` +
          `  ${JSON.stringify(r.payload)}\n`
      );
      // The files the response holds now (PRDCT-2403). Field and file names
      // are the respondent's raw input; the human sink strips control bytes.
      const files = filesOf(r);
      if (files.length > 0) {
        io.out.write(`\nFiles (${files.length}):\n`);
        io.out.write(table(files.map((f) => [`  ${f.field}`, f.name, fmtBytes(f.sizeBytes), f.id])));
        io.out.write(`  Download them: slideless response-files ${id} ${r.id}\n`);
      }
      io.out.write(
        `\nHistory (${detail.versions.length} revision${detail.versions.length === 1 ? '' : 's'} kept, newest first):\n`
      );
      io.out.write(
        table(
          detail.versions.map((v) => [
            `r${v.revision}`,
            v.createdAt,
            v.shareTokenName ?? v.shareTokenId ?? '-',
            v.source,
            v.placement ? `p:${v.placement}` : '-',
            `v${v.version}`,
            // The names this revision held: null = a revision from before file fields existed.
            v.files == null
              ? '-'
              : v.files.length === 0
                ? 'no files'
                : `files: ${v.files.map((f) => f.name).join('; ')}`,
            JSON.stringify(v.payload)
          ])
        )
      );
    });

  program
    .command('uploads <id> <tokenId>')
    .description(
      'Show or switch file uploads on one EXISTING share link (PRDCT-2403): whether its respondents ' +
        "may upload files into the deck's form file fields. A new link has them on; a link minted " +
        'before file fields existed has them off until its owner turns them on here.'
    )
    .option('--on', 'let respondents on this link upload files into form file fields', false)
    .option('--off', 'refuse file uploads through this link (the rest of the form still submits)', false)
    .action(async (id: string, tokenId: string, opts: { on: boolean; off: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (opts.on && opts.off) throw new CliUsageError('Pass either --on or --off, not both.');
      let token: ShareToken | undefined;
      if (opts.on || opts.off) {
        token = await ctx.client.updateShareToken(id, tokenId, { canUploadFiles: opts.on });
      } else {
        // No single-token read on the API: find it in the deck's list.
        let cursor: string | null = null;
        do {
          const page = await ctx.client.shareTokens(id, { limit: 100, ...(cursor ? { cursor } : {}) });
          token = page.shareTokens.find((t) => t.id === tokenId);
          cursor = token ? null : page.nextCursor;
        } while (cursor);
        if (!token) throw new CliUsageError(`No share token ${tokenId} on this deck.`);
      }
      if (ctx.json) {
        return printJson(io, {
          id: token.id,
          canUploadFiles: token.canUploadFiles,
          canSubmitForms: token.canSubmitForms
        });
      }
      io.out.write(
        (token.canUploadFiles
          ? `File uploads are ON for link ${token.id} ("${token.name}").\n`
          : `File uploads are OFF for link ${token.id} ("${token.name}").\n`) +
          // An upload rides a form submit: the switch is inert while forms are off.
          (token.canUploadFiles && token.canSubmitForms === false
            ? '  Forms are off on this link, so no file can be uploaded through it until they are on.\n'
            : '')
      );
    });

  program
    .command('notify <id>')
    .description(
      'Show or switch the owner mails for form responses on one deck (PRDCT-2330): a mail when a ' +
        'response arrives, another when one is edited; on by default'
    )
    .option('--on', 'mail the deck owner on new and edited responses', false)
    .option('--off', 'stop mailing the deck owner about responses (forms stay on)', false)
    .action(async (id: string, opts: { on: boolean; off: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (opts.on && opts.off) throw new CliUsageError('Pass either --on or --off, not both.');
      const deck =
        opts.on || opts.off
          ? await ctx.client.updatePresentation(id, { notifyOnResponse: opts.on })
          : await ctx.client.presentation(id);
      if (ctx.json) return printJson(io, { notifyOnResponse: deck.notifyOnResponse });
      io.out.write(
        deck.notifyOnResponse
          ? `Response mails are ON for "${deck.title}": the owner is mailed on a new response and on an edit.\n`
          : `Response mails are OFF for "${deck.title}".\n`
      );
    });

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
  const fileCount = filesOf(r).length;
  return [
    r.createdAt,
    r.formName,
    r.shareTokenName ?? r.shareTokenId ?? '-',
    r.source,
    r.placement ? `p:${r.placement}` : '-',
    fileCount === 0 ? '-' : `${fileCount} file${fileCount === 1 ? '' : 's'}`,
    preview.length > 60 ? `${preview.slice(0, 57)}...` : preview
  ];
}

/** The files a response holds; a server from before file fields (PRDCT-2403) answers without the key. */
function filesOf(r: FormResponse): FormResponseFile[] {
  return (r as { files?: FormResponseFile[] }).files ?? [];
}

/**
 * CSV of the listed rows: the attribution columns plus one column per
 * payload field (union across rows, in first-seen order). Repeated-input
 * array values are joined with "; ".
 *
 * Then one column per FILE FIELD met in the rows (PRDCT-2403), named
 * `<field> (files)` and holding that field's file names joined with "; ".
 * Field names and file names are respondent input like the payload, so both
 * the header and the cell go through `csvCell` (quoting + formula guard).
 */
export function responsesCsv(rows: FormResponse[]): string {
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
  const fileFields: string[] = [];
  const seenFields = new Set<string>();
  for (const r of rows) {
    for (const f of filesOf(r)) {
      if (!seenFields.has(f.field)) {
        seenFields.add(f.field);
        fileFields.push(f.field);
      }
    }
  }
  const header = [
    'formName',
    'source',
    'placement',
    'link',
    'createdAt',
    ...payloadKeys,
    ...fileFields.map((field) => `${field} (files)`)
  ];
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
      }),
      ...fileFields.map((field) =>
        filesOf(r)
          .filter((f) => f.field === field)
          .map((f) => f.name)
          .join('; ')
      )
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

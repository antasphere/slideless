import type { Command } from 'commander';
import { PlatformApiError, type ChassisClient } from '@antasphere/chassis-sdk';
import { DEMO_PASS_MAX_MINUTES, type DemoPass } from '@antasphere/chassis-contract';
import { CliApiRefusal, CliUsageError, printJson, table, type CliIo } from '../context.js';
import type { CliKit } from '../kit.js';
import { withOwnerSession } from '../owner-session.js';

/**
 * The demo commands: an owner mints a link that signs one member in without
 * a password, for a demonstration (the demo pass spec, section 8). The
 * routes exist only while the instance's DEMO_SIGN_IN switch is on, on the
 * self-hosted edition, and they refuse every machine credential: these
 * commands sign in as the owner (owner-session.ts) and never send a key.
 *
 * The secret is in the mint's answer only, and leaves this process in one
 * place: inside the links. `--json` is `{ pass, links }` through `printJson`
 * (the raw sink); every human line goes through the sanitizing sinks the
 * runner installed, since a member's name is somebody else's text.
 */

/** The instance's unknown-path answer: what all three routes are while the switch is off. */
const SWITCH_OFF =
  'Demo sign-in is off on this instance (DEMO_SIGN_IN), or this is the cloud edition, where demo links are minted at the Antasphere hub.';

/**
 * The server's refusals of the demo routes. Their sentences are the ones to
 * read, so they reach the runner as worded refusals: its generic hints speak
 * of API keys, and these commands hold none.
 */
/** The role gate's refusal: the person who signed in is an admin or a member. */
const NOT_AN_OWNER =
  'Only an owner of this workspace manages demo links: the account that signed in is not one.';

const REFUSALS = new Set([
  'no_such_member',
  'owner_target',
  'demo_address_required',
  'two_factor_enrolled',
  'guest_target',
  'cross_workspace_target',
  'invalid_demo_path',
  'sessions_only',
  'not_found'
]);

async function explained<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      if (e.status === 404 && e.code === 'not_found' && e.message === 'Not found') {
        throw new CliApiRefusal(SWITCH_OFF, 404);
      }
      // The role gate answers the generic `forbidden`; the runner's hint for
      // a 403 speaks of an API key, which this command never holds.
      if (e.status === 403 && e.code === 'forbidden') throw new CliApiRefusal(NOT_AN_OWNER, 403);
      if (REFUSALS.has(e.code)) throw new CliApiRefusal(e.message, e.status);
    }
    throw e;
  }
}

/**
 * The server's page rule (`isSafeDemoPath`), checked here too so a bad
 * `--path` costs no sign-in: 1 to 2048 characters, one leading `/` (never
 * `//` nor `/\`), no `#`, no space or control character.
 */
export function isSafeDemoPath(path: string): boolean {
  if (path.length < 1 || path.length > 2048) return false;
  if (!path.startsWith('/') || path.startsWith('//') || path.startsWith('/\\')) return false;
  for (let i = 0; i < path.length; i++) {
    const code = path.charCodeAt(i);
    if (code < 0x21 || code === 0x7f) return false;
  }
  return !path.includes('#');
}

/** `--hours` / `--minutes` as the mint's `expiresInMinutes`, or undefined for the server's default. */
function lifetimeMinutes(opts: { hours?: string; minutes?: string }): number | undefined {
  if (opts.hours !== undefined && opts.minutes !== undefined) {
    throw new CliUsageError('Pass either --hours or --minutes, not both.');
  }
  const raw = opts.hours ?? opts.minutes;
  if (raw === undefined) return undefined;
  const n = /^\d+$/.test(raw) ? Number(raw) : NaN;
  const minutes = opts.hours !== undefined ? n * 60 : n;
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > DEMO_PASS_MAX_MINUTES) {
    throw new CliUsageError(
      `A demo link lives from one minute to a week (${DEMO_PASS_MAX_MINUTES} minutes): ` +
        `--${opts.hours !== undefined ? 'hours' : 'minutes'} takes a whole number in that range.`
    );
  }
  return minutes;
}

/** The link for one page: the fragment never reaches a server log. */
function demoLink(baseUrl: string, secret: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/demo#pass=${secret}&to=${encodeURIComponent(path)}`;
}

const collect = (value: string, previous: string[]): string[] => [...previous, value];

interface OwnerOpts {
  ownerEmail?: string;
  ownerPasswordStdin: boolean;
}

export function registerDemoCommands<TClient extends ChassisClient<string>>(
  kit: CliKit<TClient>,
  program: Command,
  io: CliIo
): void {
  const { identity, resolveContext } = kit;
  const prefix = identity.envPrefix;

  const demo = program
    .command('demo')
    .description(
      'Demo links: sign a member in without a password, for a demonstration (owner; DEMO_SIGN_IN on)'
    );

  /** The owner's sign-in flags every demo command carries. */
  const ownerFlags = (cmd: Command): Command =>
    cmd
      .option('--owner-email <address>', `the owner who signs in (or ${prefix}_OWNER_EMAIL)`)
      .option(
        '--owner-password-stdin',
        `read the owner's password from the first line of stdin (or ${prefix}_OWNER_PASSWORD)`,
        false
      );

  const session = (opts: OwnerOpts) => ({
    identity,
    ...(opts.ownerEmail !== undefined ? { ownerEmail: opts.ownerEmail } : {}),
    ownerPasswordStdin: opts.ownerPasswordStdin
  });

  // ── demo link ─────────────────────────────────────────────────────────────
  ownerFlags(
    demo
      .command('link')
      .description('Mint one demo pass for a member and print one link per page')
      .requiredOption('--email <address>', 'the member the link signs in')
      .option('--path <p>', 'a page the link lands on (repeatable; the first is the default, /)', collect, [])
      .option('--hours <n>', 'how long the link lives, in hours (default: a day; at most a week)')
      .option('--minutes <n>', 'how long the link lives, in minutes (instead of --hours)')
  ).action(
    async (
      opts: OwnerOpts & { email: string; path: string[]; hours?: string; minutes?: string },
      cmd: Command
    ) => {
      const paths = opts.path.length > 0 ? opts.path : ['/'];
      // Everything the command can refuse by itself, before any sign-in.
      for (const path of paths) {
        if (!isSafeDemoPath(path)) {
          throw new CliUsageError(
            `--path "${path}" is not a page of this instance: a path starting with a single /, ` +
              'with no #, no space and no control character, at most 2048 characters.'
          );
        }
      }
      const expiresInMinutes = lifetimeMinutes(opts);
      const ctx = resolveContext(cmd, io);
      const minted = await withOwnerSession(ctx, session(opts), (client) =>
        explained(() =>
          client.mintDemoPass({
            email: opts.email,
            path: paths[0]!,
            ...(expiresInMinutes !== undefined ? { expiresInMinutes } : {})
          })
        )
      );
      const links = paths.map((path) => ({ path, url: demoLink(ctx.baseUrl, minted.secret, path) }));
      if (ctx.json) return printJson(io, { pass: minted.pass, links });
      const { pass } = minted;
      io.out.write(
        `Demo link for ${pass.name} <${pass.email}>, valid until ${pass.expiresAt}:\n` +
          links.map((l) => `${l.url}\n`).join('')
      );
    }
  );

  // ── demo list ─────────────────────────────────────────────────────────────
  ownerFlags(demo.command('list').description('List the demo passes of the workspace (newest first)')).action(
    async (opts: OwnerOpts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const { passes } = await withOwnerSession(ctx, session(opts), (client) =>
        explained(() => client.demoPasses())
      );
      if (ctx.json) return printJson(io, { passes });
      if (passes.length === 0) {
        io.out.write('No demo passes.\n');
        return;
      }
      io.out.write(
        table([
          ['ID', 'PERSON', 'PAGE', 'EXPIRES', 'REVOKED', 'LAST USED', 'USES'],
          ...passes.map((p: DemoPass) => [
            p.id,
            p.email,
            p.targetPath,
            p.expiresAt,
            p.revokedAt ?? '-',
            p.lastUsedAt ?? 'never',
            String(p.useCount)
          ])
        ])
      );
    }
  );

  // ── demo revoke ───────────────────────────────────────────────────────────
  ownerFlags(
    demo.command('revoke <id>').description('Revoke a demo pass; the sessions it opened end with it')
  ).action(async (id: string, opts: OwnerOpts, cmd: Command) => {
    const ctx = resolveContext(cmd, io);
    const pass = await withOwnerSession(ctx, session(opts), (client) =>
      explained(() => client.revokeDemoPass(id))
    );
    if (ctx.json) return printJson(io, pass);
    io.out.write(
      `Revoked the demo pass ${pass.id} for ${pass.email}. The sessions it opened are signed out.\n`
    );
  });
}

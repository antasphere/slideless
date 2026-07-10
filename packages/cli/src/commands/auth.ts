import type { Command } from 'commander';
import { PlatformClient } from '@slideless/sdk';
import {
  clearConfig,
  configPath,
  loadConfig,
  redactKey,
  saveConfig,
  type CliConfig
} from '../config.js';
import {
  CliUsageError,
  printJson,
  requireApiKey,
  resolveContext,
  table,
  type CliIo
} from '../context.js';

/**
 * Identity + profile commands: the OTP sign-in pair (login-request /
 * login-complete), key paste (login), whoami/verify, and profile management
 * (use / profiles / logout / config show / config clear).
 */

const DEFAULT_PROFILE = 'default';

interface AuthGlobals {
  apiUrl?: string;
  url?: string;
  profile?: string;
  json?: boolean;
}

/** URL for the pre-auth commands: flags → env only (no profile requirement). */
function resolveAuthUrl(cmd: Command, io: CliIo): string {
  const opts = cmd.optsWithGlobals() as AuthGlobals;
  const config = loadConfig(io.env);
  const profileName = opts.profile ?? config.activeProfile;
  const profile = profileName ? config.profiles[profileName] : undefined;
  const raw = opts.apiUrl ?? opts.url ?? io.env.SLIDELESS_URL ?? profile?.baseUrl;
  if (!raw) {
    throw new CliUsageError(
      'No instance to talk to — pass --api-url <url> (or set SLIDELESS_URL).'
    );
  }
  return raw.replace(/\/+$/, '');
}

function saveProfileKey(
  io: CliIo,
  profileName: string,
  baseUrl: string,
  apiKey: string
): { config: CliConfig; path: string } {
  const config = loadConfig(io.env);
  config.profiles[profileName] = { ...config.profiles[profileName], apiKey, baseUrl };
  config.activeProfile = profileName;
  const path = saveConfig(io.env, config);
  return { config, path };
}

async function readLineFromStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split('\n')[0]?.trim() ?? '';
}

export function registerAuthCommands(program: Command, io: CliIo): void {
  const auth = program.command('auth').description('Sign in over email OTP (mints an API key)');

  auth
    .command('login-request')
    .description('Email a 6-digit sign-in code (existing accounts only — sign-up stays closed)')
    .requiredOption('--email <email>', 'account email on the instance')
    .action(async (opts: { email: string }, cmd: Command) => {
      const baseUrl = resolveAuthUrl(cmd, io);
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const client = new PlatformClient({ baseUrl, fetch: fetchImpl });
      const result = await client.cliAuthRequest({ email: opts.email });
      const json = Boolean((cmd.optsWithGlobals() as AuthGlobals).json);
      if (json) return printJson(io, { ...result, email: opts.email, baseUrl });
      io.out.write(
        `If ${opts.email} has an account on ${baseUrl}, a sign-in code is on its way.\n` +
          `Complete with: slideless auth login-complete --email ${opts.email} --code <code>\n`
      );
    });

  auth
    .command('login-complete')
    .description('Verify the emailed code; stores the minted API key as a profile')
    .requiredOption('--email <email>', 'the email the code was sent to')
    .requiredOption('--code <code>', 'the 6-digit code from the email')
    .option('--key-name <name>', 'display name for the minted API key')
    .option('--expires-in-days <n>', 'key TTL in days (default: never expires)', (v: string) =>
      parseInt(v, 10)
    )
    .action(
      async (
        opts: { email: string; code: string; keyName?: string; expiresInDays?: number },
        cmd: Command
      ) => {
        const globals = cmd.optsWithGlobals() as AuthGlobals;
        const baseUrl = resolveAuthUrl(cmd, io);
        const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
        const client = new PlatformClient({ baseUrl, fetch: fetchImpl });
        const result = await client.cliAuthComplete({
          email: opts.email,
          otp: opts.code,
          ...(opts.keyName ? { keyName: opts.keyName } : {}),
          ...(opts.expiresInDays ? { expiresInDays: opts.expiresInDays } : {})
        });
        const profileName = globals.profile ?? DEFAULT_PROFILE;
        const { path } = saveProfileKey(io, profileName, baseUrl, result.key);
        if (globals.json) {
          // The full key is deliberately NOT echoed — it is already stored.
          return printJson(io, {
            profile: profileName,
            baseUrl,
            user: result.user,
            apiKey: result.apiKey,
            configPath: path
          });
        }
        io.out.write(
          `Signed in as ${result.user.email} on ${baseUrl}.\n` +
            `API key "${result.apiKey.name}" (${redactKey(result.key)}) saved to profile ` +
            `"${profileName}" (${path}).\n`
        );
      }
    );

  program
    .command('login')
    .description('Save an existing slk_ API key as a profile (pass --api-key or pipe it on stdin)')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals & { apiKey?: string };
      const baseUrl = resolveAuthUrl(cmd, io);
      let key = globals.apiKey ?? io.env.SLIDELESS_API_KEY;
      if (!key) {
        key = await readLineFromStdin();
      }
      if (!key || !key.startsWith('slk_')) {
        throw new CliUsageError(
          'No API key provided — pass --api-key slk_… or pipe the key on stdin.'
        );
      }
      const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
      const client = new PlatformClient({ baseUrl, apiKey: key, fetch: fetchImpl });
      const me = await client.me(); // verify before storing
      const profileName = globals.profile ?? DEFAULT_PROFILE;
      const { path } = saveProfileKey(io, profileName, baseUrl, key);
      if (globals.json) {
        return printJson(io, { profile: profileName, baseUrl, user: me.user, configPath: path });
      }
      io.out.write(
        `Key verified for ${me.user.email} on ${baseUrl} — saved to profile "${profileName}" (${path}).\n`
      );
    });

  program
    .command('logout')
    .description('Forget the stored API key of the active (or named) profile')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      const profileName = globals.profile ?? config.activeProfile;
      const profile = profileName ? config.profiles[profileName] : undefined;
      if (!profileName || !profile) {
        throw new CliUsageError('No profile to log out of.');
      }
      delete profile.apiKey;
      if (!profile.baseUrl) delete config.profiles[profileName];
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { loggedOut: profileName });
      io.out.write(`Logged out of profile "${profileName}" (key forgotten; revoke it in the dashboard to kill it server-side).\n`);
    });

  program
    .command('whoami')
    .description('Show the identity behind the resolved API key')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      const me = await ctx.client.me();
      if (ctx.json) return printJson(io, me);
      io.out.write(
        `${me.user.name} <${me.user.email}>\n` +
          `  instance:  ${ctx.baseUrl}\n` +
          `  workspace: ${me.workspace.name}\n` +
          `  role:      ${me.role} (via ${me.via})\n` +
          `  scopes:    ${me.scopes ? me.scopes.join(', ') : 'full (session)'}\n` +
          (me.via === 'api_key' ? `  key expires: ${me.apiKeyExpiresAt ?? 'never'}\n` : '')
      );
    });

  program
    .command('verify')
    .description('Check that the resolved instance + key work (exit 0 = ok)')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      requireApiKey(ctx);
      const me = await ctx.client.me();
      if (ctx.json) return printJson(io, { ok: true, baseUrl: ctx.baseUrl, user: me.user });
      io.out.write(`ok — ${me.user.email} (${me.role}) @ ${ctx.baseUrl}\n`);
    });

  program
    .command('use <profile>')
    .description('Switch the active profile')
    .action(async (name: string, _opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      if (!config.profiles[name]) {
        throw new CliUsageError(`Unknown profile "${name}" — run \`slideless profiles\`.`);
      }
      config.activeProfile = name;
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { activeProfile: name });
      io.out.write(`Active profile: ${name}\n`);
    });

  program
    .command('profiles')
    .description('List saved profiles')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const config = loadConfig(io.env);
      const names = Object.keys(config.profiles);
      if (globals.json) {
        return printJson(io, {
          activeProfile: config.activeProfile ?? null,
          profiles: Object.fromEntries(
            names.map((n) => {
              const p = config.profiles[n]!;
              return [
                n,
                { baseUrl: p.baseUrl ?? null, apiKey: p.apiKey ? redactKey(p.apiKey) : null }
              ];
            })
          )
        });
      }
      if (names.length === 0) {
        io.out.write('No profiles. Sign in with `slideless auth login-request --api-url <url> --email <you>`.\n');
        return;
      }
      io.out.write(
        table(
          names.map((n) => {
            const p = config.profiles[n]!;
            return [
              config.activeProfile === n ? '*' : ' ',
              n,
              p.baseUrl ?? '(no url)',
              p.apiKey ? redactKey(p.apiKey) : '(no key)'
            ];
          })
        )
      );
    });

  const config = program.command('config').description('Inspect or reset the CLI config file');

  config
    .command('show')
    .description('Show the config path, active profile, and redacted keys')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      const cfg = loadConfig(io.env);
      const path = configPath(io.env);
      const redacted = {
        path,
        activeProfile: cfg.activeProfile ?? null,
        profiles: Object.fromEntries(
          Object.entries(cfg.profiles).map(([n, p]) => [
            n,
            { baseUrl: p.baseUrl ?? null, apiKey: p.apiKey ? redactKey(p.apiKey) : null }
          ])
        )
      };
      if (globals.json) return printJson(io, redacted);
      io.out.write(`config: ${path ?? '(no HOME/XDG_CONFIG_HOME — config disabled)'}\n`);
      io.out.write(`${JSON.stringify(redacted, null, 2)}\n`);
    });

  config
    .command('clear')
    .description('Delete the config file (all profiles and stored keys)')
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals;
      clearConfig(io.env);
      if (globals.json) return printJson(io, { cleared: true });
      io.out.write('Config cleared.\n');
    });
}

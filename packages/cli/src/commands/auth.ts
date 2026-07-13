import type { Command } from 'commander';
import { CliAuthClient, CliAuthError, resolveTargetWorkspace } from '@antasphere/cli-core';
import { PlatformClient } from '@slideless/sdk';
import {
  clearConfig,
  configPath,
  loadConfig,
  redactKey,
  removeWorkspaceKey,
  saveConfig,
  type CliConfig
} from '../config.js';
import { CliUsageError, printJson, requireApiKey, resolveContext, table, type CliIo } from '../context.js';

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
    throw new CliUsageError('No instance to talk to — pass --api-url <url> (or set SLIDELESS_URL).');
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

/**
 * Cloud instances are hub-only (D1): the tool's own OTP entrances refuse
 * there (403 cli_otp_disabled), so ask discovery FIRST — the same
 * unauthenticated GET /instance probe (and the same cloud test) as the
 * connect-on-demand seam in context.ts — and steer to `antasphere login`
 * instead of mailing a dead code or printing the server's raw refusal.
 * Discovery failing (unreachable host, older instance) falls through: the
 * classic flow then reports its own, real error. Self-host instances are
 * untouched beyond the probe.
 */
async function refuseOtpLoginOnCloud(baseUrl: string, io: CliIo): Promise<void> {
  let cloud = false;
  try {
    const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
    const info = await new PlatformClient({ baseUrl, fetch: fetchImpl }).instance();
    cloud = info.auth.methods.includes('antasphere') || info.edition === 'cloud';
  } catch {
    return; // discovery is advisory — never block the classic flow on it
  }
  if (cloud) {
    throw new CliUsageError(
      `${baseUrl} is an Antasphere-cloud instance — it signs in at the hub, not with its own ` +
        'email codes. Run `antasphere login` once; `slideless` then connects automatically ' +
        '(or pass --api-key <slk_…> / set SLIDELESS_API_KEY).'
    );
  }
}

export function registerAuthCommands(program: Command, io: CliIo): void {
  const auth = program.command('auth').description('Sign in over email OTP (mints an API key)');

  auth
    .command('login-request')
    .description('Email a 6-digit sign-in code (existing accounts only — sign-up stays closed)')
    .requiredOption('--email <email>', 'account email on the instance')
    .action(async (opts: { email: string }, cmd: Command) => {
      const baseUrl = resolveAuthUrl(cmd, io);
      await refuseOtpLoginOnCloud(baseUrl, io);
      // The OTP pair rides cli-core's instance auth client — the same
      // plumbing every Antasphere tool CLI signs in with.
      const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
      const result = await client.request({ email: opts.email });
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
        await refuseOtpLoginOnCloud(baseUrl, io);
        const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
        const result = await client.complete({
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
        throw new CliUsageError('No API key provided — pass --api-key slk_… or pipe the key on stdin.');
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
    .description(
      'Forget the stored API key of the active (or named) profile; --org logs one connected hub org out instead'
    )
    .action(async (_opts, cmd: Command) => {
      const globals = cmd.optsWithGlobals() as AuthGlobals & { org?: string };
      const config = loadConfig(io.env);
      const profileName = globals.profile ?? config.activeProfile;
      const profile = profileName ? config.profiles[profileName] : undefined;
      if (!profileName || !profile) {
        throw new CliUsageError('No profile to log out of.');
      }
      // Per-org logout (the cross-tool connect counterpart): revoke the
      // exchange-minted slk_ key server-side, then evict it from the cache.
      // Taken on an explicit --org, or when the profile holds ONLY
      // hub-connected keys; a classic single-key profile keeps today's path.
      const hubKeys = profile.workspaceKeys ?? {};
      const perOrg = globals.org !== undefined || (!profile.apiKey && Object.keys(hubKeys).length > 0);
      if (perOrg) {
        const org = globals.org ?? resolveTargetWorkspace(io.env, {});
        if (!org) {
          throw new CliUsageError(
            'Pass --org <id> to say which hub org to log out of (or set one with `antasphere org use`).'
          );
        }
        const entry = hubKeys[org];
        if (!entry) {
          const cached = Object.keys(hubKeys).join(', ') || '(none)';
          throw new CliUsageError(
            `No connected key for hub org ${org} on profile "${profileName}". Connected orgs: ${cached}.`
          );
        }
        // The revoke targets the instance the key was minted on — the
        // profile's baseUrl, which scopes the cache. Never a flag/env URL:
        // a cached key must not travel to a different instance, not even
        // to die (a foreign host would see the key AND the real one would
        // survive while we report it gone).
        const rawUrl = profile.baseUrl;
        let revoked = false;
        if (rawUrl) {
          const baseUrl = rawUrl.replace(/\/+$/, '');
          try {
            const client = new CliAuthClient({ baseUrl, ...(io.fetch ? { fetch: io.fetch } : {}) });
            await client.revoke(entry.apiKey);
            revoked = true;
          } catch (e) {
            // A dead/expired key cannot revoke itself (401) — still evict it.
            // A 403 is different: the key WORKS but the instance refuses the
            // self-revoke (an OLDER instance whose fail-closed machine
            // allowlist predates DELETE /cli/auth/key — current instances
            // open it). Never report that as "already unusable" — the key
            // stays valid server-side and only the dashboard can kill it.
            if (e instanceof CliAuthError && e.status === 401) {
              io.err.write('The cached key was already unusable — evicting it anyway.\n');
            } else if (e instanceof CliAuthError && e.status === 403) {
              io.err.write(
                `This instance refused the self-revoke (${e.code}) — the key STAYS VALID server-side; ` +
                  'revoke it from the dashboard. Evicting the cached copy.\n'
              );
            } else {
              throw e;
            }
          }
        } else {
          io.err.write('No instance URL known for this profile — evicting the cached key locally only.\n');
        }
        removeWorkspaceKey(io.env, profileName, org);
        if (globals.json) return printJson(io, { profile: profileName, org, revoked, evicted: true });
        io.out.write(
          `Logged out of hub org ${org} on profile "${profileName}"${revoked ? ' (key revoked server-side)' : ''}.\n`
        );
        return;
      }
      delete profile.apiKey;
      if (!profile.baseUrl) delete config.profiles[profileName];
      saveConfig(io.env, config);
      if (globals.json) return printJson(io, { loggedOut: profileName });
      io.out.write(
        `Logged out of profile "${profileName}" (key forgotten; revoke it in the dashboard to kill it server-side).\n`
      );
    });

  program
    .command('whoami')
    .description('Show the identity behind the resolved API key')
    .action(async (_opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
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
      await requireApiKey(ctx);
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
                {
                  baseUrl: p.baseUrl ?? null,
                  apiKey: p.apiKey ? redactKey(p.apiKey) : null,
                  hubOrgs: Object.keys(p.workspaceKeys ?? {})
                }
              ];
            })
          )
        });
      }
      if (names.length === 0) {
        io.out.write(
          'No profiles. Sign in with `slideless auth login-request --api-url <url> --email <you>`.\n'
        );
        return;
      }
      io.out.write(
        table(
          names.map((n) => {
            const p = config.profiles[n]!;
            const hubOrgs = Object.keys(p.workspaceKeys ?? {});
            return [
              config.activeProfile === n ? '*' : ' ',
              n,
              p.baseUrl ?? '(no url)',
              p.apiKey
                ? redactKey(p.apiKey)
                : hubOrgs.length > 0
                  ? `(hub: ${hubOrgs.join(', ')})`
                  : '(no key)'
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
            {
              baseUrl: p.baseUrl ?? null,
              apiKey: p.apiKey ? redactKey(p.apiKey) : null,
              // Hub-connected orgs: cached exchange keys, redacted like the rest.
              workspaceKeys: Object.fromEntries(
                Object.entries(p.workspaceKeys ?? {}).map(([org, entry]) => [org, redactKey(entry.apiKey)])
              )
            }
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

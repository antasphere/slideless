import { PlatformClient } from '@slideless/sdk';
import type { Command } from 'commander';
import {
  activeHubProfile,
  CliUsageError,
  connectOnDemand,
  lookupConnectKey,
  resolveApiKey,
  resolveBaseUrl,
  resolveProfile as coreResolveProfile,
  type CliIo,
  type ResolvedProfile
} from '@antasphere/cli-core';
import { loadConfig, type CliConfig, type CliProfile } from './config.js';

// The injectable I/O seam, the usage-error class, and the resolution
// helpers live in @antasphere/cli-core (extracted from this CLI); re-exported
// so the command modules' imports stay unchanged.
export { CliUsageError, printJson } from '@antasphere/cli-core';
export type { CliIo } from '@antasphere/cli-core';

export interface CliContext {
  client: PlatformClient;
  baseUrl: string;
  apiKey: string | undefined;
  json: boolean;
  io: CliIo;
  /** The profile the context resolved against (undefined = flags/env only). */
  profileName: string | undefined;
  config: CliConfig;
}

interface GlobalOpts {
  apiUrl?: string;
  url?: string;
  apiKey?: string;
  profile?: string;
  json?: boolean;
}

/** The named (or active) profile, erroring on an explicitly named missing one. */
export function resolveProfile(
  config: CliConfig,
  requested: string | undefined
): { name: string | undefined; profile: CliProfile | undefined } {
  const resolved: ResolvedProfile = coreResolveProfile(config, requested, {
    unknownHint: 'run `slideless profiles` to list them.'
  });
  return resolved;
}

/**
 * Backend + credential resolution, in its documented order:
 *
 *   base URL:  --api-url (or --url) → SLIDELESS_URL → profile baseUrl → error
 *   API key:   --api-key            → SLIDELESS_API_KEY → profile apiKey
 *              → cached hub-connect key (cloud instances)
 *
 * There is deliberately NO hard-coded default URL: a self-hosted CLI must
 * name its instance explicitly (flag, env, or a saved profile) rather than
 * silently talking to the wrong host.
 *
 * The last credential step is the cross-tool connect cache (cli-core
 * binding patterns §7): purely additive — it is consulted only when every
 * direct source came up empty, so oss / single-key flows resolve exactly
 * as before and never read the hub profile. The cached key is USER-scoped
 * (one per hub profile, valid for every org — the org is a per-request
 * selection, never part of the credential) and is only replayed against
 * the instance it was minted on — the profile's baseUrl scopes the cache,
 * so a key minted for the cloud can never be sent to some other instance
 * named by --api-url / SLIDELESS_URL.
 */
export function resolveContext(cmd: Command, io: CliIo): CliContext {
  const opts = cmd.optsWithGlobals() as GlobalOpts;
  const config = loadConfig(io.env);
  const { name: profileName, profile } = resolveProfile(config, opts.profile);

  const baseUrl = resolveBaseUrl({
    flag: opts.apiUrl ?? opts.url,
    env: io.env,
    envVar: 'SLIDELESS_URL',
    profile,
    missingMessage:
      'No instance configured. Pass --api-url <url>, set SLIDELESS_URL, or sign in once with ' +
      '`slideless auth login-request --api-url <url> --email <you>` to save a profile.'
  });
  let apiKey = resolveApiKey({ flag: opts.apiKey, env: io.env, envVar: 'SLIDELESS_API_KEY', profile });
  if (!apiKey && profile?.baseUrl?.replace(/\/+$/, '') === baseUrl) {
    // No direct key: the connect cache's slot is the ACTIVE hub profile
    // (what `antasphere login` stored) — org-independent by design.
    const hub = activeHubProfile(io.env);
    if (hub.name) apiKey = lookupConnectKey(profile, hub.name);
  }
  const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    client: new PlatformClient({ baseUrl, ...(apiKey ? { apiKey } : {}), fetch: fetchImpl }),
    baseUrl,
    apiKey,
    json: Boolean(opts.json),
    io,
    profileName,
    config
  };
}

const NO_KEY_MESSAGE =
  'An API key is required. Sign in (`slideless auth login-request --email <you>`), paste one ' +
  '(`slideless login`), pass --api-key, or set SLIDELESS_API_KEY.';

/** Slideless-branded copy for the cli-core seam (byte-identical to the
 *  pre-extraction string — the default lacks the `<slk_…>` hint). */
const MISSING_HUB_LOGIN_MESSAGE =
  'This Slideless instance signs in through the Antasphere hub. Run `antasphere login` once, ' +
  'then retry — or pass --api-key <slk_…> / set SLIDELESS_API_KEY.';

/**
 * Requires an API key; throws a friendly message the runner turns into exit 1.
 *
 * When nothing resolved, this is the connect-on-demand seam (binding
 * patterns §7, gcloud model), owned by @antasphere/cli-core since 0.3.0:
 * if — and only if — discovery says the instance is an Antasphere-cloud
 * one, the stored `antasphere login` credential is exchanged (hub → tool)
 * for a USER-scoped tool-local `slk_` key, which is cached per (tool, hub
 * profile) and used for this invocation — and served from that cache on
 * every subsequent run (no re-exchange, no fresh mint). Self-hosted
 * instances never take this branch: they get the classic error unchanged.
 */
export async function requireApiKey(ctx: CliContext): Promise<string> {
  if (ctx.apiKey) return ctx.apiKey;
  const { io } = ctx;
  const outcome = await connectOnDemand({
    tool: 'slideless',
    toolBaseUrl: ctx.baseUrl,
    ...(ctx.profileName !== undefined ? { profileName: ctx.profileName } : {}),
    env: io.env,
    // Thread the injected fetch so the probe + exchange stay on the test
    // harness wire (and any proxying the runner set up).
    ...(io.fetch ? { fetch: io.fetch } : {}),
    notify: (line) => io.err.write(line),
    messages: { missingHubLogin: MISSING_HUB_LOGIN_MESSAGE }
  });
  if (outcome.outcome === 'not_cloud') {
    // Self-hosted / unreachable: the classic error, byte-identical.
    throw new CliUsageError(NO_KEY_MESSAGE);
  }

  // The minted key becomes this invocation's credential.
  ctx.apiKey = outcome.key;
  const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
  ctx.client = new PlatformClient({ baseUrl: ctx.baseUrl, apiKey: outcome.key, fetch: fetchImpl });
  return outcome.key;
}

/** Human-readable size (B / KB / MB) for the listing commands. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Minimal aligned two-space table for human output. */
export function table(rows: string[][]): string {
  if (rows.length === 0) return '';
  const first = rows[0]!;
  const widths = first.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? '').length)));
  return (
    rows
      .map((r) =>
        r
          .map((cell, i) => (i === r.length - 1 ? cell : (cell ?? '').padEnd(widths[i] ?? 0)))
          .join('  ')
          .trimEnd()
      )
      .join('\n') + '\n'
  );
}

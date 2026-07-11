import { PlatformClient } from '@slideless/sdk';
import type { Command } from 'commander';
import {
  CliUsageError,
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
 *
 * There is deliberately NO hard-coded default URL: a self-hosted CLI must
 * name its instance explicitly (flag, env, or a saved profile) rather than
 * silently talking to the wrong host.
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
  const apiKey = resolveApiKey({ flag: opts.apiKey, env: io.env, envVar: 'SLIDELESS_API_KEY', profile });
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

/** Requires an API key; throws a friendly message the runner turns into exit 1. */
export function requireApiKey(ctx: CliContext): string {
  if (!ctx.apiKey) {
    throw new CliUsageError(
      'An API key is required. Sign in (`slideless auth login-request --email <you>`), paste one ' +
        '(`slideless login`), pass --api-key, or set SLIDELESS_API_KEY.'
    );
  }
  return ctx.apiKey;
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

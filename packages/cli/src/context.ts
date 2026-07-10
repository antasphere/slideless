import { PlatformClient } from '@slideless/sdk';
import type { Command } from 'commander';
import { loadConfig, type CliConfig, type CliProfile } from './config.js';

/** Injectable I/O so the CLI is testable in-process (defaults wired in the bin). */
export interface CliIo {
  env: Record<string, string | undefined>;
  out: { write(s: string): void };
  err: { write(s: string): void };
  fetch?: typeof globalThis.fetch;
}

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

export class CliUsageError extends Error {}

/** The named (or active) profile, erroring on an explicitly named missing one. */
export function resolveProfile(
  config: CliConfig,
  requested: string | undefined
): { name: string | undefined; profile: CliProfile | undefined } {
  if (requested) {
    const profile = config.profiles[requested];
    if (!profile) {
      throw new CliUsageError(`Unknown profile "${requested}" — run \`slideless profiles\` to list them.`);
    }
    return { name: requested, profile };
  }
  const name = config.activeProfile;
  const profile = name ? config.profiles[name] : undefined;
  return { name: profile ? name : undefined, profile };
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

  const rawUrl = opts.apiUrl ?? opts.url ?? io.env.SLIDELESS_URL ?? profile?.baseUrl;
  if (!rawUrl) {
    throw new CliUsageError(
      'No instance configured. Pass --api-url <url>, set SLIDELESS_URL, or sign in once with ' +
        '`slideless auth login-request --api-url <url> --email <you>` to save a profile.'
    );
  }
  const baseUrl = rawUrl.replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? io.env.SLIDELESS_API_KEY ?? profile?.apiKey;
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

export function printJson(io: CliIo, value: unknown): void {
  io.out.write(`${JSON.stringify(value, null, 2)}\n`);
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

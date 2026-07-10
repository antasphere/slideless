import { PlatformClient } from '@platform/sdk';
import type { Command } from 'commander';

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
}

/**
 * Resolve the instance target from --url/--api-key flags, falling back to
 * PLATFORM_URL / PLATFORM_API_KEY. The API-key surface is confined by the
 * server's fail-closed allowlist to {GET /me, /files*, GET /workspace/export},
 * so that is exactly what this CLI does; discovery (/instance) is public.
 */
export function resolveContext(cmd: Command, io: CliIo): CliContext {
  const opts = cmd.optsWithGlobals() as { url?: string; apiKey?: string; json?: boolean };
  const baseUrl = (opts.url ?? io.env.PLATFORM_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
  const apiKey = opts.apiKey ?? io.env.PLATFORM_API_KEY;
  const fetchImpl = io.fetch ?? globalThis.fetch.bind(globalThis);
  return {
    client: new PlatformClient({ baseUrl, ...(apiKey ? { apiKey } : {}), fetch: fetchImpl }),
    baseUrl,
    apiKey,
    json: Boolean(opts.json),
    io
  };
}

/** Requires an API key; throws a friendly message the runner turns into exit 1. */
export function requireApiKey(ctx: CliContext): string {
  if (!ctx.apiKey) {
    throw new Error(
      'An API key is required. Pass --api-key or set PLATFORM_API_KEY (mint one in the dashboard).'
    );
  }
  return ctx.apiKey;
}

export function printJson(io: CliIo, value: unknown): void {
  io.out.write(`${JSON.stringify(value, null, 2)}\n`);
}

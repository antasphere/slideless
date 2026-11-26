import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import {
  cliIdentity,
  defineCli,
  type CliContext as ChassisCliContext,
  type CliIo
} from '@antasphere/chassis-cli';
import { IDENTITY } from '@slideless/contract';
import { PlatformClient } from '@slideless/sdk';
import { sayIfOlderThanSite } from './older-than-site.js';

/**
 * The ONE instantiation of the CLI chassis for Slideless. What the tool is
 * called is its identity, so it is spelled ONCE, in `@slideless/contract`
 * (`IDENTITY`), read here and spelled nowhere in `@antasphere/chassis-cli`; every generic function that carries it (the
 * config namespace, the environment variables, the hints that name the
 * binary, the key prefix) is built from it and exported under the name it
 * has always had. The command modules import this file, and it imports none
 * of them.
 */
export const cli = defineCli({
  identity: cliIdentity(IDENTITY),
  description: `Command-line client for a ${IDENTITY.displayName} instance (push, share, pull, preview)`,
  createClient: (options) => new PlatformClient(options),
  // The deck hint: a push that lost the race for the next version number.
  errorHint: (e) =>
    e.code === 'version_conflict' ? ' (someone pushed in between — rerun to retry)' : undefined
});

/** The context every command resolves: the chassis's, over the Slideless client. */
export type CliContext = ChassisCliContext<PlatformClient>;

export const loadConfig = cli.loadConfig;
export const updateConfig = cli.updateConfig;

/** The running bundle's real path, read once; null when it cannot be read (the line then names no command). */
const RUNNING_FILE: string | null = (() => {
  try {
    return realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
})();

/** The version of the program a command belongs to (the kit sets it from index.ts's `VERSION`). */
function programVersion(cmd: Command): string | undefined {
  let root = cmd;
  while (root.parent) root = root.parent;
  return root.version();
}

/**
 * The context of a Slideless command: the kit's, then the one line that says
 * this command is older than its site (older-than-site.ts, PRDCT-5249).
 * `program` is the command whose program's version is read: `cmd` itself,
 * except for a folder's routed command (folder-site.ts), which resolves a
 * view of its command that has no parent.
 */
export function resolveContext(cmd: Command, io: CliIo, program: Command = cmd): CliContext {
  const ctx = cli.resolveContext(cmd, io);
  const version = programVersion(program);
  if (version !== undefined) sayIfOlderThanSite(ctx, version, RUNNING_FILE);
  return ctx;
}

export const requireApiKey = cli.requireApiKey;

import { cliIdentity, defineCli, type CliContext as ChassisCliContext } from '@antasphere/chassis-cli';
import { IDENTITY } from '@slideless/contract';
import { PlatformClient } from '@slideless/sdk';

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
export const saveConfig = cli.saveConfig;

export const resolveContext = cli.resolveContext;
export const requireApiKey = cli.requireApiKey;

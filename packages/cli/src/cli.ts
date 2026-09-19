import { defineCli, type CliContext as ChassisCliContext } from '@antasphere/chassis-cli';
import { PlatformClient } from '@slideless/sdk';

/**
 * The ONE instantiation of the CLI chassis for Slideless. What the tool is
 * called is its identity, so it is spelled here and nowhere in
 * `@antasphere/chassis-cli`; every generic function that carries it (the
 * config namespace, the environment variables, the hints that name the
 * binary, the key prefix) is built from it and exported under the name it
 * has always had. The command modules import this file, and it imports none
 * of them.
 */
export const cli = defineCli({
  identity: {
    bin: 'slideless',
    tool: 'slideless',
    legacyConfigDir: 'slideless',
    displayName: 'Slideless',
    envPrefix: 'SLIDELESS',
    keyPrefix: 'slk'
  },
  description: 'Command-line client for a Slideless instance (push, share, pull, preview)',
  createClient: (options) => new PlatformClient(options),
  // The deck hint: a push that lost the race for the next version number.
  errorHint: (e) =>
    e.code === 'version_conflict' ? ' (someone pushed in between — rerun to retry)' : undefined
});

/** The context every command resolves: the chassis's, over the Slideless client. */
export type CliContext = ChassisCliContext<PlatformClient>;

export const configPath = cli.configPath;
export const loadConfig = cli.loadConfig;
export const saveConfig = cli.saveConfig;
export const clearConfig = cli.clearConfig;

export const resolveContext = cli.resolveContext;
export const requireApiKey = cli.requireApiKey;

export const pickWorkspaceSelection = cli.workspace.pickWorkspaceSelection;
export const describeSelection = cli.workspace.describeSelection;
export const describeSource = cli.workspace.describeSource;
export const explainRefusal = cli.workspace.explainRefusal;

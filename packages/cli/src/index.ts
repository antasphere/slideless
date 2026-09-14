import { Command, CommanderError } from 'commander';
import { CliAuthError } from '@antasphere/cli-core';
import { PlatformApiError } from '@slideless/sdk';
import { CliUsageError, setStdinApiKey, ttySafeIo, type CliIo } from './context.js';
import { readSecretFromStdin } from './stdin.js';
import { registerAuthCommands } from './commands/auth.js';
import { registerDeckCommands } from './commands/decks.js';
import { registerContentCommands } from './commands/content.js';
import { registerSharingCommands } from './commands/sharing.js';
import { registerFileCommands } from './commands/files.js';
import { registerCompletionCommand } from './commands/completion.js';

export type { CliIo } from './context.js';
export { startDevServer, DEV_SANDBOX_CSP } from './devserver.js';

/**
 * `slideless` — the typed CLI over @slideless/sdk; the primary human/agent
 * face of an instance. Multi-profile (the `slideless` namespace of the
 * shared Antasphere config home: $XDG_CONFIG_HOME/antasphere/tools/
 * slideless.json, default ~/.config/antasphere/; pre-cli-core configs at
 * ~/.config/slideless/config.json are imported once, non-destructively),
 * instance-portable, human tables by default and `--json` everywhere; any
 * error prints to stderr and exits non-zero.
 *
 * Resolution order (documented in docs/agents/cli.md):
 *   base URL: --api-url (alias --url) → SLIDELESS_URL → profile baseUrl → error
 *   API key:  --api-key → SLIDELESS_API_KEY → profile apiKey
 *             → cached hub-connect key (cloud instances; user-scoped —
 *               one per hub profile, valid for every org)
 *             → connect-on-demand: `antasphere login` exchanged for an slk_ key
 */

const VERSION = '0.2.4';

/**
 * The command tree, built once per run. Exported for the docs-coverage test
 * (test/docs-coverage.test.ts), which walks it to prove every command and
 * every flag appears in docs/agents/cli.md — the reference an agent reads.
 */
export function buildProgram(io: CliIo): Command {
  const program = new Command();
  program
    .name('slideless')
    .description('Command-line client for a Slideless instance (push, share, pull, preview)')
    .version(VERSION)
    .option('--api-url <url>', 'instance base URL (or SLIDELESS_URL / profile baseUrl)')
    .option('--url <url>', 'alias of --api-url')
    .option('--api-key <key>', 'API key (or SLIDELESS_API_KEY / profile apiKey)')
    .option('--api-key-stdin', 'read the API key from the first line of stdin (keeps it out of argv)', false)
    .option('--profile <name>', 'use this saved profile instead of the active one')
    .option('--json', 'machine-readable JSON output', false);

  // Identity + profiles: auth login-request/login-complete, login, logout,
  // whoami, verify, use, profiles, config show/clear.
  registerAuthCommands(program, io);
  // Deck management: list, get, versions, delete.
  registerDeckCommands(program, io);
  // Authoring: push, pull, pull-annotations, annotation resolve/reopen, dev.
  registerContentCommands(program, io);
  // Sharing + collaborators: share, unshare, share-email, pin, tokens, views,
  // responses, invite, uninvite.
  registerSharingCommands(program, io);
  // Platform substrate (template heritage): instance, export, files *.
  registerFileCommands(program, io);
  // Shell completion — registered LAST so the tree it prints is complete.
  registerCompletionCommand(program, io);

  return program;
}

/**
 * Run the CLI with injected I/O and return a process exit code. The bin calls
 * this with real process streams; tests call it in-process.
 */
export async function run(argv: string[], rawIo: CliIo): Promise<number> {
  // Every human sink is wrapped ONCE, here: deck titles, annotation bodies,
  // stored filenames and server error messages are all somebody else's text
  // heading for a terminal (context.ts `sanitizeForTty`). `--json` keeps the
  // raw sink through `printJson`.
  const io = ttySafeIo(rawIo);

  // `--api-key-stdin` is resolved BEFORE commander parses: `resolveContext`
  // is synchronous, so the key must already be parked against this io by
  // the time a command asks for it. Reading stdin is the whole point — an
  // argv-borne secret is visible in `ps` and lands in the shell history.
  if (argv.includes('--api-key-stdin')) {
    try {
      setStdinApiKey(io, await readSecretFromStdin(io, 'API key'));
    } catch (e) {
      io.err.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
      return 1;
    }
  }

  const program = buildProgram(io);
  program.exitOverride();
  program.configureOutput({
    writeOut: (s) => io.out.write(s),
    writeErr: (s) => io.err.write(s)
  });
  try {
    await program.parseAsync(argv, { from: 'user' });
    return 0;
  } catch (e) {
    if (e instanceof CommanderError) {
      // --help / --version and usage errors already wrote their output.
      return e.exitCode;
    }
    if (e instanceof PlatformApiError || e instanceof CliAuthError) {
      const hint =
        e.status === 403
          ? ' (this API key is not allowed to do that)'
          : e.code === 'version_conflict'
            ? ' (someone pushed in between — rerun to retry)'
            : e.status === 401
              ? ' (check the key: `slideless verify`)'
              : '';
      io.err.write(`Error: ${e.message}${hint}\n`);
      return 1;
    }
    if (e instanceof CliUsageError) {
      io.err.write(`Error: ${e.message}\n`);
      return 1;
    }
    io.err.write(`Error: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

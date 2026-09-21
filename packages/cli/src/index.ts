import type { Command } from 'commander';
import type { CliIo } from '@antasphere/chassis-cli';
import { cli } from './cli.js';
import { registerDeckCommands } from './commands/decks.js';
import { registerContentCommands } from './commands/content.js';
import { registerReferenceCommands } from './commands/references.js';
import { registerProjectDeckCommands } from './commands/projects.js';
import { registerSharingCommands } from './commands/sharing.js';
import { registerResponseFilesCommand } from './commands/response-files.js';

export type { CliIo } from '@antasphere/chassis-cli';
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
 *   workspace: --workspace → SLIDELESS_WORKSPACE → profile activeWorkspaceId
 *             → none sent (the server's default membership)
 */

const VERSION = '0.4.1';

/**
 * The Slideless command groups, handed to the chassis program, which places
 * them after the auth and workspace groups and before instance/export/files
 * and the completion command (`@antasphere/chassis-cli` program.ts).
 */
function registerTool(program: Command, io: CliIo): void {
  // Deck management: list, get, versions, delete.
  registerDeckCommands(program, io);
  // Authoring: push, pull, pull-annotations, annotation resolve/reopen, dev.
  registerContentCommands(program, io);
  // References: reference list/pull/new/push/publish/unpublish/default/start,
  // and brand / template as the same verbs with the type preset.
  registerReferenceCommands(program, io);
  // The deck's side of the projects (ADR 026), hung off the chassis's own
  // `projects` group: projects link / unlink / brand.
  registerProjectDeckCommands(program, io);
  // Sharing + collaborators: share, unshare, share-email, pin, tokens, views,
  // responses, response, uploads, notify, invite, uninvite.
  registerSharingCommands(program, io);
  // The files respondents uploaded into form file fields: response-files.
  registerResponseFilesCommand(program, io);
}

/**
 * The command tree, built once per run. Exported for the docs-coverage test
 * (test/docs-coverage.test.ts), which walks it to prove every command and
 * every flag appears in docs/agents/cli.md — the reference an agent reads.
 */
export function buildProgram(io: CliIo): Command {
  return cli.buildProgram(io, registerTool, VERSION);
}

/**
 * Run the CLI with injected I/O and return a process exit code. The bin calls
 * this with real process streams; tests call it in-process.
 */
export async function run(argv: string[], rawIo: CliIo): Promise<number> {
  return cli.run(argv, rawIo, registerTool, VERSION);
}

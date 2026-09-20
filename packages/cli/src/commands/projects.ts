import { resolve } from 'node:path';
import type { Command } from 'commander';
import { PlatformApiError } from '@slideless/sdk';
import type { Presentation, PresentationProjectRef } from '@slideless/contract';
import { CliUsageError, explainProjectRefusal, printJson, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext, type CliContext } from '../cli.js';
import { LINK_FILENAME, readLink } from '../manifest.js';

/**
 * The DECK's side of the projects (ADR 026). The chassis owns the concept
 * and its commands (`projects list|get|create|update|archive|unarchive`,
 * `projects members *`); what a project HOLDS is the tool's, so these three
 * verbs hang off the same `projects` group:
 *
 *   projects link <project> [deck]     put a deck in the project
 *   projects unlink <project> [deck]   take it back out
 *   projects brand <project> [ref]     read, set or --clear the project's brand
 *
 * The deck argument is optional wherever the CLI already has a convention
 * for it: `.slideless.json` in the named folder, or in the current one, names
 * the deck (the same file `push`, `open` and `pull` read).
 *
 * Every refusal the server has a code for becomes a sentence; anything else
 * is rethrown and the runner prints it unchanged. `--json` is the API
 * payload verbatim through `printJson`, every human line through the
 * sanitizing sinks the runner installed.
 */

/** The group the chassis registered, found by name on the program. */
function projectsGroup(program: Command): Command {
  const group = program.commands.find((c) => c.name() === 'projects');
  if (!group) {
    // The chassis registers it before the tool's groups (program.ts); a
    // rename there must fail loudly here, not silently drop three commands.
    throw new Error('The chassis `projects` command group is missing — cannot register the deck verbs.');
  }
  return group;
}

/**
 * The deck a verb acts on: the id as written, else the `.slideless.json` of
 * the named folder (or of the current one), which must name THIS instance.
 * A folder path and a deck id are told apart the way the rest of the CLI
 * does it — an argument that names an existing link file is a folder.
 */
async function resolveDeck(ctx: CliContext, deck: string | undefined): Promise<string> {
  if (deck !== undefined) {
    const link = await readLink(resolve(deck));
    if (!link) return deck;
    if (link.baseUrl !== ctx.baseUrl) {
      throw new CliUsageError(
        `${LINK_FILENAME} in ${deck} links that folder to ${link.baseUrl}, but you are working against ` +
          `${ctx.baseUrl}. Name the deck by id instead.`
      );
    }
    return link.presentationId;
  }
  const link = await readLink(resolve('.'));
  if (!link) {
    throw new CliUsageError(
      `No deck given and no ${LINK_FILENAME} in the current folder — name the deck by id, or run this ` +
        'from a folder a push linked.'
    );
  }
  if (link.baseUrl !== ctx.baseUrl) {
    throw new CliUsageError(
      `${LINK_FILENAME} links this folder to ${link.baseUrl}, but you are working against ${ctx.baseUrl}. ` +
        'Name the deck by id instead.'
    );
  }
  return link.presentationId;
}

/**
 * The link/unlink/brand refusals as sentences. The chassis has the project
 * ones (`explainProjectRefusal`); these are the codes the deck side adds,
 * where the same code means something different depending on the verb.
 */
export function explainDeckProjectRefusal(
  e: PlatformApiError,
  verb: 'link' | 'unlink' | 'brand'
): string | null {
  switch (e.code) {
    case 'project_not_found':
      return 'No such project, or it is not yours to read. (A project you are not a member of answers the same way: its existence is not probeable.)';
    case 'not_found':
      return verb === 'brand'
        ? 'No such project or deck, or it is not yours to read.'
        : 'No such deck, or it is not yours to read.';
    case 'not_linked':
      return verb === 'brand'
        ? 'That deck is not in this project. Link it first (`slideless projects link <project> <deck>`).'
        : 'That deck is not in this project, so there is nothing to unlink.';
    case 'not_a_brand':
      return 'That deck is not a brand reference: its AGENT.md frontmatter names no `type: brand`. Push it as a brand first (`slideless brand push`).';
    case 'insufficient_project_role':
      return verb === 'brand'
        ? 'You need the manager role on this project to change its brand.'
        : 'You need editor or more on this project to put a deck in it.';
    case 'project_archived':
      return 'This project is archived and read-only. Unarchive it first to change what it holds.';
    case 'guest_forbidden':
      return 'You are a guest of this workspace, and guests do not take part in projects.';
    case 'forbidden':
      return verb === 'unlink'
        ? 'Only the deck administrator (its owner, or a workspace admin or owner) or a manager of the project takes a deck out of it.'
        : 'Only the deck administrator — its owner, or a workspace admin or owner — puts a deck in a project.';
    default:
      return explainProjectRefusal(e, 'project');
  }
}

/** Run a deck-side project call, turning the known refusals into sentences. */
export async function explainedDeckProject<T>(
  verb: 'link' | 'unlink' | 'brand',
  run: () => Promise<T>
): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof PlatformApiError) {
      const line = explainDeckProjectRefusal(e, verb);
      if (line) throw new CliUsageError(line);
    }
    throw e;
  }
}

/**
 * The projects of a deck payload. The field is in the contract, but an
 * instance older than this CLI answers without it, and the CLI treats the
 * instance's answer as untrusted input everywhere else: a missing or
 * malformed field reads as "no projects", never as a crash mid-push.
 */
export function projectsOf(deck: { projects?: readonly PresentationProjectRef[] }): PresentationProjectRef[] {
  return Array.isArray(deck.projects) ? [...deck.projects] : [];
}

/** The projects of a deck, as a human line: `Atlas (brand), Borealis`, or nothing. */
export function projectsLine(projects: readonly PresentationProjectRef[]): string {
  return projects.map((p) => `${p.name}${p.isBrand ? ' (brand)' : ''}`).join(', ');
}

export function registerProjectDeckCommands(program: Command, io: CliIo): void {
  const projects = projectsGroup(program);

  // ── projects link ─────────────────────────────────────────────────────────
  projects
    .command('link <project> [deck]')
    .description(
      `Put a deck in a project: its members read it from then on (deck administrator + project editor). ` +
        `No deck: the ${LINK_FILENAME} of the current folder`
    )
    .action(async (project: string, deck: string | undefined, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deckId = await resolveDeck(ctx, deck);
      const updated = await explainedDeckProject('link', () =>
        ctx.client.linkPresentationProject(deckId, project)
      );
      if (ctx.json) return printJson(io, updated);
      const now = projectsOf(updated);
      io.out.write(
        `"${updated.title}" is in ${now.length} project${now.length === 1 ? '' : 's'}: ${projectsLine(now)}\n`
      );
    });

  // ── projects unlink ───────────────────────────────────────────────────────
  projects
    .command('unlink <project> [deck]')
    .description(
      `Take a deck out of a project (the deck administrator, or a project manager). ` +
        `No deck: the ${LINK_FILENAME} of the current folder`
    )
    .action(async (project: string, deck: string | undefined, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const deckId = await resolveDeck(ctx, deck);
      const updated = await explainedDeckProject('unlink', () =>
        ctx.client.unlinkPresentationProject(deckId, project)
      );
      if (ctx.json) return printJson(io, updated);
      const left = projectsOf(updated);
      io.out.write(
        left.length === 0
          ? `"${updated.title}" is in no project.\n`
          : `"${updated.title}" is in ${left.length} project${left.length === 1 ? '' : 's'}: ${projectsLine(left)}\n`
      );
    });

  // ── projects brand ────────────────────────────────────────────────────────
  projects
    .command('brand <project> [ref]')
    .description(
      "Show the project's brand; with a deck, make that linked brand reference its brand (project manager)"
    )
    .option('--clear', "clear the project's brand; the deck and its link stay", false)
    .action(async (project: string, ref: string | undefined, opts: { clear: boolean }, cmd: Command) => {
      if (ref !== undefined && opts.clear) {
        throw new CliUsageError('Name the brand to set, or pass --clear, not both.');
      }
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);

      if (opts.clear) {
        const cleared = await explainedDeckProject('brand', () => ctx.client.clearProjectBrand(project));
        if (ctx.json) return printJson(io, cleared);
        io.out.write('This project has no brand now; the deck and its link stay.\n');
        return;
      }

      if (ref === undefined) {
        const current = await explainedDeckProject('brand', () => ctx.client.projectBrand(project));
        if (ctx.json) return printJson(io, current);
        if (!current.brand) {
          io.out.write(
            'This project has no brand. Link a brand reference to it and set it ' +
              '(`slideless projects brand <project> <ref>`).\n'
          );
          return;
        }
        io.out.write(brandLines(current.brand));
        return;
      }

      const deckId = await resolveDeck(ctx, ref);
      const set = await explainedDeckProject('brand', () => ctx.client.setProjectBrand(project, deckId));
      if (ctx.json) return printJson(io, set);
      io.out.write(
        set.brand
          ? `The project's brand is now:\n${brandLines(set.brand)}`
          : "The project's brand is now unset.\n"
      );
    });
}

/** The brand deck, as the human sees it. */
function brandLines(brand: Presentation): string {
  return `${brand.title}\n  id:      ${brand.id}\n  version: ${brand.currentVersion}\n`;
}

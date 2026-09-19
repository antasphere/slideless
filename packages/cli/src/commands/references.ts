import { mkdir, readdir, readFile, rm, rmdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type { Command } from 'commander';
import { PlatformApiError } from '@slideless/sdk';
import { AGENT_DOC_PATH, REFERENCE_TYPES, type Presentation, type ReferenceType } from '@slideless/contract';
import {
  CliUsageError,
  printJson,
  requireApiKey,
  resolveContext,
  table,
  type CliContext,
  type CliIo
} from '../context.js';
import { LINK_FILENAME, readLink, writeLink } from '../manifest.js';
import { writeNoFollow } from '../safe-write.js';
import {
  parseReferenceType,
  readFrontmatter,
  readReferenceLink,
  REFERENCE_DIR,
  referenceDirFor,
  resolveReference,
  scaffoldReference,
  pathExists,
  stripTypeLine,
  type FrontmatterRead
} from '../references.js';
import {
  downloadVersionInto,
  listReferences,
  printPushResult,
  pushDeck,
  type PushOptions
} from './content.js';

/**
 * References from the command line (PRDCT-2420). One real family,
 * `slideless reference <verb>`, whose verbs take `--type brand|template`
 * where the type matters, and two shortcut families, `slideless brand` and
 * `slideless template`, the same verbs with the type preset. Every verb
 * takes `--json`.
 *
 *   list                 the references the caller can read, a mark on the default
 *   pull [ref]           the reference's files into .slideless/<type>/ (no ref: the default)
 *   new <dir>            a neutral scaffold: AGENT.md with the frontmatter, a deck, assets/
 *   push [dir]           push, refused before any upload when the folder declares no type
 *   publish|unpublish    the audience switch (PATCH audience)
 *   default [ref]        the workspace's default of the type (PATCH defaultReference)
 *   start <ref> <dir>    a fresh deck folder copied from the reference, the type line removed
 *
 * The server owns every rule (who reads, who administers, one default per
 * type, the classification at push); this file turns its refusals into
 * sentences and never decides anything the server would not.
 */

interface Family {
  /** The command's name: `reference`, `brand`, `template`. */
  name: string;
  /** The preset type of a shortcut family; undefined for `reference`, which takes `--type`. */
  type: ReferenceType | undefined;
}

export function registerReferenceCommands(program: Command, io: CliIo): void {
  registerFamily(program, io, { name: 'reference', type: undefined });
  registerFamily(program, io, { name: 'brand', type: 'brand' });
  registerFamily(program, io, { name: 'template', type: 'template' });
}

/** The noun of the messages: `brand`, `template`, or `reference` when the type is open. */
const nounOf = (type: ReferenceType | undefined): string => type ?? 'reference';

/**
 * The type a verb runs with: the family's preset (a shortcut family never
 * registers `--type`, so commander refuses the flag before this runs), else
 * the flag's value, else nothing (or a usage error where the verb needs one).
 */
function typeOf(family: Family, flag: string | undefined, required: boolean): ReferenceType | undefined {
  if (family.type) return family.type;
  if (flag !== undefined) return parseReferenceType(flag);
  if (required) throw new CliUsageError(`Pass --type ${REFERENCE_TYPES.join('|')}.`);
  return undefined;
}

function registerFamily(program: Command, io: CliIo, family: Family): void {
  const noun = nounOf(family.type);
  const root = program
    .command(family.name)
    .description(
      family.type
        ? `The workspace's ${family.type}s: \`slideless reference\` with --type ${family.type} preset`
        : 'The references the workspace keeps to make other decks from (brand, template)'
    );
  const withType = (cmd: Command, hint: string): Command =>
    family.type ? cmd : cmd.option('--type <type>', `${hint} (${REFERENCE_TYPES.join(' | ')})`);

  // ── list ──────────────────────────────────────────────────────────────────
  withType(
    root.command('list').description(`List the ${noun}s you can read in the workspace (* marks the default)`),
    'only this type'
  )
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (opts: { type?: string; cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const type = typeOf(family, opts.type, false);
      const params = {
        ...(type ? { type } : {}),
        ...(opts.cursor ? { cursor: opts.cursor } : {}),
        ...(opts.limit !== undefined ? { limit: opts.limit } : {})
      };
      const first = await ctx.client.references(params);
      const rows = [...first.presentations];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.references({ ...params, cursor });
          rows.push(...page.presentations);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { references: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write(`No ${noun}s.\n`);
        return;
      }
      io.out.write(
        table(
          rows.map((r) => [
            r.defaultReference ? '*' : ' ',
            r.reference?.type ?? '-',
            r.title,
            r.id,
            r.audience,
            `v${r.currentVersion}`,
            r.ownerUserId ?? '(deleted user)'
          ])
        )
      );
      io.out.write(`\n* = the workspace's default ${type ?? 'of its type'}\n`);
      if (nextCursor) io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
    });

  // ── pull ──────────────────────────────────────────────────────────────────
  withType(
    root
      .command('pull [ref]')
      .description(
        `Download a ${noun} into ${REFERENCE_DIR}/<type>/ of the current deck folder (no ref: the workspace default)`
      ),
    'the type to pull'
  )
    .option('--at <version>', 'pull this version instead of the latest', (v: string) => parseInt(v, 10))
    .option('--into <dir>', `write there instead of ${REFERENCE_DIR}/<type>/`)
    .action(
      async (ref: string | undefined, opts: { type?: string; at?: number; into?: string }, cmd: Command) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const type = typeOf(family, opts.type, ref === undefined);
        const match = await pickReference(ctx, ref, type, noun);
        const matchType = match.reference!.type;
        const version = versionOf(match, opts.at);
        const dest = resolve(opts.into ?? referenceDirFor('.', matchType));

        // The folder is replaced only when it is one this command wrote (its
        // link file names a reference); anything else that is not empty is
        // refused, so a mistyped --into never wipes a folder of somebody's.
        await prepareReferenceDir(dest, ctx.baseUrl, noun);
        const detail = await downloadOrClean(ctx, match.id, version, dest);
        await writeLink(dest, {
          presentationId: match.id,
          baseUrl: ctx.baseUrl,
          reference: { type: matchType, version }
        });
        if (ctx.json) {
          return printJson(io, {
            reference: match,
            version: detail,
            path: dest,
            files: detail.manifest.length
          });
        }
        io.out.write(
          `Pulled ${matchType} "${match.title}" v${version} → ${dest} (${detail.manifest.length} files)\n` +
            `  read ${join(dest, AGENT_DOC_PATH)} before authoring; a push from the deck folder records this ${matchType}.\n`
        );
      }
    );

  // ── new ───────────────────────────────────────────────────────────────────
  withType(
    root
      .command('new <dir>')
      .description(
        `Scaffold a ${noun} folder: ${AGENT_DOC_PATH} with the frontmatter of the type, a deck, assets/`
      ),
    'the type to scaffold'
  )
    .option('--title <title>', 'the title written in the frontmatter (default: an invented one)')
    .action(async (dir: string, opts: { type?: string; title?: string }, cmd: Command) => {
      const { json } = jsonOnly(cmd);
      const type = typeOf(family, opts.type, true)!;
      const target = resolve(dir);
      if (!(await isMissingOrEmptyDir(target))) {
        throw new CliUsageError(`${target} exists and is not empty; scaffold into a new or empty folder.`);
      }
      const scaffold = scaffoldReference(type, opts.title);
      await mkdir(target, { recursive: true });
      for (const d of scaffold.dirs) await mkdir(join(target, d), { recursive: true });
      for (const f of scaffold.files)
        await writeNoFollow(join(target, f.path), Buffer.from(f.content, 'utf8'));
      if (json)
        return printJson(io, {
          path: target,
          type,
          files: scaffold.files.map((f) => f.path),
          dirs: scaffold.dirs
        });
      io.out.write(
        `Scaffolded a ${type} in ${target}: ${scaffold.files.map((f) => f.path).join(', ')}, ${scaffold.dirs.join('/, ')}/\n` +
          `  Fill ${AGENT_DOC_PATH} (the frontmatter and the sections) and the deck, then \`slideless ${family.name} push ${dir}\`.\n`
      );
    });

  // ── push ──────────────────────────────────────────────────────────────────
  withType(
    root
      .command('push [dir]')
      .description(`Push a ${noun} folder (refused before any upload when ${AGENT_DOC_PATH} names no type)`),
    'the type the folder must declare'
  )
    .option('--title <title>', 'deck title (default: existing title, or the folder name)')
    .option('--entry <path>', 'entry document (default: index.html, or the only .html)')
    .option('--id <deckId>', 'push a new version of this existing reference')
    .option('--new', `force a NEW reference even when ${LINK_FILENAME} links one`, false)
    .option('--open', "open the reference's page in the browser after the push")
    .option('--no-open', 'never open the browser')
    .action(
      async (
        dir: string | undefined,
        opts: { type?: string; title?: string; entry?: string; id?: string; new: boolean; open?: boolean },
        cmd: Command
      ) => {
        const ctx = resolveContext(cmd, io);
        await requireApiKey(ctx);
        const type = typeOf(family, opts.type, false);
        const target = dir ?? '.';
        const declared = await refuseUnlessDeclared(target, type, noun);
        const pushOpts: PushOptions = {
          kind: 'presentation',
          interactive: false,
          new: opts.new,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          // A reference is named by its frontmatter: a new deck takes that
          // title, not the folder's name, so `<ref>` resolves by the name
          // the author wrote.
          ...(declared.title !== null ? { defaultTitle: declared.title } : {}),
          ...(opts.entry !== undefined ? { entry: opts.entry } : {}),
          ...(opts.id !== undefined ? { id: opts.id } : {}),
          ...(opts.open !== undefined ? { open: opts.open } : {})
        };
        let result;
        try {
          result = await pushDeck(ctx, target, pushOpts);
        } catch (e) {
          // The link file names a reference the caller READS (the folder
          // was pulled) but the commit answers not found: the server says
          // nothing about a deck the caller cannot write to, so say here
          // what it means.
          if (
            e instanceof PlatformApiError &&
            e.status === 404 &&
            (await readReferenceLink(resolve(target)))
          ) {
            throw new CliUsageError(
              `This ${noun} is not yours to push: only its owner (or a collaborator with a dev grant) pushes a ` +
                `new version, and the instance answers "not found" to anyone else. Start a deck of your own from ` +
                `it with \`slideless ${family.name} start\`.`
            );
          }
          throw e;
        }
        printPushResult(ctx, result, pushOpts);
        if (!ctx.json && !result.committed.version.reference && !result.committed.version.referenceWarning) {
          io.out.write(`  warning: the instance classified this push as an ordinary deck, not a ${noun}.\n`);
        }
      }
    );

  // ── publish / unpublish ───────────────────────────────────────────────────
  for (const [verb, audience] of [
    ['publish', 'workspace'],
    ['unpublish', 'private']
  ] as const) {
    withType(
      root
        .command(`${verb} <ref>`)
        .description(
          audience === 'workspace'
            ? `Open the ${noun} to every member of the workspace (audience: workspace)`
            : `Close the ${noun} to its owner, the admins and its collaborators again (audience: private)`
        ),
      'narrow the name to this type'
    ).action(async (ref: string, opts: { type?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const type = typeOf(family, opts.type, false);
      const match = await pickReference(ctx, ref, type, noun);
      const updated = await patchReference(ctx, match, { audience }, noun);
      if (ctx.json) return printJson(io, updated);
      io.out.write(
        audience === 'workspace'
          ? `"${updated.title}" (${updated.reference?.type}) is published: every member of the workspace reads it.\n`
          : `"${updated.title}" (${updated.reference?.type}) is private again: its owner, the admins and its collaborators read it.\n`
      );
    });
  }

  // ── default ───────────────────────────────────────────────────────────────
  withType(
    root
      .command('default [ref]')
      .description(
        `Make a ${noun} the workspace's default of its type (admin or owner); --clear removes the default`
      ),
    'the type whose default to set or clear'
  )
    .option(
      '--clear',
      `clear the default (of <ref>, or of the --type / the family's type when no ref is given)`,
      false
    )
    .action(async (ref: string | undefined, opts: { type?: string; clear: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (ref === undefined && !opts.clear) {
        throw new CliUsageError(`Name the ${noun} to make the default, or pass --clear.`);
      }
      const type = typeOf(family, opts.type, ref === undefined);
      let match: Presentation;
      if (ref !== undefined) {
        match = await pickReference(ctx, ref, type, noun);
      } else {
        const current = await ctx.client.defaultReference(type!);
        if (!current) {
          if (ctx.json) return printJson(io, { cleared: null, type });
          io.out.write(`The workspace has no default ${type}; nothing to clear.\n`);
          return;
        }
        match = current;
      }
      if (opts.clear && !match.defaultReference) {
        if (ctx.json) return printJson(io, match);
        io.out.write(`"${match.title}" is not the default ${match.reference?.type}; nothing to clear.\n`);
        return;
      }
      const updated = await patchReference(ctx, match, { defaultReference: !opts.clear }, noun);
      if (ctx.json) return printJson(io, updated);
      io.out.write(
        opts.clear
          ? `"${updated.title}" is no longer the default ${updated.reference?.type}; the workspace has none.\n`
          : `"${updated.title}" is the workspace's default ${updated.reference?.type}: \`slideless ${updated.reference?.type} pull\` with no name fetches it.\n`
      );
    });

  // ── start ─────────────────────────────────────────────────────────────────
  withType(
    root
      .command('start <ref> <dir>')
      .description(
        `Start a deck from a ${noun}: its files copied into a fresh folder, the type line removed, no link file`
      ),
    'narrow the name to this type'
  )
    .option('--at <version>', 'start from this version instead of the latest', (v: string) => parseInt(v, 10))
    .action(async (ref: string, dir: string, opts: { type?: string; at?: number }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const type = typeOf(family, opts.type, false);
      const match = await pickReference(ctx, ref, type, noun);
      const version = versionOf(match, opts.at);
      const target = resolve(dir);
      if (!(await isMissingOrEmptyDir(target))) {
        throw new CliUsageError(`${target} exists and is not empty; start into a new or empty folder.`);
      }
      const detail = await downloadOrClean(ctx, match.id, version, target);
      // A deck made from a reference is not a reference: the type line goes,
      // the rest of the briefing (title, description, the fields) stays for
      // the agent that authors the deck. No link file: the first push of
      // this folder creates a deck of its own.
      const agentPath = join(target, AGENT_DOC_PATH);
      const hadAgentDoc = detail.manifest.some((e) => e.path === AGENT_DOC_PATH);
      if (hadAgentDoc) {
        const text = await readFile(agentPath, 'utf8');
        await writeNoFollow(agentPath, Buffer.from(stripTypeLine(text), 'utf8'));
      }
      const from = { type: match.reference!.type, id: match.id, version };
      if (ctx.json) {
        return printJson(io, { from, path: target, files: detail.manifest.length });
      }
      io.out.write(
        `Started a deck in ${target} from ${from.type} "${match.title}" v${version} (${detail.manifest.length} files` +
          `${hadAgentDoc ? `, the type line removed from ${AGENT_DOC_PATH}` : ''})\n` +
          `  Next: cd ${dir} && slideless push --new --${from.type} ${match.id}@${version}\n`
      );
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The reference `ref` names, or the workspace's default of `type` when no ref is given. */
async function pickReference(
  ctx: CliContext,
  ref: string | undefined,
  type: ReferenceType | undefined,
  noun: string
): Promise<Presentation> {
  if (ref === undefined) {
    if (!type) throw new CliUsageError(`Name the ${noun}, or pass --type to take the workspace default.`);
    const current = await ctx.client.defaultReference(type);
    if (!current) {
      throw new CliUsageError(
        `This workspace has no default ${type}. Name one (\`slideless ${type} list\`), or ask a workspace admin ` +
          `to set it (\`slideless ${type} default <ref>\`).`
      );
    }
    return current;
  }
  const candidates = await listReferences(ctx, type);
  return resolveReference(candidates, ref, noun);
}

/** `--at`, checked against the reference's versions; the latest when absent. */
function versionOf(match: Presentation, at: number | undefined): number {
  if (match.currentVersion < 1) throw new CliUsageError(`"${match.title}" has no committed versions yet.`);
  if (at === undefined) return match.currentVersion;
  if (!Number.isInteger(at) || at < 1 || at > match.currentVersion) {
    throw new CliUsageError(
      `"${match.title}" is at version ${match.currentVersion}; --at must be between 1 and that.`
    );
  }
  return at;
}

/**
 * The audience / default PATCH, with the server's refusals turned into
 * sentences (docs/concepts/references.md has the table).
 */
async function patchReference(
  ctx: CliContext,
  match: Presentation,
  patch: { audience?: 'private' | 'workspace'; defaultReference?: boolean },
  noun: string
): Promise<Presentation> {
  try {
    return await ctx.client.updatePresentation(match.id, patch);
  } catch (e) {
    if (!(e instanceof PlatformApiError)) throw e;
    const title = `"${match.title}"`;
    switch (e.code) {
      case 'not_a_reference':
        throw new CliUsageError(
          `${title} is an ordinary deck, not a ${noun}: its ${AGENT_DOC_PATH} frontmatter names no type. Push it with one first.`
        );
      case 'audience_private':
        throw new CliUsageError(
          `${title} is private; a default must be readable by the workspace. Run \`slideless ${match.reference?.type} publish\` first.`
        );
      case 'default_reference':
        throw new CliUsageError(
          `${title} is the workspace's default ${match.reference?.type} and cannot go private while it is. ` +
            `Clear the default first (\`slideless ${match.reference?.type} default ${match.id} --clear\`).`
        );
      case 'forbidden':
        throw new CliUsageError(
          patch.defaultReference !== undefined
            ? `Only a workspace admin or owner sets the default ${match.reference?.type}.`
            : `Only the owner of ${title}, or a workspace admin or owner, changes who reads it.`
        );
      default:
        throw e;
    }
  }
}

/**
 * The refusal `reference push` makes BEFORE any upload: the folder must
 * carry an AGENT.md whose frontmatter declares a type (and, on a shortcut
 * family, that type). The server would accept the push as an ordinary
 * deck, which is not what this command means.
 */
async function refuseUnlessDeclared(
  target: string,
  type: ReferenceType | undefined,
  noun: string
): Promise<FrontmatterRead> {
  const abs = resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new CliUsageError(`No such file or directory: ${target}`);
  if (!info.isDirectory()) {
    throw new CliUsageError(
      `A ${noun} is a folder with an ${AGENT_DOC_PATH} at its root; ${target} is a file.`
    );
  }
  const text = await readFile(join(abs, AGENT_DOC_PATH), 'utf8').catch(() => null);
  if (text === null) {
    throw new CliUsageError(
      `${target} has no ${AGENT_DOC_PATH}: a ${noun} declares its type in that file's frontmatter ` +
        `(\`slideless ${noun === 'reference' ? 'reference' : noun} new\` scaffolds one). Nothing was uploaded.`
    );
  }
  const read = readFrontmatter(text);
  if (!read.frontmatter) {
    throw new CliUsageError(
      `${AGENT_DOC_PATH} in ${target} has no frontmatter: a ${noun} starts with a \`---\` block whose ` +
        `\`type:\` line names ${REFERENCE_TYPES.join(' or ')}. Nothing was uploaded.`
    );
  }
  if (read.declared === null) {
    throw new CliUsageError(
      `${AGENT_DOC_PATH} in ${target} has a frontmatter with no \`type:\` line; a ${noun} names ` +
        `${REFERENCE_TYPES.join(' or ')} there. Nothing was uploaded.`
    );
  }
  if (read.type === null) {
    throw new CliUsageError(
      `${AGENT_DOC_PATH} in ${target} names the type "${read.declared}", which is not a known reference type ` +
        `(${REFERENCE_TYPES.join(', ')}). Nothing was uploaded.`
    );
  }
  if (type && read.type !== type) {
    throw new CliUsageError(
      `${AGENT_DOC_PATH} in ${target} declares a ${read.type}, and this command pushes a ${type}. ` +
        `Use \`slideless ${read.type} push\` (or \`slideless reference push\`). Nothing was uploaded.`
    );
  }
  return read;
}

/**
 * The destination of a pull: missing or empty, or a folder this command
 * wrote before (its link file names a reference on THIS instance), which
 * is emptied and written again. Anything else is refused.
 */
async function prepareReferenceDir(dest: string, baseUrl: string, noun: string): Promise<void> {
  if (await isMissingOrEmptyDir(dest)) return;
  const info = await stat(dest);
  if (!info.isDirectory()) throw new CliUsageError(`${dest} exists and is not a folder.`);
  const link = await readReferenceLink(dest);
  if (!link) {
    const plain = await readLink(dest);
    throw new CliUsageError(
      plain
        ? `${dest} is a deck folder linked by ${LINK_FILENAME}, not a pulled ${noun}; pull into another folder (--into).`
        : `${dest} is not empty and is not a folder a previous pull wrote. Delete it to pull there, or pull into another folder (--into).`
    );
  }
  if (link.baseUrl !== baseUrl) {
    throw new CliUsageError(
      `${dest} holds a ${link.reference.type} pulled from ${link.baseUrl}, and you are pulling from ${baseUrl}. ` +
        `Delete the folder or pull into another one (--into).`
    );
  }
  // Ours: replace it. The link file inside it is the proof it was ours.
  await rm(dest, { recursive: true, force: true });
}

/**
 * The download into a folder this command owns (missing, empty, or emptied
 * by `prepareReferenceDir`): on ANY failure (a lying hash, an escaping path,
 * a dropped connection) what was written is removed, the folder with it,
 * and its parent when that was created empty. A half-written folder with
 * no link file would be refused by every later pull as "not a folder a
 * previous pull wrote", with no way out but a deletion nobody names.
 */
async function downloadOrClean(ctx: CliContext, deckId: string, version: number, dest: string) {
  // What exists BEFORE the download is the person's and stays; what this
  // command creates is its own to remove. `dest` is missing or empty here
  // (`prepareReferenceDir` or `isMissingOrEmptyDir` said so): an existing
  // empty folder is emptied again on failure, never deleted; a folder this
  // command created goes; its parent goes only when the command created it
  // (the `.slideless/` above a default pull), and only while it is empty.
  const destExisted = await pathExists(dest);
  // The nearest ancestor that existed before: every level between it and
  // `dest` is one the download's mkdir creates, and one this command may
  // remove again (while empty) when the download fails.
  let firstExisting = dirname(dest);
  while (firstExisting !== dirname(firstExisting) && !(await pathExists(firstExisting))) {
    firstExisting = dirname(firstExisting);
  }
  try {
    return await downloadVersionInto(ctx, deckId, version, dest);
  } catch (e) {
    const removed: string[] = [];
    if (destExisted) {
      for (const entry of await readdir(dest).catch(() => [] as string[])) {
        await rm(join(dest, entry), { recursive: true, force: true }).catch(() => undefined);
        removed.push(join(dest, entry));
      }
    } else if (await pathExists(dest)) {
      // Created by this download (it was absent before): remove it, then
      // every level the mkdir created above it, stopping at the first that
      // is not empty (rmdir refuses it, so a sibling reference survives).
      await rm(dest, { recursive: true, force: true }).catch(() => undefined);
      removed.push(dest);
      for (let level = dirname(dest); level !== firstExisting; level = dirname(level)) {
        try {
          await rmdir(level);
        } catch {
          break;
        }
      }
    }
    if (removed.length > 0) {
      ctx.io.err.write(
        `Nothing of the download is kept: ${removed.length === 1 && removed[0] === dest ? dest : `the files in ${dest}`} ` +
          'removed.\n'
      );
    }
    throw e;
  }
}

async function isMissingOrEmptyDir(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  if (!info) return true;
  if (!info.isDirectory()) return false;
  return (await readdir(path)).length === 0;
}

/** `new` is backendless: only the --json flag matters, never URL/key. */
function jsonOnly(cmd: Command): { json: boolean } {
  const opts = cmd.optsWithGlobals() as { json?: boolean };
  return { json: Boolean(opts.json) };
}

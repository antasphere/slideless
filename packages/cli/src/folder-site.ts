import { stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Command } from 'commander';
import { CliUsageError, type CliIo } from '@antasphere/chassis-cli';
import { firstSet, normalizeUrl, sameInstance } from '@antasphere/cli-core';
import { cli, resolveContext, type CliContext } from './cli.js';
import { LINK_FILENAME, readLink } from './manifest.js';

/**
 * R6, a deck's folder decides its site (PRDCT-5248). A command run on a
 * linked folder goes to the site its `.slideless.json` names, whatever the
 * default profile is, as if `--api-url <that site>` had been given: the kit
 * then picks the profile at that site and its own sign-in. An explicit
 * `--api-url`, `--url`, `SLIDELESS_URL` or `--profile` naming ANOTHER site is
 * refused before any request, both named; `push --new` and `push --id` keep
 * their freedom (they run there and relink the folder). Two more refusals
 * before any request: a folder linked to a site no profile of this machine
 * is (a link file someone else wrote never decides where this machine's
 * content goes), and a key given on the command line on a folder whose site
 * is not the default profile's (nothing says which site that key was meant
 * for). The mismatch checks the verbs ran before (`linkedDeckId`, `pull`'s,
 * `prepareReferenceDir`) stay behind this one, as the backstop.
 */

/** A linked folder, and the site its link file names. */
export interface FolderSite {
  /** The folder, absolute. */
  folder: string;
  /** The site its `.slideless.json` names, in its normal form (`normalizeUrl`). */
  origin: string;
}

/** Whether a link file's instance is an http(s) origin, the only kind a deck's site is. */
function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * The refusal of a link file whose instance is not an http(s) URL. The link
 * file can arrive with a cloned folder: `open` must never hand its value to
 * the platform opener, and no command sends anything to it.
 */
export function refuseNonHttpSite(baseUrl: string): void {
  if (!isHttpUrl(baseUrl)) {
    throw new CliUsageError(
      `${LINK_FILENAME} names ${JSON.stringify(baseUrl)} as the instance, which is not an ` +
        'http(s) URL — refusing to open it. Fix the file or push the folder again.'
    );
  }
}

/** The site a folder's link file names; null when the folder carries no valid link. */
export async function folderSiteOf(dir: string): Promise<FolderSite | null> {
  const folder = resolve(dir);
  const link = await readLink(folder);
  if (!link) return null;
  refuseNonHttpSite(link.baseUrl);
  return { folder, origin: normalizeUrl(link.baseUrl) };
}

/**
 * The deck root of a push target, as `scanDeck` decides it: the target when
 * it is a folder, its folder when it is a file; null when nothing is there
 * (the scan then says so).
 */
export async function deckRootOf(target: string): Promise<string | null> {
  const abs = resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info) return null;
  return info.isDirectory() ? abs : dirname(abs);
}

/** What a refusal adds after « to run on the folder's own site », per verb. */
const TAIL = {
  push: ', or pass --new to make a fresh deck there',
  pull: ', or pull into another folder',
  other: ''
} as const;

/** The global options this file reads (the kit declares them, program.ts). */
interface GlobalOpts {
  apiUrl?: string;
  url?: string;
  apiKey?: string;
  apiKeyStdin?: boolean;
  profile?: string;
}

/** A site a command was given explicitly: the URL, by what, and how to take it back. */
interface ExplicitSite {
  url: string;
  by: string;
  back: string;
}

/**
 * The context of a command acting on a folder (`site`, from `folderSiteOf`),
 * synchronous and with no request of its own; `resolveContext` as it is when
 * the folder carries no link.
 */
export function resolveFolderContext(
  cmd: Command,
  io: CliIo,
  site: FolderSite | null,
  opts: { verb: 'push' | 'pull' | 'other'; freeDeck?: boolean }
): CliContext {
  if (site === null) return resolveContext(cmd, io);
  const given = cmd.optsWithGlobals() as GlobalOpts;
  const URL_VAR = `${cli.identity.envPrefix}_URL`;

  // The explicit site, in this order; a blank value counts as unset.
  let explicit: ExplicitSite | undefined;
  const apiUrl = firstSet(given.apiUrl);
  const url = firstSet(given.url);
  const envUrl = firstSet(io.env[URL_VAR]);
  const profileName = firstSet(given.profile);
  if (apiUrl) explicit = { url: apiUrl, by: '--api-url', back: 'Drop --api-url' };
  else if (url) explicit = { url, by: '--url', back: 'Drop --url' };
  else if (envUrl) explicit = { url: envUrl, by: URL_VAR, back: `Unset ${URL_VAR}` };
  else if (profileName) {
    let profileSite: string;
    try {
      profileSite = cli.profileUrl(cli.resolveProfile(cli.loadConfig(io.env), profileName).profile);
    } catch {
      // An unknown profile: the kit's own refusal says it.
      return resolveContext(cmd, io);
    }
    explicit = { url: profileSite, by: `--profile ${profileName}`, back: 'Drop --profile' };
  }

  if (explicit) {
    if (sameInstance(explicit.url, site.origin) || opts.freeDeck) return resolveContext(cmd, io);
    throw new CliUsageError(
      `${LINK_FILENAME} links ${site.folder} to ${site.origin}, and ${explicit.by} names ` +
        `${normalizeUrl(explicit.url)}. ${explicit.back} to run on the folder's own site${TAIL[opts.verb]}.`
    );
  }

  // (a) The folder's site must be a site of this machine: a saved profile, or the implicit cloud.
  const config = cli.loadConfig(io.env);
  const known =
    sameInstance(cli.identity.cloudUrl, site.origin) ||
    Object.values(config.profiles).some((profile) => sameInstance(cli.profileUrl(profile), site.origin));
  if (!known) {
    throw new CliUsageError(
      `${LINK_FILENAME} links ${site.folder} to ${site.origin}, which no profile on this machine is. ` +
        `Add it once with \`${cli.identity.bin} profiles add ${site.origin}\`, or name it for this command ` +
        `with --api-url ${site.origin}.`
    );
  }

  // (b) A key given on the command line names no site: it goes on the folder's only when that is the default's.
  const flag = firstSet(given.apiKey)
    ? '--api-key'
    : given.apiKeyStdin === true
      ? '--api-key-stdin'
      : undefined;
  if (flag) {
    const defaultSite = cli.profileUrl(cli.resolveProfile(config, undefined).profile);
    if (!sameInstance(defaultSite, site.origin)) {
      throw new CliUsageError(
        `${flag} names no site, and ${LINK_FILENAME} links ${site.folder} to ${site.origin} while the default ` +
          `profile is ${normalizeUrl(defaultSite)}. Add --api-url ${site.origin} to send this key there.`
      );
    }
  }

  // Through the wrapper, so a routed command says it too when it is older than its site; the
  // view has no parent, so the program's version is read from `cmd`.
  return resolveContext(withApiUrl(cmd, site.origin), io, cmd);
}

/** `cmd` with `--api-url` set to `origin`, never mutated (no write to `io.env` either: an exported key stays paired with its site). */
function withApiUrl(cmd: Command, origin: string): Command {
  // The kit's resolveContext reads only `cmd.optsWithGlobals()`; test/folder-site.test.ts goes red if it reads more.
  return { optsWithGlobals: () => ({ ...cmd.optsWithGlobals(), apiUrl: origin }) } as unknown as Command;
}

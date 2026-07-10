import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';

/**
 * Deck folder scanning for `slideless push`: walk a folder (or take a single
 * HTML file), apply `.slidelessignore` rules, hash every file (sha256 = the
 * server's content address), detect the entry document, and read/write the
 * `.slideless.json` link file that binds a folder to its deck id.
 */

export interface DeckFile {
  /** Relative POSIX path inside the deck (the manifest path). */
  path: string;
  absPath: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface DeckScan {
  /** The deck root (the folder the link file lives in). */
  rootDir: string;
  files: DeckFile[];
}

export const LINK_FILENAME = '.slideless.json';
export const IGNORE_FILENAME = '.slidelessignore';

/** Always excluded, whatever the ignore file says. */
const DEFAULT_IGNORES = ['.git', 'node_modules', '.DS_Store', 'Thumbs.db', LINK_FILENAME, IGNORE_FILENAME];

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.xml': 'application/xml',
  '.csv': 'text/csv',
  '.wasm': 'application/wasm'
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

export async function sha256File(absPath: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolvePromise, reject) => {
    createReadStream(absPath)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise())
      .on('error', reject);
  });
  return hash.digest('hex');
}

// ── .slidelessignore ─────────────────────────────────────────────────────────
// A pragmatic gitignore subset: `#` comments, blank lines skipped, `*` (one
// segment), `**` (any depth), `?` (one char). A pattern containing `/` is
// anchored to the deck root (a leading `/` is stripped); one without `/`
// matches any path segment (file OR directory) at any depth. A trailing `/`
// restricts the pattern to directories. No negation (`!`) support.

export interface IgnoreRule {
  regex: RegExp;
  dirOnly: boolean;
  anchored: boolean;
}

function globToRegex(glob: string): string {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        // swallow a following slash so `a/**/b` also matches `a/b`
        if (glob[i + 1] === '/') {
          out = out.slice(0, -2) + '(?:.*/)?';
          i++;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else {
      out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return out;
}

export function parseIgnoreFile(content: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    let pattern = line;
    const dirOnly = pattern.endsWith('/');
    if (dirOnly) pattern = pattern.slice(0, -1);
    const anchored = pattern.includes('/');
    if (pattern.startsWith('/')) pattern = pattern.slice(1);
    rules.push({ regex: new RegExp(`^${globToRegex(pattern)}$`), dirOnly, anchored });
  }
  return rules;
}

/** Whether relPath (POSIX, no leading slash) is ignored. */
export function isIgnored(relPath: string, isDir: boolean, rules: IgnoreRule[]): boolean {
  const base = relPath.split('/').pop() ?? relPath;
  if (DEFAULT_IGNORES.includes(base)) return true;
  for (const rule of rules) {
    if (rule.dirOnly && !isDir) continue;
    const subject = rule.anchored ? relPath : base;
    if (rule.regex.test(subject)) return true;
  }
  return false;
}

// ── Scanning ─────────────────────────────────────────────────────────────────

async function walk(
  rootDir: string,
  dir: string,
  rules: IgnoreRule[],
  out: Array<{ path: string; absPath: string }>
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absPath = join(dir, entry.name);
    const relPath = absPath
      .slice(rootDir.length + 1)
      .split(sep)
      .join('/');
    if (entry.isSymbolicLink()) continue; // never follow links out of the deck
    if (entry.isDirectory()) {
      if (isIgnored(relPath, true, rules)) continue;
      await walk(rootDir, absPath, rules, out);
    } else if (entry.isFile()) {
      if (isIgnored(relPath, false, rules)) continue;
      out.push({ path: relPath, absPath });
    }
  }
}

/**
 * Scan a deck target: a folder (recursive, ignore-aware) or a single HTML
 * file (a one-file deck whose root is the file's directory).
 */
export async function scanDeck(target: string): Promise<DeckScan> {
  const abs = resolve(target);
  const info = await stat(abs).catch(() => null);
  if (!info) throw new Error(`No such file or directory: ${target}`);

  let rootDir: string;
  let listed: Array<{ path: string; absPath: string }>;
  if (info.isFile()) {
    rootDir = dirname(abs);
    listed = [{ path: basename(abs), absPath: abs }];
  } else {
    rootDir = abs;
    let rules: IgnoreRule[] = [];
    const ignoreFile = await readFile(join(abs, IGNORE_FILENAME), 'utf8').catch(() => null);
    if (ignoreFile !== null) rules = parseIgnoreFile(ignoreFile);
    listed = [];
    await walk(rootDir, rootDir, rules, listed);
  }
  if (listed.length === 0) {
    throw new Error(`Nothing to push: ${target} has no files (after ignores)`);
  }
  if (listed.length > 5000) {
    throw new Error(`Deck too large: ${listed.length} files (the server caps manifests at 5000)`);
  }

  const files: DeckFile[] = [];
  for (const item of listed) {
    const s = await stat(item.absPath);
    files.push({
      path: item.path,
      absPath: item.absPath,
      sha256: await sha256File(item.absPath),
      sizeBytes: s.size,
      contentType: contentTypeFor(item.path)
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return { rootDir, files };
}

/**
 * Entry detection: --entry wins (must exist in the scan), then `index.html`
 * at the root, then the single .html file if there is exactly one.
 */
export function detectEntry(scan: DeckScan, explicit?: string): string {
  if (explicit) {
    const normalized = explicit.replace(/^\.\//, '');
    if (!scan.files.some((f) => f.path === normalized)) {
      throw new Error(`--entry ${explicit} is not among the deck's files`);
    }
    return normalized;
  }
  if (scan.files.some((f) => f.path === 'index.html')) return 'index.html';
  const htmls = scan.files.filter((f) => f.path.endsWith('.html') || f.path.endsWith('.htm'));
  if (htmls.length === 1) return htmls[0]!.path;
  if (htmls.length === 0) throw new Error('No HTML entry found — a deck needs at least one .html file');
  throw new Error(
    `Multiple HTML files and no index.html — pick one with --entry (${htmls
      .map((h) => h.path)
      .slice(0, 5)
      .join(', ')}${htmls.length > 5 ? ', …' : ''})`
  );
}

// ── Link file (.slideless.json) ──────────────────────────────────────────────
// Binds a local folder to its deck: push without --id becomes "new version of
// THIS deck" once the link exists. The link records the instance origin too,
// so pushing the same folder at a different instance fails loudly instead of
// silently targeting a foreign id.

export interface DeckLink {
  presentationId: string;
  baseUrl: string;
}

export async function readLink(rootDir: string): Promise<DeckLink | null> {
  try {
    const parsed = JSON.parse(await readFile(join(rootDir, LINK_FILENAME), 'utf8')) as Partial<DeckLink>;
    if (typeof parsed.presentationId === 'string' && typeof parsed.baseUrl === 'string') {
      return { presentationId: parsed.presentationId, baseUrl: parsed.baseUrl };
    }
    return null;
  } catch {
    return null;
  }
}

export async function writeLink(rootDir: string, link: DeckLink): Promise<void> {
  await writeFile(join(rootDir, LINK_FILENAME), `${JSON.stringify(link, null, 2)}\n`);
}

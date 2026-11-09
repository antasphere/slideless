import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { link, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { detectEntry, scanDeck } from './manifest.js';

/**
 * Local versions (PRDCT-4260): `slideless snapshot` and the dev server's
 * snapshot route record a folder's state as version N+1 on THIS machine, with
 * no instance and no credential. A version is the server's own shape
 * (presentation_versions: the entry plus one `{ path, sha256, sizeBytes,
 * contentType }` row per file, listed by `scanDeck`, so the same ignore rules
 * and the same 5000-file cap apply), and its files are content-addressed
 * blobs, so a later push can upload a local history as it is.
 *
 * The store is per user, never beside the folder: a version must never land
 * in a git repository by surprise. Layout under the store root:
 *
 *   blobs/<sha[0..2]>/<sha256>                     one file per distinct content
 *   folders/<key>/folder.json                      { v, root } — which folder <key> is
 *   folders/<key>/versions/<n>.json                one immutable record per version
 *
 * `<key>` is a hash of the folder's real path. A record is written whole,
 * then claimed under its number by a hard link, which fails when the number
 * is taken: two snapshots racing never overwrite each other (the loser takes
 * the next number, or answers the winner's version when it holds the same
 * state), and no reader ever sees half a record. A record is never rewritten.
 */

export const LOCAL_STORE_ENV = 'SLIDELESS_LOCAL_STORE';

const SHA256_RE = /^[0-9a-f]{64}$/;
const RECORD_RE = /^([1-9][0-9]{0,8})\.json$/;
const MAX_CLAIM_ATTEMPTS = 50;

export interface LocalVersionFile {
  path: string;
  sha256: string;
  sizeBytes: number;
  contentType: string;
}

export interface LocalVersionRecord {
  v: 1;
  version: number;
  root: string;
  entryPath: string;
  createdAt: string;
  fileCount: number;
  sizeBytes: number;
  manifest: LocalVersionFile[];
}

/** A version as listings show it: the record without its manifest. */
export type LocalVersionSummary = Omit<LocalVersionRecord, 'manifest' | 'v'>;

export interface SnapshotResult {
  /** The version that now holds the folder's state (the new one, or the latest when nothing changed). */
  version: number;
  /** False when the folder matched the latest version: nothing was written. */
  created: boolean;
  entryPath: string;
  fileCount: number;
  sizeBytes: number;
  root: string;
  store: string;
}

/**
 * The store root: `--store` → `SLIDELESS_LOCAL_STORE` → the user's data
 * directory (`%LOCALAPPDATA%` on Windows, `$XDG_DATA_HOME` or `~/.local/share`
 * elsewhere), under `antasphere/slideless/local`. A data directory, not a
 * cache: the versions are the person's work, and cache cleaners empty caches.
 */
export function defaultLocalStore(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[LOCAL_STORE_ENV]?.trim();
  if (fromEnv) return resolve(fromEnv);
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
    return join(base, 'antasphere', 'slideless', 'local');
  }
  const base = env.XDG_DATA_HOME?.trim() || join(homedir(), '.local', 'share');
  return join(base, 'antasphere', 'slideless', 'local');
}

/**
 * Open (create) the store and check it against the folder it will hold
 * versions of. A store INSIDE the folder would be scanned into its own
 * versions and grow with every snapshot, so it is refused, unless it sits
 * under a dot-prefixed directory, which no scan reads and no reload follows.
 */
export async function openLocalStore(root: string, store?: string): Promise<{ root: string; store: string }> {
  const realRoot = await realpath(resolve(root));
  const wanted = resolve(store ?? defaultLocalStore());
  await mkdir(wanted, { recursive: true });
  const realStore = await realpath(wanted);
  const rel = relative(realRoot, realStore);
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  if (inside && (rel === '' || !rel.split(/[\\/]/).some((segment) => segment.startsWith('.')))) {
    throw new Error(
      `The version store ${realStore} is inside the folder it would keep versions of; ` +
        'pass a --store outside it (or under a dot-prefixed directory, which is never scanned)'
    );
  }
  return { root: realRoot, store: realStore };
}

function folderKey(realRoot: string): string {
  return createHash('sha256').update(realRoot).digest('hex').slice(0, 24);
}

function folderDir(store: string, realRoot: string): string {
  return join(store, 'folders', folderKey(realRoot));
}

function versionsDir(store: string, realRoot: string): string {
  return join(folderDir(store, realRoot), 'versions');
}

export function blobPath(store: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error(`Not a sha256: ${sha256}`);
  return join(store, 'blobs', sha256.slice(0, 2), sha256);
}

async function versionNumbers(store: string, realRoot: string): Promise<number[]> {
  const names = await readdir(versionsDir(store, realRoot)).catch(() => [] as string[]);
  const out: number[] = [];
  for (const name of names) {
    const m = RECORD_RE.exec(name);
    if (m) out.push(Number(m[1]));
  }
  return out.sort((a, b) => a - b);
}

function parseRecord(raw: string, expected: number): LocalVersionRecord | null {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof data !== 'object' || data === null) return null;
  const r = data as Partial<LocalVersionRecord>;
  if (r.v !== 1 || r.version !== expected || typeof r.entryPath !== 'string' || !Array.isArray(r.manifest)) {
    return null;
  }
  for (const f of r.manifest) {
    if (
      typeof f !== 'object' ||
      f === null ||
      typeof f.path !== 'string' ||
      typeof f.sha256 !== 'string' ||
      !SHA256_RE.test(f.sha256) ||
      typeof f.sizeBytes !== 'number' ||
      typeof f.contentType !== 'string'
    ) {
      return null;
    }
  }
  return r as LocalVersionRecord;
}

/** One version's record, or null when it does not exist or cannot be read. */
export async function readLocalVersion(
  store: string,
  realRoot: string,
  version: number
): Promise<LocalVersionRecord | null> {
  if (!Number.isSafeInteger(version) || version < 1) return null;
  const raw = await readFile(join(versionsDir(store, realRoot), `${version}.json`), 'utf8').catch(() => null);
  return raw === null ? null : parseRecord(raw, version);
}

/** Every readable version of a folder, oldest first, without manifests. */
export async function listLocalVersions(store: string, realRoot: string): Promise<LocalVersionSummary[]> {
  const out: LocalVersionSummary[] = [];
  for (const n of await versionNumbers(store, realRoot)) {
    const record = await readLocalVersion(store, realRoot, n);
    if (!record) continue;
    const { manifest: _manifest, v: _v, ...summary } = record;
    out.push(summary);
  }
  return out;
}

async function latestRecord(store: string, realRoot: string): Promise<LocalVersionRecord | null> {
  const numbers = await versionNumbers(store, realRoot);
  for (let i = numbers.length - 1; i >= 0; i--) {
    const record = await readLocalVersion(store, realRoot, numbers[i]!);
    if (record) return record;
  }
  return null;
}

function sameState(
  a: { entryPath: string; manifest: Array<{ path: string; sha256: string }> },
  b: { entryPath: string; manifest: Array<{ path: string; sha256: string }> }
): boolean {
  if (a.entryPath !== b.entryPath || a.manifest.length !== b.manifest.length) return false;
  return a.manifest.every((f, i) => f.path === b.manifest[i]!.path && f.sha256 === b.manifest[i]!.sha256);
}

/**
 * Copy one file into the blob store, hashing the bytes AS COPIED: a file an
 * agent rewrites between the scan and the copy is recorded with the hash of
 * what was really kept, never with a hash its blob does not have.
 */
async function storeBlob(store: string, absPath: string): Promise<{ sha256: string; sizeBytes: number }> {
  const tmpDir = join(store, 'blobs', 'tmp');
  await mkdir(tmpDir, { recursive: true });
  const tmp = join(tmpDir, `${randomBytes(8).toString('hex')}.part`);
  const hash = createHash('sha256');
  let sizeBytes = 0;
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      hash.update(chunk);
      sizeBytes += chunk.length;
      cb(null, chunk);
    }
  });
  try {
    await pipeline(createReadStream(absPath), tap, createWriteStream(tmp, { flags: 'wx' }));
    const sha256 = hash.digest('hex');
    const target = blobPath(store, sha256);
    const existing = await stat(target).catch(() => null);
    if (existing?.isFile() && existing.size === sizeBytes) {
      await rm(tmp, { force: true });
    } else {
      await mkdir(join(store, 'blobs', sha256.slice(0, 2)), { recursive: true });
      await rename(tmp, target);
    }
    return { sha256, sizeBytes };
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

export interface SnapshotOptions {
  /** The store root (default: `defaultLocalStore()`). */
  store?: string;
  /** The entry document, as `slideless dev --entry` takes it. */
  entry?: string;
  /** The clock, for tests. */
  now?: () => Date;
}

/**
 * Record the folder's current state as a new local version, unless it matches
 * the latest one exactly (same entry, same paths, same contents), in which
 * case nothing is written and the latest version is answered.
 */
export async function snapshot(target: string, options: SnapshotOptions = {}): Promise<SnapshotResult> {
  const { root, store } = await openLocalStore(target, options.store);
  let scan;
  try {
    scan = await scanDeck(root);
  } catch (err) {
    const message = (err as Error).message;
    throw new Error(
      message.startsWith('Nothing to push')
        ? message.replace('Nothing to push', 'Nothing to snapshot')
        : message
    );
  }
  const entryPath = detectEntry(scan, options.entry);
  const scanned = { entryPath, manifest: scan.files };

  const latest = await latestRecord(store, root);
  if (latest && sameState(latest, scanned)) return unchanged(latest, root, store);

  const manifest: LocalVersionFile[] = [];
  for (const file of scan.files) {
    const kept = await storeBlob(store, file.absPath);
    manifest.push({
      path: file.path,
      sha256: kept.sha256,
      sizeBytes: kept.sizeBytes,
      contentType: file.contentType
    });
  }
  const sizeBytes = manifest.reduce((sum, f) => sum + f.sizeBytes, 0);

  const dir = versionsDir(store, root);
  await mkdir(dir, { recursive: true });
  await writeFile(join(folderDir(store, root), 'folder.json'), `${JSON.stringify({ v: 1, root })}\n`).catch(
    () => {}
  );

  for (let attempt = 0; attempt < MAX_CLAIM_ATTEMPTS; attempt++) {
    const current = await latestRecord(store, root);
    // A concurrent snapshot may have just recorded this very state.
    if (current && sameState(current, { entryPath, manifest })) return unchanged(current, root, store);
    const numbers = await versionNumbers(store, root);
    const next = (numbers.at(-1) ?? 0) + 1;
    const record: LocalVersionRecord = {
      v: 1,
      version: next,
      root,
      entryPath,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      fileCount: manifest.length,
      sizeBytes,
      manifest
    };
    // The record is written whole under a temporary name, then claimed by a
    // hard link: the link either takes the number atomically or fails with
    // EEXIST, and a reader never sees a record half-written (a `wx` write
    // creates the file empty first, and a racing snapshot read that as no
    // version and recorded the same state a second time).
    const tmp = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { flag: 'wx' });
    try {
      await link(tmp, join(dir, `${next}.json`));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    } finally {
      await rm(tmp, { force: true });
    }
    return { version: next, created: true, entryPath, fileCount: manifest.length, sizeBytes, root, store };
  }
  throw new Error('Could not claim a version number: too many snapshots at once');
}

function unchanged(record: LocalVersionRecord, root: string, store: string): SnapshotResult {
  return {
    version: record.version,
    created: false,
    entryPath: record.entryPath,
    fileCount: record.fileCount,
    sizeBytes: record.sizeBytes,
    root,
    store
  };
}

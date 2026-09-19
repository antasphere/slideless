import { MAX_OPAQUE_JSON_DEPTH, hasNulDeep, jsonDepthOf } from '@antasphere/chassis-contract';
import {
  AGENT_DOC_PATH,
  REFERENCE_MAX_LENGTH,
  REFERENCE_TYPES,
  type ManifestEntry,
  type Reference,
  type ReferenceType
} from '@slideless/contract';
import { parse as parseYaml } from 'yaml';
import { blobKey, type StorageDriver } from '@antasphere/chassis-server/storage';

/**
 * PUSH-TIME REFERENCE DETECTION (ADR 025).
 *
 * A deck is a REFERENCE when its root `AGENT.md` opens with a YAML
 * frontmatter whose `type` is one of `REFERENCE_TYPES` (matched
 * case-insensitively). The frontmatter is read ONCE, at push, before the
 * commit transaction — the same place and the same blob-read style as forms
 * detection (`forms/detect.ts`) — and mirrored onto the record so nothing
 * downstream ever opens the blob again.
 *
 * THE POSTURE: this reader classifies, it never refuses. An AGENT.md is
 * untrusted author input and most decks carry no frontmatter at all, so every
 * failure resolves to "an ordinary deck" (`reference: null`). A warning is
 * added only where the author visibly TRIED to declare something and it could
 * not be used; a briefing with no frontmatter, or a frontmatter with no
 * `type`, is silent — a warning there would be noise on almost every push.
 *
 * Cost shape: authenticated, once per commit, at most `FRONTMATTER_READ_CAP`
 * bytes off the stream (and fewer when the closing fence arrives early), the
 * YAML parser bounded by that cap plus an alias budget.
 */

export interface ReferenceRead {
  /** The mirrored frontmatter: `type` lowercased to the known type, every other key verbatim. Null = ordinary deck. */
  reference: Reference | null;
  /** One sentence naming what was unusable, or null. Never set when there is simply no frontmatter. */
  warning: string | null;
}

/** Bytes read from the blob, at most. A frontmatter that has not closed by then is not one we mirror. */
export const FRONTMATTER_READ_CAP = 16 * 1024;

/** A fresh object each time: a caller mutating its result must not change the next one. */
const ordinary = (): ReferenceRead => ({ reference: null, warning: null });

/** Every warning ends the same way, so the author always learns what happened to the push. */
const OUTCOME = 'the deck was saved as an ordinary deck.';
const warn = (what: string): ReferenceRead => ({
  reference: null,
  warning: `AGENT.md frontmatter ${what}; ${OUTCOME}`
});

/** Author text echoed into a warning: control and format characters out, 60 characters at most. */
const ECHO_MAX = 60;
function echo(text: string): string {
  const clean = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '');
  const chars = Array.from(clean);
  return chars.length > ECHO_MAX ? `${chars.slice(0, ECHO_MAX).join('')}…` : clean;
}

const LF = 0x0a;
const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
/** An unterminated first line that may still grow into `---`. */
const OPEN_FENCE_PREFIX = /^(?:-{0,2}|---[ \t]*\r?)$/;

type Located =
  /** The first line is not complete yet: cannot tell. */
  | { state: 'pending' }
  /** The first line is not a fence: an ordinary briefing. */
  | { state: 'none' }
  /** Opened, not closed within these bytes. */
  | { state: 'open' }
  /** Opened and closed: the YAML sits in `[start, end)`. */
  | { state: 'closed'; start: number; end: number };

/** A line's text without its CR. Fences are ASCII, so latin1 is a lossless, cheap view for the test. */
function lineText(buf: Buffer, from: number, to: number): string {
  const text = buf.toString('latin1', from, to);
  return text.endsWith('\r') ? text.slice(0, -1) : text;
}

/**
 * Finds the fences in the first bytes of an AGENT.md. `complete` = these
 * bytes are the WHOLE file, so a last line without a newline is a real line;
 * otherwise it may be the first half of a longer one and proves nothing.
 * Only the FIRST closing fence counts: a `---` further down is the body's.
 */
function locate(buf: Buffer, complete: boolean): Located {
  let pos = 0;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) pos = 3;
  else if (buf.length < 3 && !complete) return { state: 'pending' };

  let nl = buf.indexOf(LF, pos);
  if (nl === -1) {
    if (complete)
      return OPEN_FENCE.test(lineText(buf, pos, buf.length)) ? { state: 'open' } : { state: 'none' };
    return OPEN_FENCE_PREFIX.test(buf.toString('latin1', pos)) ? { state: 'pending' } : { state: 'none' };
  }
  if (!OPEN_FENCE.test(lineText(buf, pos, nl))) return { state: 'none' };

  const start = nl + 1;
  pos = start;
  while (pos <= buf.length) {
    nl = buf.indexOf(LF, pos);
    const lineEnd = nl === -1 ? buf.length : nl;
    if (nl === -1 && !complete) break;
    if (CLOSE_FENCE.test(lineText(buf, pos, lineEnd))) return { state: 'closed', start, end: pos };
    if (nl === -1) break;
    pos = nl + 1;
  }
  return { state: 'open' };
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * Walks the parsed value once, iteratively (a hostile shape must not blow the
 * stack in the guard): a reserved key at any depth, or a value that is not
 * plain JSON material (the parser can hand back a Buffer for `!!binary`, and a
 * non-plain object would change meaning through the JSON round-trip).
 */
function findUnusable(value: unknown): { kind: 'key'; key: string } | { kind: 'value' } | null {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (typeof current === 'bigint' || typeof current === 'function' || typeof current === 'symbol') {
      return { kind: 'value' };
    }
    if (current === null || typeof current !== 'object') continue;
    if (seen.has(current)) continue;
    seen.add(current);
    if (Array.isArray(current)) {
      for (const item of current) stack.push(item);
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(current);
    if (proto !== Object.prototype && proto !== null) return { kind: 'value' };
    for (const key of Object.getOwnPropertyNames(current)) {
      if (FORBIDDEN_KEYS.has(key)) return { kind: 'key', key };
      stack.push((current as Record<string, unknown>)[key]);
    }
  }
  return null;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a mapping';
  if (typeof value === 'boolean') return 'a true/false value';
  return `a ${typeof value}`;
}

/** The parser's own closed error vocabulary (`DUPLICATE_KEY` → "duplicate key"); never author text. */
function yamlErrorHint(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code)
    ? ` (${code.toLowerCase().replaceAll('_', ' ')})`
    : '';
}

/** Pure: classify the first bytes of an AGENT.md. `truncated` = the blob was longer than the cap. */
export function parseReferenceFrontmatter(head: Buffer, truncated: boolean): ReferenceRead {
  try {
    return classify(head, truncated);
  } catch {
    // Belt and braces: the contract of this reader is that it never throws.
    return warn('could not be read');
  }
}

function classify(head: Buffer, truncated: boolean): ReferenceRead {
  const located = locate(head, !truncated);
  if (located.state === 'none' || located.state === 'pending') return ordinary();
  if (located.state === 'open') {
    return warn(truncated ? 'has no closing "---" line within the first 16 KB' : 'has no closing "---" line');
  }

  const text = head.toString('utf8', located.start, located.end);
  let parsed: unknown;
  try {
    parsed = parseYaml(text, {
      schema: 'core', // timestamps stay strings
      version: '1.2',
      merge: false,
      maxAliasCount: 50,
      prettyErrors: false, // no source excerpt in an error we might surface
      strict: true,
      uniqueKeys: true,
      logLevel: 'error' // parser warnings stay off the process's stderr
    });
  } catch (err) {
    return warn(`could not be parsed as YAML${yamlErrorHint(err)}`);
  }

  // An empty (or comment-only) frontmatter declares nothing: ordinary, silent.
  if (parsed === null || parsed === undefined) return ordinary();
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return warn(`must be a YAML mapping of keys to values, but it is ${describe(parsed)}`);
  }
  // No `type`: metadata of another kind on an ordinary deck. Silent, whatever else it holds.
  if (!Object.hasOwn(parsed, 'type')) return ordinary();

  const unusable = findUnusable(parsed);
  if (unusable?.kind === 'key') return warn(`uses the reserved key "${unusable.key}"`);
  if (unusable?.kind === 'value') return warn('holds a value that cannot be kept as JSON');
  // Depth BEFORE any stringify (SL-B5: stringify recurses).
  if (jsonDepthOf(parsed) > MAX_OPAQUE_JSON_DEPTH)
    return warn(`nests deeper than ${MAX_OPAQUE_JSON_DEPTH} levels`);

  // The JSON round-trip is the normal form: what a jsonb column will hold.
  // It unshares aliased nodes, so depth and NUL are measured again on the tree.
  let plain: Record<string, unknown>;
  try {
    plain = JSON.parse(JSON.stringify(parsed)) as Record<string, unknown>;
  } catch {
    return warn('could not be converted to JSON (an alias may point back at itself)');
  }
  if (jsonDepthOf(plain) > MAX_OPAQUE_JSON_DEPTH)
    return warn(`nests deeper than ${MAX_OPAQUE_JSON_DEPTH} levels`);
  if (hasNulDeep(plain)) return warn('contains a NUL character in a key or a value');

  const rawType = plain.type;
  if (typeof rawType !== 'string') return warn(`has a "type" that is not text (it is ${describe(rawType)})`);
  const wanted = rawType.trim().toLowerCase();
  const type: ReferenceType | undefined = REFERENCE_TYPES.find((known) => known === wanted);
  if (type === undefined) {
    return warn(
      `names the type "${echo(rawType.trim())}", which is not a known reference type (${REFERENCE_TYPES.join(', ')})`
    );
  }

  const reference: Reference = { ...plain, type };
  const length = JSON.stringify(reference).length;
  if (length > REFERENCE_MAX_LENGTH) {
    return warn(`is too large to keep (${length} characters as JSON, the limit is ${REFERENCE_MAX_LENGTH})`);
  }
  return { reference, warning: null };
}

/**
 * Reads the blob until the frontmatter is decided: no fence on the first
 * line, the closing fence seen, or the cap passed. One byte past the cap is
 * enough to know the blob was longer. The stream is destroyed in `finally`,
 * so an early stop never leaves a file handle or an S3 body open.
 */
async function readHead(storage: StorageDriver, key: string): Promise<{ head: Buffer; truncated: boolean }> {
  const stream = await storage.getStream(key);
  let acc: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      acc = Buffer.concat([acc, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)]);
      if (acc.length > FRONTMATTER_READ_CAP) break;
      const { state } = locate(acc, false);
      if (state === 'none' || state === 'closed') break;
    }
  } finally {
    stream.destroy();
  }
  const truncated = acc.length > FRONTMATTER_READ_CAP;
  return { head: truncated ? acc.subarray(0, FRONTMATTER_READ_CAP) : acc, truncated };
}

/**
 * Reads AGENT.md's blob (capped) and classifies it. No AGENT.md entry, or an
 * unreadable blob → `{ reference: null, warning: null }`. Never throws: a blob
 * that cannot be read here is about to fail the commit's own missing-blob
 * check anyway. The path match is exact and case-sensitive, root only —
 * manifest paths never normalize.
 */
export async function readReference(
  storage: StorageDriver,
  workspaceId: string,
  manifest: ManifestEntry[]
): Promise<ReferenceRead> {
  const entry = manifest.find((candidate) => candidate.path === AGENT_DOC_PATH);
  if (!entry) return ordinary();
  try {
    const { head, truncated } = await readHead(storage, blobKey(workspaceId, entry.sha256));
    return parseReferenceFrontmatter(head, truncated);
  } catch {
    return ordinary();
  }
}

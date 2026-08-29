import type { ManifestEntry } from '@slideless/contract';
import { blobKey, type StorageDriver } from '../storage/driver.js';

/**
 * COMMIT-TIME FORM DETECTION (ADR 022 + PRDCT-1333, audit §3).
 *
 * ADR 022 decision 1 said the server never parses deck HTML and the runtime
 * is injected "whenever the token allows submitting". Since `canSubmitForms`
 * defaults ON, that made every share link of every deck take the injecting
 * serve path — measured at ~10x the document in peak RSS on an anonymous,
 * unrate-limited GET, for decks containing no form at all.
 *
 * So the version now records whether it holds a form, stamped once at commit
 * exactly like `has_agent_doc` (`stampManifest`, PRDCT-1311). This is NOT
 * parsing: it is a byte scan for the marker attribute, the same substring
 * question the CLI's push-time hint already asks. A false negative costs the
 * author their form (visible immediately) and a false positive costs one
 * inert script tag; neither is an authorization decision — the API still
 * enforces the capability on every submit.
 *
 * Cost shape: authenticated, once per commit, streaming with a fixed-size
 * carry so memory never scales with the document. HTML entries AND script
 * entries are read: a deck whose page carries no marker and whose bundled
 * `app.js` injects the form on load is a form deck too, and reading only
 * HTML stamped it form-less — the runtime never arrived and every submit
 * native-navigated the sandbox, storing nothing (PRDCT-1331/1334 residual;
 * the shape worked before detection existed). Fonts, images and styles are
 * never read: a marker cannot be born from them.
 */

/** The authoring marker. Matching is case-insensitive: HTML attributes are. */
export const FORM_MARKER_ATTRIBUTE = 'data-slideless-form';

/** Bytes carried between chunks so a marker split across chunks still matches. */
const CARRY = FORM_MARKER_ATTRIBUTE.length - 1;

const SCRIPT_TYPES = [
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript'
];
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];

/**
 * Entries that can carry the marker: HTML, and scripts by declared type OR
 * by extension (the manifest's `contentType` is client-supplied; a bundler
 * or a hand-written manifest may label `app.js` as octet-stream).
 */
export function isScannable(entry: ManifestEntry): boolean {
  const type = entry.contentType.toLowerCase().split(';')[0]!.trim();
  if (type.startsWith('text/html')) return true;
  if (SCRIPT_TYPES.includes(type)) return true;
  const path = entry.path.toLowerCase();
  return SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/** ASCII-only lowercase — leaves multi-byte UTF-8 sequences untouched. */
function asciiLower(buf: Buffer): Buffer {
  const out: Buffer = Buffer.allocUnsafe(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i]!;
    out[i] = b >= 0x41 && b <= 0x5a ? b + 0x20 : b;
  }
  return out;
}

async function blobHasMarker(storage: StorageDriver, key: string): Promise<boolean> {
  const stream = await storage.getStream(key);
  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const window = asciiLower(Buffer.concat([carry, chunk as Buffer]));
      if (window.includes(FORM_MARKER_ATTRIBUTE)) return true;
      carry = window.subarray(Math.max(0, window.length - CARRY));
    }
  } finally {
    stream.destroy();
  }
  return false;
}

/**
 * True when ANY HTML or script entry of the manifest carries the marker.
 * Storage failures resolve to `false` rather than failing the commit: the
 * flag is a serving optimization, and a blob that cannot be read here is
 * about to fail the commit's own missing-blob check anyway.
 */
export async function manifestHasForms(
  storage: StorageDriver,
  workspaceId: string,
  manifest: ManifestEntry[]
): Promise<boolean> {
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (!isScannable(entry) || seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    try {
      if (await blobHasMarker(storage, blobKey(workspaceId, entry.sha256))) return true;
    } catch {
      // Unreadable / not yet uploaded — the commit rejects it downstream.
    }
  }
  return false;
}

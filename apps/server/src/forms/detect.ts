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
 * carry so memory never scales with the document.
 *
 * THE RULE (PRDCT-1810, closing the PRDCT-1331/1334 residual for good):
 *
 *   1. A SCRIPT entry (by declared type or by extension) arms the runtime by
 *      its mere presence. A byte scan can never see a marker that is born
 *      at runtime — `f.dataset.slidelessForm = …`, an attribute map read
 *      from a JSON data file, a minifier splitting `'data-slideless-' +
 *      'form'` — and every one of those shapes was stamped form-less, so
 *      the runtime never arrived and each submit native-navigated the
 *      sandbox, storing nothing: the silent death PRDCT-1334 meant to
 *      close. Runnable code is INCONCLUSIVE, and inconclusive arms.
 *   2. An HTML entry arms it when it carries the marker OR an inline
 *      `<script` (runnable code again).
 *   3. A JSON entry arms it when it carries the marker (a schema-driven
 *      deck keeps its attributes in data).
 *   4. Fonts, images and styles never arm it: a marker cannot be born from
 *      them (the stylesheet-decoy pin in forms.test.ts).
 *
 * A false positive costs one inert script tag on the streaming injector
 * (the injection streams since PRDCT-1334; the buffered path this flag was
 * born to avoid is gone); a false negative costs the author every response.
 * A form-less, script-less deck keeps the byte-exact ETag serve.
 */

/** The authoring marker. Matching is case-insensitive: HTML attributes are. */
export const FORM_MARKER_ATTRIBUTE = 'data-slideless-form';

/** Inline runnable code in an HTML page: inconclusive, so it arms (rule 2). */
const INLINE_SCRIPT_MARKER = '<script';

/** Bytes carried between chunks so a needle split across chunks still matches. */
const CARRY = Math.max(FORM_MARKER_ATTRIBUTE.length, INLINE_SCRIPT_MARKER.length) - 1;

const SCRIPT_TYPES = [
  'text/javascript',
  'application/javascript',
  'application/x-javascript',
  'text/ecmascript',
  'application/ecmascript'
];
const SCRIPT_EXTENSIONS = ['.js', '.mjs', '.cjs'];
const JSON_TYPES = ['application/json', 'text/json'];
const JSON_EXTENSIONS = ['.json'];

/** How an entry takes part in detection (see THE RULE above). */
export type EntryKind = 'script' | 'html' | 'json' | 'inert';

/**
 * Scripts by declared type OR by extension (the manifest's `contentType` is
 * client-supplied; a bundler or a hand-written manifest may label `app.js`
 * as octet-stream); JSON by type or extension the same way. HTML by declared
 * TYPE only, deliberately: the viewer injects the runtime only into documents
 * it serves as `text/html` (viewer/routes.ts `isHtmlDoc`), so an `.html`
 * entry mislabelled as octet-stream is never injected and must not be armed.
 */
export function entryKind(entry: ManifestEntry): EntryKind {
  const type = entry.contentType.toLowerCase().split(';')[0]!.trim();
  const path = entry.path.toLowerCase();
  if (SCRIPT_TYPES.includes(type) || SCRIPT_EXTENSIONS.some((ext) => path.endsWith(ext))) return 'script';
  if (type.startsWith('text/html')) return 'html';
  if (JSON_TYPES.includes(type) || JSON_EXTENSIONS.some((ext) => path.endsWith(ext))) return 'json';
  return 'inert';
}

/** Entries that take part in detection at all (kept for the CLI-side mirror). */
export function isScannable(entry: ManifestEntry): boolean {
  return entryKind(entry) !== 'inert';
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

/** True when the blob's ASCII-lowercased bytes contain ANY of the needles (all needles are lowercase). */
async function blobHasAny(storage: StorageDriver, key: string, needles: readonly string[]): Promise<boolean> {
  const stream = await storage.getStream(key);
  let carry: Buffer = Buffer.alloc(0);
  try {
    for await (const chunk of stream) {
      const window = asciiLower(Buffer.concat([carry, chunk as Buffer]));
      for (const needle of needles) if (window.includes(needle)) return true;
      carry = window.subarray(Math.max(0, window.length - CARRY));
    }
  } finally {
    stream.destroy();
  }
  return false;
}

const HTML_NEEDLES = [FORM_MARKER_ATTRIBUTE, INLINE_SCRIPT_MARKER] as const;
const JSON_NEEDLES = [FORM_MARKER_ATTRIBUTE] as const;

/**
 * THE RULE, applied to a manifest: any script entry → true without a read;
 * otherwise true when an HTML entry carries the marker or an inline script
 * tag, or a JSON entry carries the marker. Storage failures resolve to
 * `false` rather than failing the commit: the flag is a serving
 * optimization, and a blob that cannot be read here is about to fail the
 * commit's own missing-blob check anyway.
 */
export async function manifestHasForms(
  storage: StorageDriver,
  workspaceId: string,
  manifest: ManifestEntry[]
): Promise<boolean> {
  if (manifest.some((entry) => entryKind(entry) === 'script')) return true;
  const seen = new Set<string>();
  for (const entry of manifest) {
    const kind = entryKind(entry);
    if (kind === 'inert' || seen.has(entry.sha256)) continue;
    seen.add(entry.sha256);
    const needles = kind === 'json' ? JSON_NEEDLES : HTML_NEEDLES;
    try {
      if (await blobHasAny(storage, blobKey(workspaceId, entry.sha256), needles)) return true;
    } catch {
      // Unreadable / not yet uploaded — the commit rejects it downstream.
    }
  }
  return false;
}

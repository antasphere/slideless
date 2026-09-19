import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { CliUsageError } from '@antasphere/cli-core';
import {
  REFERENCE_TYPES,
  type Presentation,
  type ReferenceProvenance,
  type ReferenceType
} from '@slideless/contract';
import { LINK_FILENAME, type DeckLink } from './manifest.js';

/**
 * References from the command line (PRDCT-2420): the pure half. A REFERENCE
 * is a deck the workspace keeps to make other decks from; `brand` and
 * `template` are its two types, read by the server from the `type:` line of
 * the AGENT.md frontmatter at push (ADR 025). Everything here is a function
 * of its arguments — no network, no clock — so the tests pin it directly;
 * the wiring lives in commands/references.ts and the push in
 * commands/content.ts.
 *
 * Four things live here:
 *
 *  1. the local read of an AGENT.md frontmatter (which type it declares,
 *     and the same text with that line removed for `start`);
 *  2. the resolution of a `<ref>` argument (an id, else an exact title, else
 *     a unique case-insensitive title prefix) against a list of references;
 *  3. the scaffold `reference new` writes: a neutral brand or template with
 *     the frontmatter of its type and the sections an agent reads;
 *  4. the provenance merge: `metadata.references` written into the owner's
 *     other keys, never over them.
 */

// ── The pulled reference's place inside a deck folder ────────────────────────

/**
 * Where `reference pull` lands inside the current deck folder:
 * `.slideless/<type>/`. The leading dot is the whole point: the push scan
 * skips every dot-prefixed segment (manifest.ts `isIgnored`, from the wire
 * contract's `isSafeAssetPath`), so a pulled brand can never leak into the
 * deck it sits beside. One folder per type: a second pull of the same type
 * replaces the folder.
 */
export const REFERENCE_DIR = '.slideless';

export function referenceDirFor(deckRoot: string, type: ReferenceType): string {
  return join(deckRoot, REFERENCE_DIR, type);
}

/**
 * The link file a pulled reference folder carries (`.slideless.json`, the
 * same file `pull` writes): the deck link plus the reference's type and the
 * version that was pulled. `readLink` (manifest.ts) reads the two deck
 * fields off it unchanged, so `reference push` from the folder targets the
 * reference; the `reference` block is what `push` reads to record the
 * provenance of a deck made beside it.
 */
export interface ReferenceLink extends DeckLink {
  reference: { type: ReferenceType; version: number };
}

export async function readReferenceLink(dir: string): Promise<ReferenceLink | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, LINK_FILENAME), 'utf8')) as Partial<ReferenceLink>;
    const ref = parsed.reference;
    if (
      typeof parsed.presentationId === 'string' &&
      typeof parsed.baseUrl === 'string' &&
      ref &&
      typeof ref === 'object' &&
      isReferenceType(ref.type) &&
      Number.isInteger(ref.version) &&
      (ref.version as number) >= 1
    ) {
      return {
        presentationId: parsed.presentationId,
        baseUrl: parsed.baseUrl,
        reference: { type: ref.type, version: ref.version as number }
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function isReferenceType(value: unknown): value is ReferenceType {
  return typeof value === 'string' && (REFERENCE_TYPES as readonly string[]).includes(value);
}

/** `--type` parsing: the known types, in lowercase; anything else is a usage error naming them. */
export function parseReferenceType(value: string): ReferenceType {
  const wanted = value.trim().toLowerCase();
  if (isReferenceType(wanted)) return wanted;
  throw new CliUsageError(`--type must be one of ${REFERENCE_TYPES.join(', ')} (got "${value}")`);
}

// ── The AGENT.md frontmatter, read locally ───────────────────────────────────

/**
 * The frontmatter block of an AGENT.md, by line: the first line is `---`
 * and the block ends at the first `---` (or `...`) line after it; the YAML
 * sits in between. Line-based on purpose: the CLI reads ONE key of it (the
 * type) and never parses YAML — the server is the classifier (ADR 025), and
 * this read only stops the obvious miss (no frontmatter, no type) before a
 * single byte is uploaded.
 */
interface FrontmatterSpan {
  /** Index of the opening fence line. */
  open: number;
  /** Index of the closing fence line. */
  close: number;
}

const OPEN_FENCE = /^---[ \t]*$/;
const CLOSE_FENCE = /^(?:---|\.\.\.)[ \t]*$/;
/** A top-level `type:` line: no indent, the key, a colon, the value. */
const TYPE_LINE = /^type[ \t]*:[ \t]*(.*?)[ \t]*$/;
/** A top-level `title:` line, the reference's name (`reference push` names a new deck after it). */
const TITLE_LINE = /^title[ \t]*:[ \t]*(.*?)[ \t]*$/;

function splitLines(text: string): string[] {
  return text.split('\n');
}

/** A line's text without its CR (a CRLF file keeps its endings on rewrite). */
function bare(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

function frontmatterSpan(lines: string[]): FrontmatterSpan | null {
  if (lines.length === 0) return null;
  const line0 = bare(lines[0]!);
  const first = line0.charCodeAt(0) === 0xfeff ? line0.slice(1) : line0;
  if (!OPEN_FENCE.test(first)) return null;
  for (let i = 1; i < lines.length; i++) {
    if (CLOSE_FENCE.test(bare(lines[i]!))) return { open: 0, close: i };
  }
  return null;
}

/** The `type:` line inside the block, or -1. Quotes around the value are tolerated. */
function typeLineIndex(lines: string[], span: FrontmatterSpan): number {
  for (let i = span.open + 1; i < span.close; i++) {
    if (TYPE_LINE.test(bare(lines[i]!))) return i;
  }
  return -1;
}

export interface FrontmatterRead {
  /** Whether the file opens with a closed `---` block. */
  frontmatter: boolean;
  /** The declared type as written (quotes stripped), or null when the block has no `type:` line. */
  declared: string | null;
  /** The known type the declaration names, in lowercase, or null when it is unknown or absent. */
  type: ReferenceType | null;
  /** The top-level `title:` of the block, quotes stripped, or null when it has none (or an empty one). */
  title: string | null;
}

/**
 * A scalar as the frontmatter writes it: a double-quoted one is JSON, a
 * single-quoted one is plain, else as is. Control characters are dropped
 * whatever the form: a JSON escape can spell one (`\u001b`), and a title
 * is text for a screen, never a terminal sequence.
 */
function unquote(value: string): string {
  const trimmed = value.trim();
  let out = trimmed;
  if (/^".*"$/.test(trimmed)) {
    try {
      out = String(JSON.parse(trimmed));
    } catch {
      out = trimmed.slice(1, -1);
    }
  } else if (/^'.*'$/.test(trimmed)) {
    out = trimmed.slice(1, -1).replace(/''/g, "'");
  }
  // eslint-disable-next-line no-control-regex -- dropping control characters IS the job here.
  return out.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

/** What an AGENT.md declares, as the server will read it: the block, its `type:` line, the known type, its title. */
export function readFrontmatter(text: string): FrontmatterRead {
  const lines = splitLines(text);
  const span = frontmatterSpan(lines);
  if (!span) return { frontmatter: false, declared: null, type: null, title: null };
  let title: string | null = null;
  for (let i = span.open + 1; i < span.close; i++) {
    const m = bare(lines[i]!).match(TITLE_LINE);
    if (m) {
      const value = unquote(m[1]!);
      title = value === '' ? null : value;
      break;
    }
  }
  const at = typeLineIndex(lines, span);
  if (at === -1) return { frontmatter: true, declared: null, type: null, title };
  const declared = unquote(bare(lines[at]!).match(TYPE_LINE)![1]!);
  const wanted = declared.toLowerCase();
  return { frontmatter: true, declared, type: isReferenceType(wanted) ? wanted : null, title };
}

/**
 * The same text with the `type:` line removed from its frontmatter and
 * nothing else changed (`start`: a deck made from a reference is not a
 * reference, but its title, description and every other field stay so the
 * agent keeps the briefing). A text with no frontmatter or no type line
 * comes back as it is.
 */
export function stripTypeLine(text: string): string {
  const lines = splitLines(text);
  const span = frontmatterSpan(lines);
  if (!span) return text;
  const at = typeLineIndex(lines, span);
  if (at === -1) return text;
  lines.splice(at, 1);
  return lines.join('\n');
}

// ── Resolving a <ref> argument ───────────────────────────────────────────────

/** A deck id on the wire (the server's uuid); anything else is a title. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDeckId(value: string): boolean {
  return UUID_RE.test(value.trim());
}

/** One line per candidate, for the messages that list them. */
export function referenceLines(refs: readonly Presentation[]): string {
  if (refs.length === 0) return '  (none)';
  return refs
    .map(
      (r) =>
        `  ${r.id}  ${(r.reference?.type ?? '-').padEnd(8)}  ${r.title}${r.defaultReference ? '  (default)' : ''}`
    )
    .join('\n');
}

/**
 * The reference `value` names among `candidates` (the references of one
 * type, or of every type): the exact id first, else the exact title, else
 * the ONE reference whose title starts with the value without regard to
 * case. Several exact titles, or several prefix matches, are ambiguous; the
 * error lists them so the person can name one by id. `what` is the noun of
 * the message (`brand`, `template`, `reference`).
 */
export function resolveReference(
  candidates: readonly Presentation[],
  value: string,
  what: string
): Presentation {
  const wanted = value.trim();
  if (!wanted) throw new CliUsageError(`Name a ${what}: its id, its title, or the start of its title.`);
  if (isDeckId(wanted)) {
    const byId = candidates.find((r) => r.id.toLowerCase() === wanted.toLowerCase());
    if (byId) return byId;
  }
  const exact = candidates.filter((r) => r.title.trim() === wanted);
  if (exact.length === 1) return exact[0]!;
  if (exact.length > 1) throw ambiguous(exact, wanted, what);
  const lower = wanted.toLowerCase();
  const prefixed = candidates.filter((r) => r.title.trim().toLowerCase().startsWith(lower));
  if (prefixed.length === 1) return prefixed[0]!;
  if (prefixed.length > 1) throw ambiguous(prefixed, wanted, what);
  throw new CliUsageError(
    `No ${what} named "${wanted}" among the ones you can read` +
      (candidates.length > 0 ? `. Yours:\n${referenceLines(candidates)}` : ` (there are none).`)
  );
}

function ambiguous(matches: readonly Presentation[], wanted: string, what: string): CliUsageError {
  return new CliUsageError(
    `"${wanted}" names several ${what}s. Name one by its id:\n${referenceLines(matches)}`
  );
}

/**
 * `<ref>[@n]` as `push --brand` / `--template` take it: the reference and,
 * after a trailing `@`, the version to record. A title may carry an `@`
 * of its own, so only a trailing `@<digits>` counts.
 */
export function splitRefAtVersion(value: string): { ref: string; version: number | undefined } {
  const m = value.match(/^(.*)@(\d+)$/);
  if (!m) return { ref: value, version: undefined };
  const version = Number(m[2]);
  if (version < 1) throw new CliUsageError(`"${value}": a version is a whole number from 1.`);
  return { ref: m[1]!, version };
}

// ── Provenance: metadata.references ─────────────────────────────────────────

/** The key a deck records the references it was made from under. */
export const PROVENANCE_KEY = 'references';

function isProvenanceEntry(value: unknown): value is ReferenceProvenance {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    isReferenceType(v.type) &&
    typeof v.id === 'string' &&
    typeof v.version === 'number' &&
    Number.isInteger(v.version) &&
    v.version >= 1
  );
}

/**
 * `metadata` with `references` carrying `entries`: one entry per type (a
 * new brand replaces the recorded brand, a template the template), every
 * other entry of the existing list kept, every other KEY of the metadata
 * untouched. The server's PATCH replaces the object whole, so this merge
 * is what keeps the owner's keys. A `references` that is not a list of
 * entries is replaced, not merged: it was not ours.
 */
export function mergeProvenance(
  metadata: Record<string, unknown>,
  entries: readonly ReferenceProvenance[]
): Record<string, unknown> {
  const existing = Array.isArray(metadata[PROVENANCE_KEY])
    ? (metadata[PROVENANCE_KEY] as unknown[]).filter(isProvenanceEntry)
    : [];
  const replaced = new Set(entries.map((e) => e.type));
  const kept = existing.filter((e) => !replaced.has(e.type));
  const next = [...kept, ...entries.map((e) => ({ type: e.type, id: e.id, version: e.version }))];
  return { ...metadata, [PROVENANCE_KEY]: next };
}

/** The recorded provenance of a deck, as `get` shows it: the valid entries of `metadata.references`. */
export function provenanceOf(metadata: Record<string, unknown>): ReferenceProvenance[] {
  const raw = metadata[PROVENANCE_KEY];
  return Array.isArray(raw) ? raw.filter(isProvenanceEntry) : [];
}

// ── The scaffold ─────────────────────────────────────────────────────────────

/**
 * What `reference new` writes: neutral, invented names, no real brand and no
 * real client. The frontmatter carries every field the type has, filled with
 * values an agent can read as an example and replace; the body has the
 * sections an agent reads (purpose, typography, colour, layout rules, tone,
 * what to avoid, assets); the deck shows one page per layout for a brand and
 * the skeleton pages for a template.
 */
export interface Scaffold {
  files: Array<{ path: string; content: string }>;
  /** Folders created empty (the assets the author will add). */
  dirs: string[];
}

const stamp = (now: Date): string => now.toISOString().replace(/\.\d{3}Z$/, 'Z');

export function scaffoldReference(
  type: ReferenceType,
  title: string | undefined,
  now = new Date()
): Scaffold {
  return type === 'brand'
    ? brandScaffold(title ?? 'Meridian Cartography brand', now)
    : templateScaffold(title ?? 'Monthly project update', now);
}

function brandScaffold(title: string, now: Date): Scaffold {
  const agent = `---
type: Brand
title: ${yamlString(title)}
description: The look and the voice of every deck of this workspace.
tags: [brand]
timestamp: ${stamp(now)}
fonts:
  heading:
    family: Georgia
    weights: [700]
    source: assets/fonts/heading.woff2
  body:
    family: Helvetica Neue
    weights: [400, 500]
    source: assets/fonts/body.woff2
colors:
  - name: Deep
    hex: '#1F2A44'
    role: primary, headings and the cover background
  - name: Ember
    hex: '#D9541E'
    role: accent, one element per page at most
  - name: Paper
    hex: '#F6F3EC'
    role: page background
  - name: Ink
    hex: '#1C1C1C'
    role: body text
background:
  default: Paper, flat
  cover: Deep, flat, with the logo bottom left
  never: gradients, photographs behind text
shape:
  radius: 4px
  border: 1px solid Ink at 12% opacity
  logo: assets/logo.svg
  logoClearSpace: the height of the logo mark on every side
motion:
  transitions: fade, 200ms, ease-out
  never: slide-in text, bouncing, parallax
voice:
  tone: plain, direct, numbers before adjectives
  person: we
  avoid: [seamless, world-class, synergy]
  example: We mapped 1,200 km of coastline in March, 9% more than in February.
---

# ${title}

This deck is the brand. Read it before you build a deck for this workspace, and copy the values in
the frontmatter as they are. Replace every example in this file with the real brand before you
publish it.

## Purpose

What the brand is for, and which decks it applies to. Every deck the workspace shares outside
follows it; an internal working deck may not.

## Typography

The heading font and the body font, with their weights, are in the frontmatter. Headings are
short, one line where possible. Body text is never smaller than 18px on a page.

## Colour

Deep for headings and the cover, Paper for the page, Ink for text, Ember for one element per page
at most. A page with no Ember is fine. Charts use Deep for the series and Ember for the one figure
to read first.

## Layout rules

One idea per page. The title sits top left, the logo bottom left on the cover only. Keep the
clear space around the logo. Page 1 is the cover, page 2 the palette, page 3 the type scale,
page 4 a chart drawn the house way, page 5 the closing page.

## Tone

Write the way the example sentence in the frontmatter reads: the number first, then the
comparison. Say we, never the company's name in the third person.

## What to avoid

No gradients, no photographs behind text, no slide-in animations, no words from the avoid list.
Never redraw or recolour the logo.

## Assets

\`assets/logo.svg\` is the logo; \`assets/fonts/\` holds the font files named in the frontmatter.
Use them as they are.
`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font-family: "Helvetica Neue", Helvetica, Arial, sans-serif; background: #F6F3EC; color: #1C1C1C; }
  section { min-height: 100vh; padding: 8vh 10vw; box-sizing: border-box; }
  h1 { font-family: Georgia, serif; font-size: 3rem; margin: 0 0 1rem; }
  h2 { font-family: Georgia, serif; font-size: 2rem; margin: 0 0 1rem; }
  p { font-size: 1.25rem; max-width: 40em; }
  .cover { background: #1F2A44; color: #F6F3EC; }
  .swatch { display: inline-block; width: 6rem; height: 6rem; border-radius: 4px; margin: 0 1rem 1rem 0; }
  .ember { color: #D9541E; }
  .layout { font-size: 0.9rem; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.6; }
</style>
</head>
<body>
<section class="cover">
  <p class="layout">Layout: cover</p>
  <h1>${escapeHtml(title)}</h1>
  <p>The cover as we use it: Deep background, the title in the heading font, the logo bottom left.</p>
</section>
<section>
  <p class="layout">Layout: palette</p>
  <h2>The palette</h2>
  <span class="swatch" style="background:#1F2A44"></span><span class="swatch" style="background:#D9541E"></span><span class="swatch" style="background:#F6F3EC;border:1px solid rgba(28,28,28,.12)"></span><span class="swatch" style="background:#1C1C1C"></span>
  <p>Deep, <span class="ember">Ember</span>, Paper, Ink.</p>
</section>
<section>
  <p class="layout">Layout: type scale</p>
  <h2>The type scale</h2>
  <h1>A heading at 3rem</h1>
  <h2>A section title at 2rem</h2>
  <p>Body text at 1.25rem, never smaller than 18px on a page.</p>
</section>
<section>
  <p class="layout">Layout: chart</p>
  <h2>A chart, the house way</h2>
  <p>Deep for the series, <span class="ember">Ember</span> for the one figure to read first. We mapped 1,200 km of coastline in March, 9% more than in February.</p>
</section>
<section class="cover">
  <p class="layout">Layout: closing</p>
  <h2>Thank you</h2>
  <p>The closing page: the contact details of the team.</p>
</section>
</body>
</html>
`;
  return {
    files: [
      { path: 'AGENT.md', content: agent },
      { path: 'index.html', content: html }
    ],
    dirs: ['assets', 'assets/fonts']
  };
}

function templateScaffold(title: string, now: Date): Scaffold {
  const agent = `---
type: Template
title: ${yamlString(title)}
description: The deck a project lead sends the sponsor at the end of each month.
tags: [template]
timestamp: ${stamp(now)}
purpose: >
  Tell a sponsor what the project delivered this month, what slipped, and what the next month
  holds. Sent as a link, read in five minutes, never presented live.
pages:
  - Cover. The project name, the month, the project lead.
  - The month in three figures. Delivered, slipped, spent.
  - What was delivered. One line per item, with its date.
  - What slipped. One line per item, with the new date and the reason.
  - Next month. Up to three items, each with its expected date.
  - Questions. The contact details of the project lead.
fill:
  data: Put the figures in downloads/figures.csv and draw page 2 from that file.
  keep: The page order, the page titles, the footer.
  change: Every figure, every item, the project name, the month.
  length: Six pages. Remove the slipped page only when nothing slipped.
  language: The sponsor's language. Keep the page titles short enough for one line.
---

# ${title}

This deck is the model for a monthly project update. Copy its pages, keep their order, and
replace the content with the month's facts. Replace every example in this file with the real
template before you publish it.

## Purpose

What the deck is for and who reads it, as the frontmatter says. A sponsor reads it in five
minutes without the project lead in the room.

## Typography

The template carries structure, not look. Apply the workspace's brand on top of it.

## Colour

Same rule: the brand decides. The template names no colour.

## Layout rules

Keep the page order and the page titles. One line per item on the delivered and slipped pages,
never a paragraph. The three figures of page 2 are the ones the sponsor's contract names.

## Tone

Plain words, dates on every item. A slipped item says why in one sentence.

## What to avoid

Never leave a sample figure in a real deck: every number on every page is replaced, or its page
is removed. No page without a date on it.

## Assets

\`assets/\` holds whatever the template ships (an icon set, a sample figures file). The deck
made from it takes the brand's logo and fonts, not the template's.
`;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #fff; color: #222; }
  section { min-height: 100vh; padding: 8vh 10vw; box-sizing: border-box; border-bottom: 1px dashed #ccc; }
  h1 { font-size: 2.5rem; margin: 0 0 1rem; }
  h2 { font-size: 1.75rem; margin: 0 0 1rem; }
  .page { font-size: 0.9rem; letter-spacing: 0.1em; text-transform: uppercase; opacity: 0.6; }
  table { border-collapse: collapse; } td, th { padding: 0.4rem 1rem 0.4rem 0; text-align: left; }
</style>
</head>
<body>
<section>
  <p class="page">Page 1 of 6 · Cover</p>
  <h1>Project name</h1>
  <p>Month YYYY · Project lead</p>
</section>
<section>
  <p class="page">Page 2 of 6 · The month in three figures</p>
  <h2>The month in three figures</h2>
  <table><tr><th>Delivered</th><th>Slipped</th><th>Spent</th></tr><tr><td>0</td><td>0</td><td>0</td></tr></table>
</section>
<section>
  <p class="page">Page 3 of 6 · What was delivered</p>
  <h2>What was delivered</h2>
  <ul><li>Item, date</li></ul>
</section>
<section>
  <p class="page">Page 4 of 6 · What slipped</p>
  <h2>What slipped</h2>
  <ul><li>Item, new date, the reason in one sentence</li></ul>
</section>
<section>
  <p class="page">Page 5 of 6 · Next month</p>
  <h2>Next month</h2>
  <ul><li>Item, expected date</li></ul>
</section>
<section>
  <p class="page">Page 6 of 6 · Questions</p>
  <h2>Questions</h2>
  <p>The contact details of the project lead.</p>
</section>
</body>
</html>
`;
  return {
    files: [
      { path: 'AGENT.md', content: agent },
      { path: 'index.html', content: html }
    ],
    dirs: ['assets']
  };
}

/** A YAML double-quoted scalar for a title someone typed (a colon or a quote must not break the block). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── The ownership record of a cleanup ───────────────────────────────────────

/**
 * Whether a path exists, for the cleanup after a failed download (which
 * removes only what the command created). Only ENOENT (and ENOTDIR, a file
 * where a folder was expected on the way) means absent; any other failure
 * (a parent the person cannot read) reads as PRESENT, so nothing the
 * command cannot see is ever taken for its own and removed.
 */
export async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return !(code === 'ENOENT' || code === 'ENOTDIR');
  }
}

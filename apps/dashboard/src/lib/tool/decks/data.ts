import { canonicalJson, parseBindings, renderBindings } from '@slideless/contract';
import type { Presentation } from '@slideless/contract';

/**
 * Pure helpers of the deck page's Data tab (PRDCT-3641, data-bound
 * templates): which side of the tab a deck gets, the preview of a template
 * against its sample, the diff between two data versions, and the reading of
 * the editor's JSON and of the API's refusals. No Svelte, no fetch: the
 * panels (TemplateDataPanel, DocumentDataPanel) call them, data.test.ts pins
 * them.
 */

/** The two faces of the Data tab: a template's contract, or a document's data. */
export type DataSide = 'template' | 'document';

/**
 * Which side of the Data tab a deck gets, or null when it has none. A
 * document is the more specific fact (it may carry its template's AGENT.md,
 * so its own reference may also read `template`): its data wins.
 */
export function dataSide(deck: Pick<Presentation, 'reference' | 'document'> | null): DataSide | null {
  if (!deck) return null;
  if (deck.document) return 'document';
  if (deck.reference?.type === 'template') return 'template';
  return null;
}

/** Whether the deck page shows its Data tab at all. */
export function showDataTab(deck: Pick<Presentation, 'reference' | 'document'> | null): boolean {
  return dataSide(deck) !== null;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Gives a page rendered through `srcdoc` the address its relative links
 * resolve against: a `<base href>` right after `<head>`, else right after
 * `<html>`, else at the very start. A page that already names its base keeps
 * its own, byte for byte.
 */
export function withBaseHref(html: string, href: string): string {
  if (/<base[\s/>]/i.test(html)) return html;
  const tag = `<base href="${escapeAttribute(href)}">`;
  for (const opening of [/<head(?:\s[^>]*)?>/i, /<html(?:\s[^>]*)?>/i]) {
    const match = opening.exec(html);
    if (match) {
      const at = match.index + match[0].length;
      return html.slice(0, at) + tag + html.slice(at);
    }
  }
  return tag + html;
}

/**
 * The template's entry page as it reads with its sample: the bindings
 * resolved against the sample, then the base. No sample, or a page whose
 * bindings do not parse, keeps the raw page (`rendered: false`), base added.
 */
export function previewWithSample(
  html: string,
  sample: Record<string, unknown> | null,
  baseHref: string
): { html: string; rendered: boolean } {
  if (sample === null) return { html: withBaseHref(html, baseHref), rendered: false };
  const { parsed, errors } = parseBindings(html);
  if (errors.length) return { html: withBaseHref(html, baseHref), rendered: false };
  return { html: withBaseHref(renderBindings(parsed, sample), baseHref), rendered: true };
}

export interface TopLevelChange {
  key: string;
  kind: 'added' | 'removed' | 'changed';
  /** The value before; absent on an added key. */
  before?: unknown;
  /** The value after; absent on a removed key. */
  after?: unknown;
}

/**
 * What changed between two data versions, key by key at the top level: the
 * keys of `after` in their order, then the keys only `before` had. Values are
 * compared canonically (key order inside an object never counts as a
 * change). `before` null is the first version: every key is added.
 */
export function diffTopLevel(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): TopLevelChange[] {
  const prior = before ?? {};
  const out: TopLevelChange[] = [];
  for (const key of Object.keys(after)) {
    if (!Object.prototype.hasOwnProperty.call(prior, key)) {
      out.push({ key, kind: 'added', after: after[key] });
    } else if (canonicalJson(prior[key]) !== canonicalJson(after[key])) {
      out.push({ key, kind: 'changed', before: prior[key], after: after[key] });
    }
  }
  for (const key of Object.keys(prior)) {
    if (!Object.prototype.hasOwnProperty.call(after, key)) {
      out.push({ key, kind: 'removed', before: prior[key] });
    }
  }
  return out;
}

/** A value as the code blocks show it: indented JSON. */
export function jsonText(value: unknown): string {
  return value === undefined ? '' : JSON.stringify(value, null, 2);
}

export type EditorJson = { ok: true; value: Record<string, unknown> | null } | { ok: false; error: string };

/**
 * One editor textarea read as a JSON object. `allowEmpty`: an emptied
 * textarea is `null` (the sample, removed). Anything but an object is
 * refused: a schema and a sample are both objects.
 */
export function parseEditorJson(text: string, opts: { allowEmpty?: boolean } = {}): EditorJson {
  if (!text.trim()) {
    return opts.allowEmpty ? { ok: true, value: null } : { ok: false, error: 'empty' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'not_object' };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * The detail lines of a data refusal, one per problem the API named:
 * `file line N: path` for a binding the schema does not know, `path: message`
 * for an invalid sample or invalid data (the root path reads `/`). Empty for
 * any other refusal, whose message is the whole story.
 */
export function refusalLines(code: string, details: unknown): string[] {
  if (!isRecord(details)) return [];
  if (code === 'binding_unknown' && Array.isArray(details.unknown)) {
    return details.unknown
      .filter(isRecord)
      .map((u) => `${String(u.file)} line ${String(u.line)}: ${String(u.path)}`);
  }
  if ((code === 'sample_invalid' || code === 'data_invalid') && Array.isArray(details.issues)) {
    return details.issues.filter(isRecord).map((i) => `${String(i.path) || '/'}: ${String(i.message)}`);
  }
  return [];
}

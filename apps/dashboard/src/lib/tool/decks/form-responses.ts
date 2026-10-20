import type { FormResponse, FormResponseFile } from '@slideless/contract';
import { buildCsv } from '$lib/tool/csv';

/**
 * The pure half of the form-responses panel (PRDCT-2403): the grouping of a
 * response's files per file field, the reading view's answers, the one-line
 * summary and the clamp (PRDCT-3644), and the CSV export. Kept
 * apart from the component so each has a unit test with no browser.
 *
 * SECURITY: a file's `field`, `name` and `contentType` are RAW anonymous
 * respondent input: text interpolation and guarded CSV cells only.
 *
 * The bytes themselves are fetched by the API client's download methods
 * through `$lib/download` (PRDCT-2426): a plain anchor cannot carry the
 * active workspace, so this module builds NO download URL. The requests are
 * made from IDS ONLY (deck, response, file): a name never reaches a URL.
 */

/** A response's files per file field, fields in first-seen order, files in upload order. */
export function groupFilesByField<F extends { field: string }>(files: F[]): { field: string; files: F[] }[] {
  const groups = new Map<string, F[]>();
  for (const file of files) {
    const group = groups.get(file.field);
    if (group) group.push(file);
    else groups.set(file.field, [file]);
  }
  return [...groups].map(([field, grouped]) => ({ field, files: grouped }));
}

/** One answer of a response as the reading view lays it out, field by field. */
export type AnswerField<F> =
  | { kind: 'text'; field: string; value: string }
  | { kind: 'list'; field: string; items: string[] }
  | { kind: 'files'; field: string; files: F[] };

/**
 * A response's answers in reading order (PRDCT-3644): the payload's fields as
 * the respondent's form sent them, a multi-choice as its list of items, then
 * one block per file field. RAW respondent input, text interpolation only.
 */
export function answerFields<F extends { field: string }>(
  payload: Record<string, string | string[]>,
  files: F[] | null
): AnswerField<F>[] {
  const fields: AnswerField<F>[] = Object.entries(payload).map(([field, value]) =>
    Array.isArray(value) ? { kind: 'list', field, items: value } : { kind: 'text', field, value }
  );
  for (const group of groupFilesByField(files ?? [])) {
    fields.push({ kind: 'files', field: group.field, files: group.files });
  }
  return fields;
}

/** The summary cell's budget, in characters, the ellipsis included. */
export const SUMMARY_MAX_CHARS = 80;

/**
 * The one-line summary of a response (PRDCT-3644): its first non-empty answer,
 * whitespace collapsed, cut at {@link SUMMARY_MAX_CHARS} characters with an
 * ellipsis, and how many OTHER fields the response holds (a file field counts
 * as a field, a file field sharing a payload key's name counts once). An array
 * reads as its items joined by ", ", a file field as its file names. `text` is
 * empty when no field holds anything, and `more` is then 0.
 */
export function summarizeAnswers(
  payload: Record<string, string | string[]>,
  files: { field: string; name: string }[] | null
): { text: string; more: number } {
  const candidates: [string, string][] = Object.entries(payload).map(([field, value]) => [
    field,
    Array.isArray(value)
      ? value
          .map((item) => item.trim())
          .filter(Boolean)
          .join(', ')
      : value
  ]);
  for (const group of groupFilesByField(files ?? [])) {
    candidates.push([group.field, group.files.map((file) => file.name).join(', ')]);
  }
  const total = new Set(candidates.map(([field]) => field)).size;
  for (const [, value] of candidates) {
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    // by code point, so a cut never splits a surrogate pair
    const chars = Array.from(flat);
    const text =
      chars.length > SUMMARY_MAX_CHARS
        ? `${chars
            .slice(0, SUMMARY_MAX_CHARS - 1)
            .join('')
            .trimEnd()}…`
        : flat;
    return { text, more: total - 1 };
  }
  return { text: '', more: 0 };
}

/**
 * Whether an answer is taller than the reading view shows at first
 * (PRDCT-3644): more than `lines` lines, each source line counted as the
 * number of `cols`-character rows it wraps onto. An estimate: the clamp itself
 * is CSS, this only decides whether the Show more control is offered.
 */
export function needsClamp(value: string, lines = 6, cols = 120): boolean {
  let rows = 0;
  for (const line of value.split(/\r\n|\r|\n/)) {
    rows += Math.max(1, Math.ceil(Array.from(line).length / cols));
    if (rows > lines) return true;
  }
  return false;
}

/** The CSV header of a file field's column. */
export function fileFieldColumn(field: string): string {
  return `${field} (files)`;
}

/** The names a response holds in one file field, as one CSV cell. */
function fileNamesCell(files: FormResponseFile[], field: string): string {
  return files
    .filter((file) => file.field === field)
    .map((file) => file.name)
    .join('; ');
}

/**
 * The CSV of the listed responses. Respondent-chosen payload keys become
 * extra columns (union, first-seen order), then one `<field> (files)` column
 * per file field met, holding the file NAMES joined by `; ` (the bytes are
 * the zip's business). buildCsv guards EVERY cell, keys and file names
 * included, against formula injection.
 */
export function buildResponsesCsv(rows: FormResponse[]): string {
  const payloadKeys = [...new Set(rows.flatMap((r) => Object.keys(r.payload)))];
  const fileFields = [...new Set(rows.flatMap((r) => r.files.map((file) => file.field)))];
  const header = [
    'form',
    'link',
    'source',
    'placement',
    'version',
    'createdAt',
    'updatedAt',
    ...payloadKeys,
    ...fileFields.map(fileFieldColumn)
  ];
  return buildCsv(
    header,
    rows.map((r) => [
      r.formName,
      r.shareTokenName ?? '',
      r.source,
      r.placement ?? '',
      String(r.version),
      r.createdAt,
      r.updatedAt,
      ...payloadKeys.map((key) => {
        const value = r.payload[key];
        if (value === undefined) return '';
        return Array.isArray(value) ? value.join(', ') : value;
      }),
      ...fileFields.map((field) => fileNamesCell(r.files, field))
    ])
  );
}

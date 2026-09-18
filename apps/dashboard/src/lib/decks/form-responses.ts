import type { FormResponse, FormResponseFile } from '@slideless/contract';
import { buildCsv } from '$lib/csv';

/**
 * The pure half of the form-responses panel (PRDCT-2403): the grouping of a
 * response's files per file field, and the CSV export. Kept
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

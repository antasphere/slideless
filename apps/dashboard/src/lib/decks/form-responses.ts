import type { FormResponse, FormResponseFile } from '@slideless/contract';
import { buildCsv } from '$lib/csv';

/**
 * The pure half of the form-responses panel (PRDCT-2403): the URLs of a
 * response's files, their grouping per file field, and the CSV export. Kept
 * apart from the component so each has a unit test with no browser.
 *
 * SECURITY: a file's `field`, `name` and `contentType` are RAW anonymous
 * respondent input. The URLs below are built from IDS ONLY (deck, response,
 * file), each one percent-encoded: a name never reaches an `href`.
 *
 * Downloads are plain same-origin anchors, the way the deck's attachments
 * are (`api.versionAttachmentUrl` in DeckMaster / VersionHistorySheet): the
 * session cookie rides the navigation and the server answers `attachment` +
 * `nosniff`, so the browser saves the bytes and never renders them. The SDK
 * is same-origin here (an empty base URL), hence the bare `/api/v1` prefix.
 */
const API = '/api/v1';

function responsesBase(deckId: string): string {
  return `${API}/presentations/${encodeURIComponent(deckId)}/responses`;
}

/** One uploaded file of one response. */
export function formResponseFileUrl(deckId: string, responseId: string, fileId: string): string {
  return `${responsesBase(deckId)}/${encodeURIComponent(responseId)}/files/${encodeURIComponent(fileId)}`;
}

/** Every file of one response, as one zip. */
export function formResponseFilesZipUrl(deckId: string, responseId: string): string {
  return `${responsesBase(deckId)}/${encodeURIComponent(responseId)}/files.zip`;
}

/** Every file of the deck's responses as one zip, narrowed to one form when the panel is. */
export function formResponsesFilesZipUrl(deckId: string, filter: { form?: string } = {}): string {
  const query = filter.form !== undefined ? `?form=${encodeURIComponent(filter.form)}` : '';
  return `${responsesBase(deckId)}/files.zip${query}`;
}

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

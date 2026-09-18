import { describe, expect, it } from 'vitest';
import type { FormResponse, FormResponseFile } from '@slideless/contract';
import {
  buildResponsesCsv,
  fileFieldColumn,
  formResponseFilesZipUrl,
  formResponseFileUrl,
  formResponsesFilesZipUrl,
  groupFilesByField
} from './form-responses';

function file(overrides: Partial<FormResponseFile>): FormResponseFile {
  return {
    id: 'f1',
    field: 'cv',
    name: 'cv.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1024,
    sha256: 'a'.repeat(64),
    createdAt: '2026-09-18T10:00:00.000Z',
    ...overrides
  };
}

function response(overrides: Partial<FormResponse>): FormResponse {
  return {
    id: 'r1',
    presentationId: 'd1',
    version: 2,
    formName: 'apply',
    shareTokenId: 't1',
    shareTokenName: 'Alice',
    source: 'link',
    placement: null,
    payload: { name: 'Ada' },
    revision: 1,
    files: [],
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    ...overrides
  };
}

/**
 * The files of a response (PRDCT-2403). A file's name and field are RAW
 * anonymous respondent input: the URLs are built from ids only, and the CSV
 * guards the names like every other cell.
 */
describe('the file download URLs', () => {
  it('are same-origin API paths built from ids, each one percent-encoded', () => {
    expect(formResponseFileUrl('d1', 'r1', 'f1')).toBe('/api/v1/presentations/d1/responses/r1/files/f1');
    expect(formResponseFilesZipUrl('d1', 'r1')).toBe('/api/v1/presentations/d1/responses/r1/files.zip');
    // An id is never trusted to be a clean segment: no path or query break-out.
    expect(formResponseFileUrl('d/1', 'r?1', '../f#1')).toBe(
      '/api/v1/presentations/d%2F1/responses/r%3F1/files/..%2Ff%231'
    );
  });

  it('narrows the whole-deck zip to the panel’s form filter, and only then', () => {
    expect(formResponsesFilesZipUrl('d1')).toBe('/api/v1/presentations/d1/responses/files.zip');
    expect(formResponsesFilesZipUrl('d1', { form: 'apply' })).toBe(
      '/api/v1/presentations/d1/responses/files.zip?form=apply'
    );
    expect(formResponsesFilesZipUrl('d1', { form: 'a&token=x' })).toBe(
      '/api/v1/presentations/d1/responses/files.zip?form=a%26token%3Dx'
    );
  });
});

describe('groupFilesByField', () => {
  it('groups per file field, fields in first-seen order and files in upload order', () => {
    const groups = groupFilesByField([
      file({ id: 'f1', field: 'cv', name: 'cv.pdf' }),
      file({ id: 'f2', field: 'photos', name: 'a.png' }),
      file({ id: 'f3', field: 'cv', name: 'letter.pdf' })
    ]);
    expect(groups.map((g) => g.field)).toEqual(['cv', 'photos']);
    expect(groups[0]!.files.map((f) => f.name)).toEqual(['cv.pdf', 'letter.pdf']);
    expect(groups[1]!.files.map((f) => f.id)).toEqual(['f2']);
  });

  it('answers nothing for a response without files', () => {
    expect(groupFilesByField([])).toEqual([]);
  });
});

describe('buildResponsesCsv', () => {
  it('keeps the historical columns unchanged when no response holds a file', () => {
    const csv = buildResponsesCsv([response({})]);
    expect(csv.split('\r\n')[0]).toBe(
      '"form","link","source","placement","version","createdAt","updatedAt","name"'
    );
  });

  it('adds one `<field> (files)` column per file field met, the names joined by "; "', () => {
    const csv = buildResponsesCsv([
      response({
        files: [
          file({ id: 'f1', field: 'cv', name: 'cv.pdf' }),
          file({ id: 'f2', field: 'photos', name: 'a.png' }),
          file({ id: 'f3', field: 'cv', name: 'letter.pdf' })
        ]
      }),
      response({ id: 'r2', payload: { name: 'Bob' } })
    ]);
    const [header, first, second] = csv.split('\r\n');
    expect(header!.endsWith(`"name","${fileFieldColumn('cv')}","${fileFieldColumn('photos')}"`)).toBe(true);
    expect(fileFieldColumn('cv')).toBe('cv (files)');
    expect(first!.endsWith('"Ada","cv.pdf; letter.pdf","a.png"')).toBe(true);
    // A response without files leaves the file columns empty, never shifted.
    expect(second!.endsWith('"Bob","",""')).toBe(true);
  });

  it('guards a file NAME and a file FIELD against formula injection like any other cell', () => {
    const csv = buildResponsesCsv([
      response({ files: [file({ field: '=cmd', name: '=HYPERLINK("http://evil")' })] })
    ]);
    const [header, row] = csv.split('\r\n');
    expect(header!.endsWith('"\'=cmd (files)"')).toBe(true);
    expect(row!.endsWith('"\'=HYPERLINK(""http://evil"")"')).toBe(true);
  });
});

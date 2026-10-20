import { describe, expect, it } from 'vitest';
import type { FormResponse, FormResponseFile } from '@slideless/contract';
import {
  answerFields,
  buildResponsesCsv,
  fileFieldColumn,
  groupFilesByField,
  needsClamp,
  summarizeAnswers,
  SUMMARY_MAX_CHARS
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
 * anonymous respondent input: the CSV guards the names like every other cell.
 * The download requests are the SDK's (ids only, each percent-encoded:
 * packages/sdk/test/download-headers.test.ts).
 */
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

/** The table's one-line summary of a response (PRDCT-3644). */
describe('summarizeAnswers', () => {
  it('answers an empty summary for an empty payload with no file', () => {
    expect(summarizeAnswers({}, [])).toEqual({ text: '', more: 0 });
    expect(summarizeAnswers({}, null)).toEqual({ text: '', more: 0 });
  });

  it('shows the one field whole, with nothing more', () => {
    expect(summarizeAnswers({ name: 'Ada Lovelace' }, [])).toEqual({ text: 'Ada Lovelace', more: 0 });
  });

  it('takes the first NON-EMPTY answer and counts every other field', () => {
    expect(summarizeAnswers({ company: '  ', name: 'Ada', email: 'ada@example.com' }, [])).toEqual({
      text: 'Ada',
      more: 2
    });
  });

  it('clamps a long text at 80 characters, the ellipsis included, whitespace collapsed', () => {
    const long = `${'word '.repeat(40)}\n\nsecond paragraph`;
    const { text, more } = summarizeAnswers({ message: long, name: 'Ada' }, []);
    expect(Array.from(text)).toHaveLength(SUMMARY_MAX_CHARS);
    expect(SUMMARY_MAX_CHARS).toBe(80);
    expect(text.endsWith('…')).toBe(true);
    expect(text).not.toContain('\n');
    expect(text.startsWith('word word')).toBe(true);
    expect(more).toBe(1);
  });

  it('leaves a text of exactly 80 characters untouched', () => {
    const exact = 'x'.repeat(80);
    expect(summarizeAnswers({ a: exact }, []).text).toBe(exact);
  });

  it('never splits a surrogate pair at the cut', () => {
    const { text } = summarizeAnswers({ a: '😀'.repeat(100) }, []);
    expect(Array.from(text)).toHaveLength(80);
    expect(text).toBe(`${'😀'.repeat(79)}…`);
  });

  it('joins an array with ", "', () => {
    expect(summarizeAnswers({ topics: ['design', 'code', 'ops'] }, [])).toEqual({
      text: 'design, code, ops',
      more: 0
    });
  });

  it('skips an empty array for the next answer', () => {
    expect(summarizeAnswers({ topics: [], name: 'Ada' }, []).text).toBe('Ada');
  });

  it('counts each file field as one field, and reads its names when nothing else answers', () => {
    const files = [
      file({ id: 'f1', field: 'cv', name: 'cv.pdf' }),
      file({ id: 'f2', field: 'cv', name: 'letter.pdf' }),
      file({ id: 'f3', field: 'photos', name: 'a.png' })
    ];
    expect(summarizeAnswers({ name: 'Ada' }, files)).toEqual({ text: 'Ada', more: 2 });
    expect(summarizeAnswers({}, files)).toEqual({ text: 'cv.pdf, letter.pdf', more: 1 });
  });
});

/** The reading view's clamp decision (PRDCT-3644). */
describe('needsClamp', () => {
  it('clamps on the line count: six lines stay whole, seven do not', () => {
    expect(needsClamp(['1', '2', '3', '4', '5', '6'].join('\n'))).toBe(false);
    expect(needsClamp(['1', '2', '3', '4', '5', '6', '7'].join('\n'))).toBe(true);
    expect(needsClamp('a\r\nb\r\nc', 2)).toBe(true);
  });

  it('clamps on the character count: a line wraps every 120 characters', () => {
    expect(needsClamp('x'.repeat(720))).toBe(false);
    expect(needsClamp('x'.repeat(721))).toBe(true);
    expect(needsClamp('x'.repeat(50), 6, 10)).toBe(false);
    expect(needsClamp('x'.repeat(61), 6, 10)).toBe(true);
  });

  it('counts empty lines as lines', () => {
    expect(needsClamp('a\n\n\n\n\n\nb')).toBe(true);
    expect(needsClamp('')).toBe(false);
  });
});

/** The reading view's fields, in order (PRDCT-3644). */
describe('answerFields', () => {
  it('lays out text, then lists, in payload order, then one block per file field', () => {
    const fields = answerFields({ name: 'Ada', topics: ['design', 'code'] }, [
      file({ id: 'f1', field: 'cv', name: 'cv.pdf' }),
      file({ id: 'f2', field: 'cv', name: 'letter.pdf' })
    ]);
    expect(fields.map((f) => [f.kind, f.field])).toEqual([
      ['text', 'name'],
      ['list', 'topics'],
      ['files', 'cv']
    ]);
    const list = fields[1]!;
    expect(list.kind === 'list' && list.items).toEqual(['design', 'code']);
    const files = fields[2]!;
    expect(files.kind === 'files' && files.files.map((f) => f.name)).toEqual(['cv.pdf', 'letter.pdf']);
  });

  it('reads a revision from before file fields (files null) as its payload alone', () => {
    expect(answerFields({ name: 'Ada' }, null)).toEqual([{ kind: 'text', field: 'name', value: 'Ada' }]);
  });
});

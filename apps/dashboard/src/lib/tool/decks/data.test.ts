import { describe, expect, it } from 'vitest';
import {
  dataSide,
  diffTopLevel,
  parseEditorJson,
  previewWithSample,
  refusalLines,
  showDataTab,
  withBaseHref
} from './data';

const BASE = 'https://app.example.com/v/abc/';

/** The tab is shown on a template and on a document, and nowhere else (PRDCT-3641). */
describe('showDataTab', () => {
  const pin = { templateId: 't1', templateVersion: 2, schemaVersion: '1' };

  it('shows the tab on a template, with the template side', () => {
    const deck = { reference: { type: 'template' as const }, document: null };
    expect(showDataTab(deck)).toBe(true);
    expect(dataSide(deck)).toBe('template');
  });

  it('shows the tab on a document, with the document side', () => {
    const deck = { reference: null, document: pin };
    expect(showDataTab(deck)).toBe(true);
    expect(dataSide(deck)).toBe('document');
  });

  it('prefers the document side when a document also reads as a template', () => {
    expect(dataSide({ reference: { type: 'template' as const }, document: pin })).toBe('document');
  });

  it('hides the tab on an ordinary deck, a brand, and before the deck is loaded', () => {
    expect(showDataTab({ reference: null, document: null })).toBe(false);
    expect(showDataTab({ reference: { type: 'brand' as const }, document: null })).toBe(false);
    expect(showDataTab(null)).toBe(false);
  });
});

describe('withBaseHref', () => {
  it('puts the base right after <head>, attributes and case alike', () => {
    expect(withBaseHref('<html><head><title>x</title></head></html>', BASE)).toBe(
      `<html><head><base href="${BASE}"><title>x</title></head></html>`
    );
    expect(withBaseHref('<HEAD lang="fr"><meta charset="utf-8">', BASE)).toBe(
      `<HEAD lang="fr"><base href="${BASE}"><meta charset="utf-8">`
    );
  });

  it('never mistakes <header> for <head>', () => {
    expect(withBaseHref('<html><body><header>h</header></body></html>', BASE)).toBe(
      `<html><base href="${BASE}"><body><header>h</header></body></html>`
    );
  });

  it('without a head or an html tag, starts the page with it', () => {
    expect(withBaseHref('<p>bare</p>', BASE)).toBe(`<base href="${BASE}"><p>bare</p>`);
  });

  it('leaves a page that names its own base alone, byte for byte', () => {
    const page = '<html><head><base href="https://cdn.example.com/"><title>x</title></head></html>';
    expect(withBaseHref(page, BASE)).toBe(page);
    const upper = '<head><BASE target="_blank"/></head>';
    expect(withBaseHref(upper, BASE)).toBe(upper);
  });

  it('escapes the href it writes', () => {
    expect(withBaseHref('<head>', 'https://x/"><script>')).toBe(
      '<head><base href="https://x/&quot;&gt;&lt;script&gt;">'
    );
  });
});

describe('previewWithSample', () => {
  const page = '<head></head><h1>{{title}}</h1>';

  it('renders the bindings against the sample, the base added', () => {
    expect(previewWithSample(page, { title: 'Q3 <review>' }, BASE)).toEqual({
      html: `<head><base href="${BASE}"></head><h1>Q3 &lt;review&gt;</h1>`,
      rendered: true
    });
  });

  it('keeps the raw page without a sample, or when the bindings do not parse', () => {
    expect(previewWithSample(page, null, BASE)).toEqual({
      html: `<head><base href="${BASE}"></head><h1>{{title}}</h1>`,
      rendered: false
    });
    expect(previewWithSample('<head></head>{{> partial}}', { a: 1 }, BASE).rendered).toBe(false);
  });
});

describe('diffTopLevel', () => {
  it('names what was added, changed and removed, after’s order then the removed', () => {
    expect(
      diffTopLevel(
        { a: 1, b: { x: 1 }, gone: true, same: [1, 2] },
        { b: { x: 2 }, a: 1, same: [1, 2], c: 'new' }
      )
    ).toEqual([
      { key: 'b', kind: 'changed', before: { x: 1 }, after: { x: 2 } },
      { key: 'c', kind: 'added', after: 'new' },
      { key: 'gone', kind: 'removed', before: true }
    ]);
  });

  it('never counts key order inside an object as a change', () => {
    expect(diffTopLevel({ o: { a: 1, b: 2 } }, { o: { b: 2, a: 1 } })).toEqual([]);
  });

  it('reads the first version as every key added', () => {
    expect(diffTopLevel(null, { a: 1, b: null })).toEqual([
      { key: 'a', kind: 'added', after: 1 },
      { key: 'b', kind: 'added', after: null }
    ]);
  });

  it('tells a null value from a missing key', () => {
    expect(diffTopLevel({ a: null }, {})).toEqual([{ key: 'a', kind: 'removed', before: null }]);
    expect(diffTopLevel({ a: null }, { a: 0 })).toEqual([
      { key: 'a', kind: 'changed', before: null, after: 0 }
    ]);
  });
});

describe('parseEditorJson', () => {
  it('reads an object', () => {
    expect(parseEditorJson('{"type":"object"}')).toEqual({ ok: true, value: { type: 'object' } });
  });

  it('reads an emptied sample as null, an emptied schema as an error', () => {
    expect(parseEditorJson('  \n', { allowEmpty: true })).toEqual({ ok: true, value: null });
    expect(parseEditorJson('')).toEqual({ ok: false, error: 'empty' });
  });

  it('refuses broken JSON and anything but an object', () => {
    expect(parseEditorJson('{"a":').ok).toBe(false);
    expect(parseEditorJson('[1]')).toEqual({ ok: false, error: 'not_object' });
    expect(parseEditorJson('null')).toEqual({ ok: false, error: 'not_object' });
  });
});

describe('refusalLines', () => {
  it('names each unknown binding by file and line', () => {
    expect(
      refusalLines('binding_unknown', {
        unknown: [{ path: 'client.nmae', file: 'index.html', line: 12 }]
      })
    ).toEqual(['index.html line 12: client.nmae']);
  });

  it('names each issue by its path, the root as /', () => {
    const details = {
      issues: [
        { path: '/total', message: 'must be number' },
        { path: '', message: 'must have required property "title"' }
      ]
    };
    expect(refusalLines('sample_invalid', details)).toEqual([
      '/total: must be number',
      '/: must have required property "title"'
    ]);
    expect(refusalLines('data_invalid', details)).toHaveLength(2);
  });

  it('has nothing to add to another refusal', () => {
    expect(refusalLines('schema_version_unchanged', undefined)).toEqual([]);
    expect(refusalLines('forbidden', { issues: [] })).toEqual([]);
  });
});

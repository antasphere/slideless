import { describe, expect, it } from 'vitest';
import { DATA_BLOCK_ID, withDataBlock } from '../../src/documents/service.js';
import {
  contractRefusalBody,
  documentBindingOf,
  isBoundFileEntry
} from '../../src/presentations/data-contract.js';

/**
 * The pure halves of the document renderer (PRDCT-3641): the data block the
 * rendered entry carries, and the contract reader's helpers. The behaviour
 * end to end is documents.test.ts (integration).
 */
describe('withDataBlock', () => {
  it('puts the block before </head>, escaping what would close the script', () => {
    const out = withDataBlock('<html><head><title>t</title></head><body></body></html>', {
      a: '</script><img src=x onerror=alert(1)>',
      b: '<!-- c -->'
    });
    expect(out.indexOf(`id="${DATA_BLOCK_ID}"`)).toBeLessThan(out.indexOf('</head>'));
    expect(out).not.toContain('</script><img');
    expect(out).not.toContain('<!-- c');
    expect(out).toContain('\\u003c/script>');
    // The block parses back to the data.
    const json = /<script type="application\/json" id="slideless-data">(.*?)<\/script>/.exec(out)![1]!;
    expect(JSON.parse(json)).toEqual({ a: '</script><img src=x onerror=alert(1)>', b: '<!-- c -->' });
  });

  it('falls back to before <body, then to the top', () => {
    expect(withDataBlock('<body><p>x</p></body>', { a: 1 }).startsWith('<script')).toBe(true);
    expect(withDataBlock('<p>x</p>', { a: 1 }).startsWith('<script')).toBe(true);
    expect(withDataBlock('<HEAD></HEAD>', { a: 1 })).toContain('</script></HEAD>');
  });
});

describe('the contract reader helpers', () => {
  it('binds HTML entries by declared type only', () => {
    expect(
      isBoundFileEntry({ path: 'a.html', sha256: 'x', sizeBytes: 1, contentType: 'text/html; charset=utf-8' })
    ).toBe(true);
    expect(
      isBoundFileEntry({ path: 'a.html', sha256: 'x', sizeBytes: 1, contentType: 'application/octet-stream' })
    ).toBe(false);
    expect(isBoundFileEntry({ path: 'a.css', sha256: 'x', sizeBytes: 1, contentType: 'text/css' })).toBe(
      false
    );
  });

  it('shapes every refusal with its code, and the details that name the place', () => {
    expect(contractRefusalBody({ code: 'schema_invalid', message: 'm' })).toEqual({
      error: { code: 'schema_invalid', message: 'm' }
    });
    expect(
      contractRefusalBody({
        code: 'binding_unknown',
        message: 'm',
        unknown: [{ path: 'x', file: 'index.html', line: 3 }]
      })
    ).toEqual({
      error: {
        code: 'binding_unknown',
        message: 'm',
        details: { unknown: [{ path: 'x', file: 'index.html', line: 3 }] }
      }
    });
    expect(
      (
        contractRefusalBody({
          code: 'sample_invalid',
          message: 'm',
          issues: [{ path: '/a', message: 'bad' }]
        }).error as { details?: unknown }
      ).details
    ).toEqual({
      issues: [{ path: '/a', message: 'bad' }]
    });
  });

  it('answers the document binding only for a deck with a pin', () => {
    expect(documentBindingOf({ templateId: null, templateVersion: null, documentData: null })).toBeNull();
    expect(documentBindingOf({ templateId: 't', templateVersion: 2, documentData: {} }, '1')).toEqual({
      templateId: 't',
      templateVersion: 2,
      schemaVersion: '1'
    });
  });
});

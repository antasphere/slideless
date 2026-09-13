import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import AdmZip from 'adm-zip';
import { pino } from 'pino';
import type { Attachment } from '@slideless/contract';
import { attachmentsZipFilename, serveAttachmentsZip } from '../../src/presentations/attachments.js';
import type { StorageDriver } from '../../src/storage/driver.js';

/**
 * The attachments zip (PRDCT-2278) at the unit level: the archive a
 * recipient or an owner receives is a STORE-only zip whose entries are the
 * attachments' names with their exact bytes, a missing blob is a clean 404
 * before any status line, HEAD carries the headers and no body, and the
 * filename slug is nothing but `[a-z0-9-]`. The central directory is what
 * a reader parses to list the archive, so the test reads the bytes back
 * through an independent zip reader (adm-zip) rather than trusting the
 * writer.
 */

const WORKSPACE = '11111111-2222-3333-4444-555555555555';
const logger = pino({ level: 'silent' });

const BLOBS: Record<string, Buffer> = {
  ['a'.repeat(64)]: Buffer.from('col1,col2\n1,2\n'),
  ['b'.repeat(64)]: Buffer.from('%PDF-1.4 fake pdf bytes'),
  ['c'.repeat(64)]: Buffer.from('# notes\n')
};

const attachments: Attachment[] = [
  {
    name: 'figures.csv',
    path: 'downloads/figures.csv',
    sizeBytes: 14,
    contentType: 'text/csv',
    sha256: 'a'.repeat(64)
  },
  {
    name: 'annex.pdf',
    path: 'downloads/annex.pdf',
    sizeBytes: 23,
    contentType: 'application/pdf',
    sha256: 'b'.repeat(64)
  },
  {
    name: 'sub/notes.md',
    path: 'downloads/sub/notes.md',
    sizeBytes: 8,
    contentType: 'text/markdown',
    sha256: 'c'.repeat(64)
  }
];

function storageOf(blobs: Record<string, Buffer>): StorageDriver {
  const shaOfKey = (key: string) => key.split('/').pop() ?? '';
  return {
    name: 'local',
    put: async () => {},
    getStream: async (key: string) => Readable.from([blobs[shaOfKey(key)]!]),
    exists: async (key: string) => shaOfKey(key) in blobs,
    head: async (key: string) =>
      shaOfKey(key) in blobs ? { sizeBytes: blobs[shaOfKey(key)]!.length } : null,
    delete: async () => {},
    healthcheck: async () => {}
  } as unknown as StorageDriver;
}

function appWith(storage: StorageDriver, entries: Attachment[]): Hono {
  const app = new Hono();
  app.on(['GET', 'HEAD'], '/zip', (c) =>
    serveAttachmentsZip(c, {
      storage,
      logger,
      workspaceId: WORKSPACE,
      attachments: entries,
      filename: attachmentsZipFilename('Quarterly review', 3),
      mtime: new Date('2026-09-13T10:00:00Z'),
      headOnly: c.req.method === 'HEAD',
      extraHeaders: { 'x-probe': 'kept' }
    })
  );
  return app;
}

describe('attachmentsZipFilename', () => {
  it('slugs the title, appends the version, strips accents and anything outside [a-z0-9-]', () => {
    expect(attachmentsZipFilename('Quarterly review', 3)).toBe('quarterly-review-v3.zip');
    expect(attachmentsZipFilename('  Résumé — Q3 / 2026 !! ', 12)).toBe('resume-q3-2026-v12.zip');
    expect(attachmentsZipFilename('日本語のみ', 1)).toBe('deck-v1.zip');
    expect(attachmentsZipFilename('', 2)).toBe('deck-v2.zip');
  });

  it('caps the slug and never ends on a dash', () => {
    const name = attachmentsZipFilename(`${'word '.repeat(40)}`, 1);
    const slug = name.replace(/-v1\.zip$/, '');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith('-')).toBe(false);
    expect(name).toMatch(/^[a-z0-9-]+-v1\.zip$/);
  });
});

describe('serveAttachmentsZip', () => {
  it('streams a store-only archive whose entries are the attachment names with their exact bytes', async () => {
    const res = await appWith(storageOf(BLOBS), attachments).request('/zip');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toBe(
      'attachment; filename="quarterly-review-v3.zip"; filename*=UTF-8\'\'quarterly-review-v3.zip'
    );
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-probe')).toBe('kept');
    expect(res.headers.get('content-length')).toBeNull(); // streamed: the size is only known at the end

    const zip = new AdmZip(Buffer.from(await res.arrayBuffer()));
    const entries = zip.getEntries();
    expect(entries.map((e) => e.entryName)).toEqual(['figures.csv', 'annex.pdf', 'sub/notes.md']);
    for (const entry of entries) {
      // Compression method 0 = stored (no deflate), the whole point of the
      // streaming shape: nothing is buffered to compress.
      expect(entry.header.method, entry.entryName).toBe(0);
      const sha = attachments.find((a) => a.name === entry.entryName)!.sha256;
      expect(entry.getData().equals(BLOBS[sha]!), entry.entryName).toBe(true);
    }
  });

  it('answers a clean 404 when any attachment blob is unreachable, before any bytes go out', async () => {
    const missingOne = storageOf({ ['a'.repeat(64)]: BLOBS['a'.repeat(64)]! });
    const res = await appWith(missingOne, attachments).request('/zip');
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: { code: 'not_found' } });
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('HEAD carries the download headers and no body', async () => {
    const res = await appWith(storageOf(BLOBS), attachments).request('/zip', { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');
    expect(res.headers.get('content-disposition')).toContain('quarterly-review-v3.zip');
    expect(await res.text()).toBe('');
  });
});

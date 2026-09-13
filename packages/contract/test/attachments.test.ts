import { describe, expect, it } from 'vitest';
import {
  assetPathSchema,
  attachmentNameOf,
  attachmentPathOf,
  attachmentsOf,
  DOWNLOADS_DIR,
  DOWNLOADS_PREFIX,
  isAttachmentPath,
  type ManifestEntry
} from '../src/index.js';

/**
 * The `downloads/` convention (PRDCT-2278) as a pure rule: exact,
 * case-sensitive, root-level prefix with at least one character after the
 * slash; the name is the rest; the derived list keeps manifest order.
 */
const entry = (path: string): ManifestEntry => ({
  path,
  sha256: 'a'.repeat(64),
  sizeBytes: 3,
  contentType: 'text/plain'
});

describe('isAttachmentPath', () => {
  it('matches root-level downloads/ entries, nested ones included', () => {
    expect(DOWNLOADS_DIR).toBe('downloads');
    expect(DOWNLOADS_PREFIX).toBe('downloads/');
    expect(isAttachmentPath('downloads/a.csv')).toBe(true);
    expect(isAttachmentPath('downloads/sub/deep/notes.md')).toBe(true);
  });

  it('is exact and case-sensitive, and the bare folder is not an attachment', () => {
    for (const p of [
      'Downloads/a.csv',
      'downloads',
      'downloads/',
      'downloads-old/a.csv',
      'x/downloads/a.csv',
      'index.html'
    ]) {
      expect(isAttachmentPath(p), p).toBe(false);
    }
  });
});

describe('attachment names', () => {
  it('round-trips between the manifest path and the name', () => {
    expect(attachmentNameOf('downloads/sub/notes.md')).toBe('sub/notes.md');
    expect(attachmentPathOf('sub/notes.md')).toBe('downloads/sub/notes.md');
    expect(attachmentPathOf(attachmentNameOf('downloads/a.csv'))).toBe('downloads/a.csv');
  });
});

describe('attachmentsOf', () => {
  it('derives the attachments in manifest order and skips everything else', () => {
    const manifest = [
      entry('index.html'),
      entry('downloads/b.pdf'),
      entry('assets/logo.png'),
      entry('downloads/a.csv'),
      entry('Downloads/nope.csv')
    ];
    expect(attachmentsOf(manifest)).toEqual([
      {
        name: 'b.pdf',
        path: 'downloads/b.pdf',
        sizeBytes: 3,
        contentType: 'text/plain',
        sha256: 'a'.repeat(64)
      },
      {
        name: 'a.csv',
        path: 'downloads/a.csv',
        sizeBytes: 3,
        contentType: 'text/plain',
        sha256: 'a'.repeat(64)
      }
    ]);
    expect(attachmentsOf([entry('index.html')])).toEqual([]);
  });
});

describe('the reserved root path downloads.zip', () => {
  it('is refused at the root, in any case, and allowed anywhere else', () => {
    // The viewer answers /v/{secret}/downloads.zip itself; a root file of
    // that name would be shadowed with no way to reach it.
    expect(assetPathSchema.safeParse('downloads.zip').success).toBe(false);
    expect(assetPathSchema.safeParse('Downloads.ZIP').success).toBe(false);
    expect(assetPathSchema.safeParse('assets/downloads.zip').success).toBe(true);
    expect(assetPathSchema.safeParse('downloads/downloads.zip').success).toBe(true);
    expect(assetPathSchema.safeParse('downloads.zip.txt').success).toBe(true);
  });
});

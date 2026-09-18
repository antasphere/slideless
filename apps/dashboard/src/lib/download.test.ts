import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlatformApiError } from '@slideless/sdk';
import { en } from '$lib/i18n';

const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  loading: vi.fn(() => 'loading-toast'),
  dismiss: vi.fn()
}));
vi.mock('svelte-sonner', () => ({ toast: toastMock }));

import {
  REVOKE_DELAY_MS,
  SLOW_DOWNLOAD_MS,
  download,
  downloadErrorMessage,
  filenameFromContentDisposition,
  safeFilename,
  saveBlob,
  saveDownload
} from './download';

/**
 * The dashboard's one download path (PRDCT-2426). The tests run under node:
 * the anchor and the object URL are the two browser seams, faked here so the
 * order of the save flow (object URL, click, removal, revocation) is pinned.
 */

interface FakeAnchor {
  href: string;
  download: string;
  rel: string;
  style: { display: string };
  click: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
}

let anchors: FakeAnchor[];
let appended: FakeAnchor[];
let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  anchors = [];
  appended = [];
  createObjectURL = vi.fn(() => `blob:fake-${anchors.length + 1}`);
  revokeObjectURL = vi.fn();
  vi.stubGlobal('document', {
    createElement: (tag: string) => {
      expect(tag).toBe('a');
      const anchor: FakeAnchor = {
        href: '',
        download: '',
        rel: '',
        style: { display: '' },
        click: vi.fn(),
        remove: vi.fn()
      };
      anchors.push(anchor);
      return anchor;
    },
    body: { appendChild: (node: FakeAnchor) => appended.push(node) }
  });
  // Only the two statics are faked: the URL constructor stays the real one.
  vi.spyOn(URL, 'createObjectURL').mockImplementation(createObjectURL as never);
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(revokeObjectURL as never);
  toastMock.error.mockClear();
  toastMock.loading.mockClear();
  toastMock.dismiss.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function fileResponse(body: string, disposition?: string): Response {
  return new Response(body, {
    status: 200,
    headers: disposition ? { 'content-disposition': disposition } : {}
  });
}

describe('filenameFromContentDisposition', () => {
  it('reads the server’s own encoding: filename* wins over the ascii fallback', () => {
    expect(
      filenameFromContentDisposition(
        `attachment; filename="r_sum_.pdf"; filename*=UTF-8''r%C3%A9sum%C3%A9.pdf`
      )
    ).toBe('résumé.pdf');
  });

  it('reads a quoted name, with its escapes', () => {
    expect(filenameFromContentDisposition('attachment; filename="deck-v3.zip"')).toBe('deck-v3.zip');
    expect(filenameFromContentDisposition('attachment; filename="a \\"b\\".txt"')).toBe('a "b".txt');
  });

  it('reads a bare name and an inline disposition', () => {
    expect(filenameFromContentDisposition('inline; filename=annex.pdf')).toBe('annex.pdf');
  });

  it('keeps a semicolon inside a quoted name', () => {
    expect(filenameFromContentDisposition('attachment; filename="a;b.csv"')).toBe('a;b.csv');
  });

  it('falls back to the plain parameter when filename* is malformed or not UTF-8', () => {
    expect(filenameFromContentDisposition(`attachment; filename="ok.txt"; filename*=UTF-8''%E0%A4%A`)).toBe(
      'ok.txt'
    );
    expect(
      filenameFromContentDisposition(`attachment; filename="ok.txt"; filename*=ISO-8859-1''caf%E9`)
    ).toBe('ok.txt');
  });

  it('answers null when the header names nothing', () => {
    expect(filenameFromContentDisposition(null)).toBeNull();
    expect(filenameFromContentDisposition('')).toBeNull();
    expect(filenameFromContentDisposition('attachment')).toBeNull();
    expect(filenameFromContentDisposition('attachment; filename=""')).toBeNull();
  });

  it('never lets a name become a path', () => {
    expect(filenameFromContentDisposition(`attachment; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd`)).toBe(
      '.._.._etc_passwd'
    );
    expect(filenameFromContentDisposition('attachment; filename="sub/notes.md"')).toBe('sub_notes.md');
  });
});

describe('safeFilename', () => {
  it('drops control characters and separators, refuses dot-only names', () => {
    expect(safeFilename(`a${String.fromCharCode(0)}b${String.fromCharCode(10)}.txt`)).toBe('ab.txt');
    expect(safeFilename('C:\\temp\\x.txt')).toBe('C:_temp_x.txt');
    expect(safeFilename('..')).toBe('');
    expect(safeFilename('   ')).toBe('');
  });
});

describe('saveBlob', () => {
  it('clicks a hidden anchor on an object URL, removes it, and revokes the URL afterwards', () => {
    saveBlob(new Blob(['x']), 'figures.csv');

    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(anchors).toHaveLength(1);
    const anchor = anchors[0]!;
    expect(anchor.href).toBe('blob:fake-1');
    expect(anchor.download).toBe('figures.csv');
    expect(appended).toEqual([anchor]);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();

    // Not before the browser had its beat to start reading, and not never.
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(REVOKE_DELAY_MS);
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:fake-1');
  });

  it('never hands this origin a renderable type: the object URL is octet-stream, the bytes intact', async () => {
    saveBlob(new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'page.html');
    const handed = createObjectURL.mock.calls[0]![0] as Blob;
    expect(handed.type).toBe('application/octet-stream');
    expect(await handed.text()).toBe('<script>alert(1)</script>');
    expect(anchors[0]!.download).toBe('page.html');
  });

  it('never saves under an empty or path-shaped name', () => {
    saveBlob(new Blob(['x']), '../');
    expect(anchors[0]!.download).toBe('.._');
    saveBlob(new Blob(['x']), '');
    expect(anchors[1]!.download).toBe('download');
  });
});

describe('saveDownload', () => {
  it('saves the fetched bytes under the server’s name', async () => {
    const name = await saveDownload(
      async () =>
        fileResponse('zip-bytes', `attachment; filename="deck-v3.zip"; filename*=UTF-8''deck-v3.zip`),
      { fallbackName: 'ignored.bin' }
    );
    expect(name).toBe('deck-v3.zip');
    expect(anchors[0]!.download).toBe('deck-v3.zip');
    const saved = createObjectURL.mock.calls[0]![0] as Blob;
    expect(await saved.text()).toBe('zip-bytes');
  });

  it('uses the caller’s name only when the answer names none', async () => {
    expect(await saveDownload(async () => fileResponse('x'), { fallbackName: 'export.zip' })).toBe(
      'export.zip'
    );
    expect(await saveDownload(async () => fileResponse('x'))).toBe('download');
  });

  it('reads the body once: the Blob is the only buffer', async () => {
    const res = fileResponse('x', 'attachment; filename="a.txt"');
    const blob = vi.spyOn(res, 'blob');
    const arrayBuffer = vi.spyOn(res, 'arrayBuffer');
    const text = vi.spyOn(res, 'text');
    await saveDownload(async () => res);
    expect(blob).toHaveBeenCalledOnce();
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it('lets a refusal through and saves nothing', async () => {
    const refusal = new PlatformApiError(404, 'not_found', 'Presentation not found');
    await expect(
      saveDownload(async () => {
        throw refusal;
      })
    ).rejects.toBe(refusal);
    expect(anchors).toHaveLength(0);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe('download', () => {
  it('saves and says nothing when all goes well and fast', async () => {
    await expect(download(async () => fileResponse('x', 'attachment; filename="a.txt"'))).resolves.toBe(true);
    expect(anchors[0]!.click).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(SLOW_DOWNLOAD_MS * 2);
    expect(toastMock.loading).not.toHaveBeenCalled();
    expect(toastMock.error).not.toHaveBeenCalled();
  });

  it('turns a refusal into a sentence on screen instead of a click that does nothing', async () => {
    await expect(
      download(async () => {
        throw new PlatformApiError(404, 'not_found', 'Presentation not found');
      })
    ).resolves.toBe(false);
    expect(toastMock.error).toHaveBeenCalledExactlyOnceWith(en['download.notFound']);
    expect(anchors).toHaveLength(0);
  });

  it('shows that a slow download is on its way, and clears it when the file arrives', async () => {
    let arrive!: (res: Response) => void;
    const pending = download(() => new Promise<Response>((resolve) => (arrive = resolve)));
    await vi.advanceTimersByTimeAsync(SLOW_DOWNLOAD_MS);
    expect(toastMock.loading).toHaveBeenCalledExactlyOnceWith(en['download.preparing']);
    arrive(fileResponse('big', 'attachment; filename="all.zip"'));
    await expect(pending).resolves.toBe(true);
    expect(toastMock.dismiss).toHaveBeenCalledExactlyOnceWith('loading-toast');
  });
});

describe('downloadErrorMessage', () => {
  it('has a sentence for each way a download fails', () => {
    expect(downloadErrorMessage(new PlatformApiError(404, 'no_files', 'x'))).toBe(en['download.notFound']);
    expect(downloadErrorMessage(new DOMException('timed out', 'TimeoutError'))).toBe(en['download.timedOut']);
    expect(downloadErrorMessage(new TypeError('Failed to fetch'))).toBe(en['download.network']);
    expect(downloadErrorMessage(new PlatformApiError(429, 'rate_limited', 'x'))).toBe(
      en['common.tooManyAttempts']
    );
    expect(downloadErrorMessage('?')).toBe(en['download.failed']);
  });
});

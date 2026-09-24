import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The still-image loader (PRDCT-2725): one request per version however many
 * components ask, the pending answer retried on 2 / 4 / 8 / 16 s, any other
 * refusal a null without retry, and the bounded cache revoking what it drops.
 */
vi.mock('$lib/api', () => {
  class PlatformApiError extends Error {
    constructor(
      public readonly status: number,
      public readonly code: string,
      message: string
    ) {
      super(message);
    }
  }
  return { api: { versionThumbnail: vi.fn() }, PlatformApiError };
});

const { api, PlatformApiError } = await import('$lib/api');
const { loadStill, __resetStills } = await import('./stills');
const versionThumbnail = api.versionThumbnail as unknown as ReturnType<typeof vi.fn>;

const ok = () => new Response(new Blob(['webp']), { status: 200, headers: { 'content-type': 'image/webp' } });
const refused = (code: string) => new PlatformApiError(404, code, code);

let counter = 0;
let revokeObjectURL: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  counter = 0;
  versionThumbnail.mockReset();
  vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:still-${++counter}`);
  revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
});
afterEach(() => {
  __resetStills();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('loadStill', () => {
  it('asks once for concurrent callers of the same version, and serves the cache after', async () => {
    versionThumbnail.mockImplementation(async () => ok());
    const a = loadStill('deck-1', 1);
    const b = loadStill('deck-1', 1);
    expect(a).toBe(b);
    expect(await a).toBe('blob:still-1');
    expect(await loadStill('deck-1', 1)).toBe('blob:still-1');
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
    expect(versionThumbnail).toHaveBeenCalledWith('deck-1', 1);
    await loadStill('deck-1', 2);
    expect(versionThumbnail).toHaveBeenCalledTimes(2);
  });

  it('retries a pending image after 2 s then 4 s, and resolves the URL once it is made', async () => {
    vi.useFakeTimers();
    versionThumbnail
      .mockRejectedValueOnce(refused('thumbnail_pending'))
      .mockRejectedValueOnce(refused('thumbnail_pending'))
      .mockResolvedValueOnce(ok());
    const still = loadStill('deck-2', 3);
    await vi.advanceTimersByTimeAsync(0);
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(versionThumbnail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(versionThumbnail).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(versionThumbnail).toHaveBeenCalledTimes(3);
    expect(await still).toBe('blob:still-1');
  });

  it('gives up after four retries, and does not keep that null', async () => {
    vi.useFakeTimers();
    versionThumbnail.mockRejectedValue(refused('thumbnail_pending'));
    const still = loadStill('deck-3', 1);
    await vi.advanceTimersByTimeAsync(2000 + 4000 + 8000 + 16000);
    expect(await still).toBeNull();
    expect(versionThumbnail).toHaveBeenCalledTimes(5);
    versionThumbnail.mockReset();
    versionThumbnail.mockResolvedValue(ok());
    expect(await loadStill('deck-3', 1)).toBe('blob:still-1');
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
  });

  it('answers null without a retry for a failed image, and keeps it', async () => {
    vi.useFakeTimers();
    versionThumbnail.mockRejectedValue(refused('thumbnail_failed'));
    expect(await loadStill('deck-4', 1)).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
    expect(await loadStill('deck-4', 1)).toBeNull();
    expect(versionThumbnail).toHaveBeenCalledTimes(1);
  });

  it('answers null for a network failure', async () => {
    versionThumbnail.mockRejectedValue(new TypeError('Failed to fetch'));
    expect(await loadStill('deck-5', 1)).toBeNull();
  });

  it('holds at most 300 versions, evicting the oldest and revoking its URL', async () => {
    versionThumbnail.mockImplementation(async () => ok());
    for (let v = 1; v <= 300; v++) await loadStill('deck-6', v);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await loadStill('deck-6', 301);
    expect(revokeObjectURL).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:still-1');
    // the evicted version is asked again
    const before = versionThumbnail.mock.calls.length;
    await loadStill('deck-6', 1);
    expect(versionThumbnail.mock.calls.length).toBe(before + 1);
  });
});

import { describe, expect, it } from 'vitest';
import { hashToken, thumbnailStorageKey } from '../../src/thumbnails/service.js';
import { decodeDeckPath, isWebp } from '../../src/thumbnails/routes.js';

/** The small pure pieces of the still-image queue (PRDCT-2725); the protocol itself is the integration suite's. */
describe('thumbnailStorageKey', () => {
  const W = '11111111-1111-4111-8111-111111111111';
  const P = '22222222-2222-4222-8222-222222222222';
  const V = '33333333-3333-4333-8333-333333333333';

  it('builds the key under thumbs/', () => {
    expect(thumbnailStorageKey(W, P, V)).toBe(`thumbs/${W}/${P}/${V}.webp`);
  });

  it('refuses anything that is not a uuid', () => {
    expect(() => thumbnailStorageKey('../../etc', P, V)).toThrow('invalid id');
    expect(() => thumbnailStorageKey(W, 'x', V)).toThrow('invalid id');
    expect(() => thumbnailStorageKey(W, P, `${V}/..`)).toThrow('invalid id');
  });
});

describe('the one-time key', () => {
  it('is stored as its sha256 hex, never itself', () => {
    const token = 'A'.repeat(43);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toBe(hashToken('B'.repeat(43)));
  });
});

describe('the renderer routes’ helpers', () => {
  it('decodes a URL path back to a manifest path, one decode per segment, and refuses what does not decode', () => {
    expect(decodeDeckPath('deck%20one/a%25b.png')).toBe('deck one/a%b.png');
    expect(decodeDeckPath('index.html')).toBe('index.html');
    expect(decodeDeckPath('%ZZ')).toBeNull();
  });

  it('recognises a WebP by its RIFF/WEBP magic and nothing shorter', () => {
    const webp = Buffer.concat([
      Buffer.from('RIFF'),
      Buffer.alloc(4),
      Buffer.from('WEBPVP8 '),
      Buffer.alloc(4)
    ]);
    expect(isWebp(webp)).toBe(true);
    expect(isWebp(Buffer.from('RIFF....WEBP'))).toBe(false);
    expect(isWebp(Buffer.from('<html>not an image</html>'))).toBe(false);
    expect(isWebp(Buffer.from('\x89PNG\r\n\x1a\n' + '0'.repeat(20), 'latin1'))).toBe(false);
  });
});

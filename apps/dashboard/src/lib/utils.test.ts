import { describe, expect, it } from 'vitest';
import { safeHttpUrl, safeNext } from './utils';

describe('safeNext (open-redirect guard)', () => {
  it('allows a single-slash internal path', () => {
    expect(safeNext('/members')).toBe('/members');
    expect(safeNext('/oauth/consent?client_id=x')).toBe('/oauth/consent?client_id=x');
  });

  it('rejects protocol-relative and backslash tricks that leave the origin', () => {
    expect(safeNext('//evil.com')).toBe('/');
    expect(safeNext('/\\evil.com')).toBe('/');
    expect(safeNext('https://evil.com')).toBe('/');
    expect(safeNext('javascript:alert(1)')).toBe('/');
  });

  /**
   * DASH-1: the C0 characters the URL parser DELETES before parsing sail
   * straight past a `startsWith('//')` check, and the browser then navigates
   * to the stripped value — off-origin. `?next=/%09//evil.example/` decodes to
   * exactly the first case below.
   */
  it('rejects the C0-smuggled protocol-relative forms', () => {
    expect(safeNext('/\t//evil.example/')).toBe('/');
    expect(safeNext('/\n//evil.example/')).toBe('/');
    expect(safeNext('/\r//evil.example/')).toBe('/');
    expect(safeNext('/\u0000//evil.example/')).toBe('/');
    expect(safeNext('\t//evil.example/')).toBe('/');
    expect(safeNext('/\t/\\evil.example/')).toBe('/');
    expect(safeNext(' //evil.example/')).toBe('/');
    expect(safeNext('\thttps://evil.example/')).toBe('/');
    expect(safeNext('java\tscript:alert(1)')).toBe('/');
  });

  it('rejects anything that resolves off-origin however it is spelled', () => {
    expect(safeNext('/\\\\evil.example/')).toBe('/');
    expect(safeNext('///evil.example/')).toBe('/');
    expect(safeNext('/%2f/evil.example/')).not.toContain('//evil.example');
    expect(safeNext('\\/evil.example')).toBe('/');
  });

  /**
   * The case the RE-SERIALIZATION guard exists for, and the only one the two
   * prefix checks above cannot see. `safeNext` returns the PARSED path, not the
   * caller's string, and the URL parser resolves dot segments: `/a/..//evil`
   * normalizes to the pathname `//evil` — protocol-relative, off-origin the
   * moment it is handed to `goto()` or Better Auth's `callbackURL`. The input
   * starts with exactly one slash and contains no backslash, so layer 2 waves
   * it through; without the final `startsWith('//')` check on the SERIALIZED
   * result this fix would have introduced the very bug it closes.
   */
  it('rejects dot-segment paths that NORMALIZE into a protocol-relative URL', () => {
    expect(safeNext('/a/..//evil.example/')).toBe('/');
    expect(safeNext('/..//evil.example/')).toBe('/');
    expect(safeNext('/a/../..//evil.example/')).toBe('/');
    expect(safeNext('/.//evil.example/')).toBe('/');
    // Percent-encoded dot segments: the parser decodes them before resolving.
    expect(safeNext('/a/%2e%2e//evil.example/')).toBe('/');
    // A legitimate dot segment that stays a real path is still preserved.
    expect(safeNext('/a/../orgs')).toBe('/orgs');
  });

  it('is what the login sinks actually receive — the DECODED query value', () => {
    // Every sink reads `page.url.searchParams.get('next')`, which decodes
    // %09 to a raw tab before safeNext ever sees it.
    const url = new URL('https://app.example.com/login?next=/%09//evil.example/');
    expect(url.searchParams.get('next')).toBe('/\t//evil.example/');
    expect(safeNext(url.searchParams.get('next'))).toBe('/');
  });

  it('preserves a legitimate deep link with query and hash', () => {
    expect(safeNext('/oauth/consent?client_id=x&scope=a%20b#frag')).toBe(
      '/oauth/consent?client_id=x&scope=a%20b#frag'
    );
  });

  it('falls back to root on empty/relative input', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext(undefined)).toBe('/');
    expect(safeNext('')).toBe('/');
    expect(safeNext('members')).toBe('/');
  });
});

describe('safeHttpUrl (OAuth client-metadata gate)', () => {
  it('passes http and https URLs through unchanged', () => {
    expect(safeHttpUrl('http://example.com')).toBe('http://example.com');
    expect(safeHttpUrl('https://example.com/logo.png')).toBe('https://example.com/logo.png');
  });

  it('rejects script-bearing and non-http schemes', () => {
    expect(safeHttpUrl('javascript:alert(1)')).toBeNull();
    expect(safeHttpUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
    expect(safeHttpUrl('vbscript:msgbox(1)')).toBeNull();
    expect(safeHttpUrl('//evil.com')).toBeNull();
    expect(safeHttpUrl('not a url')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(safeHttpUrl(null)).toBeNull();
    expect(safeHttpUrl(undefined)).toBeNull();
    expect(safeHttpUrl('')).toBeNull();
  });
});

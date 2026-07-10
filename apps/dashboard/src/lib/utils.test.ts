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

import { describe, expect, it, vi } from 'vitest';
import { consumeDemoFragment, demoSignInOn, demoTarget, parseDemoFragment } from './demo-link';

describe('parseDemoFragment', () => {
  it('reads both keys', () => {
    expect(parseDemoFragment('#pass=abc123&to=/members')).toEqual({ pass: 'abc123', to: '/members' });
  });

  it('decodes an encoded path, its query included', () => {
    const hash = `#pass=abc123&to=${encodeURIComponent('/projects/p1?tab=files&x=a b')}`;
    expect(parseDemoFragment(hash)).toEqual({ pass: 'abc123', to: '/projects/p1?tab=files&x=a b' });
  });

  it('reads a fragment without `to`', () => {
    expect(parseDemoFragment('#pass=abc123')).toEqual({ pass: 'abc123', to: null });
  });

  it('reads an empty fragment, and empty values, as nothing', () => {
    expect(parseDemoFragment('')).toEqual({ pass: null, to: null });
    expect(parseDemoFragment('#')).toEqual({ pass: null, to: null });
    expect(parseDemoFragment('#pass=&to=')).toEqual({ pass: null, to: null });
  });

  it('keeps a nested `#` inside `to` as part of the value', () => {
    expect(parseDemoFragment('#pass=abc123&to=/members#top')).toEqual({ pass: 'abc123', to: '/members#top' });
    expect(parseDemoFragment(`#pass=abc123&to=${encodeURIComponent('/members#top')}`).to).toBe(
      '/members#top'
    );
  });

  it('reads a base64url secret unchanged', () => {
    const secret = 'Ab-_0123456789abcdefghijklmnopqrstuvwxyzABC';
    expect(parseDemoFragment(`#pass=${secret}&to=%2F`).pass).toBe(secret);
  });
});

describe('demoTarget', () => {
  it('lands on the link’s own page when it is safe', () => {
    expect(demoTarget('/members', '/')).toBe('/members');
    expect(demoTarget('/', '/members')).toBe('/');
  });

  it('keeps a decoded path with its query', () => {
    const { to } = parseDemoFragment(`#pass=x&to=${encodeURIComponent('/projects/p1?tab=files')}`);
    expect(demoTarget(to, '/')).toBe('/projects/p1?tab=files');
  });

  it('falls back to the pass’s page without `to`, and to `/` without either', () => {
    expect(demoTarget(null, '/members')).toBe('/members');
    expect(demoTarget(null, undefined)).toBe('/');
    expect(demoTarget(null, null)).toBe('/');
  });

  it('never leaves the origin, whatever `to` says', () => {
    for (const to of [
      '//evil.test',
      'https://evil.test',
      '/\\evil',
      '/\t//evil.test',
      'javascript:alert(1)'
    ]) {
      expect(demoTarget(to, '/members'), to).toBe('/members');
      expect(demoTarget(to, null), to).toBe('/');
    }
  });

  it('never leaves the origin through the answer’s path either', () => {
    expect(demoTarget(null, '//evil.test')).toBe('/');
    expect(demoTarget(null, 'https://evil.test')).toBe('/');
    expect(demoTarget('//evil.test', '/\\evil')).toBe('/');
  });

  it('keeps a nested `#` as the page’s own fragment, on this origin', () => {
    const { to } = parseDemoFragment('#pass=x&to=/members#top');
    expect(demoTarget(to, '/')).toBe('/members#top');
  });
});

describe('demoSignInOn (the banner of the app layout)', () => {
  it('is on only when the instance says true', () => {
    expect(demoSignInOn({ demoSignIn: true })).toBe(true);
  });

  it('is off when the key is absent or false', () => {
    expect(demoSignInOn({})).toBe(false);
    expect(demoSignInOn({ demoSignIn: false })).toBe(false);
  });
});

describe('consumeDemoFragment', () => {
  it('takes the fragment out of the address bar once, and returns what it read', () => {
    const replaceState = vi.fn();
    const result = consumeDemoFragment(
      { hash: '#pass=abc123&to=/members', pathname: '/demo' },
      { replaceState }
    );
    expect(replaceState).toHaveBeenCalledTimes(1);
    expect(replaceState).toHaveBeenCalledWith(null, '', '/demo');
    expect(result).toEqual({ pass: 'abc123', to: '/members' });
  });
});

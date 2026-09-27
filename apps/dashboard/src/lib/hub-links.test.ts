import { describe, expect, it } from 'vitest';
import { hubLink } from './hub-links';

describe('hubLink', () => {
  it('leaves the base untouched with no path and no return target', () => {
    expect(hubLink('https://account.example.test')).toBe('https://account.example.test');
  });

  it('joins a path with exactly one slash, with or without a trailing slash on the base', () => {
    expect(hubLink('https://account.example.test', 'no-access')).toBe(
      'https://account.example.test/no-access'
    );
    expect(hubLink('https://account.example.test/', '/no-access')).toBe(
      'https://account.example.test/no-access'
    );
  });

  it('encodes the return target once, as a query parameter', () => {
    expect(hubLink('https://account.example.test/', undefined, 'https://tool.example.test/members')).toBe(
      'https://account.example.test/?return_to=https%3A%2F%2Ftool.example.test%2Fmembers'
    );
    expect(hubLink('https://account.example.test', 'orgs', 'https://tool.example.test/a b')).toBe(
      'https://account.example.test/orgs?return_to=https%3A%2F%2Ftool.example.test%2Fa%20b'
    );
  });

  it('appends to an existing query string instead of starting a second one', () => {
    expect(
      hubLink(
        'https://account.example.test/no-access?client_id=tool-1',
        undefined,
        'https://tool.example.test/'
      )
    ).toBe(
      'https://account.example.test/no-access?client_id=tool-1&return_to=https%3A%2F%2Ftool.example.test%2F'
    );
  });
});

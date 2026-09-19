import { describe, expect, it } from 'vitest';
import { en, fr, t, type MessageKey } from './index';

/**
 * Catalog integrity. Key parity is already a compile-time guarantee
 * (fr: Record<MessageKey, string>), but an `as any` on the fr export would
 * silently void it — these assertions keep the guarantee honest at runtime.
 */

const catalogs = { en, fr } as const;

function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

describe('i18n catalogs', () => {
  it('en and fr have identical key sets', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
  });

  it('every key carries the same {placeholder} tokens in both locales', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(placeholders(fr[key]), `placeholder mismatch on "${key}"`).toEqual(placeholders(en[key]));
    }
  });

  it('no catalog contains an empty or whitespace-only string', () => {
    for (const [name, catalog] of Object.entries(catalogs)) {
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `${name}.${key} is empty`).not.toBe('');
      }
    }
  });
});

describe('t()', () => {
  it('interpolates {name} placeholders', () => {
    // Node test env has no localStorage/navigator.language → locale is 'en'.
    expect(t('invite.joinTitle', { workspace: 'Acme' })).toBe('Join Acme');
    expect(t('table.pageOf', { page: 2, count: 9 })).toBe('Page 2 of 9');
  });

  it('leaves unknown placeholders intact instead of printing "undefined"', () => {
    expect(t('invite.joinTitle', {})).toBe('Join {workspace}');
  });
});

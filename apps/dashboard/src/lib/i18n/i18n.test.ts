import { describe, expect, it } from 'vitest';
import { en, type MessageKey } from './en';
import { fr } from './fr';
import { t } from './index';

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

describe('the French typography rule, on the references section', () => {
  // fr.ts states it in its header: U+2019 apostrophes, U+00A0 before ? ! : ;
  // and inside guillemets. Older keys are not all clean, so the rule is
  // pinned on the keys the references section brought (PRDCT-2421) and on
  // every key added after it under these prefixes.
  const pinned = (Object.keys(fr) as MessageKey[]).filter(
    (k) =>
      k.startsWith('refs.') ||
      k === 'nav.brands' ||
      k === 'nav.templates' ||
      (k.startsWith('overview.') && /brand/i.test(k))
  );

  it('covers the references keys', () => {
    expect(pinned.length).toBeGreaterThan(50);
  });

  it('uses the typographic apostrophe, never the ASCII one', () => {
    for (const key of pinned) expect(fr[key], key).not.toContain("'");
  });

  it('puts a non-breaking space before ? ! : ; and inside guillemets', () => {
    for (const key of pinned) {
      const text = fr[key];
      expect(text, key).not.toMatch(/ [?!:;]/);
      expect(text, key).not.toMatch(/« |\S»/);
      // a verbatim frontmatter line (`type: Brand`) keeps its ASCII colon: only the French punctuation is checked
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

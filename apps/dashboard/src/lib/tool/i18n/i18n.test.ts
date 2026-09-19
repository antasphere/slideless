import { describe, expect, it } from 'vitest';
import { fr } from './fr';

describe('the French typography rule, on the references section', () => {
  // fr.ts states it in its header: U+2019 apostrophes, U+00A0 before ? ! : ;
  // and inside guillemets. Older keys are not all clean, so the rule is
  // pinned on the keys the references section brought (PRDCT-2421) and on
  // every key added after it under these prefixes.
  const pinned = (Object.keys(fr) as (keyof typeof fr)[]).filter(
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

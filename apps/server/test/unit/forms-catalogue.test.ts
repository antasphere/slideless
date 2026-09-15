import { describe, expect, it } from 'vitest';
import {
  FORMS_CATALOGUE,
  FORMS_LANGUAGES,
  FORMS_TEXT_KEYS,
  FORMS_TEXT_MAX,
  formsScriptTag
} from '../../src/viewer/forms-runtime.js';

/**
 * PRDCT-2344 — the confirmation dialog's language contract. The catalogue
 * is the closed set of strings a deck author can override
 * (`data-slideless-text-<key>`), one complete set per language; the runtime
 * falls back key by key to English, so a hole in a language would show as a
 * silent language switch inside an otherwise translated dialog, which is
 * precisely the failure this task removes.
 */
describe('forms runtime: the language catalogue', () => {
  it('every language carries every key and nothing else', () => {
    const keys = [...FORMS_TEXT_KEYS].sort();
    for (const lang of FORMS_LANGUAGES) {
      expect(Object.keys(FORMS_CATALOGUE[lang]).sort(), lang).toEqual(keys);
    }
    expect(Object.keys(FORMS_CATALOGUE).sort()).toEqual([...FORMS_LANGUAGES].sort());
  });

  it('every string is non-empty text: no markup, no control character, within the cap', () => {
    for (const lang of FORMS_LANGUAGES) {
      for (const key of FORMS_TEXT_KEYS) {
        const v = FORMS_CATALOGUE[lang][key];
        expect(v.trim().length, `${lang}.${key}`).toBeGreaterThan(0);
        expect(v.length, `${lang}.${key}`).toBeLessThanOrEqual(FORMS_TEXT_MAX);
        expect(v, `${lang}.${key}`).not.toMatch(/[<>]/);
        // eslint-disable-next-line no-control-regex
        expect(v, `${lang}.${key}`).not.toMatch(/[\x00-\x1f\x7f]/);
      }
    }
  });

  it('{date} is the one placeholder, and only the resume title carries it', () => {
    for (const lang of FORMS_LANGUAGES) {
      for (const key of FORMS_TEXT_KEYS) {
        const holes = FORMS_CATALOGUE[lang][key].match(/\{\w+\}/g) ?? [];
        if (key === 'resumeTitle') expect(holes, `${lang}.${key}`).toEqual(['{date}']);
        else expect(holes, `${lang}.${key}`).toEqual([]);
      }
    }
  });

  it('the injected script carries the whole catalogue and closes exactly once', () => {
    const tag = formsScriptTag({
      version: 1,
      unlock: null,
      source: 'link',
      placement: null,
      emailAvailable: false,
      remembers: false
    });
    expect(tag).toContain('var CATALOGUE=');
    expect(tag).toContain(`var TEXT_MAX=${FORMS_TEXT_MAX};`);
    for (const lang of FORMS_LANGUAGES) expect(tag).toContain(JSON.stringify(FORMS_CATALOGUE[lang].success));
    // One opening, one closing: nothing in the serialized data can end the
    // script early (the `<` escape is what guarantees it for any future string).
    expect(tag.match(/<\/script/gi)).toHaveLength(1);
    expect(tag.match(/<script /g)).toHaveLength(1);
  });
});

import { describe, expect, it } from 'vitest';
import { buildEmbedSnippets } from '@slideless/contract';
import { tint } from './tint';

const joined = (code: string, language: 'html' | 'shell' | 'text') =>
  tint(code, language)
    .map((p) => p.text)
    .join('');

describe('code tinting never changes the code', () => {
  const snippets = buildEmbedSnippets({
    viewerUrl: `https://view.example.com/v/${'a'.repeat(64)}/`,
    appOrigin: 'https://app.example.com'
  });

  it('gives back the embed snippets byte for byte', () => {
    expect(joined(snippets.script, 'html')).toBe(snippets.script);
    expect(joined(snippets.iframe, 'html')).toBe(snippets.iframe);
  });

  it('survives what is not well formed', () => {
    for (const code of ['<', '<<a b="c', 'a < b > c', "<div data-x='1' hidden/>text</div", '', '"<>"']) {
      expect(joined(code, 'html')).toBe(code);
    }
  });

  it('names the pieces of a tag', () => {
    expect(tint('<a href="x">hi</a>', 'html')).toEqual([
      { kind: 'punct', text: '<' },
      { kind: 'tag', text: 'a' },
      { kind: 'plain', text: ' ' },
      { kind: 'attr', text: 'href' },
      { kind: 'punct', text: '=' },
      { kind: 'value', text: '"x"' },
      { kind: 'punct', text: '>' },
      { kind: 'plain', text: 'hi' },
      { kind: 'punct', text: '</' },
      { kind: 'tag', text: 'a' },
      { kind: 'punct', text: '>' }
    ]);
  });

  it('tints a command: the binary, then its flags', () => {
    const code = 'slideless login --api-url https://x --api-key slk_…\nslideless push ./deck';
    expect(joined(code, 'shell')).toBe(code);
    const kinds = tint('slideless push --force ./deck', 'shell').filter((p) => p.kind !== 'plain');
    expect(kinds).toEqual([
      { kind: 'tag', text: 'slideless' },
      { kind: 'flag', text: '--force' }
    ]);
  });
});

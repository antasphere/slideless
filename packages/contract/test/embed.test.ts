import { describe, expect, it } from 'vitest';
import { buildEmbedSnippets, EMBED_PLACEMENT_RE, VIEWER_IFRAME_SANDBOX } from '../src/index.js';

/**
 * The shared embed-snippet builder (PRDCT-1312) — the single source behind
 * the dashboard dialog and the CLI's `share --embed`. These tests pin the
 * Surface D attrs, the placement injection surface, and the URL forms.
 */

const URL_ = 'https://view.example.com/v/abc123/';
const ORIGIN = 'https://slides.example.com';

describe('buildEmbedSnippets', () => {
  it('emits the script+div and iframe forms with the exact Surface D attrs', () => {
    const s = buildEmbedSnippets({ viewerUrl: URL_, appOrigin: ORIGIN });
    expect(s.embedJsUrl).toBe('https://slides.example.com/embed.js');
    expect(s.script).toBe(
      `<script src="https://slides.example.com/embed.js" async></script>\n` +
        `<div data-slideless-embed="${URL_}"></div>`
    );
    expect(s.iframe).toContain(`src="${URL_}"`);
    expect(s.iframe).toContain(`sandbox="${VIEWER_IFRAME_SANDBOX}"`);
    expect(s.iframe).toContain('referrerpolicy="no-referrer"');
    // The tripwires: these tokens must never appear (ADR 012).
    expect(s.iframe).not.toContain('allow-same-origin');
    expect(s.iframe).not.toContain('allow-top-navigation');
  });

  it('bakes a placement label into both forms (data attribute / ?p=)', () => {
    const s = buildEmbedSnippets({ viewerUrl: URL_, appOrigin: ORIGIN, placement: 'pricing-footer' });
    expect(s.script).toContain('data-slideless-placement="pricing-footer"');
    expect(s.iframe).toContain(`src="${URL_}?p=pricing-footer"`);
  });

  it('appends with & when the viewer URL already carries a query', () => {
    const s = buildEmbedSnippets({ viewerUrl: `${URL_}?x=1`, appOrigin: ORIGIN, placement: 'a' });
    expect(s.iframe).toContain(`src="${URL_}?x=1&p=a"`);
  });

  it('REFUSES an invalid placement label (it lands inside HTML attributes)', () => {
    for (const bad of ['a b', 'x"onmouseover=1', 'é', 'x'.repeat(65), '']) {
      expect(() => buildEmbedSnippets({ viewerUrl: URL_, appOrigin: ORIGIN, placement: bad })).toThrow(
        /invalid placement/
      );
    }
  });

  it('trims trailing slashes off the app origin', () => {
    const s = buildEmbedSnippets({ viewerUrl: URL_, appOrigin: 'https://x.example.com/' });
    expect(s.embedJsUrl).toBe('https://x.example.com/embed.js');
  });

  it('EMBED_PLACEMENT_RE matches the documented slug shape', () => {
    expect(EMBED_PLACEMENT_RE.test('news.letter_v2-b')).toBe(true);
    expect(EMBED_PLACEMENT_RE.test('x'.repeat(64))).toBe(true);
    expect(EMBED_PLACEMENT_RE.test('x'.repeat(65))).toBe(false);
    expect(EMBED_PLACEMENT_RE.test('a/b')).toBe(false);
  });
});

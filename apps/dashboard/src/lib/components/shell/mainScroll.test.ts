import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ afterNavigate: () => {}, beforeNavigate: () => {} }));

const { scrollAfter, scrollKey } = await import('./mainScroll');

const u = (path: string) => new URL(path, 'https://tool.example');

describe('scrollAfter: the shell scroll on a navigation', () => {
  const saved = new Map([[scrollKey(u('/items?sort=name')), 640]]);

  it('opens a new page at its top', () => {
    expect(scrollAfter({ type: 'link', from: u('/items'), to: u('/settings') }, saved)).toEqual({
      kind: 'top',
      to: 0
    });
    expect(scrollAfter({ type: 'goto', from: u('/items'), to: u('/projects/1') }, saved)).toEqual({
      kind: 'top',
      to: 0
    });
  });

  it('lands back where the page was left on back and forward, the top when it was never left', () => {
    expect(scrollAfter({ type: 'popstate', from: u('/settings'), to: u('/items?sort=name') }, saved)).toEqual(
      {
        kind: 'top',
        to: 640
      }
    );
    expect(scrollAfter({ type: 'popstate', from: u('/settings'), to: u('/items') }, saved)).toEqual({
      kind: 'top',
      to: 0
    });
  });

  it('keeps the position on the first load and on a change of the query alone', () => {
    expect(scrollAfter({ type: 'enter', from: null, to: u('/items') }, saved)).toEqual({ kind: 'keep' });
    expect(scrollAfter({ type: 'goto', from: u('/items'), to: u('/items?sort=date') }, saved)).toEqual({
      kind: 'keep'
    });
  });

  it('goes to the anchor a new page is opened at', () => {
    expect(scrollAfter({ type: 'link', from: u('/items'), to: u('/settings#api%20keys') }, saved)).toEqual({
      kind: 'anchor',
      id: 'api keys'
    });
  });
});

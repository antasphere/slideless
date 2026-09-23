import { describe, expect, it } from 'vitest';
import { overlayScriptTag } from '../../src/viewer/overlay.js';

/**
 * PRDCT-2671: while the composer is open, a click on the deck closes it and
 * places nothing; the typed draft comes back in the next composer. The
 * behaviour runs in the browser (apps/dashboard/e2e/viewer-annotations.spec.ts
 * drives it); this file is the cheap tripwire on the injected source, in the
 * mould of viewer-overlay-picker.test.ts: the guard exists, it returns before
 * a drag starts, and the draft travels through both closing paths.
 */

const tag = overlayScriptTag({
  version: 1,
  unlock: null,
  entry: 'index.html',
  badge: null,
  linkCreatedAt: '2026-09-01T10:00:00Z',
  linkExpiresAt: null
});

describe('a click beside the open composer closes it instead of placing a note', () => {
  it('the layer pointerdown returns before a drag starts when the composer is open', () => {
    const handler = tag.slice(tag.indexOf("layer.addEventListener('pointerdown'"));
    const guard = handler.indexOf("if (pop.style.display === 'block') {");
    const drag = handler.indexOf('dragStart = { x: e.clientX, y: e.clientY };');
    expect(guard).toBeGreaterThan(-1);
    expect(drag).toBeGreaterThan(guard);
    const body = handler.slice(guard, drag);
    expect(body).toContain('keptDraft = popText.value;');
    expect(body).toContain('closeComposer();');
    expect(body).toContain('e.preventDefault();');
    expect(body).toContain('return;');
  });

  it('a click on the deck in browse mode keeps the draft too, and the next composer restores it', () => {
    expect(tag).toContain(
      "if (pop.style.display === 'block') { keptDraft = popText.value; closeComposer(); }"
    );
    const open = tag.slice(tag.indexOf('function openComposer()'), tag.indexOf('function closeComposer()'));
    expect(open).toContain('popText.value = keptDraft;');
    expect(open).toContain("keptDraft = '';");
  });
});

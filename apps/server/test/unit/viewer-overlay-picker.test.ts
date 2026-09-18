import { describe, expect, it } from 'vitest';
import { OVERLAY_MARKER, overlayScriptTag } from '../../src/viewer/overlay.js';

/**
 * The annotation overlay's picker: the one highlight box that travels to
 * the element under the pointer while a pin is being placed. The behaviour
 * runs in the browser (apps/dashboard/e2e/viewer-annotations.spec.ts drives
 * annotate mode end to end); this file is the cheap tripwire on the injected
 * source, in the mould of viewer-topbar.test.ts: the box exists, it is the
 * calm blue and never the amber accent, it hides exactly when the old
 * capture did, and a reader who asked for no motion gets none.
 */

const tag = overlayScriptTag({
  version: 1,
  unlock: null,
  entry: 'index.html',
  badge: null,
  linkCreatedAt: '2026-09-01T10:00:00Z',
  linkExpiresAt: null
});

/** The stylesheet block of the injected script (the `var css = [...]` array). */
const css = (): string => {
  const m = /var css = \[([\s\S]*?)\]\.join\('\\n'\);/.exec(tag);
  if (!m) throw new Error('no stylesheet in the overlay source');
  return m[1]!;
};

/** One CSS rule's declarations by its selector prefix. */
const rule = (selector: string): string => {
  const block = css();
  const at = block.indexOf(`'${selector}{`);
  if (at === -1) throw new Error(`no rule for ${selector}`);
  return block.slice(at, block.indexOf('}', at));
};

describe('the pin picker frames the element under the pointer with one travelling box', () => {
  it('is still the marked, top-only, cookie-less inline script', () => {
    expect(tag).toContain(`<script ${OVERLAY_MARKER}>`);
    expect(tag).toContain('if (window.self !== window.top) return;');
    expect(tag).toContain("credentials: 'omit'");
    expect(tag).not.toContain('document.cookie');
    expect(tag).not.toContain('localStorage');
  });

  it('mounts one box with its label chip, inside the overlay root, above the capture layer', () => {
    expect(tag).toContain("hl.id = '__sl-hl';");
    expect(tag).toContain("hlTag.id = '__sl-hl-tag';");
    expect(tag).toContain('hl.appendChild(hlTag);');
    // Mounted right after the capture layer: over the deck, under the drag
    // rectangle, the composer and the banner.
    expect(tag).toContain('root.appendChild(layer);\n  root.appendChild(hl);\n  root.appendChild(dragBox);');
    expect(rule('#__sl-hl')).toContain('position:fixed');
    expect(rule('#__sl-hl')).toContain('pointer-events:none');
  });

  it('is the selection blue, translucent, with a soft glow, and nothing amber', () => {
    const tokens = css();
    expect(tokens).toContain("'#__slideless_annotate{--sl-pick:#4a78b0;");
    expect(tokens).toContain('--sl-pick-fill:rgba(71,121,154,.10)');
    expect(tokens).toContain('--sl-pick-glow:0 0 0 4px rgba(71,121,154,.14)');
    const box = rule('#__sl-hl');
    expect(box).toContain('border:1.5px solid var(--sl-pick)');
    expect(box).toContain('background:var(--sl-pick-fill)');
    expect(box).toContain('box-shadow:var(--sl-pick-glow)');
    expect(box).not.toContain('--sl-accent');
    // The drag rectangle and the post-click contour are the picker's other
    // two surfaces; they took the same blue.
    expect(rule('#__sl-drag')).toContain('var(--sl-pick)');
    expect(rule('#__sl-drag')).not.toContain('245,179,1');
    expect(rule('.__sl-target')).toContain('var(--sl-pick)');
    expect(rule('.__sl-target')).not.toContain('dashed');
  });

  it('animates transform and size on the product motion curve, and jumps under reduced motion', () => {
    const box = rule('#__sl-hl');
    expect(box).toMatch(
      /transition:transform \.18s cubic-bezier\(\.2,0,0,1\),width \.18s cubic-bezier\(\.2,0,0,1\)/
    );
    expect(box).toContain('height .18s cubic-bezier(.2,0,0,1)');
    expect(tag).toContain("'@media (prefers-reduced-motion: reduce){#__sl-hl{transition:none;}}'");
    // A fresh show never slides in from the last spot.
    expect(tag).toContain("'#__sl-hl.__sl-hl-jump{transition:none;}'");
    expect(tag).toContain("if (fresh) hl.classList.add('__sl-hl-jump');");
  });

  it('resolves its target through the same hit-test the pin uses, frame-throttled, re-fit on scroll and resize', () => {
    expect(tag).toContain('var target = deckElementAt(hlPoint.x, hlPoint.y);');
    expect(tag).toContain('requestAnimationFrame(function () {\n    hlQueued = false;\n    fitHighlight();');
    expect(tag).toContain(
      "window.addEventListener('scroll', function () { if (hlPoint) queueHighlight(); }, true);"
    );
    expect(tag).toContain(
      "window.addEventListener('resize', function () { if (hlPoint) queueHighlight(); });"
    );
    expect(tag).toContain('new ResizeObserver(function () { queueHighlight(); })');
    expect(tag).toContain('var HL_PAD = 4;');
    expect(tag).toContain(
      "hl.style.borderRadius = Math.max(4, Math.min(12, radius > 0 ? radius + HL_PAD : 0)) + 'px';"
    );
  });

  it('never frames the document itself or an overlay surface', () => {
    expect(tag).toContain('if (!node || node === doc.body || node === doc.documentElement) return false;');
    expect(tag).toContain("if (root.contains(node) || node.id === '__slideless_topbar') return false;");
  });

  it('hides when the mode ends, on a press, when the pointer leaves, and while the composer is open', () => {
    expect(tag).toContain('else hideHighlight();');
    expect(tag).toContain("layer.addEventListener('pointerdown', hideHighlight);");
    expect(tag).toContain("layer.addEventListener('pointerleave', hideHighlight);");
    expect(tag).toContain(
      "if (mode !== 'annotate' || !hlPoint || dragStart || pop.style.display === 'block') {"
    );
    expect(tag).toContain("hl.classList.remove('on');");
  });

  it('labels the element with its own text as text, never as markup', () => {
    expect(tag).toContain('hlTag.textContent = describeElement(target);');
    expect(tag).not.toContain('hlTag.innerHTML');
    expect(tag).toContain("words = node.getAttribute('aria-label') || '';");
    expect(tag).toContain("if (!words && tag === 'img') words = node.getAttribute('alt') || '';");
    expect(tag).toContain('var room = 28 - tag.length - 3;');
  });

  it('adds no request: the overlay still calls only the annotations list, create and the badge', () => {
    // Three fetches were there before the picker; the picker adds none.
    expect(tag.match(/fetchFn\(/g)).toHaveLength(3);
    expect(tag).not.toMatch(/https?:\/\//);
  });
});

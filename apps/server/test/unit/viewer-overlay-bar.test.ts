import { describe, expect, it } from 'vitest';
import { MOTION_DURATION_MS, MOTION_EASING } from '@slideless/contract';
import { overlayScriptTag } from '../../src/viewer/overlay.js';

/**
 * The annotation overlay after the rebrand round: its two entrances live in
 * the recipient bar when one is mounted (viewer/topbar.ts hosts them under
 * the overlay's own ids), the floating fallback exists only without a bar,
 * the two runtimes talk through two document events and nothing else, and
 * the panel wears the dashboard's material. The behaviour runs in the
 * browser suite (apps/dashboard/e2e/viewer-annotations.spec.ts and
 * viewer-topbar.spec.ts); this file is the cheap tripwire on the injected
 * source, in the mould of viewer-topbar.test.ts.
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

describe('the overlay hands its entrances to the bar and keeps a floating fallback', () => {
  it('mounts the floating buttons only when no bar host is in the document', () => {
    expect(tag).toContain(
      "if (doc.getElementById('__slideless_topbar')) hostByBar();\n  else { root.appendChild(badge); root.appendChild(fabPin); }"
    );
    // A bar that mounts later says so with a state query; the fallback leaves
    // and the position section of the settings goes with it.
    expect(tag).toContain("else if (action === 'state') { hostByBar(); announce(); }");
    expect(tag).toContain("root.classList.add('__sl-hosted');");
    expect(tag).toContain('if (badge.parentNode) badge.parentNode.removeChild(badge);');
    expect(css()).toContain("'#__slideless_annotate.__sl-hosted .__sl-pos{display:none;}'");
    // The fallback keeps the ids the browser suite has always used.
    expect(tag).toContain("badge.id = '__sl-badge';");
    expect(tag).toContain("fabPin.id = '__sl-fab-pin';");
  });

  it('speaks to the bar through two document events, and announces on every change', () => {
    expect(tag).toContain("var STATE_EVENT = 'slideless:annotations-state';");
    expect(tag).toContain("var ACTION_EVENT = 'slideless:annotations';");
    expect(tag).toContain(
      "detail: { count: notes.length, open: openCount(), panel: sheet.classList.contains('open'), mode: mode }"
    );
    expect(tag).toContain("if (action === 'panel') toggleSheet();");
    expect(tag).toContain("else if (action === 'pin') setMode(mode === 'annotate' ? 'browse' : 'annotate');");
    // Announced from the three places the state moves: the panel, the mode, the list.
    expect(tag).toContain(
      "sheet.classList.toggle('open', willOpen);\n  badge.classList.toggle('__sl-open', willOpen);\n  announce();"
    );
    expect(tag).toContain('  syncFabTransform();\n  renderPins();\n  announce();\n}');
    expect(tag).toContain("tabDone._count.textContent = '(' + (notes.length - open) + ')';\n  announce();");
  });

  it('adds no request: still the annotations list, create and the badge, cookie-less', () => {
    expect(tag.match(/fetchFn\(/g)).toHaveLength(3);
    expect(tag).toContain("credentials: 'omit'");
    expect(tag).not.toMatch(/https?:\/\//);
    expect(tag).not.toContain('document.cookie');
  });

  it('wears the dashboard material: the Slideless tokens light and dark, the one motion, no amber', () => {
    const sheet = css();
    expect(sheet).toContain(
      '--sl-ink:#1c1915;--sl-ink-soft:#35302a;--sl-muted:#6e6759;--sl-hairline:#e0daca;'
    );
    expect(sheet).toContain('--sl-accent:#7a6652;--sl-accent-ink:#f7f4ec;');
    expect(sheet).toContain("'@media (prefers-color-scheme: dark){#__slideless_annotate{");
    expect(sheet).toContain('--sl-accent:#db7d5f;--sl-accent-ink:#2a1d15;');
    expect(sheet).toContain(`--sl-motion:${MOTION_DURATION_MS}ms ${MOTION_EASING};`);
    expect(sheet).toContain(
      "'@media (prefers-reduced-motion: reduce){#__slideless_annotate{--sl-motion:0s linear;}}'"
    );
    expect(sheet).not.toContain('#f5b301');
    expect(sheet).not.toContain('245,179,1');
    // The panel: float material, 14px corners, the lg shadow, a slide with a
    // fade, out of the accessibility tree once closed; a bottom sheet on a phone.
    expect(sheet).toContain(
      "'#__sl-sheet{position:fixed;top:calc(10px + var(--slideless-topbar,0px));right:10px;bottom:10px;width:360px;'"
    );
    expect(sheet).toContain(
      'border:1px solid var(--sl-hairline);border-radius:14px;box-shadow:var(--sl-shadow-lg);'
    );
    expect(sheet).toContain('visibility:hidden;opacity:0;transform:translateX(12px);');
    expect(sheet).toContain(`visibility 0s linear ${MOTION_DURATION_MS}ms;}`);
    expect(sheet).toContain(
      "'@media (max-width:640px){#__sl-sheet{top:auto;left:0;right:0;bottom:0;width:auto;max-width:none;max-height:72vh;'"
    );
    // The title in the display serif, the one action in ink, the others outline.
    expect(sheet).toContain('#__sl-sheet .__sl-head strong{flex:1;font:400 19px/1.2 var(--sl-display);');
    expect(sheet).toContain("'.__sl-btn-primary{background:var(--sl-ink);color:var(--sl-ground);'");
    expect(sheet).toContain(
      "'.__sl-btn-outline{background:var(--sl-plate-strong);color:var(--sl-ink);border:1px solid var(--sl-hairline);}'"
    );
    expect(tag).toContain("var popCancel = el('button', '__sl-btn __sl-btn-outline', 'Cancel');");
    expect(tag).toContain("var modeBtn = el('button', '__sl-btn __sl-btn-primary');");
    // The pin: a ringed dot in the accent, the mono face, one pulse when placed.
    expect(sheet).toContain(
      'border:2px solid var(--sl-paper);box-shadow:0 0 0 1.5px var(--sl-accent),var(--sl-shadow-md);'
    );
    expect(sheet).toContain("'.__sl-pin.__sl-placed{animation:__sl-placed .9s cubic-bezier(0.2,0,0,1) 1;}'");
    expect(tag).toContain(
      "if (placedId && p.note.id === placedId) { pin.classList.add('__sl-placed'); placedId = null; }"
    );
  });

  it('keeps the status word the API sends inside the meta line, as a tag', () => {
    expect(tag).toContain(
      "if (a.status === 'resolved') meta.appendChild(el('span', '__sl-tag __sl-tag-ok', 'resolved'));"
    );
    expect(css()).toContain('text-transform:capitalize;');
  });
});

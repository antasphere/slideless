import { describe, expect, it } from 'vitest';
import { entryInjectionFor, type EntryTransformContext } from '../../src/viewer/inject.js';
import { OVERLAY_MARKER } from '../../src/viewer/overlay.js';
import {
  TOPBAR_HEIGHT_PX,
  TOPBAR_MARKER,
  TOPBAR_OFFSET_PROPERTY,
  topbarScriptTag
} from '../../src/viewer/topbar.js';

/**
 * The recipient top bar's injector decision (PRDCT-2281), without a
 * database: which navigations get the bar, which never do, and the guards
 * the runtime source must keep. The behavioural half runs in the browser
 * suite (apps/dashboard/e2e/viewer-topbar.spec.ts) and against the booted
 * app (test/integration/viewer-topbar.test.ts); this file is the cheap
 * tripwire that goes red in `pnpm turbo test` when a guard is removed.
 */

function ctx(over: Partial<EntryTransformContext> = {}): EntryTransformContext {
  return {
    token: {
      id: 'tok',
      purpose: 'share',
      canAnnotate: false,
      canSubmitForms: true,
      canDownload: true,
      showBar: true,
      remembersResponses: false,
      createdAt: new Date('2026-09-13T10:00:00Z'),
      expiresAt: null
    },
    rawRequested: false,
    browserEntry: true,
    frameEntry: false,
    version: 3,
    entryPath: 'index.html',
    deckTitle: 'Quarterly review',
    versionHasDownloads: true,
    badgePosition: null,
    placement: null,
    versionHasForms: false,
    emailAvailable: false,
    mintUnlockProof: () => null,
    ...over
  };
}

const configOf = (body: string): Record<string, unknown> => {
  const m = /<script data-slideless-topbar>[\s\S]*?var CFG=(\{[^\n]*?\});/.exec(body);
  if (!m) throw new Error('no topbar config in the plan');
  return JSON.parse(m[1]!) as Record<string, unknown>;
};

describe('the recipient bar rides top-level document navigations of show_bar links', () => {
  it('a default link on a browser navigation gets the bar, and nothing else', () => {
    const plan = entryInjectionFor(ctx());
    expect(plan).not.toBeNull();
    expect(plan!.head).toBe('');
    expect(plan!.body).toContain(TOPBAR_MARKER);
    expect(plan!.body).not.toContain(OVERLAY_MARKER);
    expect(configOf(plan!.body)).toEqual({
      title: 'Quarterly review',
      version: 3,
      unlock: null,
      downloads: true
    });
  });

  it('show_bar off = a bare deck: the plan is null and the blob streams byte-exact', () => {
    expect(entryInjectionFor(ctx({ token: { ...ctx().token, showBar: false } }))).toBeNull();
  });

  it('a frame navigation never gets the bar (embeds and iframes stay bare)', () => {
    expect(entryInjectionFor(ctx({ browserEntry: false, frameEntry: true }))).toBeNull();
    // Even with a form on the version: the forms runtime rides the frame,
    // the bar does not.
    const framedForms = entryInjectionFor(
      ctx({ browserEntry: false, frameEntry: true, versionHasForms: true })
    );
    expect(framedForms).not.toBeNull();
    expect(framedForms!.body).not.toContain(TOPBAR_MARKER);
  });

  it('?raw and non-navigation fetches stay byte-exact', () => {
    expect(entryInjectionFor(ctx({ rawRequested: true }))).toBeNull();
    expect(entryInjectionFor(ctx({ browserEntry: false }))).toBeNull();
  });

  it('the bar precedes the overlay in the plan so its root offset is set first', () => {
    const plan = entryInjectionFor(ctx({ token: { ...ctx().token, canAnnotate: true } }));
    expect(plan).not.toBeNull();
    expect(plan!.body.indexOf(TOPBAR_MARKER)).toBeGreaterThanOrEqual(0);
    expect(plan!.body.indexOf(TOPBAR_MARKER)).toBeLessThan(plan!.body.indexOf(OVERLAY_MARKER));
  });

  it('the download hint is the AND of the link switch and the version having files', () => {
    expect(configOf(entryInjectionFor(ctx({ versionHasDownloads: false }))!.body)['downloads']).toBe(false);
    expect(
      configOf(entryInjectionFor(ctx({ token: { ...ctx().token, canDownload: false } }))!.body)['downloads']
    ).toBe(false);
    expect(configOf(entryInjectionFor(ctx())!.body)['downloads']).toBe(true);
  });

  it('carries the unlock proof of a password link, minted once', () => {
    let mints = 0;
    const plan = entryInjectionFor(
      ctx({
        mintUnlockProof: () => {
          mints++;
          return 'proof-value';
        }
      })
    );
    expect(configOf(plan!.body)['unlock']).toBe('proof-value');
    expect(mints).toBe(1);
  });
});

describe('the injected script keeps its guards (mutation tripwires)', () => {
  const tag = topbarScriptTag({ title: 'T', version: 1, unlock: null, downloads: false });

  it('escapes `<` in the config so a deck title can never close the script tag', () => {
    const hostile = topbarScriptTag({
      title: '</script><script>alert(1)</script>',
      version: 1,
      unlock: null,
      downloads: false
    });
    expect(hostile).not.toContain('</script><script>alert');
    expect(hostile).toContain('\\u003c/script>\\u003cscript>alert(1)');
    // Exactly one script element: the marker opens it, one close tag ends it.
    expect(hostile.match(/<\/script>/g)).toHaveLength(1);
  });

  it('mounts in the top browsing context only', () => {
    expect(tag).toContain('if (window.self !== window.top) return;');
  });

  it('calls the attachments list cookie-less, relative to the deck page', () => {
    expect(tag).toContain("credentials: 'omit'");
    expect(tag).toContain("new URL('/api/v1/viewer/' + rawSecret + '/attachments', location.href)");
    // The only fetch the runtime makes.
    expect(tag.match(/fetchFn\(/g)).toHaveLength(1);
  });

  it('mounts in a shadow root and publishes its height on the root for the overlay', () => {
    expect(tag).toContain("host.attachShadow({ mode: 'open' })");
    expect(tag).toContain(`var OFFSET_PROP = '${TOPBAR_OFFSET_PROPERTY}';`);
    expect(tag).toContain(`var BAR = ${TOPBAR_HEIGHT_PX};`);
  });

  it('never mounts twice and never reaches for a cookie or a session', () => {
    expect(tag).toContain('if (window.__slidelessTopbarLoaded) return;');
    expect(tag).not.toContain('document.cookie');
    expect(tag).not.toContain('localStorage');
    expect(tag).not.toMatch(/https?:\/\//);
  });

  it('is one IIFE under a try so a runtime error never reaches the deck', () => {
    expect(tag.startsWith(`\n<script ${TOPBAR_MARKER}>\n(function(){\n"use strict";\ntry{`)).toBe(true);
    expect(tag.trimEnd().endsWith('}catch(e){}\n})();\n</script>')).toBe(true);
  });
});

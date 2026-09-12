import { describe, expect, it } from 'vitest';
import { VIEWER_IFRAME_SANDBOX } from '@slideless/contract';
import { VIEWER_CONTENT_HEADERS, VIEWER_CSP } from '../../src/viewer/routes.js';

/**
 * The served viewer header and the contract's iframe attribute are ONE
 * token list in two shapes (ADR 012; PRDCT-2268 added
 * allow-popups-to-escape-sandbox to both at once). The header is what a
 * top-level share link inherits, and until this pin it was asserted only by
 * the Docker integration suite — the non-Docker gate stayed green with the
 * token stripped from the served header (verifier round 1, mutation 8).
 * This file is the cheap tripwire: drift between the two lists, or either
 * fatal token, goes red in `pnpm turbo test`.
 */
describe('viewer CSP sandbox is the contract iframe list in header form', () => {
  it('VIEWER_CSP is exactly `sandbox ` + VIEWER_IFRAME_SANDBOX', () => {
    expect(VIEWER_CSP).toBe(`sandbox ${VIEWER_IFRAME_SANDBOX}`);
  });

  it('every viewer content response carries that header verbatim', () => {
    expect(VIEWER_CONTENT_HEADERS['content-security-policy']).toBe(VIEWER_CSP);
  });

  it('lets windows the deck opens escape, never the deck itself (PRDCT-2268, ADR 012)', () => {
    expect(VIEWER_CSP).toContain('allow-popups-to-escape-sandbox');
    expect(VIEWER_CSP).not.toContain('allow-same-origin');
    expect(VIEWER_CSP).not.toContain('allow-top-navigation');
  });
});

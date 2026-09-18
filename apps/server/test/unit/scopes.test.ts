import { describe, expect, it } from 'vitest';
import { requiredScopeFor } from '../../src/middleware/scopes.js';

/**
 * The fail-closed machine allowlist, pinned where PRDCT-2278 leans on it:
 * the owner-side attachment routes are OPEN to read keys through the
 * /presentations prefix (consciously), and the recipient side under
 * /viewer/* stays UNLISTED — a machine credential presented there dies at
 * the gate, the share secret being the only credential that surface takes.
 */
const DECK = '/api/v1/presentations/11111111-2222-3333-4444-555555555555';

describe('requiredScopeFor — attachments', () => {
  it('opens the owner-side attachment reads under presentations:read', () => {
    expect(requiredScopeFor(`${DECK}/versions/3/downloads.zip`, 'GET')).toBe('presentations:read');
    expect(requiredScopeFor(`${DECK}/versions/3/downloads/figures.csv`, 'GET')).toBe('presentations:read');
    expect(requiredScopeFor(`${DECK}/versions/3/downloads/sub%2Fnotes.md`, 'HEAD')).toBe(
      'presentations:read'
    );
  });

  it('keeps the recipient-side attachments list unlisted (fail-closed for keys and tokens)', () => {
    expect(requiredScopeFor('/api/v1/viewer/abcdefghijklmnopqrstuvwxyz/attachments', 'GET')).toBeNull();
  });

  it('never opens a write on the attachment paths without a conscious listing', () => {
    // A mutation on the read-only attachment paths falls under the generic
    // /presentations mutation rule (presentations:write), exactly like every
    // other unlisted-by-name /presentations path — no read key can reach it.
    expect(requiredScopeFor(`${DECK}/versions/3/downloads.zip`, 'DELETE')).toBe('presentations:write');
  });
});

describe('requiredScopeFor — duplicate (PRDCT-2279)', () => {
  it('opens the duplicate under presentations:write and never to a read key', () => {
    expect(requiredScopeFor(`${DECK}/duplicate`, 'POST')).toBe('presentations:write');
    expect(requiredScopeFor(`${DECK}/duplicate`, 'GET')).toBe('presentations:read');
  });
});

describe('requiredScopeFor — workspace creation (PRDCT-2444 / PRDCT-2443)', () => {
  it('stays UNLISTED for every method and every neighbouring spelling: sessions only', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE', 'HEAD']) {
      expect(requiredScopeFor('/api/v1/workspaces', method)).toBeNull();
      expect(requiredScopeFor('/api/v1/workspaces/', method)).toBeNull();
      expect(requiredScopeFor('/api/v1/workspaces/11111111-2222-3333-4444-555555555555', method)).toBeNull();
    }
    // The export keeps its own singular path and its own scope — the new
    // plural route must never ride it.
    expect(requiredScopeFor('/api/v1/workspace/export', 'GET')).toBe('data:export');
  });
});

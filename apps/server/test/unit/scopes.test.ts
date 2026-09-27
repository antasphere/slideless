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

describe('requiredScopeFor — teams (PRDCT-2813, the chassis rules under the tool’s scope names)', () => {
  const TEAM = '/api/v1/teams/11111111-2222-3333-4444-555555555555';

  it('the list: GET under presentations:read, POST under presentations:write', () => {
    expect(requiredScopeFor('/api/v1/teams', 'GET')).toBe('presentations:read');
    expect(requiredScopeFor('/api/v1/teams', 'POST')).toBe('presentations:write');
  });

  it('the seat of one person: DELETE under presentations:write, every other method closed', () => {
    const seat = `${TEAM}/members/user-abc`;
    expect(requiredScopeFor(seat, 'DELETE')).toBe('presentations:write');
    expect(requiredScopeFor(seat, 'POST')).toBeNull();
    expect(requiredScopeFor(seat, 'PUT')).toBeNull();
    expect(requiredScopeFor(seat, 'PATCH')).toBeNull();
  });

  it('the roster: GET under presentations:read, PUT closed', () => {
    expect(requiredScopeFor(`${TEAM}/members`, 'GET')).toBe('presentations:read');
    expect(requiredScopeFor(`${TEAM}/members`, 'PUT')).toBeNull();
  });

  it('a team id that is not a uuid is not a listed shape', () => {
    expect(requiredScopeFor('/api/v1/teams/not-a-uuid', 'GET')).toBeNull();
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

describe('requiredScopeFor — members stay closed to machines (ADR 014, PRDCT-2816)', () => {
  const MEMBER = '/api/v1/members/11111111-2222-3333-4444-555555555555';

  it('the account deletion and the removal are UNLISTED for every method: sessions only', () => {
    for (const method of ['POST', 'GET', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(MEMBER, method)).toBeNull();
      expect(requiredScopeFor(`${MEMBER}/remove`, method)).toBeNull();
    }
  });
});

describe('requiredScopeFor — the default workspace (PRDCT-2815)', () => {
  const PATH = '/api/v1/me/default-workspace';

  it('PUT is listed under presentations:write', () => {
    expect(requiredScopeFor(PATH, 'PUT')).toBe('presentations:write');
  });

  it('every other method on the path stays unlisted', () => {
    for (const method of ['GET', 'POST', 'PATCH', 'DELETE']) {
      expect(requiredScopeFor(PATH, method)).toBeNull();
    }
  });

  it('a longer path and any other path under /me stay unlisted for PUT', () => {
    expect(requiredScopeFor(`${PATH}/x`, 'PUT')).toBeNull();
    expect(requiredScopeFor('/api/v1/me/anything', 'PUT')).toBeNull();
  });
});

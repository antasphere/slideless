import { describe, expect, it } from 'vitest';
import { PlatformApiError } from '@slideless/sdk';
import { en, fr } from '$lib/i18n';
import { newIdempotencyKey, startFreshSignIn, workspaceCreateFailure } from './workspace-create';

/**
 * The refusal sentences of the "New workspace" dialog (PRDCT-2443 /
 * PRDCT-2444). The server speaks codes; the person reads one plain sentence,
 * and that sentence never says where a workspace is created behind the scenes.
 */

const refusal = (status: number, code: string, message = 'Antasphere refused this organization name') =>
  new PlatformApiError(status, code, message);

describe('workspaceCreateFailure', () => {
  it.each([
    [400, 'validation_error', en['workspace.createErrorName']],
    [403, 'workspace_limit_reached', en['workspace.createErrorLimit']],
    [403, 'workspace_creation_disabled', en['workspace.createErrorDisabled']],
    [403, 'guest_forbidden', en['workspace.createErrorGuest']],
    [403, 'hub_unavailable', en['workspace.createErrorUnconfirmed']],
    [403, 'hub_refused', en['workspace.createErrorRefused']],
    [403, 'hub_link_required', en['workspace.createErrorLinkRequired']],
    [429, 'rate_limited', en['workspace.createErrorRateLimited']],
    [409, 'idempotency_in_flight', en['workspace.createErrorInFlight']],
    [409, 'idempotency_key_reuse', en['workspace.createErrorInFlight']]
  ])('%i %s reads as its own sentence, with no way to sign in offered', (status, code, sentence) => {
    expect(workspaceCreateFailure(refusal(status, code))).toEqual({
      message: sentence,
      signInAgain: false,
      freshSignIn: false
    });
  });

  it.each(['hub_grant_expired', 'session_required', 'unauthenticated'])(
    '%s means sign in again, and the dialog offers the way there',
    (code) => {
      expect(workspaceCreateFailure(refusal(401, code))).toEqual({
        message: en['workspace.createErrorSignInAgain'],
        signInAgain: true,
        freshSignIn: false
      });
    }
  );

  it('401 hub_reauth_required: the session is alive, so the control starts a fresh sign-in', () => {
    // A grant minted before workspace creation existed lacks its scope; a
    // reload would come straight back to the app and fail the same way.
    expect(workspaceCreateFailure(refusal(401, 'hub_reauth_required'))).toEqual({
      message: en['workspace.createErrorFreshSignIn'],
      signInAgain: true,
      freshSignIn: true
    });
  });

  it('a 429 under any code is the rate sentence', () => {
    expect(workspaceCreateFailure(refusal(429, 'too_many_requests')).message).toBe(
      en['workspace.createErrorRateLimited']
    );
  });

  it('an unknown code never shows the server’s own message', () => {
    const failure = workspaceCreateFailure(refusal(500, 'internal_error'));
    expect(failure.message).toBe(en['workspace.createErrorGeneric']);
    expect(failure.message).not.toContain('Antasphere');
  });

  it('a network failure is the generic sentence', () => {
    expect(workspaceCreateFailure(new TypeError('Failed to fetch')).message).toBe(
      en['workspace.createErrorGeneric']
    );
  });
});

describe('the wording of workspace creation', () => {
  // The product owner's ruling: the person creates a Slideless workspace and
  // never learns what that is behind the scenes.
  const FORBIDDEN = /organi[sz]ation|\bhub\b|antasphere/i;
  const CREATION_KEYS = (Object.keys(en) as (keyof typeof en)[]).filter(
    (key) =>
      key.startsWith('workspace.create') ||
      [
        'workspace.nameLabel',
        'workspace.namePlaceholder',
        'workspace.creating',
        'workspace.signInAgain'
      ].includes(key) ||
      key === 'noOrg.titleCreate' ||
      key === 'noOrg.bodyCreate'
  );

  it('covers the dialog, its refusals and the zero state', () => {
    expect(CREATION_KEYS.length).toBeGreaterThanOrEqual(19);
  });

  it.each([
    ['en', en],
    ['fr', fr]
  ] as const)('%s never says organisation, hub or Antasphere', (_lang, catalog) => {
    for (const key of CREATION_KEYS) {
      expect(catalog[key], key).not.toMatch(FORBIDDEN);
    }
  });
});

describe('newIdempotencyKey', () => {
  it('is fresh per call and within the header’s 200 characters', () => {
    const a = newIdempotencyKey();
    const b = newIdempotencyKey();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ws-create-[0-9a-f]{32}$/);
  });
});

describe('startFreshSignIn', () => {
  it('starts the antasphere sign-in back to the page it was called from', async () => {
    const calls: unknown[] = [];
    const started = await startFreshSignIn(async (options) => {
      calls.push(options);
      return {};
    }, '/decks?x=1');
    expect(started).toBe(true);
    expect(calls).toEqual([
      { providerId: 'antasphere', callbackURL: '/decks?x=1', errorCallbackURL: '/login' }
    ]);
  });

  it('reports false when the sign-in cannot start, so the caller falls back to a reload', async () => {
    expect(await startFreshSignIn(async () => ({ error: { code: 'x' } }), '/')).toBe(false);
    expect(
      await startFreshSignIn(async () => {
        throw new Error('network');
      }, '/')
    ).toBe(false);
  });
});

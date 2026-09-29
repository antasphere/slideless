import { describe, expect, it } from 'vitest';
import type { EntitlementRequest, Principal } from '@antasphere/chassis-contract';
import type { Db } from '@antasphere/chassis-db';
import { linksOfDeck } from '../../src/presentations/links-of-deck.js';
import { memberSeatHooks } from '../../src/presentations/member-seats.js';
import type { DeckDomain } from '../../src/tool.js';

/**
 * The two count hooks read the request through the route's own schemas
 * BEFORE any lookup (PRDCT-2899): a deck id that is not a uuid or a body the
 * validator refuses answers null, so the validator's 400 follows and nothing
 * reaches the database. The domain and the database here throw on any use.
 */

const DECK = '11111111-2222-4333-8444-555555555555'; // a v4 uuid: `uuidParams` refuses any other
const principal = {
  userId: 'u1',
  workspaceId: 'w1',
  role: 'owner',
  origin: 'local',
  via: 'session'
} as Principal;
const untouchable = new Proxy(
  {},
  {
    get: (_t, key) => {
      throw new Error(`looked up ${String(key)}`);
    }
  }
);
const domain = () => untouchable as unknown as DeckDomain;
const db = untouchable as unknown as Db;

function request(id: string, body: unknown): EntitlementRequest {
  return {
    method: 'POST',
    path: `/api/v1/presentations/${id}/x`,
    headers: new Headers(),
    params: { id },
    principal,
    body: async () => body
  };
}

describe('the count hooks look nothing up for a request the validator refuses', () => {
  const invite = memberSeatHooks(db, domain).collaboratorInviteSeats;
  const links = linksOfDeck(domain);

  it('the invite: an address the schema refuses', async () => {
    await expect(invite(request(DECK, { email: 'not-an-address' }))).resolves.toBeNull();
  });

  it('the invite: a deck id that is not a uuid', async () => {
    await expect(invite(request('not-a-uuid', { email: 'a@b.test' }))).resolves.toBeNull();
  });

  it('the link mint: a deck id that is not a uuid', async () => {
    await expect(links(request('not-a-uuid', { name: 'a link' }))).resolves.toBeNull();
  });

  it('the link mint: a body the schema refuses', async () => {
    await expect(links(request(DECK, { name: '' }))).resolves.toBeNull();
  });

  it('the claim: a token the schema refuses', async () => {
    await expect(
      memberSeatHooks(db, domain).collaboratorClaimSeats(request(DECK, { token: 'short' }))
    ).resolves.toBeNull();
  });
});

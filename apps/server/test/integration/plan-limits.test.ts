import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The plan's limits and features on Slideless (PRDCT-2702), on the cloud
 * edition against the fake hub: the member cap (`workspace.members`, free 3)
 * at the collaborator invite and at the claim (the public door, whose
 * refusal is the neutral sentence), the links per deck (`links.perDeck`,
 * free 10, previews excluded, expired links counted), and the viewer
 * password (`deck.password`, pro only) gated on the ACT of setting one, at
 * the mint and at the update, on the three surfaces. A refusal posts
 * nothing to the hub; a pro account passes all of it.
 *
 * The plan read is stale-while-revalidate (PRDCT-2633): with a zero TTL a
 * change at the hub is served on the request AFTER the one that notices it,
 * so `setPlan` primes the cache with a request that changes nothing (a mint
 * on a deck that does not exist: 404, no event) and waits for the refresh.
 */

const OPERATOR = { email: 'operator@planlimits.test', name: 'Operator', password: 'operator-plan-pass-1' };
const HUB_SECRET = 'integration-test-hub-secret-plans';
const ORG_SEATS = '88888888-aaaa-4bbb-8ccc-0000000000c1';
const ORG_LINKS = '88888888-aaaa-4bbb-8ccc-0000000000c2';
const ORG_PASSWORD = '88888888-aaaa-4bbb-8ccc-0000000000c3';
const ORG_SURFACES = '88888888-aaaa-4bbb-8ccc-0000000000c4';
const ORG_PRO = '88888888-aaaa-4bbb-8ccc-0000000000c5';
const ORG_SWEPT = '88888888-aaaa-4bbb-8ccc-0000000000c6';
const ORG_TEAM = '88888888-aaaa-4bbb-8ccc-0000000000c7';
const ORG_SWEPT_GUEST = '88888888-aaaa-4bbb-8ccc-0000000000d2';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

const json = (body: unknown, headers: Record<string, string> = {}, method = 'POST') => ({
  method,
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp(), ...headers },
  body: JSON.stringify(body)
});

interface Person {
  cookie: string;
  workspaceId: string;
  key: string;
  sub: string;
  org: string;
}

async function hubPerson(fixture: HubUserFixture): Promise<Person> {
  const cookie = await sso.ssoLogin(app, hub, fixture);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json(
        {
          name: 'plan-key',
          scopes: ['presentations:read', 'presentations:write'],
          workspaceId: me.activeWorkspaceId
        },
        { cookie, 'x-workspace-id': me.activeWorkspaceId }
      )
    )
  );
  return {
    cookie,
    workspaceId: me.activeWorkspaceId,
    key: minted.key,
    sub: fixture.sub,
    org: fixture.workspaceId
  };
}

const owner = (sub: string, org: string, email: string): HubUserFixture => ({
  sub,
  email,
  name: sub,
  workspaceId: org,
  role: 'owner',
  workspaceName: `Org ${sub}`
});

/** The multipart encoding of one deck asset, as a client builds it before it sends. */
async function encodeAsset(bytes: Buffer): Promise<{ body: ArrayBuffer; contentType: string }> {
  const form = new FormData();
  form.set('sha256', createHash('sha256').update(bytes).digest('hex'));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  const encoded = new Response(form);
  return { body: await encoded.arrayBuffer(), contentType: encoded.headers.get('content-type')! };
}

function postAsset(headers: Record<string, string>, asset: { body: ArrayBuffer; contentType: string }) {
  return app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: {
      'x-forwarded-for': sso.nextIp(),
      'content-type': asset.contentType,
      'content-length': String(asset.body.byteLength),
      ...headers
    },
    body: asset.body
  });
}

async function uploadAsset(headers: Record<string, string>, bytes: Buffer) {
  return postAsset(headers, await encodeAsset(bytes));
}

/** The upgrade link of a plan refusal (metering.test.ts's shape). */
function expectedUpgradeUrl(org: string, plan: string, key: string, requiredPlan: string | null): string {
  const url = new URL(`${hub.issuer}/billing/upgrade`);
  url.searchParams.set('org', org);
  url.searchParams.set('tool', hub.toolSlug);
  url.searchParams.set('plan', plan);
  url.searchParams.set('key', key);
  if (requiredPlan !== null) url.searchParams.set('requiredPlan', requiredPlan);
  return url.toString();
}

let rpcId = 0;
async function mcpTool(key: string, name: string, args: Record<string, unknown>) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': sso.nextIp(),
      authorization: `Bearer ${key}`
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error).toBeUndefined();
  const text: string = body.result.content?.[0]?.text ?? '';
  return { isError: body.result.isError === true, text };
}

async function until<T>(read: () => T, ok: (v: T) => boolean, ms = 20_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = read();
    if (ok(v) || Date.now() > deadline) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

const events = () => [...hub.usageEvents.values()];
const eventsOf = (org: string, actionKey: string) =>
  events().filter((e) => e.accountRef === org && e.actionKey === actionKey).length;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Nothing more reaches the hub for this organization and action within the poster's window. */
async function expectNothingPosted(org: string, actionKey: string, posted: number): Promise<void> {
  await sleep(2_500);
  expect(eventsOf(org, actionKey)).toBe(posted);
}

/**
 * Change the account's plan at the hub and make the instance read it: one
 * request that reads the plan and changes nothing (a mint on a deck that
 * does not exist answers 404 and emits nothing), then the refresh it
 * started behind it.
 */
async function setPlan(person: Person, plan: 'free' | 'pro'): Promise<void> {
  hub.setEntitlements(person.org, { plan });
  const reads = () => hub.entitlementsRequests.filter((r) => r.accountRef === person.org).length;
  const before = reads();
  const prime = await app.app.request(
    `/api/v1/presentations/${randomUUID()}/tokens`,
    json({ name: 'prime' }, { authorization: `Bearer ${person.key}` })
  );
  expect(prime.status).toBe(404);
  await until(reads, (n) => n > before);
  await sleep(200);
}

let deckCounter = 0;
/** The owner pushes one deck with their key: the asset, the upload session, the commit. */
async function makeDeck(person: Person): Promise<string> {
  const headers = { authorization: `Bearer ${person.key}` };
  const html = Buffer.from(
    `<!doctype html><html><head><title>Plan ${++deckCounter}</title></head><body><h1>${deckCounter}</h1></body></html>`
  );
  const asset = await uploadAsset(headers, html);
  expect(asset.status, await asset.clone().text()).toBe(201);
  const reserve = await readJson(await app.app.request('/api/v1/presentations/uploads', json({}, headers)));
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title: `Plan ${deckCounter}`,
        entryPath: 'index.html',
        manifest: [
          {
            path: 'index.html',
            sha256: createHash('sha256').update(html).digest('hex'),
            sizeBytes: html.length,
            contentType: 'text/html'
          }
        ]
      },
      headers
    )
  );
  expect(commit.status, await commit.clone().text()).toBe(201);
  return reserve.uploadSession.presentationId as string;
}

const dashboard = (p: Person) => ({ cookie: p.cookie, 'x-workspace-id': p.workspaceId });
const cli = (p: Person) => ({ authorization: `Bearer ${p.key}` });

const invite = (p: Person, deckId: string, email: string) =>
  app.app.request(`/api/v1/presentations/${deckId}/collaborators`, json({ email }, dashboard(p)));

const mint = (
  p: Person,
  deckId: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = cli(p)
) => app.app.request(`/api/v1/presentations/${deckId}/tokens`, json(body, headers));

const patchToken = (p: Person, deckId: string, tokenId: string, body: Record<string, unknown>) =>
  app.app.request(`/api/v1/presentations/${deckId}/tokens/${tokenId}`, json(body, cli(p), 'PATCH'));

interface TokenRow {
  id: string;
  name: string;
  purpose: string;
  revokedAt: string | null;
  hasPassword: boolean;
}

async function listTokens(p: Person, deckId: string): Promise<TokenRow[]> {
  const res = await app.app.request(`/api/v1/presentations/${deckId}/tokens?limit=100`, {
    headers: { ...cli(p), 'x-forwarded-for': sso.nextIp() }
  });
  expect(res.status).toBe(200);
  return (await readJson(res)).shareTokens as TokenRow[];
}

const liveShareLinks = async (p: Person, deckId: string) =>
  (await listTokens(p, deckId)).filter((t) => t.purpose === 'share' && t.revokedAt === null).length;

/** A signed-in plan refusal: 403 plan_required with the key, the plans and the upgrade link. */
async function expectPlanRequired(res: Response, org: string, key: string, message: string): Promise<void> {
  expect(res.status).toBe(403);
  const body = await readJson(res);
  expect(body.error.code).toBe('plan_required');
  expect(body.error.message).toBe(message);
  expect(body.error.details).toEqual({
    key,
    plan: 'free',
    requiredPlan: 'pro',
    upgradeUrl: expectedUpgradeUrl(org, 'free', key, 'pro')
  });
}

const MEMBERS_MESSAGE = 'workspace.members is limited to 3 on the free plan; the pro plan allows it';
const LINKS_MESSAGE = 'links.perDeck is limited to 10 on the free plan; the pro plan allows it';
const PASSWORD_MESSAGE = 'This needs the pro plan (deck.password is not part of the free plan)';

beforeAll(async () => {
  [container, hub] = await Promise.all([
    startPostgres(),
    FakeHub.start({ clientId: 'tool-slideless-cloud', clientSecret: HUB_SECRET })
  ]);
  app = await createTestApp(
    await createDatabase(container, 'plan_limits_cloud'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: HUB_SECRET
    },
    {
      usageRetry: { limit: 3, delaySeconds: 1 },
      entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0 },
      // Every gated request reads the plan again (served stale, refreshed behind: see setPlan).
      entitlementDials: { ttlMs: 0, coldWaitMs: 1_500 }
    }
  );
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Plan Limits', owner: OPERATOR })
  );
  expect(setup.status).toBe(201);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('discovery carries the plan values', () => {
  it('a form response is 1 credit per call, the two count limits and the two pro features', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    const action = (key: string) => info.entitlements.actions.find((a: { key: string }) => a.key === key);
    // The seed ruling of 24 September 2026.
    expect(action('forms.response')).toMatchObject({ creditsPerUnit: 1, unit: 'call' });
    expect(info.entitlements.limits['workspace.members']).toEqual({ oss: null, free: 3, pro: null });
    expect(info.entitlements.limits['links.perDeck']).toEqual({ oss: null, free: 10, pro: null });
    expect(info.entitlements.features['deck.password']).toEqual({ free: false, pro: true });
    expect(info.entitlements.features.custom_domain).toEqual({ free: false, pro: true });
  });
});

// The seats org is shared by the invite describe and the claim describe (the claim needs its downgrade).
let seatsOwner: Person;
let seatsDeck: string;
let seatsDeck2: string;

describe('the member cap at the collaborator invite', () => {
  let grantB: string;

  beforeAll(async () => {
    seatsOwner = await hubPerson(owner('hub-plan-seats', ORG_SEATS, 'seats@planlimits.test'));
    seatsDeck = await makeDeck(seatsOwner);
    seatsDeck2 = await makeDeck(seatsOwner);
  });

  it('two invitations fill the free plan’s three seats (the owner and two reserved)', async () => {
    const a = await invite(seatsOwner, seatsDeck, 'a@seats.test');
    expect(a.status, await a.clone().text()).toBe(201);
    const b = await invite(seatsOwner, seatsDeck, 'b@seats.test');
    expect(b.status, await b.clone().text()).toBe(201);
    grantB = (await readJson(b)).collaborator.id;
  });

  it('a third address is refused with the upgrade link, and nothing is posted for it', async () => {
    await until(
      () => eventsOf(ORG_SEATS, 'collaborators.invite'),
      (n) => n >= 2
    );
    const posted = eventsOf(ORG_SEATS, 'collaborators.invite');
    await expectPlanRequired(
      await invite(seatsOwner, seatsDeck, 'c@seats.test'),
      ORG_SEATS,
      'workspace.members',
      MEMBERS_MESSAGE
    );
    await expectNothingPosted(ORG_SEATS, 'collaborators.invite', posted);
  });

  it('an address already invited holds its seat: inviting it on another deck is not a plan refusal', async () => {
    const again = await invite(seatsOwner, seatsDeck2, 'a@seats.test');
    const body = await readJson(again);
    expect(body.error?.code).not.toBe('plan_required');
    expect([201, 409]).toContain(again.status);
  });

  it('revoking a pending grant frees its seat: the third address then gets in', async () => {
    const revoked = await app.app.request(`/api/v1/presentations/${seatsDeck}/collaborators/${grantB}`, {
      method: 'DELETE',
      headers: { ...dashboard(seatsOwner), 'x-forwarded-for': sso.nextIp() }
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    const c = await invite(seatsOwner, seatsDeck, 'c@seats.test');
    expect(c.status, await c.clone().text()).toBe(201);
  });
});

describe('the cap never says more than the handler would (ADR 013)', () => {
  let member: Person;

  beforeAll(async () => {
    // A plain member of the seats org, with no grant on the owner's decks.
    member = await hubPerson({
      sub: 'hub-plan-seats-member',
      email: 'member@seats.test',
      name: 'Seats Member',
      workspaceId: ORG_SEATS,
      role: 'member',
      workspaceName: 'Org hub-plan-seats'
    });
  });

  it('a member who cannot read the deck gets the handler’s 404 at the invite, never a plan refusal, on a workspace at its cap', async () => {
    const res = await invite(member, seatsDeck, 'outsider@seats.test');
    expect(res.status, await res.clone().text()).toBe(404);
  });

  it('a member who cannot read the deck gets the handler’s 404 at the link mint, never the deck’s link count', async () => {
    // The owner's second deck holds ten links, so the count alone would
    // refuse: the member must meet the handler's 404 before any count.
    for (let n = 1; n <= 10; n++) {
      const res = await mint(seatsOwner, seatsDeck2, { name: `probe-${n}` });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    expect(await liveShareLinks(seatsOwner, seatsDeck2)).toBe(10);
    const res = await mint(member, seatsDeck2, { name: 'probe' });
    expect(res.status, await res.clone().text()).toBe(404);
    expect(await liveShareLinks(seatsOwner, seatsDeck2)).toBe(10);
  });

  it('a plain member inviting an outsider on their own deck at the cap reads the handler’s refusal, never the cap', async () => {
    const own = await makeDeck(member);
    const res = await invite(member, own, 'stranger@seats.test');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('external_invite_forbidden');
    expect(body.error.details).toBeUndefined();
  });

  it('a colleague invited as a collaborator holds one seat, not two: an outsider still gets in beside them', async () => {
    // A fresh org of two members (the owner, a member): the member's own
    // address as a collaborator adds no seat, a first outsider is the third
    // seat and lands, a second outsider is the fourth and is refused.
    const teamOwner = await hubPerson(owner('hub-plan-team', ORG_TEAM, 'team@planlimits.test'));
    await hubPerson({
      sub: 'hub-plan-team-member',
      email: 'teammate@team.test',
      name: 'Team Member',
      workspaceId: ORG_TEAM,
      role: 'member',
      workspaceName: 'Org hub-plan-team'
    });
    const teamDeck = await makeDeck(teamOwner);
    const colleague = await invite(teamOwner, teamDeck, 'teammate@team.test');
    expect(colleague.status, await colleague.clone().text()).toBe(201);
    const third = await invite(teamOwner, teamDeck, 'third@team.test');
    expect(third.status, await third.clone().text()).toBe(201);
    await expectPlanRequired(
      await invite(teamOwner, teamDeck, 'fourth@team.test'),
      ORG_TEAM,
      'workspace.members',
      MEMBERS_MESSAGE
    );
  });

  it('a hub-projected workspace above its cap still answers hub_managed on its own invitation door, never a plan refusal', async () => {
    const res = await app.app.request(
      '/api/v1/invitations',
      json({ email: 'anyone@seats.test', role: 'member' }, dashboard(seatsOwner))
    );
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('hub_managed');
    expect(body.error.details.manageUrl).toBeTruthy();
  });
});

describe('an active grant not yet claimed still holds its seat (the swept state)', () => {
  let owner2: Person;
  let deck: string;

  beforeAll(async () => {
    owner2 = await hubPerson(owner('hub-plan-swept', ORG_SWEPT, 'swept@planlimits.test'));
    deck = await makeDeck(owner2);
  });

  it('the person invited first keeps the seat after signing in, so the third address is refused', async () => {
    const x = await invite(owner2, deck, 'x@swept.test');
    expect(x.status, await x.clone().text()).toBe(201);
    const grantId = (await readJson(x)).collaborator.id;
    // x signs in through the hub: the JIT sweep flips the grant to active with no membership yet.
    await sso.ssoLogin(app, hub, {
      sub: 'hub-plan-swept-x',
      email: 'x@swept.test',
      name: 'Swept X',
      workspaceId: ORG_SWEPT_GUEST,
      role: 'owner',
      workspaceName: 'Swept Personal'
    });
    let status = 'pending';
    for (let i = 0; i < 40 && status !== 'active'; i++) {
      const { rows } = await app.db.pool.query(`SELECT status FROM collaborators WHERE id = $1`, [grantId]);
      status = rows[0].status;
      if (status !== 'active') await sleep(50);
    }
    expect(status).toBe('active');
    const y = await invite(owner2, deck, 'y@swept.test');
    expect(y.status, await y.clone().text()).toBe(201);
    await expectPlanRequired(
      await invite(owner2, deck, 'z@swept.test'),
      ORG_SWEPT,
      'workspace.members',
      MEMBERS_MESSAGE
    );
  });
});

describe('the member cap at the claim (the public door)', () => {
  // Under pro the owner invites d, e and f; d and e sign in and claim (the
  // members reach the free cap of 3 beside the owner and the plain member,
  // 4 in all, above it); back on free, f's claim is a join on a workspace
  // above its cap and is refused. A claim judges the members alone: the
  // other reservations never block it (first come, first seated).
  const guests = {
    d: { email: 'd@seats.test', sub: 'hub-plan-guest-d', org: '88888888-aaaa-4bbb-8ccc-0000000000d1' },
    e: { email: 'e@seats.test', sub: 'hub-plan-guest-e', org: '88888888-aaaa-4bbb-8ccc-0000000000d3' },
    f: { email: 'f@seats.test', sub: 'hub-plan-guest-f', org: '88888888-aaaa-4bbb-8ccc-0000000000d4' }
  } as const;
  type Guest = keyof typeof guests;
  const tokens: Record<string, string> = {};
  const cookies: Record<string, string> = {};
  const userIds: Record<string, string> = {};

  const guestRows = async (who: Guest) =>
    (
      await app.db.pool.query(
        `SELECT role, origin, is_active FROM workspace_members WHERE user_id = $1 AND workspace_id = $2`,
        [userIds[who], seatsOwner.workspaceId]
      )
    ).rows;

  const claim = (who: Guest) =>
    app.app.request('/api/v1/collaborators/claim', json({ token: tokens[who] }, { cookie: cookies[who]! }));

  /** The guest signs in through the hub: the JIT sweep flips the grant to active (the G1 sequence). */
  async function signIn(who: Guest, grantId: string) {
    cookies[who] = await sso.ssoLogin(app, hub, {
      sub: guests[who].sub,
      email: guests[who].email,
      name: `Plan Guest ${who}`,
      workspaceId: guests[who].org,
      role: 'owner',
      workspaceName: `Guest ${who}`
    });
    const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [guests[who].email]);
    expect(rows).toHaveLength(1);
    userIds[who] = rows[0].id;
    let status = 'pending';
    for (let i = 0; i < 40 && status !== 'active'; i++) {
      const { rows: grants } = await app.db.pool.query(`SELECT status FROM collaborators WHERE id = $1`, [
        grantId
      ]);
      status = grants[0].status;
      if (status !== 'active') await sleep(50);
    }
    expect(status).toBe('active');
  }

  beforeAll(async () => {
    await setPlan(seatsOwner, 'pro');
    const grantIds: Record<string, string> = {};
    for (const who of ['d', 'e', 'f'] as const) {
      const res = await invite(seatsOwner, seatsDeck, guests[who].email);
      expect(res.status, await res.clone().text()).toBe(201);
      const invited = await readJson(res);
      grantIds[who] = invited.collaborator.id;
      tokens[who] = (invited.claimUrl as string).split('/').pop()!;
    }
    for (const who of ['d', 'e'] as const) {
      await signIn(who, grantIds[who]!);
      const res = await claim(who);
      expect(res.status, await res.clone().text()).toBe(200);
    }
    await setPlan(seatsOwner, 'free');
    await signIn('f', grantIds.f!);
  });

  it('a workspace whose members are above the cap takes nobody in: the neutral refusal, and no guest row', async () => {
    const res = await claim('f');
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.message).toBe('The owner of this content cannot take this action right now');
    expect(body.error.details).toBeUndefined();
    expect(await guestRows('f')).toHaveLength(0);
  });

  it('back on pro, the same claim answers 200 and mints the guest row', async () => {
    await setPlan(seatsOwner, 'pro');
    const res = await claim('f');
    expect(res.status, await res.clone().text()).toBe(200);
    const body = await readJson(res);
    expect(body.workspaceId).toBe(seatsOwner.workspaceId);
    expect(body.userId).toBe(userIds.f);
    expect(body.collaborator.status).toBe('active');
    const rows = await guestRows('f');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ role: 'member', origin: 'guest', is_active: true });
    await setPlan(seatsOwner, 'free');
  });
});

// The seat pool's edges (PRDCT-2702): each describe stands on its own
// organization, on the free plan unless it says otherwise.
const ORG_JOIN = '88888888-aaaa-4bbb-8ccc-0000000000e1';
const ORG_INACTIVE = '88888888-aaaa-4bbb-8ccc-0000000000e2';
const ORG_EXPIRED = '88888888-aaaa-4bbb-8ccc-0000000000e3';
const ORG_SEATED = '88888888-aaaa-4bbb-8ccc-0000000000e4';

interface Invited {
  grantId: string;
  token: string;
}

async function invited(p: Person, deckId: string, email: string): Promise<Invited> {
  const res = await invite(p, deckId, email);
  expect(res.status, await res.clone().text()).toBe(201);
  const body = await readJson(res);
  return { grantId: body.collaborator.id, token: (body.claimUrl as string).split('/').pop()! };
}

/** A guest signs in through the hub on their own personal org; the JIT sweep flips the grant to active. */
async function guestSignIn(
  sub: string,
  email: string,
  personalOrg: string,
  grantId: string
): Promise<string> {
  const cookie = await sso.ssoLogin(app, hub, {
    sub,
    email,
    name: sub,
    workspaceId: personalOrg,
    role: 'owner',
    workspaceName: `Personal ${sub}`
  });
  let status = 'pending';
  for (let i = 0; i < 40 && status !== 'active'; i++) {
    const { rows } = await app.db.pool.query(`SELECT status FROM collaborators WHERE id = $1`, [grantId]);
    status = rows[0].status;
    if (status !== 'active') await sleep(50);
  }
  expect(status).toBe('active');
  return cookie;
}

const claimWith = (token: string, cookie: string) =>
  app.app.request('/api/v1/collaborators/claim', json({ token }, { cookie }));

describe('a claim judges the members alone', () => {
  it('a claim on a workspace under the cap in members and over it in grants seats the person: the other reservations never block a join', async () => {
    // Four grants made under pro leave five seats reserved on free with one
    // member: the claims seat people until the MEMBERS reach the cap.
    const joinOwner = await hubPerson(owner('hub-plan-join', ORG_JOIN, 'join@planlimits.test'));
    const deckId = await makeDeck(joinOwner);
    await setPlan(joinOwner, 'pro');
    const grants: Invited[] = [];
    for (const n of [1, 2, 3, 4]) grants.push(await invited(joinOwner, deckId, `g${n}@join.test`));
    await setPlan(joinOwner, 'free');
    const personal = [
      '88888888-aaaa-4bbb-8ccc-0000000000e5',
      '88888888-aaaa-4bbb-8ccc-0000000000e6',
      '88888888-aaaa-4bbb-8ccc-0000000000e7'
    ];
    const claimAs = async (n: number) => {
      const cookie = await guestSignIn(
        `hub-plan-join-g${n}`,
        `g${n}@join.test`,
        personal[n - 1]!,
        grants[n - 1]!.grantId
      );
      return claimWith(grants[n - 1]!.token, cookie);
    };
    const first = await claimAs(1);
    expect(first.status, await first.clone().text()).toBe(200);
    const second = await claimAs(2);
    expect(second.status, await second.clone().text()).toBe(200);
    const third = await claimAs(3);
    expect(third.status).toBe(403);
    const body = await readJson(third);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.message).toBe('The owner of this content cannot take this action right now');
    expect(body.error.details).toBeUndefined();
  });
});

describe('only active members hold a seat', () => {
  it('a member the hub sweep deactivated holds no seat', async () => {
    // Two members, one deactivated: the owner alone is seated, so two
    // outsiders fit and the third is refused.
    const inactiveOwner = await hubPerson(
      owner('hub-plan-inactive', ORG_INACTIVE, 'inactive@planlimits.test')
    );
    const member = await hubPerson({
      sub: 'hub-plan-inactive-member',
      email: 'member@inactive.test',
      name: 'Inactive Member',
      workspaceId: ORG_INACTIVE,
      role: 'member',
      workspaceName: 'Org hub-plan-inactive'
    });
    expect(member.workspaceId).toBe(inactiveOwner.workspaceId);
    const { rows } = await app.db.pool.query(`SELECT id FROM "user" WHERE email = $1`, [
      'member@inactive.test'
    ]);
    const updated = await app.db.pool.query(
      `UPDATE workspace_members SET is_active = false WHERE user_id = $1 AND workspace_id = $2`,
      [rows[0].id, inactiveOwner.workspaceId]
    );
    expect(updated.rowCount).toBe(1);
    const deckId = await makeDeck(inactiveOwner);
    const a = await invite(inactiveOwner, deckId, 'a@inactive.test');
    expect(a.status, await a.clone().text()).toBe(201);
    const b = await invite(inactiveOwner, deckId, 'b@inactive.test');
    expect(b.status, await b.clone().text()).toBe(201);
    await expectPlanRequired(
      await invite(inactiveOwner, deckId, 'c@inactive.test'),
      ORG_INACTIVE,
      'workspace.members',
      MEMBERS_MESSAGE
    );
  });
});

describe('only a live pending grant holds a seat', () => {
  it('an expired pending grant frees its seat', async () => {
    // Two pending grants fill the three seats beside the owner; once one
    // expires, its seat is free again and the next address gets in.
    const expiredOwner = await hubPerson(owner('hub-plan-expired', ORG_EXPIRED, 'expired@planlimits.test'));
    const deckId = await makeDeck(expiredOwner);
    const a = await invited(expiredOwner, deckId, 'a@expired.test');
    await invited(expiredOwner, deckId, 'b@expired.test');
    const updated = await app.db.pool.query(
      `UPDATE collaborators SET claim_expires_at = now() - interval '1 minute' WHERE id = $1`,
      [a.grantId]
    );
    expect(updated.rowCount).toBe(1);
    const c = await invite(expiredOwner, deckId, 'c@expired.test');
    expect(c.status, await c.clone().text()).toBe(201);
  });
});

describe('a seated guest adds no seat', () => {
  it('a guest already seated claims a second deck at the cap without a plan refusal', async () => {
    // At three members, a guest already seated is invited and claims on a
    // second deck: neither act adds a seat, while an outsider is refused.
    const seatedOwner = await hubPerson(owner('hub-plan-seated', ORG_SEATED, 'seated@planlimits.test'));
    const deckOne = await makeDeck(seatedOwner);
    await setPlan(seatedOwner, 'pro');
    const h1 = await invited(seatedOwner, deckOne, 'h1@seated.test');
    const h2 = await invited(seatedOwner, deckOne, 'h2@seated.test');
    const h1Cookie = await guestSignIn(
      'hub-plan-seated-h1',
      'h1@seated.test',
      '88888888-aaaa-4bbb-8ccc-0000000000e8',
      h1.grantId
    );
    const h1Claim = await claimWith(h1.token, h1Cookie);
    expect(h1Claim.status, await h1Claim.clone().text()).toBe(200);
    const h2Cookie = await guestSignIn(
      'hub-plan-seated-h2',
      'h2@seated.test',
      '88888888-aaaa-4bbb-8ccc-0000000000e9',
      h2.grantId
    );
    const h2Claim = await claimWith(h2.token, h2Cookie);
    expect(h2Claim.status, await h2Claim.clone().text()).toBe(200);
    await setPlan(seatedOwner, 'free');
    const deckTwo = await makeDeck(seatedOwner);
    const again = await invited(seatedOwner, deckTwo, 'h1@seated.test');
    await expectPlanRequired(
      await invite(seatedOwner, deckTwo, 'z@seated.test'),
      ORG_SEATED,
      'workspace.members',
      MEMBERS_MESSAGE
    );
    const second = await claimWith(again.token, h1Cookie);
    expect(second.status, await second.clone().text()).toBe(200);
  });
});

describe('the links per deck', () => {
  let person: Person;
  let deckId: string;

  beforeAll(async () => {
    person = await hubPerson(owner('hub-plan-links', ORG_LINKS, 'links@planlimits.test'));
    deckId = await makeDeck(person);
  });

  it('ten links are minted, the eleventh is refused with the upgrade link', async () => {
    for (let n = 1; n <= 10; n++) {
      const res = await mint(person, deckId, { name: `link-${n}` });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    expect(await liveShareLinks(person, deckId)).toBe(10);
    await expectPlanRequired(
      await mint(person, deckId, { name: 'link-11' }),
      ORG_LINKS,
      'links.perDeck',
      LINKS_MESSAGE
    );
    expect(await liveShareLinks(person, deckId)).toBe(10);
  });

  it('a preview token neither counts nor is gated', async () => {
    const res = await app.app.request(`/api/v1/presentations/${deckId}/preview-token`, json({}, cli(person)));
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await liveShareLinks(person, deckId)).toBe(10);
  });

  it('revoking a link lets the next mint through', async () => {
    const [first] = (await listTokens(person, deckId)).filter((t) => t.purpose === 'share' && !t.revokedAt);
    const revoked = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${first!.id}`, {
      method: 'DELETE',
      headers: { ...cli(person), 'x-forwarded-for': sso.nextIp() }
    });
    expect(revoked.status, await revoked.clone().text()).toBe(200);
    expect(await liveShareLinks(person, deckId)).toBe(9);
    const res = await mint(person, deckId, { name: 'link-after-revoke' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await liveShareLinks(person, deckId)).toBe(10);
  });

  it('an expired link still counts', async () => {
    const [first] = (await listTokens(person, deckId)).filter((t) => t.purpose === 'share' && !t.revokedAt);
    const revoked = await app.app.request(`/api/v1/presentations/${deckId}/tokens/${first!.id}`, {
      method: 'DELETE',
      headers: { ...cli(person), 'x-forwarded-for': sso.nextIp() }
    });
    expect(revoked.status).toBe(200);
    const expiring = await mint(person, deckId, {
      name: 'link-expiring',
      expiresAt: new Date(Date.now() + 1_000).toISOString()
    });
    expect(expiring.status, await expiring.clone().text()).toBe(201);
    await sleep(1_500);
    expect(await liveShareLinks(person, deckId)).toBe(10);
    await expectPlanRequired(
      await mint(person, deckId, { name: 'link-over' }),
      ORG_LINKS,
      'links.perDeck',
      LINKS_MESSAGE
    );
  });

  it('on pro the eleventh link is minted', async () => {
    await setPlan(person, 'pro');
    const res = await mint(person, deckId, { name: 'link-pro' });
    expect(res.status, await res.clone().text()).toBe(201);
    expect(await liveShareLinks(person, deckId)).toBe(11);
  });
});

describe('the password is pro, gated on the act of setting one', () => {
  let person: Person;
  let deckId: string;
  let plainId: string;
  let lockedUnderProId: string;

  const hasPassword = async (tokenId: string) =>
    (await listTokens(person, deckId)).find((t) => t.id === tokenId)!.hasPassword;

  beforeAll(async () => {
    person = await hubPerson(owner('hub-plan-password', ORG_PASSWORD, 'password@planlimits.test'));
    deckId = await makeDeck(person);
  });

  it('a password the schema refuses is the validator’s 400, never a plan refusal', async () => {
    const res = await mint(person, deckId, { name: 'short', password: 'abc' });
    expect(res.status, await res.clone().text()).toBe(400);
  });

  it('a mint that sets a password is refused on free, and nothing is posted for it', async () => {
    const posted = eventsOf(ORG_PASSWORD, 'share_tokens.create');
    await expectPlanRequired(
      await mint(person, deckId, { name: 'locked', password: 'hunter22' }),
      ORG_PASSWORD,
      'deck.password',
      PASSWORD_MESSAGE
    );
    await expectNothingPosted(ORG_PASSWORD, 'share_tokens.create', posted);
  });

  it('the same mint without a password is minted', async () => {
    const res = await mint(person, deckId, { name: 'locked' });
    expect(res.status, await res.clone().text()).toBe(201);
    plainId = (await readJson(res)).shareToken.id;
  });

  it('an update that sets a password is refused; a rename is not', async () => {
    await expectPlanRequired(
      await patchToken(person, deckId, plainId, { password: 'hunter22' }),
      ORG_PASSWORD,
      'deck.password',
      PASSWORD_MESSAGE
    );
    expect(await hasPassword(plainId)).toBe(false);
    const renamed = await patchToken(person, deckId, plainId, { name: 'renamed' });
    expect(renamed.status, await renamed.clone().text()).toBe(200);
  });

  it('on pro the update sets the password, and a link locked under pro is minted', async () => {
    await setPlan(person, 'pro');
    const res = await patchToken(person, deckId, plainId, { password: 'hunter22' });
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await hasPassword(plainId)).toBe(true);
    const locked = await mint(person, deckId, { name: 'locked-pro', password: 'hunter22' });
    expect(locked.status, await locked.clone().text()).toBe(201);
    lockedUnderProId = (await readJson(locked)).shareToken.id;
    expect(await hasPassword(lockedUnderProId)).toBe(true);
  });

  it('back on free, removing a password is never refused, and a set password stays a fact', async () => {
    await setPlan(person, 'free');
    const removed = await patchToken(person, deckId, plainId, { password: null });
    expect(removed.status, await removed.clone().text()).toBe(200);
    expect(await hasPassword(plainId)).toBe(false);
    expect(await hasPassword(lockedUnderProId)).toBe(true);
  });
});

describe('the password refusal on the three surfaces', () => {
  let person: Person;
  let deckId: string;

  beforeAll(async () => {
    person = await hubPerson(owner('hub-plan-surfaces', ORG_SURFACES, 'surfaces@planlimits.test'));
    deckId = await makeDeck(person);
  });

  it('the dashboard (a session)', async () => {
    await expectPlanRequired(
      await mint(person, deckId, { name: 'locked', password: 'hunter22' }, dashboard(person)),
      ORG_SURFACES,
      'deck.password',
      PASSWORD_MESSAGE
    );
  });

  it('the CLI (an API key)', async () => {
    await expectPlanRequired(
      await mint(person, deckId, { name: 'locked', password: 'hunter22' }, cli(person)),
      ORG_SURFACES,
      'deck.password',
      PASSWORD_MESSAGE
    );
  });

  it('an agent (the MCP tool): the text names the code and the upgrade link, and nothing was posted', async () => {
    const result = await mcpTool(person.key, 'slideless_add_share_token', {
      workspace: person.workspaceId,
      presentationId: deckId,
      name: 'locked',
      password: 'hunter22'
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('code: plan_required');
    expect(result.text).toContain(
      `Upgrade: ${expectedUpgradeUrl(ORG_SURFACES, 'free', 'deck.password', 'pro')}`
    );
    await expectNothingPosted(ORG_SURFACES, 'share_tokens.create', 0);
    expect(await liveShareLinks(person, deckId)).toBe(0);
  });
});

describe('a pro account passes all of it', () => {
  let person: Person;
  let deckId: string;

  beforeAll(async () => {
    hub.setEntitlements(ORG_PRO, { plan: 'pro' });
    person = await hubPerson(owner('hub-plan-pro', ORG_PRO, 'pro@planlimits.test'));
    deckId = await makeDeck(person);
  });

  it('a fourth collaborator, an eleventh link and a locked link are each accepted', async () => {
    for (const n of [1, 2, 3, 4]) {
      const res = await invite(person, deckId, `p${n}@pro.test`);
      expect(res.status, await res.clone().text()).toBe(201);
    }
    for (let n = 1; n <= 11; n++) {
      const res = await mint(person, deckId, { name: `pro-${n}` });
      expect(res.status, await res.clone().text()).toBe(201);
    }
    const locked = await mint(person, deckId, { name: 'pro-locked', password: 'hunter22' });
    expect(locked.status, await locked.clone().text()).toBe(201);
    expect((await readJson(locked)).shareToken.hasPassword).toBe(true);
    expect(await liveShareLinks(person, deckId)).toBe(12);
  });
});

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * P7, the MCP leg: on a hub-origin (projected) workspace, MCP needs zero
 * changes — tools re-enter /api/v1 in-process, so the membership gating and
 * the new /me signals apply to them as to any caller. Split out of
 * hub-managed-membership.test.ts when that file became part of the chassis
 * suite (`packages/chassis-server/test/integration`): these three `it`s call
 * the deck MCP tools, so they stay with the app. Same fixtures the original
 * ran on: a cloud instance, a hub owner whose first SSO login projects ORG_A,
 * and that owner's API key pinned to the projected workspace.
 */
const OPERATOR = { email: 'operator@p7.test', name: 'Operator', password: 'operator-pass-p7-1' };
const ORG_A = '77777777-aaaa-4bbb-8ccc-000000000001';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

let hubAdminCookie: string;
/** ORG_A's lazy projection — hub-origin (centralAccountId = ORG_A). */
let projectedWorkspaceId: string;
/** hubAdmin's API key, bound to the projected workspace at mint. */
let projectedKey: string;

let ipCounter = 0;
const nextIp = () => `10.96.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

const hubAdmin: HubUserFixture = {
  sub: 'hub-admin-p7',
  email: 'hub-admin@p7.test',
  name: 'Hub Admin',
  workspaceId: ORG_A,
  role: 'owner',
  workspaceName: 'Org A'
};

let rpcId = 0;
async function mcp(method: string, params: unknown = {}) {
  const res = await app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      authorization: `Bearer ${projectedKey}`
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

beforeAll(async () => {
  [container, hub] = await Promise.all([startPostgres(), FakeHub.start()]);
  app = await createTestApp(await createDatabase(container, 'p7_hub_managed_mcp'), {
    EDITION: 'cloud',
    HUB_ISSUER_URL: hub.issuer,
    HUB_CLIENT_ID: 'tool-slideless-cloud',
    HUB_CLIENT_SECRET: 'integration-test-hub-secret-p7'
  });

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'P7 Cloud', owner: OPERATOR })
  );
  expect(setup.status).toBe(201);
  await sso.seedLocalWorkspace(app, 'P7 Cloud', OPERATOR.email);

  // The first login lazily projects the org into a workspace.
  hubAdminCookie = await sso.ssoLogin(app, hub, hubAdmin);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie: hubAdminCookie } }));
  projectedWorkspaceId = me.activeWorkspaceId;

  // hubAdmin's API key, minted from the session and PINNED to the projected
  // workspace, as in hub-managed-membership.test.ts.
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json(
        {
          name: 'p7-key',
          scopes: ['presentations:read', 'presentations:write'],
          workspaceId: projectedWorkspaceId
        },
        { cookie: hubAdminCookie, 'x-workspace-id': projectedWorkspaceId }
      )
    )
  );
  projectedKey = minted.key;
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('MCP is unaffected (zero MCP code changes)', () => {
  it('the tool surface exposes NO workspace-membership tool — only the sanctioned per-deck collaborator pair', async () => {
    const result = await mcp('tools/list');
    const names = result.tools.map((t: { name: string }) => t.name);
    expect(names.length).toBeGreaterThan(0);
    // The per-deck collaborator surface (ADR 013) is the sanctioned local
    // path and STAYS; nothing touches /members or /invitations.
    expect(names.filter((n: string) => /member|invit/i.test(n)).sort()).toEqual([
      'slideless_invite_collaborator',
      'slideless_uninvite_collaborator'
    ]);
  });

  it('whoami re-enters /api/v1 in-process and carries the new /me signals', async () => {
    const result = await mcp('tools/call', { name: 'slideless_whoami', arguments: {} });
    const me = JSON.parse(result.content[0].text);
    expect(me.workspace.hubOrigin).toBe(true);
    expect(me.origin).toBe('hub');
    expect(me.hubManageUrl).toBe(hub.issuer);
  });

  it('per-deck write + read on the projected workspace work through MCP', async () => {
    const uploaded = await mcp('tools/call', {
      name: 'slideless_upload_html_presentation',
      arguments: { title: 'P7 Deck', html: '<!doctype html><html><body><h1>p7</h1></body></html>' }
    });
    const deck = JSON.parse(uploaded.content[0].text);
    expect(deck.presentation.id).toBeTruthy();
    const fetched = await mcp('tools/call', {
      name: 'slideless_get_presentation',
      arguments: { presentationId: deck.presentation.id }
    });
    const body = JSON.parse(fetched.content[0].text);
    expect(body.title).toBe('P7 Deck');
  });
});

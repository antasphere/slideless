import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { FakeHub, type HubUserFixture } from '@antasphere/chassis-server/testing';
import { IDENTITY } from '@slideless/contract';
import { createDatabase, createTestApp, readJson, startPostgres, type TestApp } from './helpers.js';
import * as sso from './sso-helpers.js';

/**
 * The billing rail's phase 1 on Slideless (PRDCT-2626), on the cloud edition
 * against the stub hub that speaks lane A's contract: ONE metered route,
 * the deck asset upload, declared once in the contract and traversed by the
 * three surfaces — the dashboard (a session), the CLI (an API key, what the
 * SDK sends) and an agent (the in-process MCP tool, which re-enters
 * /api/v1) — each landing its event in the hub's usage_events with its
 * `via`; a plan refusal carrying the upgrade link on the three surfaces
 * (the MCP tool's text included); and discovery showing the Slideless
 * seed (the five actions, the three limits, the two features). The chassis
 * suite (entitlements.test.ts, run under this host too) pins the oss half
 * and the poster's retries.
 */

const OPERATOR = { email: 'operator@meter.test', name: 'Operator', password: 'operator-meter-pass-1' };
const ORG_OK = '77777777-aaaa-4bbb-8ccc-00000000ab01';
const ORG_TIGHT = '77777777-aaaa-4bbb-8ccc-00000000ab02';
const HUB_SECRET = 'integration-test-hub-secret-meter';
const HTML = '<!doctype html><html><head><title>Metered</title></head><body><h1>Hello</h1></body></html>';

let container: StartedPostgreSqlContainer;
let hub: FakeHub;
let app: TestApp;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': sso.nextIp(), ...headers },
  body: JSON.stringify(body)
});

interface Person {
  cookie: string;
  workspaceId: string;
  key: string;
  sub: string;
}

async function hubPerson(fixture: HubUserFixture): Promise<Person> {
  const cookie = await sso.ssoLogin(app, hub, fixture);
  const me = await readJson(await app.app.request('/api/v1/me', { headers: { cookie } }));
  const minted = await readJson(
    await app.app.request(
      '/api/v1/api-keys',
      json(
        {
          name: 'meter-key',
          scopes: ['presentations:read', 'presentations:write'],
          workspaceId: me.activeWorkspaceId
        },
        { cookie, 'x-workspace-id': me.activeWorkspaceId }
      )
    )
  );
  return { cookie, workspaceId: me.activeWorkspaceId, key: minted.key, sub: fixture.sub };
}

/** A multipart upload as a client sends it on the wire: the encoded bytes with their Content-Length. */
async function uploadAsset(headers: Record<string, string>, bytes: Buffer) {
  const form = new FormData();
  form.set('sha256', createHash('sha256').update(bytes).digest('hex'));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  const encoded = new Response(form);
  const body = await encoded.arrayBuffer();
  return app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: {
      'x-forwarded-for': sso.nextIp(),
      'content-type': encoded.headers.get('content-type')!,
      'content-length': String(body.byteLength),
      ...headers
    },
    body
  });
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

beforeAll(async () => {
  [container, hub] = await Promise.all([
    startPostgres(),
    FakeHub.start({ clientId: 'tool-slideless-cloud', clientSecret: HUB_SECRET })
  ]);
  app = await createTestApp(
    await createDatabase(container, 'metering_cloud'),
    {
      EDITION: 'cloud',
      HUB_ISSUER_URL: hub.issuer,
      HUB_CLIENT_ID: 'tool-slideless-cloud',
      HUB_CLIENT_SECRET: HUB_SECRET
    },
    { usageRetry: { limit: 3, delaySeconds: 1 } }
  );
  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Meter Cloud', owner: OPERATOR })
  );
  expect(setup.status).toBe(201);
}, 180_000);

afterAll(async () => {
  await app?.stop();
  await Promise.all([container?.stop(), hub?.stop()]);
});

describe('discovery carries the Slideless seed', () => {
  it('the five actions, the three limits with the cap as the free value, the two features', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    expect(info.entitlements.actions.map((a: { key: string }) => a.key).sort()).toEqual(
      [
        'collaborators.invite',
        'files.upload',
        'presentations.commit',
        'share_tokens.create',
        'workspace.export'
      ].sort()
    );
    expect(info.entitlements.limits).toEqual({
      'files.maxBytes': { oss: 100 * 1024 * 1024, free: 100 * 1024 * 1024, pro: 500 * 1024 * 1024 },
      'workspace.members': { oss: null, free: 3, pro: null },
      'links.perDeck': { oss: null, free: 10, pro: null }
    });
    expect(info.entitlements.features).toEqual({
      custom_domain: { free: false, pro: true },
      'deck.password': { free: false, pro: true }
    });
  });
});

describe('one metered route, three surfaces, every event in the hub', () => {
  let person: Person;

  beforeAll(async () => {
    person = await hubPerson({
      sub: 'hub-meter-ok',
      email: 'ok@meter.test',
      name: 'Meter OK',
      workspaceId: ORG_OK,
      role: 'owner',
      workspaceName: 'Org OK'
    });
  });

  it('the dashboard (a session) uploads: via session, the file it created, the hub sub', async () => {
    const res = await uploadAsset(
      { cookie: person.cookie, 'x-workspace-id': person.workspaceId },
      Buffer.from(HTML)
    );
    expect(res.status).toBe(201);
    const { sizeBytes } = await readJson(res);
    await until(
      () => events().length,
      (n) => n >= 1
    );
    expect(events()[0]).toMatchObject({
      actionKey: 'files.upload',
      quantity: sizeBytes,
      unit: 'bytes',
      workspaceId: person.workspaceId,
      accountRef: ORG_OK,
      userId: person.sub,
      via: 'session',
      resourceType: 'file',
      toolSlug: IDENTITY.slug,
      source: { edition: 'cloud' }
    });
  });

  it('the CLI (an API key, the SDK’s call) uploads: via api_key', async () => {
    const res = await uploadAsset(
      { authorization: `Bearer ${person.key}` },
      Buffer.from(HTML + '<!-- cli -->')
    );
    expect(res.status).toBe(201);
    await until(
      () => events().length,
      (n) => n >= 2
    );
    expect(events()[1]).toMatchObject({
      actionKey: 'files.upload',
      via: 'api_key',
      userId: person.sub,
      accountRef: ORG_OK
    });
  });

  it('an agent (the MCP upload tool, in process) uploads and publishes: files.upload then presentations.commit', async () => {
    const before = events().length;
    const result = await mcpTool(person.key, 'slideless_upload_html_presentation', {
      html: HTML + '<!-- mcp -->'
    });
    expect(result.isError, result.text).toBe(false);
    await until(
      () => events().length,
      (n) => n >= before + 2
    );
    const mine = events().slice(before);
    expect(mine.map((e) => e.actionKey).sort()).toEqual(['files.upload', 'presentations.commit']);
    expect(mine.every((e) => e.via === 'api_key' && e.accountRef === ORG_OK && e.userId === person.sub)).toBe(
      true
    );
    const commit = mine.find((e) => e.actionKey === 'presentations.commit')!;
    expect(commit).toMatchObject({ quantity: 1, unit: 'call', resourceType: 'presentation' });
    expect(hub.usageRequests.every((r) => /^Bearer mach_/.test(r.auth ?? ''))).toBe(true);
  });

  it('a share link is metered too; a free route (the upload session) is not', async () => {
    const before = events().length;
    const created = await readJson(
      await app.app.request(
        '/api/v1/presentations/uploads',
        json({}, { authorization: `Bearer ${person.key}` })
      )
    );
    // The upload session is free (not declared): no event for it.
    expect(created.uploadSession.id).toBeTruthy();
    const list = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${person.key}`, 'x-forwarded-for': sso.nextIp() }
    });
    const deckId = (await readJson(list)).presentations[0].id as string;
    const token = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'meter' }, { authorization: `Bearer ${person.key}` })
    );
    expect(token.status, await token.text()).toBe(201);
    await until(
      () => events().length,
      (n) => n >= before + 1
    );
    expect(
      events()
        .slice(before)
        .map((e) => e.actionKey)
    ).toEqual(['share_tokens.create']);
  });
});

describe('a plan refusal carries the upgrade link on the three surfaces', () => {
  let tight: Person;

  beforeAll(async () => {
    hub.setEntitlements(ORG_TIGHT, { plan: 'free', limits: { 'files.maxBytes': 10 } });
    tight = await hubPerson({
      sub: 'hub-meter-tight',
      email: 'tight@meter.test',
      name: 'Meter Tight',
      workspaceId: ORG_TIGHT,
      role: 'owner',
      workspaceName: 'Org Tight'
    });
  });

  const expectPlanRequired = async (res: Response) => {
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan: 'free',
      requiredPlan: 'pro',
      upgradeUrl: hub.issuer
    });
  };

  it('the dashboard (a session)', async () => {
    await expectPlanRequired(
      await uploadAsset({ cookie: tight.cookie, 'x-workspace-id': tight.workspaceId }, Buffer.from(HTML))
    );
  });

  it('the CLI (an API key)', async () => {
    await expectPlanRequired(await uploadAsset({ authorization: `Bearer ${tight.key}` }, Buffer.from(HTML)));
  });

  it('an agent (the MCP tool): the text names the code and the upgrade link, and nothing is posted', async () => {
    const posted = hub.usageEvents.size;
    const result = await mcpTool(tight.key, 'slideless_upload_html_presentation', { html: HTML });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('code: plan_required');
    expect(result.text).toContain(`Upgrade: ${hub.issuer}`);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageEvents.size).toBe(posted);
  });
});

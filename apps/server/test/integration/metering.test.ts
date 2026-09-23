import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { declaredCredits } from '@antasphere/chassis-contract';
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
 *
 * The pair's lessons (lane D of the billing rail wave): the event never
 * names the tool and the fake hub's registry slug is `slideless-cloud`, not
 * the identity slug, so a stamped body would be refused here as the real
 * hub refuses it (PRDCT-2629); a plan refusal is proven on the PHASE-1
 * profile with a declared size over the real cap, the body limit deferred
 * behind the gate (PRDCT-2632); the upload price is pinned from the
 * declaration (PRDCT-2627).
 *
 * Phase 2 (PRDCT-2664, PRDCT-2652, PRDCT-2653): the app boots with no reuse
 * of a credit-check answer, so every metered request asks the hub; the plan
 * refusal links the hub's upgrade page with the key and the required plan
 * appended; the pro upload value is the operator's cap; the last two
 * describes price the actions at the fake hub and pin the check, the debit,
 * the 402 on the three surfaces, the fail-open and the 411.
 */

const OPERATOR = { email: 'operator@meter.test', name: 'Operator', password: 'operator-meter-pass-1' };
const ORG_OK = '77777777-aaaa-4bbb-8ccc-00000000ab01';
const ORG_TIGHT = '77777777-aaaa-4bbb-8ccc-00000000ab02';
const HUB_SECRET = 'integration-test-hub-secret-meter';
const METRICS_TOKEN = 'integration-metrics-token-meter';
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

/** The multipart encoding of one deck asset, as a client builds it before it sends. */
async function encodeAsset(bytes: Buffer): Promise<{ body: ArrayBuffer; contentType: string }> {
  const form = new FormData();
  form.set('sha256', createHash('sha256').update(bytes).digest('hex'));
  form.set('file', new Blob([new Uint8Array(bytes)], { type: 'text/html' }), 'index.html');
  const encoded = new Response(form);
  return { body: await encoded.arrayBuffer(), contentType: encoded.headers.get('content-type')! };
}

/**
 * Send an encoded asset. `contentLength` is the declared size; null sends NO
 * Content-Length at all (`app.request` builds a Request, which carries no
 * such header for a buffer body: the gate sees none).
 */
function postAsset(
  headers: Record<string, string>,
  asset: { body: ArrayBuffer; contentType: string },
  contentLength: number | null
) {
  return app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: {
      'x-forwarded-for': sso.nextIp(),
      'content-type': asset.contentType,
      ...(contentLength === null ? {} : { 'content-length': String(contentLength) }),
      ...headers
    },
    body: asset.body
  });
}

/**
 * A multipart upload as a client sends it on the wire: the encoded bytes
 * with their Content-Length. `declaredLength` overrides the header: a size
 * refusal happens on the declared size BEFORE a byte is read, so a header
 * alone proves it without a 200 MB body in memory.
 */
async function uploadAsset(headers: Record<string, string>, bytes: Buffer, declaredLength?: number) {
  const asset = await encodeAsset(bytes);
  return postAsset(headers, asset, declaredLength ?? asset.body.byteLength);
}

/**
 * The upgrade link of a plan refusal: the hub's upgrade page for the
 * organization (`org`, `tool`, `plan`, as the fake hub's entitlements answer
 * spells it), the refused `key` and the `requiredPlan` appended by the gate
 * (no `requiredPlan` when no tier allows the value).
 */
function expectedUpgradeUrl(org: string, plan: string, key: string, requiredPlan: string | null): string {
  const url = new URL(`${hub.issuer}/billing/upgrade`);
  url.searchParams.set('org', org);
  url.searchParams.set('tool', hub.toolSlug);
  url.searchParams.set('plan', plan);
  url.searchParams.set('key', key);
  if (requiredPlan !== null) url.searchParams.set('requiredPlan', requiredPlan);
  return url.toString();
}

const MB = 1024 * 1024;

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
      HUB_CLIENT_SECRET: HUB_SECRET,
      METRICS_TOKEN
    },
    {
      usageRetry: { limit: 3, delaySeconds: 1 },
      // Every metered request asks the hub's credit check (no reuse of an
      // answer), so each test sees its own check at the fake (PRDCT-2664).
      entitlementCheckDials: { allowTtlMs: 0, denyTtlMs: 0 }
    }
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
  it('the five actions, the three limits with the cap as the free and the pro value, the two features', async () => {
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
      // What discovery advertises is what the instance serves (PRDCT-2653):
      // the pro value IS the operator's cap (100 MB by default here).
      'files.maxBytes': { oss: 100 * 1024 * 1024, free: 100 * 1024 * 1024, pro: 100 * 1024 * 1024 },
      'workspace.members': { oss: null, free: 3, pro: null },
      'links.perDeck': { oss: null, free: 10, pro: null }
    });
    expect(info.entitlements.features).toEqual({
      custom_domain: { free: false, pro: true },
      'deck.password': { free: false, pro: true }
    });
  });

  it('the upload action is metered in bytes and priced per MB: a 20 MB deck is 100 credits, never six digits (PRDCT-2627)', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    const upload = info.entitlements.actions.find((a: { key: string }) => a.key === 'files.upload');
    expect(upload).toMatchObject({
      creditsPerUnit: 5,
      unit: 'bytes',
      per: MB,
      label: 'Upload deck files (5 credits per MB)'
    });
    const credits = declaredCredits(upload, 20 * MB);
    expect(credits).toBe(100);
    expect(credits).toBeLessThan(100_000);
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
      source: { edition: 'cloud' }
    });
    // The body never names the tool (PRDCT-2629): the hub records the token's
    // registry slug, which is NOT the identity slug.
    const posted = (hub.usageRequests.at(-1)!.body as { events: Array<Record<string, unknown>> }).events;
    expect(posted.every((e) => !('toolSlug' in e))).toBe(true);
    expect(hub.toolSlug).toBe('slideless-cloud');
    expect(hub.toolSlug).not.toBe(IDENTITY.slug);
    expect(events()[0]).toMatchObject({ toolSlug: 'slideless-cloud' });
  });

  it('the CLI (an API key, the SDK’s call) uploads: via api_key', async () => {
    const res = await uploadAsset(
      { authorization: `Bearer ${person.key}` },
      Buffer.from(HTML + '<!-- cli -->')
    );
    expect(res.status).toBe(201);
    const { sizeBytes } = await readJson(res);
    const mine = () => events().find((e) => e.via === 'api_key' && e.quantity === sizeBytes);
    await until(mine, (e) => Boolean(e));
    expect(mine()).toMatchObject({
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

describe('an idempotency replay is metered once', () => {
  it('the same share link created twice under one Idempotency-Key lands one event', async () => {
    const person = await hubPerson({
      sub: 'hub-meter-idem',
      email: 'idem@meter.test',
      name: 'Meter Idem',
      workspaceId: '77777777-aaaa-4bbb-8ccc-00000000ab03',
      role: 'owner',
      workspaceName: 'Org Idem'
    });
    const result = await mcpTool(person.key, 'slideless_upload_html_presentation', {
      html: HTML + '<!-- idem -->'
    });
    expect(result.isError, result.text).toBe(false);
    const list = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${person.key}`, 'x-forwarded-for': sso.nextIp() }
    });
    const deckId = (await readJson(list)).presentations[0].id as string;
    await until(
      () => events().filter((e) => e.accountRef === '77777777-aaaa-4bbb-8ccc-00000000ab03').length,
      (n) => n >= 2
    );
    const before = events().length;
    const key = `meter-idem-${Date.now()}`;
    const first = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'idem' }, { authorization: `Bearer ${person.key}`, 'idempotency-key': key })
    );
    expect(first.status, await first.clone().text()).toBe(201);
    const replay = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'idem' }, { authorization: `Bearer ${person.key}`, 'idempotency-key': key })
    );
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotency-replayed')).toBe('true');
    await until(
      () => events().length,
      (n) => n >= before + 1
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect(
      events()
        .slice(before)
        .map((e) => e.actionKey)
    ).toEqual(['share_tokens.create']);
  });
});

describe('a plan refusal on the phase-1 profile: the gate sees the declared size before the body limit (PRDCT-2632)', () => {
  // The phase-1 hub sends an empty `limits`: the free cap IS the instance cap
  // (100 MB). A 200 MB upload used to meet the tool's multipart body limit
  // (cap + 1 MiB, installed before the gate) as 413 file_too_large with no
  // upgrade link, on every surface; only a size within 1 MiB above the cap
  // reached the gate. The header alone is the proof: nothing reads the body.
  const ORG_FREE = '77777777-aaaa-4bbb-8ccc-00000000ab04';
  const ORG_PRO = '77777777-aaaa-4bbb-8ccc-00000000ab05';
  let free: Person;
  let pro: Person;

  beforeAll(async () => {
    hub.setEntitlements(ORG_PRO, { plan: 'pro' });
    free = await hubPerson({
      sub: 'hub-meter-free',
      email: 'free@meter.test',
      name: 'Meter Free',
      workspaceId: ORG_FREE,
      role: 'owner',
      workspaceName: 'Org Free'
    });
    pro = await hubPerson({
      sub: 'hub-meter-pro',
      email: 'pro@meter.test',
      name: 'Meter Pro',
      workspaceId: ORG_PRO,
      role: 'owner',
      workspaceName: 'Org Pro'
    });
  });

  // On this host pro = the cap = 100 MB (PRDCT-2653), so no tier allows a
  // size above 100 MB: the refusal names no required plan.
  const expectPlanRequired = async (
    res: Response,
    org: string,
    plan: 'free' | 'pro',
    requiredPlan: 'pro' | null
  ) => {
    expect(res.status).toBe(403);
    const body = await readJson(res);
    expect(body.error.code).toBe('plan_required');
    expect(body.error.details).toEqual({
      key: 'files.maxBytes',
      plan,
      requiredPlan,
      upgradeUrl: expectedUpgradeUrl(org, plan, 'files.maxBytes', requiredPlan)
    });
  };

  it('the dashboard (a session): 200 MB declared on the free plan answers 403 with the upgrade link, not the instance cap', async () => {
    await expectPlanRequired(
      await uploadAsset(
        { cookie: free.cookie, 'x-workspace-id': free.workspaceId },
        Buffer.from(HTML),
        200 * MB
      ),
      ORG_FREE,
      'free',
      null
    );
  });

  it('the CLI (an API key): the same at 200 MB, and at 100.5 MB', async () => {
    await expectPlanRequired(
      await uploadAsset({ authorization: `Bearer ${free.key}` }, Buffer.from(HTML), 200 * MB),
      ORG_FREE,
      'free',
      null
    );
    await expectPlanRequired(
      await uploadAsset({ authorization: `Bearer ${free.key}` }, Buffer.from(HTML), 100 * MB + MB / 2),
      ORG_FREE,
      'free',
      null
    );
  });

  it('a pro account (pro = the instance cap, 100 MB) meets its own plan limit at 200 MB: 403 plan_required, no tier allows it', async () => {
    await expectPlanRequired(
      await uploadAsset({ authorization: `Bearer ${pro.key}` }, Buffer.from(HTML), 200 * MB),
      ORG_PRO,
      'pro',
      null
    );
  });

  it('nothing was posted for any refusal, and a small upload still lands', async () => {
    const before = hub.usageEvents.size;
    await new Promise((r) => setTimeout(r, 1_500));
    expect(hub.usageEvents.size).toBe(before);
    const ok = await uploadAsset(
      { authorization: `Bearer ${free.key}` },
      Buffer.from(HTML + '<!-- free -->')
    );
    expect(ok.status).toBe(201);
    const { sizeBytes } = await readJson(ok);
    await until(
      () => events().some((e) => e.accountRef === ORG_FREE && e.quantity === sizeBytes),
      (landed) => landed
    );
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
      upgradeUrl: expectedUpgradeUrl(ORG_TIGHT, 'free', 'files.maxBytes', 'pro')
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
    expect(result.text).toContain(
      `Upgrade: ${expectedUpgradeUrl(ORG_TIGHT, 'free', 'files.maxBytes', 'pro')}`
    );
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageEvents.size).toBe(posted);
  });
});

describe('the pair’s finding, pinned on the stub (PRDCT-2629)', () => {
  it('a body that stamps the identity slug is refused by the hub as tool_mismatch — what the pair found (PRDCT-2629)', async () => {
    const mint = await fetch(`${hub.issuer}/api/v1/auth/oauth2/token`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${Buffer.from(`tool-slideless-cloud:${HUB_SECRET}`).toString('base64')}`
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        scope: 'usage:write',
        resource: hub.apiResource
      })
    });
    expect(mint.status).toBe(200);
    const { access_token } = (await mint.json()) as { access_token: string };
    const landed = events().find((e) => e.actionKey === 'files.upload')!;
    const stamped = { ...landed, id: '01JZZZZZZZZZZZZZZZZZZZZZZ2', toolSlug: IDENTITY.slug };
    const unstamped = { ...landed, id: '01JZZZZZZZZZZZZZZZZZZZZZZ3' };
    delete (unstamped as { toolSlug?: string }).toolSlug;
    const res = await fetch(`${hub.issuer}/api/v1/usage/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${access_token}` },
      body: JSON.stringify({ events: [stamped, unstamped] })
    });
    expect(res.status).toBe(200);
    const answer = (await res.json()) as { results: Array<{ id: string; status: string; reason?: string }> };
    expect(answer.results).toEqual([
      { id: stamped.id, status: 'rejected', reason: 'tool_mismatch' },
      // An accepted result carries its credits (phase 2); no price is set yet here.
      { id: unstamped.id, status: 'accepted', credits: 0 }
    ]);
  });
});

const metric = async (name: string): Promise<number> => {
  const res = await app.app.request('/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
  expect(res.status).toBe(200);
  const line = (await res.text())
    .split('\n')
    .find((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  return line ? Number(line.split(' ').at(-1)) : 0;
};

const debitsOf = (org: string) => hub.ledger.filter((l) => l.kind === 'debit' && l.accountRef === org);

describe('the check goes live: the hub is asked before a priced action (PRDCT-2664)', () => {
  // Runs after every phase-1 case above: the prices set here are the hub's
  // price book for the rest of the file.
  const ORG_CHECK = '77777777-aaaa-4bbb-8ccc-00000000ab06';
  let person: Person;
  const eventsOf = () => events().filter((e) => e.accountRef === ORG_CHECK);
  const dashboard = () => ({ cookie: person.cookie, 'x-workspace-id': person.workspaceId });
  const topUpUrl = (credits: number, balance: number) =>
    `${hub.issuer}/billing/top-up?org=${ORG_CHECK}&credits=${credits}&balance=${balance}&tool=${hub.toolSlug}&action=files.upload`;

  beforeAll(async () => {
    hub.setPrice('files.upload', { creditsPerUnit: 5, unit: 'bytes', per: 1024 * 1024 });
    hub.setPrice('presentations.commit', { creditsPerUnit: 50, unit: 'call' });
    person = await hubPerson({
      sub: 'hub-meter-check',
      email: 'check@meter.test',
      name: 'Meter Check',
      workspaceId: ORG_CHECK,
      role: 'owner',
      workspaceName: 'Org Check'
    });
  });

  const expectShort = async (res: Response) => {
    expect(res.status).toBe(402);
    const body = await readJson(res);
    expect(body.error.code).toBe('entitlement_denied');
    expect(body.error.details).toEqual({ credits: 5, balance: 0, topUpUrl: topUpUrl(5, 0) });
    expect(body.error.details.topUpUrl.startsWith(`${hub.issuer}/billing/top-up?org=${ORG_CHECK}`)).toBe(
      true
    );
    expect(body.error.message).toContain(topUpUrl(5, 0));
  };

  it('the dashboard uploads: the hub is asked with the machine token and the declared size, then debits the stored size at ingest', async () => {
    const balance = hub.balanceOf(ORG_CHECK);
    const checks = hub.checkRequests.length;
    const asset = await encodeAsset(Buffer.from(HTML + '<!-- check -->'));
    const res = await postAsset(dashboard(), asset, asset.body.byteLength);
    expect(res.status).toBe(201);
    const { sizeBytes } = await readJson(res);
    expect(hub.checkRequests).toHaveLength(checks + 1);
    expect(hub.checkRequests.at(-1)).toEqual({
      auth: expect.stringMatching(/^Bearer mach_/),
      // What the gate asks with: the declared Content-Length of the multipart body.
      body: {
        accountRef: ORG_CHECK,
        actionKey: 'files.upload',
        quantity: asset.body.byteLength,
        unit: 'bytes'
      }
    });
    await until(
      () => eventsOf().length,
      (n) => n >= 1
    );
    const [eventId, event] = [...hub.usageEvents.entries()].find(([, e]) => e.accountRef === ORG_CHECK)!;
    expect(event).toMatchObject({ actionKey: 'files.upload', quantity: sizeBytes, unit: 'bytes' });
    // The STORED size, at 5 credits per MiB rounded up to the MiB.
    const credits = Math.ceil(sizeBytes / MB) * 5;
    expect(credits).toBe(5);
    expect(hub.balanceOf(ORG_CHECK)).toBe(balance - credits);
    expect(debitsOf(ORG_CHECK)).toEqual([
      { accountRef: ORG_CHECK, kind: 'debit', amount: -credits, sourceRef: eventId }
    ]);
  });

  it('a balance below the price: the dashboard meets 402 entitlement_denied with the top-up link, and nothing is posted', async () => {
    hub.setBalance(ORG_CHECK, 0);
    const posted = hub.usageEvents.size;
    await expectShort(await uploadAsset(dashboard(), Buffer.from(HTML + '<!-- check -->')));
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageEvents.size).toBe(posted);
    expect(hub.balanceOf(ORG_CHECK)).toBe(0);
  });

  it('the CLI (an API key): the same 402 with the same details', async () => {
    await expectShort(
      await uploadAsset({ authorization: `Bearer ${person.key}` }, Buffer.from(HTML + '<!-- check -->'))
    );
  });

  it('an agent (the MCP tool): the text names the code, the top-up link, the price and the balance, and nothing is posted', async () => {
    const posted = hub.usageEvents.size;
    const result = await mcpTool(person.key, 'slideless_upload_html_presentation', {
      html: HTML + '<!-- check mcp -->'
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('code: entitlement_denied');
    expect(result.text).toContain(`Top up: ${hub.issuer}/billing/top-up?org=${ORG_CHECK}`);
    expect(result.text).toContain('this needs 5 credits, the organization holds 0');
    await new Promise((r) => setTimeout(r, 2_500));
    expect(hub.usageEvents.size).toBe(posted);
  });

  it('the balance restored, the dashboard upload lands and is debited once more', async () => {
    hub.setBalance(ORG_CHECK, 5_000);
    const debits = debitsOf(ORG_CHECK).length;
    const res = await uploadAsset(dashboard(), Buffer.from(HTML + '<!-- check restored -->'));
    expect(res.status).toBe(201);
    await until(
      () => debitsOf(ORG_CHECK).length,
      (n) => n >= debits + 1
    );
    expect(debitsOf(ORG_CHECK)).toHaveLength(debits + 1);
    expect(hub.balanceOf(ORG_CHECK)).toBe(5_000 - 5);
  });

  it('a share link with no price row is checked and allowed at 0 credits: no debit, the balance unmoved', async () => {
    // A deck to share: the agent publishes one (an upload and a commit, both priced).
    const before = eventsOf().length;
    const published = await mcpTool(person.key, 'slideless_upload_html_presentation', {
      html: HTML + '<!-- check share -->'
    });
    expect(published.isError, published.text).toBe(false);
    await until(
      () => eventsOf().length,
      (n) => n >= before + 2
    );
    const list = await app.app.request('/api/v1/presentations', {
      headers: { authorization: `Bearer ${person.key}`, 'x-forwarded-for': sso.nextIp() }
    });
    const deckId = (await readJson(list)).presentations[0].id as string;
    const balance = hub.balanceOf(ORG_CHECK);
    const debits = debitsOf(ORG_CHECK).length;
    const checks = hub.checkRequests.length;
    const token = await app.app.request(
      `/api/v1/presentations/${deckId}/tokens`,
      json({ name: 'check' }, { authorization: `Bearer ${person.key}` })
    );
    expect(token.status, await token.clone().text()).toBe(201);
    expect(hub.checkRequests).toHaveLength(checks + 1);
    expect(hub.checkRequests.at(-1)).toEqual({
      auth: expect.stringMatching(/^Bearer mach_/),
      body: { accountRef: ORG_CHECK, actionKey: 'share_tokens.create', quantity: 1, unit: 'call' }
    });
    await until(
      () => eventsOf().some((e) => e.actionKey === 'share_tokens.create'),
      (landed) => landed
    );
    const [shareId] = [...hub.usageEvents.entries()].find(
      ([, e]) => e.accountRef === ORG_CHECK && e.actionKey === 'share_tokens.create'
    )!;
    // Accepted at 0 credits: no debit carries its id and the balance did not move.
    expect(hub.ledger.some((l) => l.sourceRef === shareId)).toBe(false);
    expect(debitsOf(ORG_CHECK)).toHaveLength(debits);
    expect(hub.balanceOf(ORG_CHECK)).toBe(balance);
  });

  it('a hub that does not answer the check fails open, on /metrics; once it answers again the posture heals', async () => {
    hub.checkMode = 'network';
    try {
      const down = await uploadAsset(dashboard(), Buffer.from(HTML + '<!-- check down -->'));
      expect(down.status).toBe(201);
      expect(await metric('usage_check_posture')).toBe(1);
      expect(await metric('usage_check_total{outcome="fail_open"}')).toBeGreaterThanOrEqual(1);
    } finally {
      hub.checkMode = 'ok';
    }
    // Past the outage hold (5 s from the failed call), the next request asks the hub again.
    await new Promise((r) => setTimeout(r, 5_100));
    const up = await uploadAsset(dashboard(), Buffer.from(HTML + '<!-- check up -->'));
    expect(up.status).toBe(201);
    expect(await metric('usage_check_posture')).toBe(0);
  });
});

describe('a metered upload declares its size (PRDCT-2652)', () => {
  const ORG_LENGTH = '77777777-aaaa-4bbb-8ccc-00000000ab07';
  let person: Person;
  const dashboard = () => ({ cookie: person.cookie, 'x-workspace-id': person.workspaceId });
  const fileCount = async () => {
    const res = await app.app.request('/api/v1/files', {
      headers: { ...dashboard(), 'x-forwarded-for': sso.nextIp() }
    });
    expect(res.status).toBe(200);
    return ((await readJson(res)).files as unknown[]).length;
  };

  beforeAll(async () => {
    person = await hubPerson({
      sub: 'hub-meter-length',
      email: 'length@meter.test',
      name: 'Meter Length',
      workspaceId: ORG_LENGTH,
      role: 'owner',
      workspaceName: 'Org Length'
    });
  });

  it('an asset upload with no Content-Length is 411 length_required: no file, no check, no event', async () => {
    const files = await fileCount();
    const checks = hub.checkRequests.length;
    // Scoped to this organization: an earlier describe's last event may still be in flight.
    const posted = () => events().filter((e) => e.accountRef === ORG_LENGTH).length;
    expect(posted()).toBe(0);
    const asset = await encodeAsset(Buffer.from(HTML + '<!-- silent -->'));
    const res = await postAsset(dashboard(), asset, null);
    expect(res.status).toBe(411);
    expect((await readJson(res)).error.code).toBe('length_required');
    expect(await fileCount()).toBe(files);
    expect(hub.checkRequests).toHaveLength(checks);
    await new Promise((r) => setTimeout(r, 2_500));
    expect(posted()).toBe(0);
  });

  it('a free account at exactly the free value passes the plan check and lands (201)', async () => {
    const info = await readJson(await app.app.request('/api/v1/instance'));
    const freeBytes = info.entitlements.limits['files.maxBytes'].free as number;
    // The encoding's overhead is fixed for a given file name and type: size
    // the file so the multipart body is EXACTLY the free value.
    const probe = await encodeAsset(Buffer.from('x'));
    const overhead = probe.body.byteLength - 1;
    const asset = await encodeAsset(Buffer.alloc(freeBytes - overhead, 0x61));
    expect(asset.body.byteLength).toBe(freeBytes);
    const res = await postAsset(dashboard(), asset, asset.body.byteLength);
    expect(res.status, await res.clone().text()).toBe(201);
    expect(hub.checkRequests.at(-1)!.body).toMatchObject({
      accountRef: ORG_LENGTH,
      actionKey: 'files.upload',
      quantity: freeBytes
    });
  }, 120_000);
});

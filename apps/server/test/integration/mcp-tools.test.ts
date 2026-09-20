import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  RecordingEmailDriver,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * The slideless_ MCP tool set (Phase 7), driven as a real MCP client would:
 * raw JSON-RPC POSTs against /mcp (stateless transport, plain JSON responses)
 * authenticated with slk_ API keys.
 *
 *  - discovery: the unauthenticated 401 challenge + RFC 9728 document name
 *    THIS instance's origin (the legacy portability bug — never a hardcoded
 *    external URL)
 *  - tools/list carries the whole slideless_ set with the right annotations
 *  - the historically-fragile surface: inline upload → commit → download
 *    round-trips byte-faithfully, for the single-HTML and the multi-file
 *    (text + base64 binary + new-version) shapes
 *  - caps: decoded inline content over 768 KiB is a clean tool error naming
 *    the CLI; request bodies over 1 MiB die at the transport (413)
 *  - ADR 013 through tools: a member's key cannot read/list/push another
 *    user's deck (not_found, never 403)
 *  - scope UX: a read-only key gets the actionable "Missing scope" denial
 *  - sharing/collaborators/annotations flows incl. anonymous viewer access
 *    with the sandbox headers, send-rotation, revoke-all, and delete.
 *  - references (ADR 025): the two read tools list by type, answer the
 *    workspace default or a plain "none set", and follow the audience (a
 *    member's key sees a reference only once it is published).
 *
 * The deck side of projects (ADR 026: `projectIds` on an upload, the list
 * filter, link/unlink, the project's brand) is mcp-projects-decks.test.ts.
 */

const OWNER = { email: 'owner@mcp.test', name: 'MCP Owner', password: 'mcp-owner-password-1' };
const MEMBER = { email: 'member@mcp.test', name: 'MCP Member', password: 'mcp-member-password-1' };

const EXPECTED_TOOLS = [
  'slideless_whoami',
  'slideless_list_presentations',
  'slideless_get_presentation',
  'slideless_list_versions',
  'slideless_get_version',
  'slideless_download_version',
  'slideless_get_agent_doc',
  'slideless_list_references',
  'slideless_get_default_reference',
  'slideless_update_presentation',
  'slideless_delete_presentation',
  'slideless_upload_html_presentation',
  'slideless_upload_presentation_files',
  'slideless_get_project_brand',
  'slideless_link_presentation_to_project',
  'slideless_unlink_presentation_from_project',
  'slideless_set_project_brand',
  'slideless_add_share_token',
  'slideless_list_share_tokens',
  'slideless_list_token_views',
  'slideless_set_token_version_mode',
  'slideless_unshare_presentation',
  'slideless_share_via_email',
  'slideless_invite_collaborator',
  'slideless_uninvite_collaborator',
  'slideless_list_collaborators',
  'slideless_list_annotations',
  'slideless_list_form_responses'
];

let container: StartedPostgreSqlContainer;
let app: TestApp;
let mail: RecordingEmailDriver;
let ownerCookie: string;
let ownerKey: string;
let readOnlyKey: string;
let memberKey: string;

// Rotate forwarded IPs (TRUST_PROXY=true in tests) so the per-IP /mcp and
// invitation-wall buckets never interfere with the suite.
let ipCounter = 0;
const nextIp = () => `10.99.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': nextIp(), ...headers },
  body: JSON.stringify(body)
});

let rpcId = 0;

/** One raw JSON-RPC POST to /mcp (stateless: every request self-contained). */
async function mcpPost(key: string | null, method: string, params: unknown = {}): Promise<Response> {
  return app.app.request('/mcp', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-forwarded-for': nextIp(),
      ...(key ? { authorization: `Bearer ${key}` } : {})
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params })
  });
}

/** JSON-RPC result (throws on protocol-level errors). Untyped, like readJson. */
async function rpc(key: string, method: string, params: unknown = {}) {
  const res = await mcpPost(key, method, params);
  expect(res.status).toBe(200);
  const body = await readJson(res);
  expect(body.error, `JSON-RPC error for ${method}: ${JSON.stringify(body.error)}`).toBeUndefined();
  return body.result;
}

/** Parse a tool's JSON text block; error texts are not JSON → null. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function parseMaybe(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Call one tool; returns { isError, text, data } (data = parsed JSON text). */
async function callTool(key: string, name: string, args: Record<string, unknown> = {}) {
  const result = await rpc(key, 'tools/call', { name, arguments: args });
  const text: string = result.content?.[0]?.text ?? '';
  return { isError: result.isError === true, text, data: parseMaybe(text) };
}

async function mintKey(cookie: string, name: string, scopes: string[]): Promise<string> {
  const res = await app.app.request('/api/v1/api-keys', json({ name, scopes }, { cookie }));
  expect(res.status).toBe(201);
  return (await readJson(res)).key as string;
}

const signIn = async (who: typeof OWNER) =>
  extractCookie(
    await app.app.request('/api/v1/auth/sign-in/email', json({ email: who.email, password: who.password }))
  );

beforeAll(async () => {
  container = await startPostgres();
  mail = new RecordingEmailDriver();
  app = await createTestApp(await createDatabase(container, 'mcp_tools'), {}, { email: mail });

  const setup = await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'MCP Suite', owner: OWNER })
  );
  expect(setup.status).toBe(201);
  ownerCookie = await signIn(OWNER);
  ownerKey = await mintKey(ownerCookie, 'owner-rw', ['presentations:read', 'presentations:write']);
  readOnlyKey = await mintKey(ownerCookie, 'owner-ro', ['presentations:read']);

  // A plain member joins through an ordinary invitation and mints their own key.
  const invited = await readJson(
    await app.app.request(
      '/api/v1/invitations',
      json({ email: MEMBER.email, role: 'member' }, { cookie: ownerCookie })
    )
  );
  const accept = await app.app.request(
    '/api/v1/invitations/accept',
    json({ token: invited.acceptUrl.split('/invite/')[1], name: MEMBER.name, password: MEMBER.password })
  );
  expect(accept.status).toBe(200);
  const memberCookie = await signIn(MEMBER);
  memberKey = await mintKey(memberCookie, 'member-rw', ['presentations:read', 'presentations:write']);
}, 240_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('discovery + auth gate', () => {
  it('an unauthenticated call answers the RFC 9728 challenge naming THIS instance origin', async () => {
    const res = await mcpPost(null, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 't', version: '0' }
    });
    expect(res.status).toBe(401);
    const challenge = res.headers.get('www-authenticate') ?? '';
    // PUBLIC_BASE_URL of the test boot — never a hardcoded external origin.
    expect(challenge).toContain(
      'resource_metadata="http://localhost:3000/.well-known/oauth-protected-resource/mcp"'
    );

    const doc = await readJson(await app.app.request('/.well-known/oauth-protected-resource/mcp'));
    expect(doc.authorization_servers).toEqual(['http://localhost:3000']);
    expect(doc.resource).toBe('http://localhost:3000/mcp');
  });

  it('initialize works with an slk_ key over plain JSON', async () => {
    const result = await rpc(ownerKey, 'initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'mcp-tools-suite', version: '0.0.1' }
    });
    expect(result.serverInfo.name).toBe('slideless');
  });

  it('tools/list carries the whole slideless_ set with the right annotations', async () => {
    interface ToolInfo {
      name: string;
      description: string;
      inputSchema?: { properties?: Record<string, unknown> };
      annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
    }
    const result = await rpc(ownerKey, 'tools/list');
    const tools = result.tools as ToolInfo[];
    // Org as a parameter (user-scoped credential model): EVERY tool accepts
    // the optional `workspace` argument — chassis examples included.
    for (const tool of tools) {
      expect(tool.inputSchema?.properties?.workspace, `${tool.name} lacks the workspace arg`).toBeDefined();
    }
    const byName = new Map(tools.map((t) => [t.name, t]));
    const toolOf = (name: string): ToolInfo => {
      const tool = byName.get(name);
      expect(tool, `missing tool ${name}`).toBeDefined();
      return tool!;
    };
    for (const name of EXPECTED_TOOLS) {
      expect(byName.has(name), `missing tool ${name}`).toBe(true);
    }
    // The chassis examples stay registered.
    expect(byName.has('get_me')).toBe(true);
    expect(byName.has('list_files')).toBe(true);

    for (const name of [
      'slideless_whoami',
      'slideless_list_presentations',
      'slideless_get_presentation',
      'slideless_list_versions',
      'slideless_get_version',
      'slideless_download_version',
      'slideless_get_agent_doc',
      'slideless_list_references',
      'slideless_get_default_reference',
      'slideless_get_project_brand',
      'slideless_list_share_tokens',
      'slideless_list_token_views',
      'slideless_list_collaborators',
      'slideless_list_annotations',
      'slideless_list_form_responses'
    ]) {
      expect(toolOf(name).annotations?.readOnlyHint, ` readOnlyHint`).toBe(true);
    }
    for (const name of [
      'slideless_delete_presentation',
      'slideless_unlink_presentation_from_project',
      'slideless_unshare_presentation',
      'slideless_uninvite_collaborator'
    ]) {
      expect(toolOf(name).annotations?.destructiveHint, ` destructiveHint`).toBe(true);
      expect(toolOf(name).description).toContain('confirm with the user');
    }
    // Write tools describe themselves confirm-first.
    for (const name of [
      'slideless_upload_html_presentation',
      'slideless_upload_presentation_files',
      'slideless_link_presentation_to_project',
      'slideless_set_project_brand',
      'slideless_add_share_token',
      'slideless_share_via_email',
      'slideless_invite_collaborator',
      'slideless_set_token_version_mode'
    ]) {
      expect(toolOf(name).description, ` confirm-first`).toContain('confirm with the user');
    }
  });

  it('slideless_whoami resolves the key owner (identity from the credential, never a parameter)', async () => {
    const me = await callTool(ownerKey, 'slideless_whoami');
    expect(me.isError).toBe(false);
    expect(me.data.user.email).toBe(OWNER.email);
    expect(me.data.via).toBe('api_key');
    expect(me.data.scopes).toContain('presentations:read');
    // The org-discovery contract: whoami lists every organization with the
    // explicit default/suspended flags the workspace argument keys off.
    expect(Array.isArray(me.data.workspaces)).toBe(true);
    expect(me.data.workspaces[0]).toMatchObject({ suspended: false, default: false });
    expect(me.data.activeWorkspaceId).toBeTruthy();
  });

  it('a read-only key gets the actionable scope denial on a write tool', async () => {
    const result = await callTool(readOnlyKey, 'slideless_upload_html_presentation', {
      html: '<!doctype html><title>x</title>'
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Missing scope "presentations:write"');
    // ... while its reads still work.
    const me = await callTool(readOnlyKey, 'slideless_whoami');
    expect(me.isError).toBe(false);
  });

  it('a write-only key gets the actionable scope denial on a READ tool (PRDCT-2531, verifier F-7)', async () => {
    // The API's allowlist is the enforcement point (a key without the read scope is
    // refused `/me` whatever the tool does); the tool-level pre-check is what makes the
    // refusal a sentence the model can act on, instead of a raw 403.
    const writeOnlyKey = await mintKey(ownerCookie, 'owner-wo', ['presentations:write']);
    for (const name of ['slideless_whoami', 'get_me']) {
      const result = await callTool(writeOnlyKey, name);
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toBe(
        'Missing scope "presentations:read": this connection was not granted permission to read data. ' +
          'Reconnect the MCP server and approve the permission on the consent screen.'
      );
    }
  });
});

describe('inline upload → commit → download round-trip (the legacy-broken surface)', () => {
  const MARKER = 'the-quick-brown-mcp-round-trip-7f3a';
  const HTML = `<!doctype html><html><head><title>MCP Round Trip</title></head><body><h1>${MARKER}</h1></body></html>`;
  // 1×1 transparent PNG.
  const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  let htmlDeckId: string;
  let filesDeckId: string;

  it('slideless_upload_html_presentation creates a 1-file deck (title from <title>)', async () => {
    const result = await callTool(ownerKey, 'slideless_upload_html_presentation', { html: HTML });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.presentation.title).toBe('MCP Round Trip');
    expect(result.data.presentation.entryPath).toBe('index.html');
    expect(result.data.version.version).toBe(1);
    expect(result.data.version.fileCount).toBe(1);
    expect(result.data.uploadedBlobs).toBe(1);
    htmlDeckId = result.data.presentation.id;
    // PRDCT-2280: the deck's own page, the same address the CLI prints —
    // composed from PUBLIC_BASE_URL, never a share link.
    expect(result.data.url).toBe(`http://localhost:3000/decks/${htmlDeckId}/present`);
  });

  it('slideless_list_presentations shows it; get/versions/manifest agree', async () => {
    const list = await callTool(ownerKey, 'slideless_list_presentations');
    expect(list.data.presentations.map((p: { id: string }) => p.id)).toContain(htmlDeckId);

    const deck = await callTool(ownerKey, 'slideless_get_presentation', { presentationId: htmlDeckId });
    expect(deck.data.currentVersion).toBe(1);

    const versions = await callTool(ownerKey, 'slideless_list_versions', { presentationId: htmlDeckId });
    expect(versions.data.versions).toHaveLength(1);

    const detail = await callTool(ownerKey, 'slideless_get_version', { presentationId: htmlDeckId });
    expect(detail.data.version).toBe(1);
    expect(detail.data.manifest).toHaveLength(1);
    expect(detail.data.manifest[0].path).toBe('index.html');
  });

  it('slideless_download_version returns the exact HTML text inline', async () => {
    const dl = await callTool(ownerKey, 'slideless_download_version', { presentationId: htmlDeckId });
    expect(dl.isError, dl.text).toBe(false);
    expect(dl.data.entryPath).toBe('index.html');
    const file = dl.data.files.find((f: { path: string }) => f.path === 'index.html');
    expect(file.inlined).toBe(true);
    expect(file.content).toBe(HTML);
  });

  it('slideless_upload_presentation_files: text + base64 binary; binary comes back as a CLI note', async () => {
    const result = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      title: 'Files Deck',
      files: [
        { path: 'index.html', contentText: `<!doctype html><html><body>v1 ${MARKER}</body></html>` },
        { path: 'assets/pixel.png', contentBase64: PNG_BASE64 }
      ]
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.presentation.title).toBe('Files Deck');
    expect(result.data.version.fileCount).toBe(2);
    filesDeckId = result.data.presentation.id;

    const dl = await callTool(ownerKey, 'slideless_download_version', { presentationId: filesDeckId });
    const html = dl.data.files.find((f: { path: string }) => f.path === 'index.html');
    expect(html.inlined).toBe(true);
    expect(html.content).toContain(`v1 ${MARKER}`);
    const png = dl.data.files.find((f: { path: string }) => f.path === 'assets/pixel.png');
    expect(png.inlined).toBe(false);
    expect(png.note).toContain('slideless');
    expect(png.sizeBytes).toBe(Buffer.from(PNG_BASE64, 'base64').length);
  });

  it('a downloads/ folder makes attachments: get_version lists them, the deck says hasDownloads (PRDCT-2278)', async () => {
    const result = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      title: 'Attachments Deck',
      files: [
        { path: 'index.html', contentText: `<!doctype html><html><body>with files ${MARKER}</body></html>` },
        { path: 'downloads/report.csv', contentText: 'a,b\n1,2\n' },
        { path: 'downloads/sub/notes.md', contentText: '# notes\n' }
      ]
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.presentation.hasDownloads).toBe(true);
    expect(result.data.version.hasDownloads).toBe(true);
    const attachmentsDeckId = result.data.presentation.id as string;

    const detail = await callTool(ownerKey, 'slideless_get_version', { presentationId: attachmentsDeckId });
    expect(detail.isError, detail.text).toBe(false);
    expect(detail.data.manifest).toHaveLength(3);
    expect(detail.data.attachments).toEqual([
      expect.objectContaining({ name: 'report.csv', path: 'downloads/report.csv', contentType: 'text/csv' }),
      expect.objectContaining({ name: 'sub/notes.md', path: 'downloads/sub/notes.md' })
    ]);

    const noFiles = await callTool(ownerKey, 'slideless_get_version', { presentationId: filesDeckId });
    expect(noFiles.data.attachments).toEqual([]);

    // The link switch: on by default, off when asked.
    const on = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: attachmentsDeckId,
      name: 'downloads on'
    });
    expect(on.isError, on.text).toBe(false);
    expect(on.data.shareToken.canDownload).toBe(true);
    expect(on.data.shareToken.downloadCount).toBe(0);
    const off = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: attachmentsDeckId,
      name: 'downloads off',
      canDownload: false
    });
    expect(off.isError, off.text).toBe(false);
    expect(off.data.shareToken.canDownload).toBe(false);
    const offList = await app.app.request(`/api/v1/viewer/${off.data.secret}/attachments`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect(offList.status).toBe(200);
    expect((await readJson(offList)).attachments).toEqual([]);
    const onList = await app.app.request(`/api/v1/viewer/${on.data.secret}/attachments`, {
      headers: { 'x-forwarded-for': nextIp() }
    });
    expect((await readJson(onList)).attachments.map((a: { name: string }) => a.name)).toEqual([
      'report.csv',
      'sub/notes.md'
    ]);

    // The bar switch (PRDCT-2281, lane D): on by default, off when asked.
    expect(on.data.shareToken.showBar).toBe(true);
    const bare = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: attachmentsDeckId,
      name: 'bare',
      showBar: false
    });
    expect(bare.isError, bare.text).toBe(false);
    expect(bare.data.shareToken.showBar).toBe(false);
  });

  it('with presentationId it commits a NEW VERSION of that deck', async () => {
    const result = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      presentationId: filesDeckId,
      files: [{ path: 'index.html', contentText: `<!doctype html><html><body>v2 ${MARKER}</body></html>` }]
    });
    expect(result.isError, result.text).toBe(false);
    expect(result.data.version.version).toBe(2);
    expect(result.data.presentation.currentVersion).toBe(2);
    expect(result.data.url).toBe(`http://localhost:3000/decks/${filesDeckId}/present`);

    const latest = await callTool(ownerKey, 'slideless_download_version', { presentationId: filesDeckId });
    expect(latest.data.version).toBe(2);
    expect(latest.data.files[0].content).toContain(`v2 ${MARKER}`);

    // The older version stays pullable by number.
    const v1 = await callTool(ownerKey, 'slideless_download_version', {
      presentationId: filesDeckId,
      version: 1
    });
    expect(v1.data.files.find((f: { path: string }) => f.path === 'index.html').content).toContain(
      `v1 ${MARKER}`
    );
  });

  it('rejects duplicate paths, double content, and a missing HTML entry with clean errors', async () => {
    const dup = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      files: [
        { path: 'index.html', contentText: 'a' },
        { path: 'index.html', contentText: 'b' }
      ]
    });
    expect(dup.isError).toBe(true);
    expect(dup.text).toContain('Duplicate path');

    const both = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      files: [{ path: 'index.html', contentText: 'a', contentBase64: 'YQ==' }]
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('exactly one of contentText or contentBase64');

    const noEntry = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      files: [{ path: 'styles.css', contentText: 'body{}' }]
    });
    expect(noEntry.isError).toBe(true);
    expect(noEntry.text).toContain('No HTML entry');
  });

  it('inline content over 768 KiB is a clean tool error pointing at the CLI', async () => {
    const big = 'x'.repeat(800 * 1024);
    const result = await callTool(ownerKey, 'slideless_upload_html_presentation', {
      html: `<!doctype html><title>big</title>${big}`
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('slideless CLI');
  });

  it('a request body over 1 MiB dies at the transport cap (413)', async () => {
    const res = await app.app.request('/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${ownerKey}`,
        'x-forwarded-for': nextIp()
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'slideless_upload_html_presentation',
          arguments: { html: 'y'.repeat(1024 * 1024 + 64) }
        }
      })
    });
    expect(res.status).toBe(413);
  });
});

describe('ADR 013 through tools — a key cannot reach a deck its user cannot read', () => {
  let privateDeckId: string;

  beforeAll(async () => {
    const created = await callTool(ownerKey, 'slideless_upload_html_presentation', {
      html: '<!doctype html><title>Owner Private</title><h1>owner-only content</h1>',
      title: 'Owner Private'
    });
    expect(created.isError, created.text).toBe(false);
    privateDeckId = created.data.presentation.id;
  });

  it("the member's key gets not_found on get/download and an empty list — never a 403", async () => {
    const get = await callTool(memberKey, 'slideless_get_presentation', { presentationId: privateDeckId });
    expect(get.isError).toBe(true);
    expect(get.text).toContain('HTTP 404');
    expect(get.text).toContain('not_found');
    expect(get.text).not.toContain('403');

    const dl = await callTool(memberKey, 'slideless_download_version', { presentationId: privateDeckId });
    expect(dl.isError).toBe(true);
    expect(dl.text).toContain('not_found');

    const list = await callTool(memberKey, 'slideless_list_presentations');
    expect(list.data.presentations.map((p: { id: string }) => p.id)).not.toContain(privateDeckId);

    // Push-a-version is blocked the same way (the deck lookup 404s first).
    const push = await callTool(memberKey, 'slideless_upload_presentation_files', {
      presentationId: privateDeckId,
      files: [{ path: 'index.html', contentText: '<!doctype html><title>hijack</title>' }]
    });
    expect(push.isError).toBe(true);
    expect(push.text).toContain('not_found');
  });

  it('the owner still reads it in full (sanity)', async () => {
    const dl = await callTool(ownerKey, 'slideless_download_version', { presentationId: privateDeckId });
    expect(dl.isError).toBe(false);
    expect(dl.data.files[0].content).toContain('owner-only content');
  });
});

describe('sharing, collaborators, annotations, delete', () => {
  let deckId: string;
  let anonUrl: string;
  let rotateTokenId: string;

  beforeAll(async () => {
    const created = await callTool(ownerKey, 'slideless_upload_html_presentation', {
      html: '<!doctype html><html><head><title>Share Flow</title></head><body>share-flow-body</body></html>'
    });
    expect(created.isError, created.text).toBe(false);
    deckId = created.data.presentation.id;
  });

  it('slideless_add_share_token returns the viewer URL; anonymous GET is 200 + sandboxed', async () => {
    const token = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Alice (viewer)',
      canAnnotate: true
    });
    expect(token.isError, token.text).toBe(false);
    expect(token.data.url).toContain('/v/');
    expect(token.data.secret).toBeTruthy();
    expect(token.data.shareToken.versionMode).toBe('latest');
    anonUrl = token.data.url;

    const viewerPath = new URL(anonUrl).pathname;
    const res = await app.app.request(viewerPath, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain('sandbox');
    expect(csp).not.toContain('allow-same-origin');
    expect(await res.text()).toContain('share-flow-body');
  });

  it('slideless_set_token_version_mode pins and unpins', async () => {
    const created = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Bob (pinned)'
    });
    const tokenId = created.data.shareToken.id;
    rotateTokenId = tokenId;

    const missing = await callTool(ownerKey, 'slideless_set_token_version_mode', {
      presentationId: deckId,
      tokenId,
      mode: 'pinned'
    });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain('pinnedVersion is required');

    const pinned = await callTool(ownerKey, 'slideless_set_token_version_mode', {
      presentationId: deckId,
      tokenId,
      mode: 'pinned',
      pinnedVersion: 1
    });
    expect(pinned.isError, pinned.text).toBe(false);
    expect(pinned.data.versionMode).toBe('pinned');
    expect(pinned.data.pinnedVersion).toBe(1);

    const latest = await callTool(ownerKey, 'slideless_set_token_version_mode', {
      presentationId: deckId,
      tokenId,
      mode: 'latest'
    });
    expect(latest.data.versionMode).toBe('latest');
  });

  it('slideless_share_via_email delivers and ROTATES the link', async () => {
    const before = mail.sent.length;
    const sent = await callTool(ownerKey, 'slideless_share_via_email', {
      presentationId: deckId,
      tokenId: rotateTokenId,
      email: 'reviewer@mcp.test',
      message: 'please review'
    });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.data.emailSent).toBe(true);
    expect(mail.sent.length).toBe(before + 1);
    expect(mail.sent[before]!.to).toBe('reviewer@mcp.test');
  });

  it('slideless_list_share_tokens shows stats, slideless_unshare_presentation (no tokenId) revokes ALL', async () => {
    const list = await callTool(ownerKey, 'slideless_list_share_tokens', { presentationId: deckId });
    expect(list.data.shareTokens.length).toBeGreaterThanOrEqual(2);

    const unshared = await callTool(ownerKey, 'slideless_unshare_presentation', { presentationId: deckId });
    expect(unshared.isError, unshared.text).toBe(false);
    expect(unshared.data.revokedCount).toBeGreaterThanOrEqual(2);

    // The anonymous link is dead now (the viewer's revoked semantics: 403).
    const res = await app.app.request(new URL(anonUrl).pathname, { headers: { accept: 'text/html' } });
    expect(res.status).toBe(403);

    const after = await callTool(ownerKey, 'slideless_list_share_tokens', { presentationId: deckId });
    expect(after.data.shareTokens.every((t: { revokedAt: string | null }) => t.revokedAt !== null)).toBe(
      true
    );
  });

  it('slideless_list_token_views returns per-view events (survives revocation; no IP-shaped fields)', async () => {
    const list = await callTool(ownerKey, 'slideless_list_share_tokens', { presentationId: deckId });
    // The anonymous link was opened (counted) earlier in the suite; its
    // history survives the revoke-all above.
    const opened = list.data.shareTokens.find((t: { accessCount: number }) => t.accessCount >= 1);
    expect(opened, 'a token with at least one counted open').toBeDefined();
    const views = await callTool(ownerKey, 'slideless_list_token_views', {
      presentationId: deckId,
      tokenId: opened.id
    });
    expect(views.isError, views.text).toBe(false);
    expect(Array.isArray(views.data.views)).toBe(true);
    expect(views.data.views.length).toBeGreaterThanOrEqual(1);
    // The wire shape is EXACTLY the privacy-vetted field set — an ip/geo/url
    // field appearing here is a regression, not an addition.
    expect(Object.keys(views.data.views[0]).sort()).toEqual(
      ['id', 'occurredAt', 'placement', 'referrerHost', 'uaFamily', 'version'].sort()
    );
  });

  it('collaborator invite → list → uninvite', async () => {
    const invited = await callTool(ownerKey, 'slideless_invite_collaborator', {
      presentationId: deckId,
      email: 'devcollab@mcp.test'
    });
    expect(invited.isError, invited.text).toBe(false);
    expect(invited.data.claimUrl).toContain('/collab/');
    expect(invited.data.collaborator.status).toBe('pending');
    const collaboratorId = invited.data.collaborator.id;

    const list = await callTool(ownerKey, 'slideless_list_collaborators', { presentationId: deckId });
    expect(list.data.collaborators.map((c: { id: string }) => c.id)).toContain(collaboratorId);

    const removed = await callTool(ownerKey, 'slideless_uninvite_collaborator', {
      presentationId: deckId,
      collaboratorId
    });
    expect(removed.isError, removed.text).toBe(false);
    expect(removed.data.status).toBe('revoked');
  });

  it('slideless_list_annotations reads the deck stream and the inbox, with filters', async () => {
    const create = await app.app.request(
      `/api/v1/presentations/${deckId}/annotations`,
      json({ version: 1, selection: { slide: 1 }, body: 'tighten the intro' }, { cookie: ownerCookie })
    );
    expect(create.status).toBe(201);

    const perDeck = await callTool(ownerKey, 'slideless_list_annotations', { presentationId: deckId });
    expect(perDeck.data.annotations).toHaveLength(1);
    expect(perDeck.data.annotations[0].body).toBe('tighten the intro');

    const resolved = await callTool(ownerKey, 'slideless_list_annotations', {
      presentationId: deckId,
      status: 'resolved'
    });
    expect(resolved.data.annotations).toHaveLength(0);

    const inbox = await callTool(ownerKey, 'slideless_list_annotations', {});
    expect(inbox.data.annotations.map((a: { presentationId: string }) => a.presentationId)).toContain(deckId);
  });

  it('slideless_list_form_responses lists rows (with filters) and answers summary mode', async () => {
    // A fresh link (the revoke-all above killed the earlier ones); the
    // viewer surface then plays the injected runtime's part.
    const token = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'form-filler'
    });
    expect(token.isError, token.text).toBe(false);
    const submit = await app.app.request(`/api/v1/viewer/${token.data.secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({
        payload: { name: 'MCP Respondent' },
        source: 'embed',
        placement: 'mcp-embed'
      })
    });
    expect(submit.status).toBe(201);

    const listed = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.responses).toHaveLength(1);
    expect(listed.data.responses[0]).toMatchObject({
      formName: 'rsvp',
      shareTokenId: token.data.shareToken.id,
      shareTokenName: 'form-filler',
      source: 'embed',
      placement: 'mcp-embed',
      payload: { name: 'MCP Respondent' }
    });
    // PRDCT-1331: no respondent identity on the wire, agents included.
    expect(listed.data.responses[0]).not.toHaveProperty('respondentUserId');
    expect(listed.data.responses[0]).not.toHaveProperty('respondentEmail');
    expect(listed.data.nextCursor).toBeNull();

    // Filters ride through to the API.
    const other = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      form: 'other-form'
    });
    expect(other.data.responses).toHaveLength(0);
    const bySource = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      source: 'embed'
    });
    expect(bySource.data.responses).toHaveLength(1);

    // summary: true answers the grouped overview instead of rows.
    const summary = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      summary: true
    });
    expect(summary.isError, summary.text).toBe(false);
    expect(summary.data.total).toBe(1);
    expect(summary.data.buckets).toHaveLength(1);
    expect(summary.data.buckets[0]).toMatchObject({
      formName: 'rsvp',
      shareTokenName: 'form-filler',
      source: 'embed',
      placement: 'mcp-embed',
      count: 1
    });
    expect(summary.data.responses).toBeUndefined();

    // Read-only keys reach it (readOnlyHint is honest)…
    const ro = await callTool(readOnlyKey, 'slideless_list_form_responses', {
      presentationId: deckId
    });
    expect(ro.isError, ro.text).toBe(false);
    // …and the member's key stays walled off the owner's deck (ADR 013).
    const foreign = await callTool(memberKey, 'slideless_list_form_responses', {
      presentationId: deckId
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('not_found');
  });

  it('slideless_delete_presentation removes the deck; reads answer not_found after', async () => {
    const deleted = await callTool(ownerKey, 'slideless_delete_presentation', { presentationId: deckId });
    expect(deleted.isError, deleted.text).toBe(false);
    expect(deleted.data.id).toBe(deckId);

    const get = await callTool(ownerKey, 'slideless_get_presentation', { presentationId: deckId });
    expect(get.isError).toBe(true);
    expect(get.text).toContain('not_found');

    const list = await callTool(ownerKey, 'slideless_list_presentations');
    expect(list.data.presentations.map((p: { id: string }) => p.id)).not.toContain(deckId);
  });
});

describe('org as a parameter: the workspace argument targets one of the holder’s orgs', () => {
  let w2 = '';
  let w2DeckId = '';

  beforeAll(async () => {
    const me = await callTool(ownerKey, 'slideless_whoami');
    w2 = (await app.registry.workspaces.create('MCP Second Org', me.data.user.id)).workspaceId;
  });

  it('a write into the named org lands THERE, not in the default one', async () => {
    const created = await callTool(ownerKey, 'slideless_upload_html_presentation', {
      workspace: w2,
      html: '<!doctype html><title>Org Two Deck</title><h1>org-two-body</h1>'
    });
    expect(created.isError, created.text).toBe(false);
    w2DeckId = created.data.presentation.id;

    // Named org: visible. Default org: absent. One credential, two orgs.
    const inW2 = await callTool(ownerKey, 'slideless_list_presentations', { workspace: w2 });
    expect(inW2.data.presentations.map((p: { id: string }) => p.id)).toContain(w2DeckId);
    const inDefault = await callTool(ownerKey, 'slideless_list_presentations');
    expect(inDefault.data.presentations.map((p: { id: string }) => p.id)).not.toContain(w2DeckId);

    // whoami reflects the selection.
    const asW2 = await callTool(ownerKey, 'slideless_whoami', { workspace: w2 });
    expect(asW2.data.activeWorkspaceId).toBe(w2);
    expect(asW2.data.workspaces.map((w: { id: string }) => w.id)).toContain(w2);
  });

  it('an org the holder does not belong to fails closed (same as nonexistent)', async () => {
    const foreign = await callTool(ownerKey, 'slideless_list_presentations', {
      workspace: '00000000-0000-4000-8000-000000000000'
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('HTTP 401');
    // The member's key cannot borrow the owner's org either: the argument
    // is authorized against the CALLER's memberships, never trusted.
    const borrowed = await callTool(memberKey, 'slideless_list_presentations', { workspace: w2 });
    expect(borrowed.isError).toBe(true);
    expect(borrowed.text).toContain('HTTP 401');
  });
});

// ═══ The forms fast-lane through the tools (PRDCT-2328/2329/2330) ═══════════

describe('remembering links, revision history and the owner-mail switch through the tools', () => {
  let deckId: string;

  beforeAll(async () => {
    const created = await callTool(ownerKey, 'slideless_upload_html_presentation', {
      html: '<!doctype html><title>Lane Forms</title><form data-slideless-form="rsvp"><input name="n"></form>',
      title: 'Lane Forms'
    });
    expect(created.isError, created.text).toBe(false);
    deckId = created.data.presentation.id;
  });

  it('slideless_add_share_token remembers by default, and can mint a fresh-per-submit or read-only link', async () => {
    const named = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Alice'
    });
    expect(named.isError, named.text).toBe(false);
    expect(named.data.shareToken.remembersResponses).toBe(true);
    expect(named.data.shareToken.canSubmitForms).toBe(true);

    const broadcast = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Website',
      remembersResponses: false
    });
    expect(broadcast.isError, broadcast.text).toBe(false);
    expect(broadcast.data.shareToken.remembersResponses).toBe(false);

    const readOnly = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Read only',
      canSubmitForms: false
    });
    expect(readOnly.isError, readOnly.text).toBe(false);
    expect(readOnly.data.shareToken.canSubmitForms).toBe(false);
    expect(readOnly.data.shareToken.remembersResponses).toBe(true);
  });

  it('slideless_list_form_responses with responseId answers the response and its revisions', async () => {
    const token = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Bob'
    });
    const secret: string = token.data.secret;
    const first = await app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ payload: { n: 'one' } })
    });
    expect(first.status).toBe(201);
    const responseId = (await readJson(first)).response.id as string;
    const second = await app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp() },
      body: JSON.stringify({ payload: { n: 'two' } })
    });
    expect(second.status).toBe(200); // the remembering link updated its own row

    const detail = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      responseId
    });
    expect(detail.isError, detail.text).toBe(false);
    expect(detail.data.response.id).toBe(responseId);
    expect(detail.data.response.revision).toBe(2);
    expect(detail.data.versions.map((v: { revision: number }) => v.revision)).toEqual([2, 1]);
    expect(detail.data.versions[1].payload).toEqual({ n: 'one' });
    expect(detail.data.versions[0].shareTokenName).toBe('Bob');

    const ro = await callTool(readOnlyKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      responseId
    });
    expect(ro.isError, ro.text).toBe(false);
    const foreign = await callTool(memberKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      responseId
    });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toContain('404');
  });

  it('slideless_add_share_token takes canUploadFiles, and the responses tool lists uploaded files without their bytes (PRDCT-2403)', async () => {
    const closed = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'No uploads',
      canUploadFiles: false
    });
    expect(closed.isError, closed.text).toBe(false);
    expect(closed.data.shareToken.canUploadFiles).toBe(false);
    const refused = await app.app.request(
      `/api/v1/viewer/${closed.data.secret}/forms/rsvp/uploads?field=docs&name=a.pdf&type=application/pdf`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', origin: 'null', 'x-forwarded-for': nextIp() },
        body: new Uint8Array([1, 2, 3])
      }
    );
    expect(refused.status).toBe(403);

    const open = await callTool(ownerKey, 'slideless_add_share_token', {
      presentationId: deckId,
      name: 'Carol'
    });
    expect(open.isError, open.text).toBe(false);
    expect(open.data.shareToken.canUploadFiles).toBe(true);
    const secret: string = open.data.secret;
    const ip = nextIp();
    const uploaded = await app.app.request(
      `/api/v1/viewer/${secret}/forms/rsvp/uploads?field=docs&name=${encodeURIComponent('../id card.pdf')}&type=application/pdf`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', origin: 'null', 'x-forwarded-for': ip },
        body: new Uint8Array([37, 80, 68, 70])
      }
    );
    expect(uploaded.status).toBe(201);
    const fileId = (await readJson(uploaded)).file.id as string;
    const sent = await app.app.request(`/api/v1/viewer/${secret}/forms/rsvp/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': ip },
      body: JSON.stringify({ payload: { n: 'carol' }, files: { docs: [fileId] } })
    });
    expect(sent.status).toBe(201);
    const responseId = (await readJson(sent)).response.id as string;

    const listed = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      token: open.data.shareToken.id
    });
    expect(listed.isError, listed.text).toBe(false);
    expect(listed.data.responses).toHaveLength(1);
    expect(listed.data.responses[0].files).toEqual([
      expect.objectContaining({
        id: fileId,
        field: 'docs',
        name: 'id card.pdf',
        contentType: 'application/pdf',
        sizeBytes: 4
      })
    ]);
    // Metadata only: nothing on the MCP wire is a handle on the bytes.
    expect(Object.keys(listed.data.responses[0].files[0]).sort()).toEqual(
      ['contentType', 'createdAt', 'field', 'id', 'name', 'sha256', 'sizeBytes'].sort()
    );

    const detail = await callTool(ownerKey, 'slideless_list_form_responses', {
      presentationId: deckId,
      responseId
    });
    expect(detail.isError, detail.text).toBe(false);
    expect(detail.data.response.files.map((f: { name: string }) => f.name)).toEqual(['id card.pdf']);
    expect(detail.data.versions[0].files).toEqual([
      { id: fileId, field: 'docs', name: 'id card.pdf', sizeBytes: 4 }
    ]);

    const tokens = await callTool(ownerKey, 'slideless_list_share_tokens', { presentationId: deckId });
    expect(tokens.isError, tokens.text).toBe(false);
    const byName = new Map<string, boolean>(
      tokens.data.shareTokens.map((t: { name: string; canUploadFiles: boolean }) => [
        t.name,
        t.canUploadFiles
      ])
    );
    expect(byName.get('No uploads')).toBe(false);
    expect(byName.get('Carol')).toBe(true);
  });

  it('slideless_update_presentation switches the owner mails off and on, alone', async () => {
    const off = await callTool(ownerKey, 'slideless_update_presentation', {
      presentationId: deckId,
      notifyOnResponse: false
    });
    expect(off.isError, off.text).toBe(false);
    expect(off.data.notifyOnResponse).toBe(false);
    const on = await callTool(ownerKey, 'slideless_update_presentation', {
      presentationId: deckId,
      notifyOnResponse: true
    });
    expect(on.data.notifyOnResponse).toBe(true);
    const nothing = await callTool(ownerKey, 'slideless_update_presentation', { presentationId: deckId });
    expect(nothing.isError).toBe(true);
  });
});

describe('references through the tools (ADR 025)', () => {
  const BRAND_DOC = '---\ntype: Brand\ntitle: House brand\n---\nUse the navy palette and the serif titles.';
  const TEMPLATE_DOC = '---\ntype: template\ntitle: Quarterly review\n---\nStart from slide 2.';
  let brandId: string;
  let templateId: string;
  let ordinaryId: string;

  const pushDeck = async (title: string, agentDoc?: string): Promise<string> => {
    const result = await callTool(ownerKey, 'slideless_upload_presentation_files', {
      title,
      files: [
        { path: 'index.html', contentText: `<!doctype html><title>${title}</title><h1>${title}</h1>` },
        ...(agentDoc ? [{ path: 'AGENT.md', contentText: agentDoc }] : [])
      ]
    });
    expect(result.isError, result.text).toBe(false);
    return result.data.presentation.id as string;
  };

  const patchDeck = async (id: string, body: Record<string, unknown>) => {
    const res = await app.app.request(`/api/v1/presentations/${id}`, {
      ...json(body, { cookie: ownerCookie }),
      method: 'PATCH'
    });
    expect(res.status, JSON.stringify(body)).toBe(200);
    return readJson(res);
  };

  const idsOf = (result: { data: { presentations: Array<{ id: string }> } }) =>
    result.data.presentations.map((p) => p.id);

  beforeAll(async () => {
    brandId = await pushDeck('House brand', BRAND_DOC);
    templateId = await pushDeck('Quarterly review', TEMPLATE_DOC);
    ordinaryId = await pushDeck('Ordinary with a briefing', 'No frontmatter here, just a briefing.');
  });

  it('slideless_list_references lists every reference by default, in the list shape with the three reference fields', async () => {
    const all = await callTool(ownerKey, 'slideless_list_references');
    expect(all.isError, all.text).toBe(false);
    expect(idsOf(all)).toEqual(expect.arrayContaining([brandId, templateId]));
    expect(idsOf(all)).not.toContain(ordinaryId);
    expect(all.data.nextCursor).toBeNull();

    const brand = all.data.presentations.find((p: { id: string }) => p.id === brandId);
    // The type is lowercased at push; the other frontmatter keys ride along.
    expect(brand.reference).toMatchObject({ type: 'brand', title: 'House brand' });
    expect(brand.audience).toBe('private');
    expect(brand.defaultReference).toBe(false);
    expect(brand.hasAgentDoc).toBe(true);

    // `reference` spelled out is the same listing as the omitted default.
    const spelled = await callTool(ownerKey, 'slideless_list_references', { type: 'reference' });
    expect(idsOf(spelled)).toEqual(idsOf(all));
  });

  it('type narrows to one kind, and the ordinary listing no longer carries references', async () => {
    const brands = await callTool(ownerKey, 'slideless_list_references', { type: 'brand' });
    expect(idsOf(brands)).toContain(brandId);
    expect(idsOf(brands)).not.toContain(templateId);

    const templates = await callTool(ownerKey, 'slideless_list_references', { type: 'template' });
    expect(idsOf(templates)).toContain(templateId);
    expect(idsOf(templates)).not.toContain(brandId);

    const ordinary = await callTool(ownerKey, 'slideless_list_presentations', { limit: 100 });
    expect(idsOf(ordinary)).toContain(ordinaryId);
    expect(idsOf(ordinary)).not.toContain(brandId);
    expect(idsOf(ordinary)).not.toContain(templateId);
    // The list shape carries the three fields on an ordinary deck too.
    const plain = ordinary.data.presentations.find((p: { id: string }) => p.id === ordinaryId);
    expect(plain).toMatchObject({ reference: null, audience: 'private', defaultReference: false });
  });

  it('pages with cursor and limit like the presentations list', async () => {
    const first = await callTool(ownerKey, 'slideless_list_references', { limit: 1 });
    expect(first.data.presentations).toHaveLength(1);
    expect(first.data.nextCursor).toBeTruthy();
    const second = await callTool(ownerKey, 'slideless_list_references', {
      limit: 1,
      cursor: first.data.nextCursor
    });
    expect(second.data.presentations).toHaveLength(1);
    expect(second.data.presentations[0].id).not.toBe(first.data.presentations[0].id);
  });

  it('an unknown type is refused before any read', async () => {
    const res = await mcpPost(ownerKey, 'tools/call', {
      name: 'slideless_list_references',
      arguments: { type: 'theme' }
    });
    const body = await readJson(res);
    const refused = body.error !== undefined || body.result?.isError === true;
    expect(refused, JSON.stringify(body)).toBe(true);

    const missing = await mcpPost(ownerKey, 'tools/call', {
      name: 'slideless_get_default_reference',
      arguments: {}
    });
    const missingBody = await readJson(missing);
    expect(missingBody.error !== undefined || missingBody.result?.isError === true).toBe(true);
    // `reference` is a list filter, never a default's type.
    const wide = await mcpPost(ownerKey, 'tools/call', {
      name: 'slideless_get_default_reference',
      arguments: { type: 'reference' }
    });
    const wideBody = await readJson(wide);
    expect(wideBody.error !== undefined || wideBody.result?.isError === true).toBe(true);
  });

  it('slideless_get_default_reference says plainly when no default is set', async () => {
    const none = await callTool(ownerKey, 'slideless_get_default_reference', { type: 'brand' });
    expect(none.isError, none.text).toBe(false);
    expect(none.data.type).toBe('brand');
    expect(none.data.presentation).toBeNull();
    expect(none.data.note).toContain('No default brand is set in this workspace');
  });

  it("a private reference stays out of a member's tools; published, the member reads it and its AGENT.md", async () => {
    const before = await callTool(memberKey, 'slideless_list_references');
    expect(before.isError, before.text).toBe(false);
    expect(idsOf(before)).not.toContain(brandId);

    const published = await patchDeck(brandId, { audience: 'workspace' });
    expect(published.audience).toBe('workspace');

    const after = await callTool(memberKey, 'slideless_list_references', { type: 'brand' });
    expect(idsOf(after)).toContain(brandId);
    // The template was never published: still the owner's alone.
    const memberTemplates = await callTool(memberKey, 'slideless_list_references', { type: 'template' });
    expect(idsOf(memberTemplates)).not.toContain(templateId);

    const doc = await callTool(memberKey, 'slideless_get_agent_doc', { presentationId: brandId });
    expect(doc.isError, doc.text).toBe(false);
    expect(doc.data.content).toContain('Use the navy palette');
  });

  it('slideless_get_default_reference returns the default once set, for the owner, a member and a read-only key', async () => {
    const set = await patchDeck(brandId, { defaultReference: true });
    expect(set.defaultReference).toBe(true);

    for (const key of [ownerKey, memberKey, readOnlyKey]) {
      const found = await callTool(key, 'slideless_get_default_reference', { type: 'brand' });
      expect(found.isError, found.text).toBe(false);
      expect(found.data.type).toBe('brand');
      expect(found.data.presentation.id).toBe(brandId);
      expect(found.data.presentation.reference).toMatchObject({ type: 'brand', title: 'House brand' });
      expect(found.data.presentation.audience).toBe('workspace');
      expect(found.data.presentation.defaultReference).toBe(true);
      expect(found.data.note).toBeUndefined();
    }

    // One default per type: the template side is still empty.
    const template = await callTool(memberKey, 'slideless_get_default_reference', { type: 'template' });
    expect(template.data.presentation).toBeNull();
    expect(template.data.note).toContain('No default template is set in this workspace');

    const listed = await callTool(ownerKey, 'slideless_list_references', { type: 'brand' });
    const row = listed.data.presentations.find((p: { id: string }) => p.id === brandId);
    expect(row.defaultReference).toBe(true);
  });

  it('both tools describe themselves as reads that apply nothing', async () => {
    const result = await rpc(ownerKey, 'tools/list');
    const tools = result.tools as Array<{ name: string; description: string }>;
    const described = tools.find((t) => t.name === 'slideless_get_default_reference')!.description;
    expect(described).toContain('slideless_get_agent_doc');
    expect(described).toContain('Nothing is applied automatically');
  });
});

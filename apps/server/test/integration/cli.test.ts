import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { serve, type ServerType } from '@hono/node-server';
import { createServer } from 'node:net';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceMembers } from '@antasphere/chassis-db';
import { run } from '@antasphere/slideless';
import type { CliIo } from '@antasphere/slideless';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp,
  SETUP_TOKEN
} from './helpers.js';

/**
 * The CLI driven against a REAL listening server (it dials a URL). Proves the
 * agent-facing path end to end: whoami + a files upload/download round-trip
 * with a minted key, a clean scope error on a read-only key, and the project
 * flow of PRDCT-2579 — the owner puts a deck in a project with
 * `push --project`, and a plain member who is only a VIEWER of that project
 * reads it back with `list --project`, which workspace membership alone
 * would not have given them.
 */

const OWNER = { email: 'owner@cli.test', name: 'CLI Owner', password: 'cli-owner-password-123' };
const MEMBER = { email: 'member@cli.test', name: 'CLI Member', password: 'cli-member-password-123' };

let container: StartedPostgreSqlContainer;
let app: TestApp;
let server: ServerType;
let base: string;
let ownerCookie: string;
let writeKey: string;
let readKey: string;
/** The plain workspace member of the project flow: their own key, their own user id. */
let memberKey: string;
let memberUserId: string;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      if (address === null || typeof address === 'string') return reject(new Error('no port'));
      srv.close(() => resolve(address.port));
    });
  });
}

/** Run the CLI in-process, capturing stdout/stderr and the exit code. */
async function cli(args: string[], apiKey?: string): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    env: { SLIDELESS_URL: base, ...(apiKey ? { SLIDELESS_API_KEY: apiKey } : {}) },
    out: { write: (s) => out.push(s) },
    err: { write: (s) => err.push(s) }
  };
  const code = await run(args, io);
  return { code, out: out.join(''), err: err.join('') };
}

beforeAll(async () => {
  container = await startPostgres();
  const dbUrl = await createDatabase(container, 'cli');
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  app = await createTestApp(dbUrl, { PUBLIC_BASE_URL: base });
  server = serve({ fetch: app.app.fetch, port, hostname: '127.0.0.1' });

  const setup = await fetch(`${base}/api/v1/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ setupToken: SETUP_TOKEN, instanceName: 'CLI Instance', owner: OWNER })
  });
  const workspaceId = (await readJson(setup)).workspaceId as string;
  const signIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: OWNER.email, password: OWNER.password })
  });
  ownerCookie = extractCookie(signIn);

  const mint = async (cookie: string, scopes: string[], name: string) =>
    readJson(
      await fetch(`${base}/api/v1/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie },
        body: JSON.stringify({ name, scopes })
      })
    );
  writeKey = (await mint(ownerCookie, ['presentations:read', 'presentations:write'], 'cli-write')).key;
  readKey = (await mint(ownerCookie, ['presentations:read'], 'cli-read')).key;

  // A PLAIN member of the workspace: no project, no deck of their own. The
  // project flow below is the only thing that ever lets them read a deck.
  const created = await app.auth.api.signUpEmail({ body: MEMBER });
  memberUserId = created.user.id;
  await app.db.db
    .insert(workspaceMembers)
    .values({ workspaceId, userId: memberUserId, role: 'member', origin: 'local' });
  const memberSignIn = await fetch(`${base}/api/v1/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: MEMBER.email, password: MEMBER.password })
  });
  memberKey = (
    await mint(extractCookie(memberSignIn), ['presentations:read', 'presentations:write'], 'cli-member')
  ).key;
}, 240_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await app?.stop();
  await container?.stop();
});

describe('slideless CLI against a live instance', () => {
  it('instance discovery works without a key', async () => {
    const { code, out } = await cli(['instance']);
    expect(code).toBe(0);
    expect(out).toContain('CLI Instance');
  });

  it('whoami resolves the key identity', async () => {
    const { code, out } = await cli(['whoami'], writeKey);
    expect(code).toBe(0);
    expect(out).toContain('owner@cli.test');
    expect(out).toContain('api_key');
    // The keys minted in beforeAll carry no TTL.
    expect(out).toContain('key expires: never');
  });

  it('whoami shows the expiry of a TTL key', async () => {
    const minted = await readJson(
      await fetch(`${base}/api/v1/api-keys`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: ownerCookie },
        body: JSON.stringify({ name: 'cli-ttl', scopes: ['presentations:read'], expiresInDays: 30 })
      })
    );
    const { code, out } = await cli(['whoami'], minted.key);
    expect(code).toBe(0);
    expect(out).toContain(`key expires: ${minted.apiKey.expiresAt}`);
  });

  it('uploads, lists, downloads, and deletes a file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    const src = join(dir, 'hello.txt');
    await writeFile(src, 'hello from the cli');

    const uploaded = await cli(['files', 'upload', src, '--content-type', 'text/plain'], writeKey);
    expect(uploaded.code).toBe(0);
    const id = /id: (\S+)/.exec(uploaded.out)?.[1];
    expect(id).toBeTruthy();

    const list = await cli(['files', 'list', '--json'], writeKey);
    expect(list.code).toBe(0);
    expect(list.out).toContain(id!);

    const dest = join(dir, 'out.txt');
    const dl = await cli(['files', 'download', id!, '--out', dest], writeKey);
    expect(dl.code).toBe(0);
    expect(await readFile(dest, 'utf8')).toBe('hello from the cli');

    const rm = await cli(['files', 'rm', id!], writeKey);
    expect(rm.code).toBe(0);
  });

  it('gives a read-only key a clean scope error on upload', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cli-test-'));
    const src = join(dir, 'blocked.txt');
    await writeFile(src, 'nope');
    const { code, err } = await cli(['files', 'upload', src], readKey);
    expect(code).toBe(1);
    expect(err.toLowerCase()).toContain('not allowed');
  });

  /**
   * PRDCT-2579 end to end, every step through the CLI against the live
   * instance: the owner makes a project, adds a plain member as a VIEWER,
   * pushes a deck into it with `--project`, and the viewer — who has no deck
   * of their own and whose workspace membership grants nothing (ADR 013) —
   * lists it with `list --project` and reads it with `get`. The proof that
   * the project IS the grant is the control at the end: before the link, the
   * same member's `get` answered 404.
   */
  it('a project links a deck the CLI pushed, and its viewer reads it back', async () => {
    // The owner creates the project. --json is the payload, so the id is read
    // from the wire shape rather than scraped out of a human line.
    const created = await cli(['projects', 'create', 'CLI Atlas', '--json'], writeKey);
    expect(created.code).toBe(0);
    const project = (JSON.parse(created.out) as { id: string; myRole: string }).id;
    expect(project).toBeTruthy();
    expect((JSON.parse(created.out) as { myRole: string }).myRole).toBe('manager');

    // …and puts the plain member in it as a VIEWER (the weakest role).
    const added = await cli(
      ['projects', 'members', 'add', project, MEMBER.email, '--role', 'viewer', '--json'],
      writeKey
    );
    expect(added.code).toBe(0);
    expect(JSON.parse(added.out)).toMatchObject({ userId: memberUserId, role: 'viewer' });

    // A deck the owner pushes WITHOUT the project: the control.
    const dir = await mkdtemp(join(tmpdir(), 'cli-project-'));
    await writeFile(join(dir, 'index.html'), '<!doctype html><html><body>unlinked</body></html>');
    const unlinked = await cli(['push', dir, '--title', 'Unlinked', '--json', '--new'], writeKey);
    expect(unlinked.code).toBe(0);
    const unlinkedId = (JSON.parse(unlinked.out) as { presentation: { id: string } }).presentation.id;

    // The member cannot read it: workspace membership is not a deck grant,
    // and a failed read check answers 404, never 403 (ADR 013).
    const blocked = await cli(['get', unlinkedId], memberKey);
    expect(blocked.code).toBe(1);

    // The deck that goes IN the project, in the commit itself (a new deck).
    const linkedDir = await mkdtemp(join(tmpdir(), 'cli-project-'));
    await writeFile(join(linkedDir, 'index.html'), '<!doctype html><html><body>linked</body></html>');
    const pushed = await cli(
      ['push', linkedDir, '--title', 'In the project', '--project', project, '--json'],
      writeKey
    );
    expect(pushed.code).toBe(0);
    const parsed = JSON.parse(pushed.out) as {
      presentation: { id: string; projects: Array<{ id: string; name: string; isBrand: boolean }> };
      projectLinks: Array<{ projectId: string; linked: boolean }>;
    };
    const linkedId = parsed.presentation.id;
    // The commit carried it: the deck comes back already in the project.
    expect(parsed.presentation.projects).toEqual([{ id: project, name: 'CLI Atlas', isBrand: false }]);
    expect(parsed.projectLinks).toEqual([{ projectId: project, linked: true }]);

    // The viewer now reads the deck, and ONLY through the project.
    const seen = await cli(['get', linkedId], memberKey);
    expect(seen.code).toBe(0);
    expect(seen.out).toContain('In the project');
    expect(seen.out).toContain('CLI Atlas');

    // …and `list --project` is the listing filtered to it: the linked deck
    // and nothing else, the unlinked control absent.
    const listed = await cli(['list', '--project', project, '--json'], memberKey);
    expect(listed.code).toBe(0);
    const ids = (JSON.parse(listed.out) as { presentations: Array<{ id: string }> }).presentations.map(
      (p) => p.id
    );
    expect(ids).toEqual([linkedId]);
    expect(ids).not.toContain(unlinkedId);

    // The viewer cannot pull somebody else's deck into the project — and the
    // refusal does not even confirm the deck exists, which is the ADR 013
    // posture arriving as a sentence rather than as the wire code.
    const refused = await cli(['projects', 'link', project, unlinkedId], memberKey);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('No such deck, or it is not yours to read.');

    // The owner takes the deck back out, and the viewer loses it again.
    const unlinkedNow = await cli(['projects', 'unlink', project, linkedId], writeKey);
    expect(unlinkedNow.code).toBe(0);
    expect(unlinkedNow.out).toContain('is in no project');
    const gone = await cli(['get', linkedId], memberKey);
    expect(gone.code).toBe(1);
  });
});

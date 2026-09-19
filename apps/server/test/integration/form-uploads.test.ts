import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import AdmZip from 'adm-zip';
import { eq, sql } from 'drizzle-orm';
import { formResponseFiles, formResponseVersions, formResponses, shareTokens } from '@slideless/db';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  type TestApp
} from './helpers.js';

/**
 * PRDCT-2403 — a form's FILE FIELD, end to end against the booted app: the
 * anonymous upload route on the token-session viewer surface, the claim at
 * submit and at edit, the owner's three download routes, and the removal of
 * bytes (edit, response delete, pending removal, the purge sweep).
 *
 * The instance ceilings are booted SMALL so every one of them is reachable
 * in a test: 1 MB per file, 3 files per response, 2 MB per deck.
 */

const OWNER = { name: 'Owner', email: 'owner@uploads.test', password: 'owner-password-123' };
const MEMBER = { name: 'Member', email: 'member@uploads.test', password: 'member-password-123' };
const MB = 1024 * 1024;

const HTML = Buffer.from(
  '<!doctype html><html><head><title>Files</title></head><body>' +
    '<form data-slideless-form="kyc"><input name="who">' +
    '<input type="file" name="docs" multiple accept=".pdf" data-slideless-max="3"></form>' +
    '<form data-slideless-form="other"><input type="file" name="docs"></form>' +
    '</body></html>'
);
const shaOf = (bytes: Buffer | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;
let deckId: string;
let otherDeckId: string;

let ipCounter = 0;
const nextIp = () => `10.77.${Math.floor(ipCounter / 250)}.${(ipCounter++ % 250) + 1}`;

const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});

/** What the runtime sends: one raw file, octet-stream, the name/field/type on the query. */
const upload = (
  secret: string,
  form: string,
  bytes: Uint8Array,
  opts: { field?: string; name?: string; type?: string; headers?: Record<string, string> } = {}
) => {
  const qs = new URLSearchParams({
    field: opts.field ?? 'docs',
    name: opts.name ?? 'passport.pdf',
    type: opts.type ?? 'application/pdf'
  });
  return app.app.request(`/api/v1/viewer/${secret}/forms/${form}/uploads?${qs.toString()}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/octet-stream',
      'content-length': String(bytes.length),
      origin: 'null',
      'x-forwarded-for': nextIp(),
      ...(opts.headers ?? {})
    },
    body: bytes
  });
};

const uploadOk = async (secret: string, form: string, bytes: Uint8Array, opts = {}) => {
  const res = await upload(secret, form, bytes, opts);
  expect(res.status).toBe(201);
  return (await readJson(res)).file as { id: string; field: string; name: string; sizeBytes: number };
};

const submit = (secret: string, form: string, body: unknown, headers: Record<string, string> = {}) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'null', 'x-forwarded-for': nextIp(), ...headers },
    body: JSON.stringify(body)
  });

const putMe = (secret: string, form: string, body: unknown, editSecret: string) =>
  app.app.request(`/api/v1/viewer/${secret}/forms/${form}/responses/me`, {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      origin: 'null',
      'x-forwarded-for': nextIp(),
      'x-slideless-response': editSecret
    },
    body: JSON.stringify(body)
  });

async function createToken(
  body: Record<string, unknown>,
  deck: string = deckId
): Promise<{ secret: string; id: string; canUploadFiles: boolean }> {
  const res = await app.app.request(
    `/api/v1/presentations/${deck}/tokens`,
    json({ remembersResponses: false, ...body }, { cookie })
  );
  expect(res.status).toBe(201);
  const parsed = await readJson(res);
  return {
    secret: parsed.secret,
    id: parsed.shareToken.id,
    canUploadFiles: parsed.shareToken.canUploadFiles
  };
}

const owner = (path: string, init: RequestInit = {}) =>
  app.app.request(`/api/v1/presentations/${deckId}${path}`, {
    ...init,
    headers: { cookie, ...((init.headers as Record<string, string>) ?? {}) }
  });

/** The forms runtime's own config (the recipient bar injects a `var CFG=` of its own). */
const formsConfig = (html: string) =>
  JSON.parse(/<script data-slideless-forms>[\s\S]*?var CFG=(\{[^\n]*?\});/.exec(html)![1]!) as {
    uploads: { maxBytes: number; maxFiles: number } | null;
  };

const bytesOf = (n: number, fill = 7) => new Uint8Array(n).fill(fill);

async function uploadDeck(title: string): Promise<string> {
  const form = new FormData();
  form.set('sha256', shaOf(HTML));
  form.set('file', new Blob([new Uint8Array(HTML)], { type: 'text/html' }), 'index.html');
  const asset = await app.app.request('/api/v1/presentations/assets', {
    method: 'POST',
    headers: { cookie },
    body: form
  });
  expect(asset.status).toBe(201);
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json(
      {
        title,
        entryPath: 'index.html',
        manifest: [
          { path: 'index.html', sha256: shaOf(HTML), sizeBytes: HTML.length, contentType: 'text/html' }
        ]
      },
      { cookie }
    )
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId;
}

const fileRows = () => app.db.db.select().from(formResponseFiles);

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'form_uploads'), {
    FORMS_MAX_UPLOAD_MB: '1',
    FORMS_MAX_FILES_PER_RESPONSE: '3',
    FORMS_MAX_UPLOADS_MB_PER_DECK: '2'
  });
  await app.app.request(
    '/api/v1/setup',
    json({ setupToken: 'integration-test-setup-token', instanceName: 'Uploads', owner: OWNER })
  );
  const signIn = await app.app.request(
    '/api/v1/auth/sign-in/email',
    json({ email: OWNER.email, password: OWNER.password })
  );
  cookie = extractCookie(signIn);
  deckId = await uploadDeck('Client files');
  otherDeckId = await uploadDeck('Another deck');
}, 120_000);

afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

describe('the per-link switch and what the document is told', () => {
  it('a new link takes uploads by default and the runtime config states the two ceilings', async () => {
    const link = await createToken({ name: 'default' });
    expect(link.canUploadFiles).toBe(true);
    const html = await (
      await app.app.request(`/v/${link.secret}/`, {
        headers: { accept: 'text/html', 'sec-fetch-dest': 'document' }
      })
    ).text();
    expect(formsConfig(html).uploads).toEqual({ maxBytes: MB, maxFiles: 3 });
  });

  it('a link with the switch off is told null, and the upload route refuses it', async () => {
    const link = await createToken({ name: 'no uploads', canUploadFiles: false });
    expect(link.canUploadFiles).toBe(false);
    const html = await (
      await app.app.request(`/v/${link.secret}/`, {
        headers: { accept: 'text/html', 'sec-fetch-dest': 'document' }
      })
    ).text();
    expect(formsConfig(html).uploads).toBeNull();
    const res = await upload(link.secret, 'kyc', bytesOf(10));
    expect(res.status).toBe(403);
    expect((await readJson(res)).error.code).toBe('uploads_disabled');
    expect(await fileRows()).toHaveLength(0);
  });

  it('a link minted before the feature (the column default) is closed until its owner opens it', async () => {
    const link = await createToken({ name: 'old link' });
    // What migration 0043 leaves on every pre-existing row: the column default.
    await app.db.db.execute(sql`update share_tokens set can_upload_files = default where id = ${link.id}`);
    const [row] = await app.db.db.select().from(shareTokens).where(eq(shareTokens.id, link.id));
    expect(row!.canUploadFiles).toBe(false);
    expect((await upload(link.secret, 'kyc', bytesOf(10))).status).toBe(403);
    const patched = await owner(`/tokens/${link.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canUploadFiles: true })
    });
    expect(patched.status).toBe(200);
    expect((await readJson(patched)).canUploadFiles).toBe(true);
    expect((await upload(link.secret, 'kyc', bytesOf(10))).status).toBe(201);
  });

  it('forms off closes uploads too, and a preview token never takes a file', async () => {
    const noForms = await createToken({ name: 'no forms', canSubmitForms: false });
    const refused = await upload(noForms.secret, 'kyc', bytesOf(10));
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).error.code).toBe('forms_disabled');

    const preview = await readJson(await owner('/preview-token', json({}, {})));
    expect(preview.shareToken.canUploadFiles).toBe(false);
    expect((await upload(preview.secret, 'kyc', bytesOf(10))).status).toBe(403);
  });
});

describe('upload, submit, and the owner reads the files back', () => {
  it('a dropped file is pending, the submit attaches it, and every reader sees it', async () => {
    const link = await createToken({ name: 'Alice' });
    const pdf = new TextEncoder().encode('%PDF-1.4 the passport');
    const png = bytesOf(2048, 9);
    const a = await uploadOk(link.secret, 'kyc', pdf, { name: 'passport.pdf' });
    const b = await uploadOk(link.secret, 'kyc', png, { name: 'photo.png', type: 'image/png' });
    expect(a).toEqual({ id: a.id, field: 'docs', name: 'passport.pdf', sizeBytes: pdf.length });

    // Pending: no response holds them, the owner sees nothing yet.
    expect((await readJson(await owner('/responses'))).responses).toHaveLength(0);

    const res = await submit(link.secret, 'kyc', {
      payload: { who: 'Alice' },
      files: { docs: [a.id, b.id] }
    });
    expect(res.status).toBe(201);
    const created = await readJson(res);
    // The respondent wire: names and sizes, NEVER a sha, a type or a URL.
    expect(created.response.files).toEqual([
      { id: a.id, field: 'docs', name: 'passport.pdf', sizeBytes: pdf.length },
      { id: b.id, field: 'docs', name: 'photo.png', sizeBytes: png.length }
    ]);

    const listed = (await readJson(await owner('/responses'))).responses;
    expect(listed).toHaveLength(1);
    expect(listed[0].files.map((f: { name: string }) => f.name)).toEqual(['passport.pdf', 'photo.png']);
    expect(listed[0].files[0]).toMatchObject({
      id: a.id,
      field: 'docs',
      contentType: 'application/pdf',
      sizeBytes: pdf.length,
      sha256: shaOf(pdf)
    });

    const detail = await readJson(await owner(`/responses/${created.response.id}`));
    expect(detail.response.files).toHaveLength(2);
    expect(detail.versions[0].files).toEqual([
      { id: a.id, field: 'docs', name: 'passport.pdf', sizeBytes: pdf.length },
      { id: b.id, field: 'docs', name: 'photo.png', sizeBytes: png.length }
    ]);

    // One file: the bytes, ALWAYS as a download — a PDF and an image too,
    // which the generic file policy would show inline.
    for (const [file, bytes] of [
      [a, pdf],
      [b, png]
    ] as const) {
      const dl = await owner(`/responses/${created.response.id}/files/${file.id}`);
      expect(dl.status).toBe(200);
      expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/);
      expect(dl.headers.get('x-content-type-options')).toBe('nosniff');
      expect(Buffer.from(await dl.arrayBuffer()).equals(Buffer.from(bytes))).toBe(true);
    }

    // One response's zip: <field>/<file>.
    const zipRes = await owner(`/responses/${created.response.id}/files.zip`);
    expect(zipRes.status).toBe(200);
    expect(zipRes.headers.get('content-type')).toBe('application/zip');
    expect(zipRes.headers.get('content-disposition')).toMatch(/^attachment;/);
    const zip = new AdmZip(Buffer.from(await zipRes.arrayBuffer()));
    expect(zip.getEntries().map((e) => e.entryName)).toEqual(['docs/passport.pdf', 'docs/photo.png']);
    expect(zip.getEntry('docs/passport.pdf')!.getData().equals(Buffer.from(pdf))).toBe(true);

    // The whole deck's zip: <form>/<response folder>/<field>/<file>.
    const all = new AdmZip(Buffer.from(await (await owner('/responses/files.zip')).arrayBuffer()));
    const names = all.getEntries().map((e) => e.entryName);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(
      new RegExp(`^kyc/\\d{8}-\\d{4}-${created.response.id.slice(0, 8)}/docs/passport\\.pdf$`)
    );
    // Filters ride the listing's own: another form has no files.
    const none = await owner('/responses/files.zip?form=other');
    expect(none.status).toBe(404);
    expect((await readJson(none)).error.code).toBe('no_files');
  });

  it('a response with no files answers 404 no_files on its zip, and an unknown file id 404', async () => {
    const link = await createToken({ name: 'text only' });
    const created = await readJson(await submit(link.secret, 'kyc', { payload: { who: 'Bob' } }));
    const zipRes = await owner(`/responses/${created.response.id}/files.zip`);
    expect(zipRes.status).toBe(404);
    expect((await readJson(zipRes)).error.code).toBe('no_files');
    const dl = await owner(`/responses/${created.response.id}/files/00000000-0000-4000-8000-000000000001`);
    expect(dl.status).toBe(404);
  });

  it('a file of ANOTHER response is not reachable through this response, nor through another deck', async () => {
    const link = await createToken({ name: 'Carol' });
    const f = await uploadOk(link.secret, 'kyc', bytesOf(64));
    const mine = await readJson(await submit(link.secret, 'kyc', { payload: {}, files: { docs: [f.id] } }));
    const other = await readJson(await submit(link.secret, 'kyc', { payload: { who: 'someone else' } }));
    expect((await owner(`/responses/${other.response.id}/files/${f.id}`)).status).toBe(404);
    const cross = await app.app.request(
      `/api/v1/presentations/${otherDeckId}/responses/${mine.response.id}/files/${f.id}`,
      { headers: { cookie } }
    );
    expect(cross.status).toBe(404);
  });

  it('a plain workspace member gets the 404 an outsider would, on all three routes', async () => {
    const link = await createToken({ name: 'Dan' });
    const f = await uploadOk(link.secret, 'kyc', bytesOf(64));
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: {}, files: { docs: [f.id] } })
    );

    const invite = await readJson(
      await app.app.request('/api/v1/invitations', json({ email: MEMBER.email, role: 'member' }, { cookie }))
    );
    const accept = await app.app.request(
      '/api/v1/invitations/accept',
      json({
        token: (invite.acceptUrl as string).split('/invite/')[1]!,
        name: MEMBER.name,
        password: MEMBER.password
      })
    );
    expect(accept.status).toBeLessThan(300);
    const memberCookie = extractCookie(
      await app.app.request(
        '/api/v1/auth/sign-in/email',
        json({ email: MEMBER.email, password: MEMBER.password }, { 'x-forwarded-for': nextIp() })
      )
    );
    for (const path of [
      `/responses/files.zip`,
      `/responses/${created.response.id}/files.zip`,
      `/responses/${created.response.id}/files/${f.id}`
    ]) {
      const res = await app.app.request(`/api/v1/presentations/${deckId}${path}`, {
        headers: { cookie: memberCookie }
      });
      expect(res.status, path).toBe(404);
      expect((await readJson(res)).error.code, path).toBe('not_found');
    }
  });
});

describe('what the upload route refuses', () => {
  it('a file over the ceiling, by its declared length and mid-stream when the length lies', async () => {
    const link = await createToken({ name: 'big' });
    const declared = await upload(link.secret, 'kyc', bytesOf(MB + 1));
    expect(declared.status).toBe(413);
    const body = await readJson(declared);
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.details.maxBytes).toBe(MB);

    // No Content-Length at all: a streamed body is cut at the ceiling.
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytesOf(MB));
        controller.enqueue(bytesOf(1024));
        controller.close();
      }
    });
    const lied = await app.app.request(
      `/api/v1/viewer/${link.secret}/forms/kyc/uploads?field=docs&name=big.bin`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', origin: 'null', 'x-forwarded-for': nextIp() },
        body: stream,
        // undici needs `duplex` for a streamed request body.
        duplex: 'half'
      }
    );
    expect(lied.status).toBe(413);
    // Neither refusal left a row (nor, by the service's rollback, a blob).
    expect((await fileRows()).filter((r) => r.shareTokenId === link.id)).toHaveLength(0);
  });

  it('an empty file, a missing or control-character field name, a bad form name', async () => {
    const link = await createToken({ name: 'bad input' });
    const empty = await upload(link.secret, 'kyc', new Uint8Array(0));
    expect(empty.status).toBe(400);
    expect((await readJson(empty)).error.code).toBe('empty_file');
    expect((await upload(link.secret, 'kyc', bytesOf(4), { field: '' })).status).toBe(400);
    expect((await upload(link.secret, 'kyc', bytesOf(4), { field: 'do\u0000cs' })).status).toBe(400);
    expect((await upload(link.secret, 'bad name!', bytesOf(4))).status).toBe(400);
    expect((await upload('not-a-secret', 'kyc', bytesOf(4))).status).toBe(404);
  });

  it('the display name is reduced to a harmless basename', async () => {
    const link = await createToken({ name: 'names' });
    const cases: [string, string][] = [
      ['../../etc/passwd', 'passwd'],
      ['C:\\Users\\me\\evil.exe', 'evil.exe'],
      ['.env', 'env'],
      ['a\u0000b\u202ec.pdf', 'abc.pdf'],
      ['', 'file'],
      ['x'.repeat(400) + '.pdf', 'x'.repeat(251) + '.pdf']
    ];
    for (const [sent, kept] of cases) {
      const f = await uploadOk(link.secret, 'kyc', bytesOf(4), { name: sent });
      expect(f.name, JSON.stringify(sent)).toBe(kept);
    }
  });

  it('a body sent as JSON is a FILE: stored as it is, never parsed, never depth-scanned', async () => {
    const link = await createToken({ name: 'json file' });
    const deep = new TextEncoder().encode('['.repeat(5000));
    const res = await upload(link.secret, 'kyc', deep, {
      name: 'deep.json',
      headers: { 'content-type': 'application/json' }
    });
    expect(res.status).toBe(201);
  });

  it('a declared type that is not a media type is stored as octet-stream', async () => {
    const link = await createToken({ name: 'types' });
    const f = await uploadOk(link.secret, 'kyc', bytesOf(4), { type: 'text/html\r\nx-evil: 1' });
    const [row] = await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, f.id));
    expect(row!.contentType).toBe('application/octet-stream');
  });
});

describe('the claim binds an upload to its link, its form, its field, once', () => {
  it('refuses the whole submit, and writes nothing, for an id that is not claimable here', async () => {
    const a = await createToken({ name: 'link A' });
    const b = await createToken({ name: 'link B' });
    const mine = await uploadOk(a.secret, 'kyc', bytesOf(8));
    const countBefore = (await app.db.db.select().from(formResponses)).length;

    const cases: [string, string, Record<string, string[]>][] = [
      ['through another link', b.secret, { docs: [mine.id] }],
      ['an unknown id', a.secret, { docs: ['00000000-0000-4000-8000-000000000002'] }],
      ['under another field', a.secret, { other: [mine.id] }],
      ['named twice', a.secret, { docs: [mine.id, mine.id] }]
    ];
    for (const [label, secret, files] of cases) {
      const res = await submit(secret, 'kyc', { payload: { who: label }, files });
      expect(res.status, label).toBe(400);
      expect((await readJson(res)).error.code, label).toBe('invalid_files');
    }
    const wrongForm = await submit(a.secret, 'other', { payload: {}, files: { docs: [mine.id] } });
    expect(wrongForm.status).toBe(400);
    expect((await app.db.db.select().from(formResponses)).length).toBe(countBefore);

    // Still pending and still claimable by its own link and form, once.
    const ok = await submit(a.secret, 'kyc', { payload: {}, files: { docs: [mine.id] } });
    expect(ok.status).toBe(201);
    const again = await submit(a.secret, 'kyc', { payload: {}, files: { docs: [mine.id] } });
    expect(again.status).toBe(400);
  });

  it('holds a response to the per-response count ceiling', async () => {
    const link = await createToken({ name: 'many' });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++)
      ids.push((await uploadOk(link.secret, 'kyc', bytesOf(4), { name: `f${i}.pdf` })).id);
    const res = await submit(link.secret, 'kyc', { payload: {}, files: { docs: ids } });
    expect(res.status).toBe(400);
    expect((await readJson(res)).error.code).toBe('too_many_files');
    expect((await submit(link.secret, 'kyc', { payload: {}, files: { docs: ids.slice(0, 3) } })).status).toBe(
      201
    );
  });

  const switchOff = (linkId: string) =>
    owner(`/tokens/${linkId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ canUploadFiles: false })
    });

  it('a link whose switch was turned off refuses a NEW file out loud, on a submit and on an edit alike', async () => {
    const link = await createToken({ name: 'switched off' });
    const held = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'held.pdf' });
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: { who: 'x' }, files: { docs: [held.id] } })
    );
    const pending = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'late.pdf' });
    expect((await switchOff(link.id)).status).toBe(200);

    const before = (await app.db.db.select().from(formResponses)).length;
    const post = await submit(link.secret, 'kyc', { payload: { who: 'y' }, files: { docs: [pending.id] } });
    expect(post.status).toBe(403);
    expect((await readJson(post)).error.code).toBe('uploads_disabled');
    expect((await app.db.db.select().from(formResponses)).length).toBe(before);

    // The EDIT leg: the page that was open when the owner flipped the switch
    // usually holds a response already, so it edits (verifier round 2, R4).
    const put = await putMe(
      link.secret,
      'kyc',
      { payload: { who: 'edited' }, files: { docs: [held.id, pending.id] } },
      created.editSecret
    );
    expect(put.status).toBe(403);
    expect((await readJson(put)).error.code).toBe('uploads_disabled');
    // Refused WHOLE: the text did not change, the held file is still held, the late one still pending.
    const detail = await readJson(await owner(`/responses/${created.response.id}`));
    expect(detail.response.payload).toEqual({ who: 'x' });
    expect(detail.response.revision).toBe(1);
    expect(detail.response.files.map((f: { id: string }) => f.id)).toEqual([held.id]);
    const [late] = await app.db.db
      .select()
      .from(formResponseFiles)
      .where(eq(formResponseFiles.id, pending.id));
    expect(late!.responseId).toBeNull();

    // No file, or untouched file fields on a fresh response: the form still submits.
    expect((await submit(link.secret, 'kyc', { payload: { who: 'z' } })).status).toBe(201);
    expect((await submit(link.secret, 'kyc', { payload: { who: 'z' }, files: { docs: [] } })).status).toBe(
      201
    );
  });

  it('with the switch off a respondent still KEEPS and REMOVES the files the answer holds: never a silent 200', async () => {
    // Verifier round 2, the blocker: `files` used to be coerced to
    // "untouched" on such a link, so a removal answered 200 and kept the file.
    const link = await createToken({ name: 'take it back' });
    const keep = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'keep.pdf' });
    const cv = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'cv.pdf' });
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: { who: 'x' }, files: { docs: [keep.id, cv.id] } })
    );
    const [cvRow] = await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, cv.id));
    expect((await switchOff(link.id)).status).toBe(200);

    const kept = await putMe(
      link.secret,
      'kyc',
      { payload: { who: 'x' }, files: { docs: [keep.id] } },
      created.editSecret
    );
    expect(kept.status).toBe(200);
    expect((await readJson(kept)).response.files.map((f: { name: string }) => f.name)).toEqual(['keep.pdf']);
    expect(
      await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, cv.id))
    ).toHaveLength(0);
    const { createStorageDriver } = await import('@antasphere/chassis-server/storage');
    expect(await createStorageDriver(app.env).exists(cvRow!.storageKey)).toBe(false);

    const cleared = await putMe(
      link.secret,
      'kyc',
      { payload: { who: 'x' }, files: { docs: [] } },
      created.editSecret
    );
    expect(cleared.status).toBe(200);
    expect((await readJson(cleared)).response.files).toEqual([]);
    expect((await readJson(await owner(`/responses/${created.response.id}`))).response.files).toEqual([]);
  });

  it('the same holds on a remembering link, whose every submit is a POST', async () => {
    const link = await createToken({ name: 'Remy off', remembersResponses: true });
    const one = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'one.pdf' });
    const two = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'two.pdf' });
    await submit(link.secret, 'kyc', { payload: {}, files: { docs: [one.id, two.id] } });
    const late = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'late.pdf' });
    expect((await switchOff(link.id)).status).toBe(200);

    const refused = await submit(link.secret, 'kyc', { payload: {}, files: { docs: [one.id, late.id] } });
    expect(refused.status).toBe(403);
    const removed = await submit(link.secret, 'kyc', { payload: {}, files: { docs: [one.id] } });
    expect(removed.status).toBe(200);
    expect((await readJson(removed)).response.files.map((f: { name: string }) => f.name)).toEqual([
      'one.pdf'
    ]);
    expect(
      await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, two.id))
    ).toHaveLength(0);
  });
});

describe('edits, removals and the bytes behind them', () => {
  it('an edit names the full set: a file left out is removed from storage, the history keeps its name', async () => {
    const link = await createToken({ name: 'editor' });
    const keep = await uploadOk(link.secret, 'kyc', bytesOf(16), { name: 'keep.pdf' });
    const drop = await uploadOk(link.secret, 'kyc', bytesOf(16), { name: 'drop.pdf' });
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: { who: 'v1' }, files: { docs: [keep.id, drop.id] } })
    );
    const rid = created.response.id;

    // No `files` key: the files are untouched.
    const textOnly = await putMe(link.secret, 'kyc', { payload: { who: 'v2' } }, created.editSecret);
    expect(textOnly.status).toBe(200);
    expect((await readJson(textOnly)).response.files).toHaveLength(2);

    const added = await uploadOk(link.secret, 'kyc', bytesOf(16), { name: 'added.pdf' });
    const edited = await putMe(
      link.secret,
      'kyc',
      { payload: { who: 'v3' }, files: { docs: [keep.id, added.id] } },
      created.editSecret
    );
    expect(edited.status).toBe(200);
    expect((await readJson(edited)).response.files.map((f: { name: string }) => f.name)).toEqual([
      'keep.pdf',
      'added.pdf'
    ]);
    expect((await owner(`/responses/${rid}/files/${drop.id}`)).status).toBe(404);
    expect(
      await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, drop.id))
    ).toHaveLength(0);

    const versions = await app.db.db
      .select()
      .from(formResponseVersions)
      .where(eq(formResponseVersions.responseId, rid))
      .orderBy(formResponseVersions.revision);
    expect(versions.map((v) => v.files!.map((f) => f.name))).toEqual([
      ['keep.pdf', 'drop.pdf'],
      ['keep.pdf', 'drop.pdf'],
      ['keep.pdf', 'added.pdf']
    ]);
  });

  it('a remembering link keeps one response: the second submit replaces the set, the probe shows names only', async () => {
    const link = await createToken({ name: 'Remy', remembersResponses: true });
    const one = await uploadOk(link.secret, 'kyc', bytesOf(16), { name: 'one.pdf' });
    const first = await readJson(
      await submit(link.secret, 'kyc', { payload: {}, files: { docs: [one.id] } })
    );
    expect(first.remembered).toBe(true);
    const two = await uploadOk(link.secret, 'kyc', bytesOf(16), { name: 'two.pdf' });
    const second = await submit(link.secret, 'kyc', { payload: {}, files: { docs: [one.id, two.id] } });
    expect(second.status).toBe(200);
    const probe = await readJson(
      await app.app.request(`/api/v1/viewer/${link.secret}/forms/responses/remembered`, {
        headers: { origin: 'null', 'x-forwarded-for': nextIp() }
      })
    );
    expect(probe.responses).toHaveLength(1);
    expect(probe.responses[0].files).toEqual([
      { id: one.id, field: 'docs', name: 'one.pdf', sizeBytes: 16 },
      { id: two.id, field: 'docs', name: 'two.pdf', sizeBytes: 16 }
    ]);
  });

  it('the respondent removes a pending upload; an attached one, or one of another link, answers 404', async () => {
    const a = await createToken({ name: 'remover' });
    const b = await createToken({ name: 'stranger' });
    const del = (secret: string, id: string) =>
      app.app.request(`/api/v1/viewer/${secret}/forms/kyc/uploads/${id}`, {
        method: 'DELETE',
        headers: { origin: 'null', 'x-forwarded-for': nextIp() }
      });
    const pending = await uploadOk(a.secret, 'kyc', bytesOf(8));
    expect((await del(b.secret, pending.id)).status).toBe(404);
    expect((await del(a.secret, pending.id)).status).toBe(200);
    expect((await del(a.secret, pending.id)).status).toBe(404);
    expect((await submit(a.secret, 'kyc', { payload: {}, files: { docs: [pending.id] } })).status).toBe(400);

    const attached = await uploadOk(a.secret, 'kyc', bytesOf(8));
    await submit(a.secret, 'kyc', { payload: {}, files: { docs: [attached.id] } });
    expect((await del(a.secret, attached.id)).status).toBe(404);
    expect((await del(a.secret, 'not-a-uuid')).status).toBe(404);
  });

  it('deleting a response removes its files, rows and bytes', async () => {
    const link = await createToken({ name: 'to delete' });
    const f = await uploadOk(link.secret, 'kyc', bytesOf(32));
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: {}, files: { docs: [f.id] } })
    );
    const [row] = await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, f.id));
    const gone = await owner(`/responses/${created.response.id}`, { method: 'DELETE' });
    expect(gone.status).toBe(200);
    expect((await readJson(gone)).files.map((x: { id: string }) => x.id)).toEqual([f.id]);
    expect(
      await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, f.id))
    ).toHaveLength(0);
    expect(row!.storageKey).toMatch(new RegExp(`^forms/[0-9a-f-]+/${deckId}/${f.id}$`));
    const { createStorageDriver } = await import('@antasphere/chassis-server/storage');
    expect(await createStorageDriver(app.env).exists(row!.storageKey)).toBe(false);
  });

  it('the purge sweep removes what no response holds once it is a day old, and nothing else', async () => {
    const link = await createToken({ name: 'purge' });
    const stale = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'stale.pdf' });
    const fresh = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'fresh.pdf' });
    const held = await uploadOk(link.secret, 'kyc', bytesOf(8), { name: 'held.pdf' });
    await submit(link.secret, 'kyc', { payload: {}, files: { docs: [held.id] } });
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
    await app.db.db
      .update(formResponseFiles)
      .set({ createdAt: old })
      .where(eq(formResponseFiles.id, stale.id));
    await app.db.db
      .update(formResponseFiles)
      .set({ createdAt: old })
      .where(eq(formResponseFiles.id, held.id));

    const { FormUploadService, formUploadCaps } = await import('../../src/forms/uploads.js');
    const { createStorageDriver } = await import('@antasphere/chassis-server/storage');
    const service = new FormUploadService(
      app.db.db,
      createStorageDriver(app.env),
      `${app.env.DATA_DIR}/tmp`,
      app.logger,
      formUploadCaps(app.env)
    );
    expect(await service.purgeUnattached()).toBeGreaterThanOrEqual(1);
    const left = (await fileRows()).map((r) => r.id);
    expect(left).not.toContain(stale.id);
    expect(left).toContain(fresh.id);
    expect(left).toContain(held.id);
  });
});

describe('a deleted deck', () => {
  it('its files are removed by the sweep a day after the delete, the text answers stay', async () => {
    const deck = await uploadDeck('Doomed deck');
    const link = await createToken({ name: 'doomed' }, deck);
    const f = await uploadOk(link.secret, 'kyc', bytesOf(64), { name: 'doomed.pdf' });
    const created = await readJson(
      await submit(link.secret, 'kyc', { payload: { who: 'x' }, files: { docs: [f.id] } })
    );
    const del = await app.app.request(`/api/v1/presentations/${deck}`, {
      method: 'DELETE',
      headers: { cookie }
    });
    expect(del.status).toBeLessThan(300);

    const { FormUploadService, formUploadCaps } = await import('../../src/forms/uploads.js');
    const { createStorageDriver } = await import('@antasphere/chassis-server/storage');
    const storage = createStorageDriver(app.env);
    const service = new FormUploadService(
      app.db.db,
      storage,
      `${app.env.DATA_DIR}/tmp`,
      app.logger,
      formUploadCaps(app.env)
    );
    const [row] = await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, f.id));

    // The day of the delete: nothing moves.
    await service.purgeUnattached();
    expect(await storage.exists(row!.storageKey)).toBe(true);

    // A day later (the sweep's clock moved forward, the file is older than a day too).
    await service.purgeUnattached(new Date(Date.now() + 25 * 60 * 60 * 1000));
    expect(
      await app.db.db.select().from(formResponseFiles).where(eq(formResponseFiles.id, f.id))
    ).toHaveLength(0);
    expect(await storage.exists(row!.storageKey)).toBe(false);
    expect(
      await app.db.db.select().from(formResponses).where(eq(formResponses.id, created.response.id))
    ).toHaveLength(1);
  });
});

describe("the deck's upload total", () => {
  it('refuses the upload that would pass it, counts pending files, and frees room on removal', async () => {
    const link = await createToken({ name: 'full' }, otherDeckId);
    const up = (n: number) =>
      app.app.request(`/api/v1/viewer/${link.secret}/forms/kyc/uploads?field=docs&name=chunk.bin`, {
        method: 'POST',
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(n),
          origin: 'null',
          'x-forwarded-for': nextIp()
        },
        body: bytesOf(n)
      });
    const first = await readJson(await up(900 * 1024));
    expect((await up(900 * 1024)).status).toBe(201);
    const third = await up(900 * 1024);
    expect(third.status).toBe(403);
    expect((await readJson(third)).error.code).toBe('uploads_full');

    const del = await app.app.request(`/api/v1/viewer/${link.secret}/forms/kyc/uploads/${first.file.id}`, {
      method: 'DELETE',
      headers: { origin: 'null', 'x-forwarded-for': nextIp() }
    });
    expect(del.status).toBe(200);
    expect((await up(900 * 1024)).status).toBe(201);
  });

  it('six uploads fired at the route at once never pass the total, and each refusal is a 403 uploads_full', async () => {
    // The route's own leg (its bucket, its capability gate, the error
    // mapping). In-process requests may not overlap inside the insert
    // window, so the LOCK is pinned by the forced-overlap test below.
    const deck = await uploadDeck('Race deck (route)');
    const link = await createToken({ name: 'race route' }, deck);
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        app.app.request(`/api/v1/viewer/${link.secret}/forms/kyc/uploads?field=docs&name=race.bin`, {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            origin: 'null',
            'x-forwarded-for': nextIp()
          },
          body: bytesOf(700 * 1024)
        })
      )
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(2);
    for (const r of results.filter((x) => x.status !== 201)) {
      expect(r.status).toBe(403);
      expect((await readJson(r)).error.code).toBe('uploads_full');
    }
  });

  it('concurrent uploads cannot all pass a nearly full total', async () => {
    // Verifier round 1: six requests through app.request never overlapped
    // inside the count-then-insert window, so this test stayed green with
    // the per-deck lock REMOVED. The overlap is now forced: the storage
    // driver holds every upload at its `put` until all six have arrived, so
    // all six reach the insert transaction at the same instant, each having
    // already passed the cheap unlocked pre-check against an empty deck.
    const deck = await uploadDeck('Race deck');
    const link = await createToken({ name: 'race' }, deck);
    const { FormUploadService, FormUploadsFullError, formUploadCaps } =
      await import('../../src/forms/uploads.js');
    const { createStorageDriver } = await import('@antasphere/chassis-server/storage');
    const { Readable } = await import('node:stream');
    const real = createStorageDriver(app.env);
    const N = 6;
    let arrived = 0;
    let release!: () => void;
    const allArrived = new Promise<void>((resolve) => (release = resolve));
    const gated = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop !== 'put') return Reflect.get(target, prop, receiver);
        return async (...args: Parameters<typeof real.put>) => {
          if (++arrived === N) release();
          await allArrived;
          return target.put(...args);
        };
      }
    });
    const service = new FormUploadService(
      app.db.db,
      gated,
      `${app.env.DATA_DIR}/tmp`,
      app.logger,
      formUploadCaps(app.env)
    );
    const [token] = await app.db.db.select().from(shareTokens).where(eq(shareTokens.id, link.id));
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        service.upload({
          workspaceId: token!.workspaceId,
          presentationId: deck,
          shareTokenId: link.id,
          formName: 'kyc',
          fieldName: 'docs',
          filename: `race-${i}.bin`,
          contentType: 'application/octet-stream',
          body: Readable.from([Buffer.alloc(700 * 1024, 1)])
        })
      )
    );
    expect(arrived).toBe(N);
    const stored = results.filter((r) => r.status === 'fulfilled');
    const refused = results.filter((r) => r.status === 'rejected');
    expect(stored).toHaveLength(2); // 2 × 700 KB fit under 2 MB, a third does not
    expect(refused).toHaveLength(4);
    for (const r of refused) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(FormUploadsFullError);
    const rows = await app.db.db
      .select()
      .from(formResponseFiles)
      .where(eq(formResponseFiles.presentationId, deck));
    expect(rows).toHaveLength(2);
    // The four refused uploads left no bytes behind.
    for (const r of stored)
      expect(await real.exists((r as PromiseFulfilledResult<{ storageKey: string }>).value.storageKey)).toBe(
        true
      );
  });
});

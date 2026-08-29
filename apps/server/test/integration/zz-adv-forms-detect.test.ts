import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { presentations } from '@slideless/db';
import { FORMS_MARKER } from '../../src/viewer/forms-runtime.js';
import {
  createDatabase,
  createTestApp,
  extractCookie,
  readJson,
  startPostgres,
  SETUP_TOKEN,
  type TestApp
} from './helpers.js';

const OWNER = { email: 'owner@advforms.test', name: 'O', password: 'owner-password-12345' };
const json = (body: unknown, headers: Record<string, string> = {}) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body)
});
const shaOf = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const entryOf = (path: string, bytes: Buffer, contentType = 'text/html') => ({
  path,
  sha256: shaOf(bytes),
  sizeBytes: bytes.length,
  contentType
});

const HTML_SHELL = Buffer.from(
  '<!doctype html><html><head><title>Shell</title></head><body><div id="deck"></div><script src="app.js"></script></body></html>'
);
// Shape 1: the idiomatic DOM way to set data-slideless-form from JS — no literal marker anywhere.
const JS_DATASET = Buffer.from(
  "document.addEventListener('DOMContentLoaded',function(){var f=document.createElement('form');f.dataset.slidelessForm='contact';var i=document.createElement('input');i.name='email';f.appendChild(i);document.getElementById('deck').appendChild(f);});"
);
// Shape 2: a schema-driven deck — the attribute lives in a JSON data file the bundle renders.
const JS_RENDER = Buffer.from(
  "fetch('slides.json').then(function(r){return r.json()}).then(function(s){var f=document.createElement('form');Object.keys(s.form.attrs).forEach(function(k){f.setAttribute(k,s.form.attrs[k])});document.getElementById('deck').appendChild(f);});"
);
const JSON_SCHEMA = Buffer.from('{"form":{"attrs":{"data-slideless-form":"survey"}}}');
// A script-less, marker-less page: the streaming (no-runtime) path is kept for it.
const HTML_PLAIN = Buffer.from(
  '<!doctype html><html><head><title>Plain</title></head><body><h1>Just slides</h1></body></html>'
);
// Inline runnable code, no marker anywhere: inconclusive → armed.
const HTML_INLINE_SCRIPT = Buffer.from(
  "<!doctype html><html><body><div id=\"deck\"></div><script>var f=document.createElement('form');f.dataset.slidelessForm='inline';document.getElementById('deck').appendChild(f);</script></body></html>"
);
// Shape 3: a minifier/obfuscator that splits string constants (common in bundles).
const JS_SPLIT = Buffer.from(
  "document.addEventListener('DOMContentLoaded',function(){var f=document.createElement('form');f.setAttribute('data-slideless-'+'form','split');document.getElementById('deck').appendChild(f);});"
);

let container: StartedPostgreSqlContainer;
let app: TestApp;
let cookie: string;

beforeAll(async () => {
  container = await startPostgres();
  app = await createTestApp(await createDatabase(container, 'adv_forms'));
  await app.app.request('/api/v1/setup', json({ setupToken: SETUP_TOKEN, instanceName: 'F', owner: OWNER }));
  cookie = extractCookie(
    await app.app.request(
      '/api/v1/auth/sign-in/email',
      json({ email: OWNER.email, password: OWNER.password })
    )
  );
  for (const bytes of [
    HTML_SHELL,
    JS_DATASET,
    JS_RENDER,
    JSON_SCHEMA,
    JS_SPLIT,
    HTML_PLAIN,
    HTML_INLINE_SCRIPT
  ]) {
    const form = new FormData();
    form.set('sha256', shaOf(bytes));
    form.set('file', new Blob([new Uint8Array(bytes)]), 'x');
    const res = await app.app.request('/api/v1/presentations/assets', {
      method: 'POST',
      headers: { cookie },
      body: form
    });
    expect(res.status).toBe(201);
  }
}, 180_000);
afterAll(async () => {
  await app?.stop();
  await container?.stop();
});

async function uploadDeck(title: string, manifest: Array<ReturnType<typeof entryOf>>) {
  const reserve = await readJson(
    await app.app.request('/api/v1/presentations/uploads', { method: 'POST', headers: { cookie } })
  );
  const commit = await app.app.request(
    `/api/v1/presentations/uploads/${reserve.uploadSession.id}/commit`,
    json({ title, entryPath: 'index.html', manifest }, { cookie })
  );
  expect(commit.status).toBe(201);
  return reserve.uploadSession.presentationId as string;
}
async function hasForms(id: string) {
  const [row] = await app.db.db.select().from(presentations).where(eq(presentations.id, id));
  return row!.hasForms;
}
async function runtimeInjected(id: string) {
  const res = await app.app.request(`/api/v1/presentations/${id}/tokens`, json({ name: 't' }, { cookie }));
  const { secret } = await readJson(res);
  const html = await (await app.app.request(`/v/${secret}/`, { headers: { accept: 'text/html' } })).text();
  return html.includes(FORMS_MARKER);
}

/**
 * PRDCT-1810 (found by the adversarial e2e pass of 2026-08-29, red repro on
 * adv/sl-e2e@c3d1416): three ordinary bundle shapes author a real
 * data-slideless-form at runtime and carry NO literal marker. A byte scan
 * for the marker stamped all three form-less: no runtime, native submit,
 * nothing stored. The rule now: runnable code is inconclusive and ARMS the
 * runtime (forms/detect.ts, docs/sharing/forms.md).
 */
describe('PRDCT-1810: bundle shapes that author a real data-slideless-form at runtime but carry no literal marker', () => {
  it('dataset.slidelessForm (idiomatic DOM)', async () => {
    const id = await uploadDeck('dataset', [
      entryOf('index.html', HTML_SHELL),
      entryOf('app.js', JS_DATASET, 'text/javascript')
    ]);
    expect(await hasForms(id)).toBe(true);
    expect(await runtimeInjected(id)).toBe(true);
  });
  it('attribute from a JSON data file rendered by the bundle', async () => {
    const id = await uploadDeck('json', [
      entryOf('index.html', HTML_SHELL),
      entryOf('app.js', JS_RENDER, 'text/javascript'),
      entryOf('slides.json', JSON_SCHEMA, 'application/json')
    ]);
    expect(await hasForms(id)).toBe(true);
    expect(await runtimeInjected(id)).toBe(true);
  });
  it('split string constant', async () => {
    const id = await uploadDeck('split', [
      entryOf('index.html', HTML_SHELL),
      entryOf('app.js', JS_SPLIT, 'text/javascript')
    ]);
    expect(await hasForms(id)).toBe(true);
    expect(await runtimeInjected(id)).toBe(true);
  });
  it('a script-less page whose form attributes live in a JSON data file is armed by the JSON scan', async () => {
    const id = await uploadDeck('json-only', [
      entryOf('index.html', HTML_PLAIN),
      entryOf('slides.json', JSON_SCHEMA, 'application/json')
    ]);
    expect(await hasForms(id)).toBe(true);
  });
  it('an inline <script> with no literal marker arms the runtime; a script-less marker-less page keeps the streaming path', async () => {
    const inline = await uploadDeck('inline', [entryOf('index.html', HTML_INLINE_SCRIPT)]);
    expect(await hasForms(inline)).toBe(true);
    expect(await runtimeInjected(inline)).toBe(true);
    const plain = await uploadDeck('plain', [entryOf('index.html', HTML_PLAIN)]);
    expect(await hasForms(plain)).toBe(false);
    expect(await runtimeInjected(plain)).toBe(false);
  });
});

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, realpath, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { run } from '../src/index.js';
import { responsesCsv } from '../src/commands/sharing.js';
import {
  contentDispositionName,
  responseFolder,
  safePathSegment,
  uniqueRelPath
} from '../src/commands/response-files.js';
import { DECK, routedHarness, type Route } from './harness.js';

// Every test here hashes and writes real files, and the CI runner runs this
// file beside the whole monorepo's suites: 0.5 s on a laptop, 3.6 to 6.5 s
// there, where one test crossed the 5 s default (PR #48, first CI run).
vi.setConfig({ testTimeout: 20_000 });

/**
 * PRDCT-2403 at the terminal: a form's FILE FIELD. The per-link upload
 * switch (`share --no-uploads`, `uploads --on|--off`), the files a response
 * holds (`responses`, `response`, the CSV column), and `response-files`,
 * which brings respondent-chosen names onto the owner's disk — so the same
 * PRDCT-1353 posture as `pull`: contained writes, size cap, sha256 check.
 */

const AUTH = ['--url', 'http://x', '--api-key', 'slk_k_s'];
const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

const TOKEN = {
  id: '44444444-4444-4444-4444-444444444444',
  presentationId: DECK.id,
  name: 'cli',
  purpose: 'share',
  versionMode: 'latest',
  pinnedVersion: null,
  canAnnotate: false,
  canSubmitForms: true,
  canDownload: true,
  showBar: true,
  remembersResponses: false,
  canUploadFiles: true,
  badgePosition: null,
  expiresAt: null,
  hasPassword: false,
  revokedAt: null,
  accessCount: 2,
  lastAccessedAt: null,
  downloadCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z'
};

const RESPONSE_ID = '77777777-7777-7777-7777-777777777777';
const OTHER_RESPONSE_ID = '88888888-8888-8888-8888-888888888888';

interface Upload {
  id: string;
  field: string;
  name: string;
  bytes: Buffer;
  declaredSize?: number;
  declaredSha?: string;
}

let nextFileId = 0;
function upload(field: string, name: string, content: string, over: Partial<Upload> = {}): Upload {
  nextFileId += 1;
  const id = `aaaaaaaa-0000-0000-0000-${String(nextFileId).padStart(12, '0')}`;
  return { id, field, name, bytes: Buffer.from(content), ...over };
}

function wireFile(u: Upload) {
  return {
    id: u.id,
    field: u.field,
    name: u.name,
    contentType: 'application/octet-stream',
    sizeBytes: u.declaredSize ?? u.bytes.length,
    sha256: u.declaredSha ?? sha(u.bytes),
    createdAt: '2026-09-14T20:00:00.000Z'
  };
}

function wireResponse(id: string, uploads: Upload[], over: Record<string, unknown> = {}) {
  return {
    id,
    presentationId: DECK.id,
    version: 1,
    formName: 'apply',
    shareTokenId: TOKEN.id,
    shareTokenName: 'alice',
    source: 'link',
    placement: null,
    payload: { name: 'Alice' },
    revision: 1,
    files: uploads.map(wireFile),
    createdAt: '2026-09-14T20:00:00.000Z',
    updatedAt: '2026-09-14T20:00:00.000Z',
    ...over
  };
}

/** The listing + the per-file download, as the instance serves them. */
function fileRoutes(
  responses: Array<{ id: string; uploads: Upload[]; over?: Record<string, unknown> }>
): Route[] {
  const bytesById = new Map(responses.flatMap((r) => r.uploads.map((u) => [u.id, u.bytes] as const)));
  return [
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/responses$`),
      reply: () => ({
        body: { responses: responses.map((r) => wireResponse(r.id, r.uploads, r.over)), nextCursor: null }
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/[0-9a-f-]+/files/[0-9a-f-]+$`),
      reply: ({ path }) => ({
        raw: new Response(bytesById.get(path.split('/').pop()!) ?? Buffer.alloc(0), { status: 200 })
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/[0-9a-f-]+$`),
      reply: ({ path }) => {
        const r = responses.find((x) => path.endsWith(x.id));
        return r
          ? { body: { response: wireResponse(r.id, r.uploads, r.over), versions: [] } }
          : { status: 404, body: { error: { code: 'not_found', message: 'Response not found' } } };
      }
    }
  ];
}

/** A sandbox whose PARENTS are watched too: an escape shows up as a stray sibling. */
async function sandbox(): Promise<{ top: string; root: string }> {
  const top = await realpath(await mkdtemp(join(tmpdir(), 'slideless-form-files-')));
  await mkdir(join(top, 'box'));
  return { top, root: join(top, 'box', 'out') };
}

async function tree(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(relative(dir, p));
    }
  };
  await walk(dir);
  return out.sort();
}

// ── The per-link switch ──────────────────────────────────────────────────────

const createRoute: Route = {
  method: 'POST',
  path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
  reply: ({ body }) => {
    const b = body as { name: string; canUploadFiles?: boolean };
    return {
      status: 201,
      body: {
        shareToken: { ...TOKEN, name: b.name, canUploadFiles: b.canUploadFiles ?? true },
        secret: 's3cret',
        url: 'http://x/v/s3cret/'
      }
    };
  }
};

describe('share --no-uploads: the per-link file-upload switch', () => {
  it('sends canUploadFiles true by default and false with --no-uploads, and says so', async () => {
    const on = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, ...AUTH], on.io)).toBe(0);
    expect(on.calls[0]?.body).toMatchObject({ canUploadFiles: true });
    expect(on.out()).not.toContain('no uploads');

    const off = routedHarness([createRoute]);
    expect(await run(['share', DECK.id, '--no-uploads', ...AUTH], off.io)).toBe(0);
    expect(off.calls[0]?.body).toMatchObject({ canUploadFiles: false, canSubmitForms: true });
    expect(off.out()).toContain('no uploads');
  });

  it('share-email carries the switch on every link it mints', async () => {
    const h = routedHarness([
      createRoute,
      {
        method: 'POST',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/[^/]+/send$`),
        reply: () => ({ body: { shareToken: TOKEN, emailSent: true } })
      }
    ]);
    expect(
      await run(['share-email', DECK.id, '--to', 'a@x.io', 'b@x.io', '--no-uploads', ...AUTH], h.io)
    ).toBe(0);
    const mints = h.calls.filter((c) => /\/tokens$/.test(c.path));
    expect(mints).toHaveLength(2);
    for (const c of mints) expect(c.body).toMatchObject({ canUploadFiles: false });
  });

  it('tokens shows "no uploads" on a link that has them off, nothing on an older server', async () => {
    const { canUploadFiles: _dropped, ...legacy } = TOKEN;
    const h = routedHarness([
      {
        method: 'GET',
        path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens`),
        reply: () => ({
          body: {
            shareTokens: [
              TOKEN,
              { ...TOKEN, name: 'old', canUploadFiles: false },
              { ...legacy, name: 'legacy' }
            ],
            nextCursor: null
          }
        })
      }
    ]);
    expect(await run(['tokens', DECK.id, ...AUTH], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).not.toContain('no uploads');
    expect(lines[1]).toMatch(/old\s.*no uploads/);
    expect(lines[2]).not.toContain('no uploads');
  });
});

describe('uploads <id> <tokenId>: the switch on an existing link', () => {
  const routes: Route[] = [
    {
      method: 'PATCH',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens/${TOKEN.id}$`),
      reply: ({ body }) => ({
        body: { ...TOKEN, canUploadFiles: (body as { canUploadFiles: boolean }).canUploadFiles }
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/tokens$`),
      reply: () => ({ body: { shareTokens: [{ ...TOKEN, canUploadFiles: false }], nextCursor: null } })
    }
  ];

  it('reads the state without a flag, flips it with --on and --off', async () => {
    const h = routedHarness(routes);
    expect(await run(['uploads', DECK.id, TOKEN.id, ...AUTH], h.io)).toBe(0);
    expect(h.calls[0]?.method).toBe('GET');
    expect(h.out()).toContain('File uploads are OFF');

    expect(await run(['uploads', DECK.id, TOKEN.id, '--on', ...AUTH], h.io)).toBe(0);
    expect(h.calls[1]).toMatchObject({ method: 'PATCH', body: { canUploadFiles: true } });
    expect(h.calls[1]?.body).toEqual({ canUploadFiles: true });
    expect(h.out()).toContain('File uploads are ON');

    expect(await run(['uploads', DECK.id, TOKEN.id, '--off', '--json', ...AUTH], h.io)).toBe(0);
    expect(h.calls[2]).toMatchObject({ method: 'PATCH', body: { canUploadFiles: false } });
    expect(h.out()).toContain('"canUploadFiles": false');
  });

  it('refuses --on with --off, and a token the deck does not have', async () => {
    const both = routedHarness(routes);
    expect(await run(['uploads', DECK.id, TOKEN.id, '--on', '--off', ...AUTH], both.io)).toBe(1);
    expect(both.err()).toContain('either --on or --off');
    expect(both.calls).toHaveLength(0);

    const unknown = routedHarness(routes);
    expect(await run(['uploads', DECK.id, '99999999-9999-9999-9999-999999999999', ...AUTH], unknown.io)).toBe(
      1
    );
    expect(unknown.err()).toContain('No share token');
  });
});

// ── What a response holds ────────────────────────────────────────────────────

describe('responses: the files count and the CSV files columns', () => {
  const cv = upload('cv', 'cv.pdf', 'pdf');
  const formula = upload('cv', "=cmd|' /c calc'!A1.pdf", 'x');
  const photo = upload('@photo', 'me, myself.png', 'png');
  const rows = [
    wireResponse(RESPONSE_ID, [cv, formula, photo]),
    wireResponse(OTHER_RESPONSE_ID, [], { payload: { name: 'Bob' } })
  ];
  const listRoute: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DECK.id}/responses$`),
    reply: () => ({ body: { responses: rows, nextCursor: null } })
  };

  it('the human table counts the files of each row', async () => {
    const h = routedHarness([listRoute]);
    expect(await run(['responses', DECK.id, '--form', 'apply', ...AUTH], h.io)).toBe(0);
    const lines = h.out().split('\n');
    expect(lines[0]).toMatch(/\s3 files\s/);
    expect(lines[1]).toMatch(/\s-\s+\{"name":"Bob"\}/);
  });

  it('--csv adds one "<field> (files)" column per file field, names joined with "; "', async () => {
    const h = routedHarness([listRoute]);
    expect(await run(['responses', DECK.id, '--form', 'apply', '--csv', ...AUTH], h.io)).toBe(0);
    const [header, first, second] = h.out().split('\r\n');
    // The field name is respondent-side input too: `@photo (files)` is guarded.
    expect(header).toBe("formName,source,placement,link,createdAt,name,cv (files),'@photo (files)");
    // `cv.pdf; =cmd…` starts with a safe character, so it is quoted only where RFC 4180 asks.
    expect(first).toContain(",cv.pdf; =cmd|' /c calc'!A1.pdf,");
    expect(first).toContain(',"me, myself.png"');
    expect(second?.endsWith(',Bob,,')).toBe(true);
  });

  it('a file name that opens the cell as a formula gets the apostrophe guard', () => {
    const csv = responsesCsv([
      wireResponse(RESPONSE_ID, [upload('cv', '=HYPERLINK("http://evil","cv").pdf', 'x')]),
      wireResponse(OTHER_RESPONSE_ID, [upload('cv', ' +1.pdf', 'x'), upload('cv', 'b.pdf', 'x')])
    ] as never);
    const lines = csv.split('\r\n');
    expect(lines[1]).toContain(`"'=HYPERLINK(""http://evil"",""cv"").pdf"`);
    expect(lines[2]).toContain(",' +1.pdf; b.pdf");
  });

  it('rows from a server older than file fields (no `files` key) export as before', () => {
    const { files: _dropped, ...legacy } = wireResponse(RESPONSE_ID, []);
    expect(responsesCsv([legacy] as never)).toBe(
      'formName,source,placement,link,createdAt,name\r\napply,link,,alice,2026-09-14T20:00:00.000Z,Alice\r\n'
    );
  });

  it('--json passes the wire through untouched, files included', async () => {
    const h = routedHarness([listRoute]);
    expect(await run(['responses', DECK.id, '--form', 'apply', '--json', ...AUTH], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({ responses: rows, nextCursor: null });
  });
});

describe('response <id> <responseId>: the files, now and per revision', () => {
  const evil = upload('cv', 'cv\u001b[2J.pdf', 'pdf');
  const detail = {
    response: wireResponse(RESPONSE_ID, [evil], { revision: 3 }),
    versions: [
      {
        revision: 3,
        version: 1,
        shareTokenId: TOKEN.id,
        shareTokenName: 'alice',
        source: 'link',
        placement: null,
        payload: { name: 'Alice' },
        files: [{ id: evil.id, field: 'cv', name: evil.name, sizeBytes: 3 }],
        createdAt: '2026-09-14T22:00:00.000Z'
      },
      {
        revision: 2,
        version: 1,
        shareTokenId: TOKEN.id,
        shareTokenName: 'alice',
        source: 'link',
        placement: null,
        payload: { name: 'Alice' },
        files: [],
        createdAt: '2026-09-14T21:00:00.000Z'
      },
      {
        revision: 1,
        version: 1,
        shareTokenId: TOKEN.id,
        shareTokenName: 'alice',
        source: 'link',
        placement: null,
        payload: { name: 'Al' },
        files: null,
        createdAt: '2026-09-14T20:00:00.000Z'
      }
    ]
  };
  const route: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/${RESPONSE_ID}$`),
    reply: () => ({ body: detail })
  };

  it('lists field, name, size and id, then the names each revision held', async () => {
    const h = routedHarness([route]);
    expect(await run(['response', DECK.id, RESPONSE_ID, ...AUTH], h.io)).toBe(0);
    const out = h.out();
    expect(out).toContain('Files (1):');
    expect(out).toMatch(new RegExp(`cv\\s+cv\\.pdf\\s+3 B\\s+${evil.id}`));
    expect(out).toContain(`slideless response-files ${DECK.id} ${RESPONSE_ID}`);
    const history = out.slice(out.indexOf('History'));
    expect(history).toMatch(/r3\s.*files: cv\.pdf/);
    expect(history).toMatch(/r2\s.*no files/);
    expect(history).toMatch(/r1\s.*v1\s+-\s+\{"name":"Al"\}/);
    // The respondent's escape sequence never reaches the terminal.
    expect(out).not.toContain('\u001b');
  });

  it('--json stays byte-exact: the escape sequence is data there', async () => {
    const h = routedHarness([route]);
    expect(await run(['response', DECK.id, RESPONSE_ID, '--json', ...AUTH], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual(detail);
  });
});

// ── response-files: names are hostile, bytes are verified ────────────────────

describe('safePathSegment reduces any string to one inert segment', () => {
  it.each([
    ['../../x', 'x'],
    ['..', '_'],
    ['.', '_'],
    ['', '_'],
    ['.env', '_env'],
    ['...hidden', '_hidden'],
    ['a/b\\c.txt', 'c.txt'],
    ['C:\\Users\\me\\cv.pdf', 'cv.pdf'],
    ['/etc/cron.d/x', 'x'],
    ['cv\u0000\u001b[2J\u009b.pdf', 'cv[2J.pdf'],
    ['what?*<>|".txt', 'what______.txt'],
    ['trailing. . ', 'trailing'],
    ['ok name (1).pdf', 'ok name (1).pdf']
  ])('%j → %j', (raw, expected) => {
    const got = safePathSegment(raw);
    expect(got).toBe(expected);
    expect(got).not.toMatch(/[\\/]/);
    expect(got.startsWith('.')).toBe(false);
  });

  it('keeps a long name under the filesystem limit, extension kept', () => {
    const got = safePathSegment(`${'é'.repeat(300)}.pdf`);
    expect(got.length).toBeLessThanOrEqual(120);
    expect(Buffer.byteLength(got)).toBeLessThanOrEqual(255);
    expect(got.endsWith('.pdf')).toBe(true);
  });

  it('dedupes case-insensitively with " (n)" before the extension', () => {
    const taken = new Set<string>();
    expect(uniqueRelPath('cv', 'cv.pdf', taken)).toBe('cv/cv.pdf');
    expect(uniqueRelPath('cv', 'CV.pdf', taken)).toBe('cv/CV (2).pdf');
    expect(uniqueRelPath('cv', 'cv.pdf', taken)).toBe('cv/cv (3).pdf');
    expect(uniqueRelPath('cv', 'README', taken)).toBe('cv/README');
    expect(uniqueRelPath('cv', 'README', taken)).toBe('cv/README (2)');
  });

  it("names a response's folder like the server's zip does, whatever the wire says", () => {
    expect(responseFolder({ id: RESPONSE_ID, createdAt: '2026-09-14T20:00:00.000Z' })).toBe(
      '20260914-2000-77777777'
    );
    expect(responseFolder({ id: '../../..', createdAt: 'not a date' })).toBe('_');
  });
});

describe('response-files --out: every write stays inside the folder', () => {
  it('lays a deck out as <form>/<response>/<field>/<name>', async () => {
    const { root } = await sandbox();
    const a = upload('cv', 'cv.pdf', 'alice cv');
    const b = upload('photo', 'me.png', 'alice photo');
    const c = upload('cv', 'cv.pdf', 'bob cv');
    const h = routedHarness(
      fileRoutes([
        { id: RESPONSE_ID, uploads: [a, b] },
        { id: OTHER_RESPONSE_ID, uploads: [c], over: { createdAt: '2026-09-15T08:30:00.000Z' } }
      ])
    );
    expect(await run(['response-files', DECK.id, '--out', root, ...AUTH], h.io)).toBe(0);
    expect(await tree(root)).toEqual([
      'apply/20260914-2000-77777777/cv/cv.pdf',
      'apply/20260914-2000-77777777/photo/me.png',
      'apply/20260915-0830-88888888/cv/cv.pdf'
    ]);
    expect(await readFile(join(root, 'apply/20260915-0830-88888888/cv/cv.pdf'), 'utf8')).toBe('bob cv');
    expect(h.out()).toContain('Downloaded 3 files');
  });

  it('passes every filter to the listing, as `responses` does', async () => {
    const { root } = await sandbox();
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [upload('cv', 'cv.pdf', 'x')] }]));
    const code = await run(
      [
        'response-files',
        DECK.id,
        '--form',
        'apply',
        '--link',
        TOKEN.id,
        '--source',
        'embed',
        '--placement',
        'pricing-footer',
        '--since',
        '2026-09-01',
        '--out',
        root,
        ...AUTH
      ],
      h.io
    );
    expect(code).toBe(0);
    const query = new URLSearchParams(h.calls[0]!.path.split('?')[1]);
    expect(query.get('form')).toBe('apply');
    expect(query.get('token')).toBe(TOKEN.id);
    expect(query.get('source')).toBe('embed');
    expect(query.get('placement')).toBe('pricing-footer');
    expect(query.get('since')).toBe('2026-09-01T00:00:00.000Z');
  });

  it('hostile file, field and form names never leave the folder', async () => {
    const { top, root } = await sandbox();
    const uploads = [
      upload('cv', '../../x', 'one'),
      upload('cv', '..', 'two'),
      upload('cv', '.env', 'three'),
      upload('cv', 'a/b\\c.txt', 'four'),
      upload('cv', 'evil\u001b[2J\u0007name.txt', 'five'),
      upload('cv', 'same.pdf', 'six'),
      upload('cv', 'same.pdf', 'seven'),
      upload('../../../field', '/etc/cron.d/job', 'eight'),
      upload('..', 'dotdot-field.txt', 'nine')
    ];
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads, over: { formName: '../..' } }]));
    expect(await run(['response-files', DECK.id, '--out', root, ...AUTH], h.io)).toBe(0);

    const base = '_/20260914-2000-77777777';
    expect(await tree(root)).toEqual(
      [
        `${base}/_/dotdot-field.txt`,
        `${base}/cv/_`,
        `${base}/cv/_env`,
        `${base}/cv/c.txt`,
        `${base}/cv/evil[2Jname.txt`,
        `${base}/cv/same (2).pdf`,
        `${base}/cv/same.pdf`,
        `${base}/cv/x`,
        `${base}/field/job`
      ].sort()
    );
    expect(await readFile(join(root, base, 'cv/same.pdf'), 'utf8')).toBe('six');
    expect(await readFile(join(root, base, 'cv/same (2).pdf'), 'utf8')).toBe('seven');
    // Nothing beside the folder, nothing above it.
    expect(await readdir(join(top, 'box'))).toEqual(['out']);
    expect(await readdir(top)).toEqual(['box']);
    // The table names what was sent when the path could not keep it — sanitized.
    expect(h.out()).toContain('(sent as "../../x")');
    expect(h.out()).not.toContain('\u001b');
    expect(h.out()).not.toContain('\u0007');
  });

  it("one response's files land as <field>/<name>", async () => {
    const { root } = await sandbox();
    const h = routedHarness(
      fileRoutes([
        { id: RESPONSE_ID, uploads: [upload('cv', 'cv.pdf', 'a'), upload('cv', '../cv.pdf', 'b')] }
      ])
    );
    expect(await run(['response-files', DECK.id, RESPONSE_ID, '--out', root, ...AUTH], h.io)).toBe(0);
    expect(await tree(root)).toEqual(['cv/cv (2).pdf', 'cv/cv.pdf']);
    // The listing route is never called in this mode.
    expect(h.calls[0]?.path).toBe(`/api/v1/presentations/${DECK.id}/responses/${RESPONSE_ID}`);
  });

  it('refuses to write through a symlinked folder planted in the destination', async () => {
    const { top, root } = await sandbox();
    const outside = join(top, 'outside');
    await mkdir(outside);
    await mkdir(root, { recursive: true });
    await symlink(outside, join(root, 'cv'));
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [upload('cv', 'cv.pdf', 'a')] }]));
    expect(await run(['response-files', DECK.id, RESPONSE_ID, '--out', root, ...AUTH], h.io)).toBe(1);
    expect(h.err()).toMatch(/symlinked directory/);
    expect(await readdir(outside)).toEqual([]);
  });

  it('refuses bytes that do not hash to what the response declares, and keeps nothing', async () => {
    const { root } = await sandbox();
    const swapped = upload('cv', 'cv.pdf', 'substituted payload', { declaredSha: sha('the real thing') });
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [swapped] }]));
    expect(await run(['response-files', DECK.id, '--out', root, ...AUTH], h.io)).toBe(1);
    expect(h.err()).toMatch(/hash to/);
    await expect(stat(root)).rejects.toThrow();
  });

  it('refuses a download bigger than the size the response declares', async () => {
    const { root } = await sandbox();
    const big = upload('cv', 'cv.pdf', 'A'.repeat(64 * 1024), { declaredSize: 10 });
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [big] }]));
    expect(await run(['response-files', DECK.id, '--out', root, ...AUTH], h.io)).toBe(1);
    expect(h.err()).toMatch(/exceeds the response's declared 10 bytes/);
    await expect(stat(root)).rejects.toThrow();
  });

  it('--json prints the summary: every file with its path, size and response', async () => {
    const { root } = await sandbox();
    const a = upload('cv', '../cv.pdf', 'alice cv');
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [a] }]));
    expect(await run(['response-files', DECK.id, '--out', root, '--json', ...AUTH], h.io)).toBe(0);
    expect(JSON.parse(h.out())).toEqual({
      mode: 'folder',
      path: root,
      files: [
        {
          responseId: RESPONSE_ID,
          formName: 'apply',
          fileId: a.id,
          field: 'cv',
          // The wire's name, verbatim: --json is data. The path is where it really went.
          name: '../cv.pdf',
          sizeBytes: 8,
          sha256: sha('alice cv'),
          path: join(root, 'apply/20260914-2000-77777777/cv/cv.pdf')
        }
      ],
      totalBytes: 8
    });
  });

  it('a deck with no files says so, exits 0 and creates nothing', async () => {
    const { root } = await sandbox();
    const h = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [] }]));
    expect(await run(['response-files', DECK.id, '--out', root, ...AUTH], h.io)).toBe(0);
    expect(h.out()).toContain('No uploaded files match.');
    await expect(stat(root)).rejects.toThrow();

    const json = routedHarness(fileRoutes([{ id: RESPONSE_ID, uploads: [] }]));
    expect(await run(['response-files', DECK.id, '--out', root, '--json', ...AUTH], json.io)).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ mode: 'folder', path: null, files: [], totalBytes: 0 });
  });

  it('refuses the deck filters beside a responseId, and --out beside --zip', async () => {
    const filters = routedHarness([]);
    expect(await run(['response-files', DECK.id, RESPONSE_ID, '--form', 'apply', ...AUTH], filters.io)).toBe(
      1
    );
    expect(filters.err()).toContain('cannot be combined with a responseId');

    const modes = routedHarness([]);
    expect(await run(['response-files', DECK.id, '--out', 'a', '--zip', 'b.zip', ...AUTH], modes.io)).toBe(1);
    expect(modes.err()).toContain('either --out <dir> or --zip [path]');
    expect(modes.calls).toHaveLength(0);
  });
});

// ── response-files --zip ─────────────────────────────────────────────────────

describe('response-files --zip: the server archive, streamed to disk', () => {
  const ZIP = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(200 * 1024, 0x5a)]);
  const zipRoutes = (disposition: string | null): Route[] => [
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/files\\.zip$`),
      reply: () => ({
        raw: new Response(ZIP, {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            ...(disposition !== null ? { 'content-disposition': disposition } : {})
          }
        })
      })
    },
    {
      method: 'GET',
      path: new RegExp(`/api/v1/presentations/${DECK.id}/responses/${RESPONSE_ID}/files\\.zip$`),
      reply: () => ({ raw: new Response(ZIP, { status: 200 }) })
    }
  ];

  /** The default name lands in the current directory, so the test moves there. */
  async function inDir<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const before = process.cwd();
    process.chdir(dir);
    try {
      return await fn();
    } finally {
      process.chdir(before);
    }
  }

  it('writes to the path the caller typed, with the filters on the wire', async () => {
    const { top } = await sandbox();
    const out = join(top, 'box', 'files.zip');
    const h = routedHarness(zipRoutes('attachment; filename="ignored.zip"'));
    const code = await run(
      [
        'response-files',
        DECK.id,
        '--zip',
        out,
        '--form',
        'apply',
        '--source',
        'link',
        '--since',
        '2026-09-01',
        ...AUTH
      ],
      h.io
    );
    expect(code).toBe(0);
    expect(await readFile(out)).toEqual(ZIP);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.path).toBe(
      `/api/v1/presentations/${DECK.id}/responses/files.zip?form=apply&source=link&since=2026-09-01T00%3A00%3A00.000Z`
    );
    expect(h.out()).toContain(`Form files written to ${out}`);
  });

  it("takes the server's name, reduced to a plain file name in the current directory", async () => {
    const { top } = await sandbox();
    const cwd = join(top, 'box');
    const h = routedHarness(
      zipRoutes(`attachment; filename="x.zip"; filename*=UTF-8''..%2F..%2Fmy-deck-form-files.zip`)
    );
    const code = await inDir(cwd, () => run(['response-files', DECK.id, '--zip', '--json', ...AUTH], h.io));
    expect(code).toBe(0);
    expect(await readdir(cwd)).toEqual(['my-deck-form-files.zip']);
    expect(await readdir(top)).toEqual(['box']);
    expect(JSON.parse(h.out())).toEqual({
      mode: 'zip',
      path: join(cwd, 'my-deck-form-files.zip'),
      sizeBytes: ZIP.length
    });
  });

  it('falls back to a local name when the server sends none, or a dotfile', async () => {
    const { top } = await sandbox();
    const cwd = join(top, 'box');
    const none = routedHarness(zipRoutes(null));
    expect(
      await inDir(cwd, () => run(['response-files', DECK.id, RESPONSE_ID, '--zip', ...AUTH], none.io))
    ).toBe(0);
    const dotfile = routedHarness(zipRoutes('attachment; filename=".bashrc"'));
    expect(await inDir(cwd, () => run(['response-files', DECK.id, '--zip', ...AUTH], dotfile.io))).toBe(0);
    expect((await readdir(cwd)).sort()).toEqual(['_bashrc.zip', 'form-files-77777777.zip']);
  });

  it('refuses to stream through a symlink planted at the default name', async () => {
    const { top } = await sandbox();
    const cwd = join(top, 'box');
    const victim = join(top, 'victim');
    await symlink(victim, join(cwd, 'deck-form-files.zip'));
    const h = routedHarness(zipRoutes('attachment; filename="deck-form-files.zip"'));
    expect(await inDir(cwd, () => run(['response-files', DECK.id, '--zip', ...AUTH], h.io))).toBe(1);
    expect(h.err()).toMatch(/symlink/);
    await expect(stat(victim)).rejects.toThrow();
  });

  it('reads 404 no_files as the empty result it is: a message, exit 0, nothing written', async () => {
    const { top } = await sandbox();
    const cwd = join(top, 'box');
    const noFiles: Route[] = [
      {
        method: 'GET',
        path: /files\.zip$/,
        reply: () => ({
          status: 404,
          body: { error: { code: 'no_files', message: 'No uploaded files match.' } }
        })
      }
    ];
    const h = routedHarness(noFiles);
    expect(await inDir(cwd, () => run(['response-files', DECK.id, '--zip', ...AUTH], h.io))).toBe(0);
    expect(h.out()).toContain('No uploaded files match.');
    expect(await readdir(cwd)).toEqual([]);

    const json = routedHarness(noFiles);
    expect(
      await inDir(cwd, () => run(['response-files', DECK.id, '--zip', '--json', ...AUTH], json.io))
    ).toBe(0);
    expect(JSON.parse(json.out())).toEqual({ mode: 'zip', path: null, sizeBytes: 0 });

    // Any other 404 (a deck the caller cannot read) stays an error.
    const missing = routedHarness([]);
    expect(await inDir(cwd, () => run(['response-files', DECK.id, '--zip', ...AUTH], missing.io))).toBe(1);
  });

  it('parses both Content-Disposition forms, the RFC 5987 one first', () => {
    expect(contentDispositionName(`attachment; filename="a_.zip"; filename*=UTF-8''a%C3%A9.zip`)).toBe(
      'aé.zip'
    );
    expect(contentDispositionName('attachment; filename="plain.zip"')).toBe('plain.zip');
    expect(contentDispositionName(`attachment; filename="ok.zip"; filename*=UTF-8''%E0%A4%A`)).toBe('ok.zip');
    expect(contentDispositionName('attachment')).toBeNull();
    expect(contentDispositionName(null)).toBeNull();
  });
});

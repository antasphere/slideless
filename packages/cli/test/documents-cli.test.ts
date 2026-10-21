import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { deckMasterUrl, validateDataAgainstSchema } from '@slideless/contract';
import { run } from '../src/index.js';
import { DECK, routedHarness, VERSION_ROW, type Route } from './harness.js';

/**
 * PRDCT-3641 from the command line: `template schema get|set` and the
 * `document` group (create, data get/push/versions, answers, upgrade,
 * check), plus the data contract `template new` scaffolds. The fake
 * instance answers the wire shapes of `packages/contract`
 * (schemas/documents.ts); every assertion is on the request the CLI made
 * (`h.calls`), on its output, or on its exit code.
 */

const URL_ = 'http://x';
const KEY = 'slk_k_s';
const argv = (...rest: string[]) => [...rest, '--url', URL_, '--api-key', KEY];

const TEMPLATE_ID = 'cccccccc-1111-4111-8111-111111111111';
const DOC_ID = 'dddddddd-1111-4111-8111-111111111111';
const PROJECT_A = 'eeeeeeee-1111-4111-8111-111111111111';
const PROJECT_B = 'ffffffff-1111-4111-8111-111111111111';

const TEMPLATE_ROW = {
  ...DECK,
  id: TEMPLATE_ID,
  title: 'Lane report',
  currentVersion: 3,
  reference: { type: 'template' },
  audience: 'workspace',
  defaultReference: false,
  metadata: {},
  document: null
};

const SCHEMA = {
  version: '1',
  type: 'object',
  properties: {
    title: { type: 'string' },
    tickets: {
      type: 'array',
      items: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }
    }
  },
  required: ['title'],
  additionalProperties: false
};

const CONTRACT = {
  presentationId: TEMPLATE_ID,
  version: 3,
  schemaVersion: '1',
  schema: SCHEMA,
  sample: { title: 'Sample lane' },
  bindings: ['tickets', 'tickets.id', 'title']
};

const PIN = { templateId: TEMPLATE_ID, templateVersion: 3, schemaVersion: '1' };

function written(version: number, data: Record<string, unknown>, title = 'Lane report') {
  return {
    presentation: {
      ...DECK,
      id: DOC_ID,
      title,
      currentVersion: version,
      reference: null,
      audience: 'private',
      defaultReference: false,
      metadata: {},
      document: PIN
    },
    version: {
      ...VERSION_ROW,
      presentationId: DOC_ID,
      version,
      reference: null,
      referenceWarning: null
    },
    data: { presentationId: DOC_ID, version, template: PIN, data }
  };
}

/** The references list `<ref>` is resolved against. */
const listRoute: Route = {
  method: 'GET',
  path: /\/api\/v1\/presentations$/,
  reply: () => ({ body: { presentations: [TEMPLATE_ROW], nextCursor: null } })
};

const schemaGetRoute: Route = {
  method: 'GET',
  path: new RegExp(`/api/v1/presentations/${TEMPLATE_ID}/schema$`),
  reply: () => ({ body: CONTRACT })
};

const refusal = (status: number, code: string, message: string, details?: unknown) => ({
  status,
  body: { error: { code, message, ...(details !== undefined ? { details } : {}) } }
});

/** The exact bytes `--json` prints for an API answer. */
const jsonBytes = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

async function jsonFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'slideless-doc-'));
  const path = join(dir, 'data.json');
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

/** The calls past the references list (which every `<ref>` and `--from` costs). */
const apiCalls = (calls: Array<{ method: string; path: string; body?: unknown }>) =>
  calls.filter((c) => !c.path.startsWith('/api/v1/presentations?'));

// ── template schema ─────────────────────────────────────────────────────────

describe('template schema get', () => {
  it('resolves the template by name and GETs its contract', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    expect(await run(argv('template', 'schema', 'get', 'Lane report'), h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(apiCalls(h.calls)).toEqual([
      { method: 'GET', path: `/api/v1/presentations/${TEMPLATE_ID}/schema` }
    ]);
    const out = h.out();
    expect(out).toContain('"Lane report" v3 · schema 1');
    expect(out).toContain('bindings: tickets, tickets.id, title');
    expect(out).toContain(`schema:\n${JSON.stringify(SCHEMA, null, 2)}\n`);
    expect(out).toContain(`sample:\n${JSON.stringify(CONTRACT.sample, null, 2)}\n`);
  });

  it('--json prints the API answer byte for byte', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    expect(await run(argv('template', 'schema', 'get', TEMPLATE_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(jsonBytes(CONTRACT));
  });
});

describe('template schema set', () => {
  const putRoute = (reply: Route['reply']): Route => ({
    method: 'PUT',
    path: new RegExp(`/api/v1/presentations/${TEMPLATE_ID}/schema$`),
    reply
  });

  it('PUTs the schema and the sample read from the files', async () => {
    const next = { ...CONTRACT, version: 4, schemaVersion: '2' };
    const schemaFile = await jsonFile({ ...SCHEMA, version: '2' });
    const sampleFile = await jsonFile({ title: 'Another lane' });
    const h = routedHarness([listRoute, putRoute(() => ({ body: next }))]);
    expect(
      await run(argv('template', 'schema', 'set', 'Lane', '--file', schemaFile, '--sample', sampleFile), h.io)
    ).toBe(0);
    expect(h.err()).toBe('');
    expect(apiCalls(h.calls)).toEqual([
      {
        method: 'PUT',
        path: `/api/v1/presentations/${TEMPLATE_ID}/schema`,
        body: { schema: { ...SCHEMA, version: '2' }, sample: { title: 'Another lane' } }
      }
    ]);
    expect(h.out()).toContain('"Lane report" is at version 4 with schema 2 and its new sample.');
  });

  it('without --sample the body carries the schema alone; --json is the answer byte for byte', async () => {
    const next = { ...CONTRACT, version: 4, schemaVersion: '2' };
    const h = routedHarness([listRoute, putRoute(() => ({ body: next }))]);
    const file = await jsonFile({ ...SCHEMA, version: '2' });
    expect(await run(argv('template', 'schema', 'set', 'Lane', '--file', file, '--json'), h.io)).toBe(0);
    expect(apiCalls(h.calls)[0]!.body).toEqual({ schema: { ...SCHEMA, version: '2' } });
    expect(h.out()).toBe(jsonBytes(next));
  });

  it('binding_unknown prints the message and one `file line N: path` per binding', async () => {
    const h = routedHarness([
      listRoute,
      putRoute(() =>
        refusal(400, 'binding_unknown', 'A page binds a field the schema does not describe.', {
          unknown: [
            { path: 'tickets.headline', file: 'index.html', line: 12 },
            { path: 'owner', file: 'pages/two.html', line: 3 }
          ]
        })
      )
    ]);
    const file = await jsonFile(SCHEMA);
    expect(await run(argv('template', 'schema', 'set', 'Lane', '--file', file), h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: A page binds a field the schema does not describe.\n' +
        '  index.html line 12: tickets.headline\n' +
        '  pages/two.html line 3: owner\n'
    );
  });

  it('sample_invalid prints one `path: message` line per issue', async () => {
    const h = routedHarness([
      listRoute,
      putRoute(() =>
        refusal(400, 'sample_invalid', 'data.json does not follow the schema.', {
          issues: [{ path: '/title', message: 'Instance type "number" is invalid. Expected "string".' }]
        })
      )
    ]);
    const file = await jsonFile(SCHEMA);
    const sample = await jsonFile({ title: 3 });
    expect(
      await run(argv('template', 'schema', 'set', 'Lane', '--file', file, '--sample', sample), h.io)
    ).toBe(1);
    expect(h.err()).toBe(
      'Error: data.json does not follow the schema.\n' +
        '  /title: Instance type "number" is invalid. Expected "string".\n'
    );
  });

  it('a file that is not a JSON object is refused before any request', async () => {
    const h = routedHarness([listRoute]);
    const file = await jsonFile('[1, 2]');
    expect(await run(argv('template', 'schema', 'set', 'Lane', '--file', file), h.io)).toBe(1);
    expect(h.err()).toContain('must hold a JSON object');
    expect(h.calls).toHaveLength(0);
  });
});

// ── document create ─────────────────────────────────────────────────────────

describe('document create', () => {
  const createRoute = (reply: Route['reply']): Route => ({
    method: 'POST',
    path: new RegExp(`/api/v1/presentations/${TEMPLATE_ID}/instances$`),
    reply
  });

  it('POSTs the data, the title and every --project to the template, then prints the id and the url', async () => {
    const data = { title: 'Data-bound templates' };
    const file = await jsonFile(data);
    const h = routedHarness([
      listRoute,
      createRoute(() => ({ status: 201, body: written(1, data, 'PRDCT-3641') }))
    ]);
    expect(
      await run(
        argv(
          'document',
          'create',
          '--from',
          'Lane report',
          '--data',
          file,
          '--title',
          'PRDCT-3641',
          '--project',
          PROJECT_A,
          '--project',
          PROJECT_B
        ),
        h.io
      )
    ).toBe(0);
    expect(h.err()).toBe('');
    expect(apiCalls(h.calls)).toEqual([
      {
        method: 'POST',
        path: `/api/v1/presentations/${TEMPLATE_ID}/instances`,
        body: { data, title: 'PRDCT-3641', projectIds: [PROJECT_A, PROJECT_B] }
      }
    ]);
    expect(h.out()).toBe(
      `Document ${DOC_ID} created from "Lane report" at template version 3\n` +
        `  title: PRDCT-3641\n` +
        `  url: ${deckMasterUrl(URL_, DOC_ID)}\n`
    );
  });

  it('with no --title and no --project the body carries the data alone; --json is the answer', async () => {
    const data = { title: 'X' };
    const answer = written(1, data);
    const h = routedHarness([listRoute, createRoute(() => ({ status: 201, body: answer }))]);
    expect(
      await run(
        argv('document', 'create', '--from', TEMPLATE_ID, '--data', await jsonFile(data), '--json'),
        h.io
      )
    ).toBe(0);
    expect(apiCalls(h.calls)[0]!.body).toEqual({ data });
    expect(h.out()).toBe(jsonBytes(answer));
  });

  it('data_invalid prints the message and one line per issue, root included', async () => {
    const h = routedHarness([
      listRoute,
      createRoute(() =>
        refusal(400, 'data_invalid', 'The data does not follow the schema at /tickets/0/id.', {
          issues: [
            { path: '/tickets/0/id', message: 'Instance does not have required property "id".' },
            { path: '', message: 'Property "extra" does not match additional properties schema.' }
          ]
        })
      )
    ]);
    const file = await jsonFile({ title: 'X', tickets: [{}], extra: 1 });
    expect(await run(argv('document', 'create', '--from', 'Lane', '--data', file), h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: The data does not follow the schema at /tickets/0/id.\n' +
        '  /tickets/0/id: Instance does not have required property "id".\n' +
        '  (root): Property "extra" does not match additional properties schema.\n'
    );
  });

  it('a refusal without a list keeps the runner’s own line', async () => {
    const h = routedHarness([
      listRoute,
      createRoute(() => refusal(422, 'not_a_data_template', 'This template carries no schema.json.'))
    ]);
    const file = await jsonFile({ title: 'X' });
    expect(await run(argv('document', 'create', '--from', 'Lane', '--data', file), h.io)).toBe(1);
    expect(h.err()).toBe('Error: This template carries no schema.json.\n');
  });
});

// ── document data get / push / versions ─────────────────────────────────────

describe('document data get', () => {
  const current = {
    presentationId: DOC_ID,
    version: 2,
    template: PIN,
    data: { title: 'X', answers: { merge_gate: { decision: 'yes' } } }
  };
  const getRoute: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DOC_ID}/data$`),
    reply: () => ({ body: current })
  };

  it('prints the data as JSON, two-space indent', async () => {
    const h = routedHarness([getRoute]);
    expect(await run(argv('document', 'data', 'get', DOC_ID), h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: `/api/v1/presentations/${DOC_ID}/data` }]);
    expect(h.out()).toBe(`${JSON.stringify(current.data, null, 2)}\n`);
  });

  it('--json prints the whole answer byte for byte', async () => {
    const h = routedHarness([getRoute]);
    expect(await run(argv('document', 'data', 'get', DOC_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(jsonBytes(current));
  });
});

describe('document data push', () => {
  const dataPath = new RegExp(`/api/v1/presentations/${DOC_ID}/data$`);
  const versionRoute: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DOC_ID}/data/versions/2$`),
    reply: () => ({
      body: {
        presentationId: DOC_ID,
        version: 2,
        source: 'push',
        templateVersion: 3,
        changed: ['tickets', 'title'],
        answeredBy: null,
        createdBy: 'u1',
        createdAt: '2026-10-20T10:00:00.000Z',
        data: {}
      }
    })
  };

  it('--file PUTs the whole data and prints the version and the changed keys', async () => {
    const data = { title: 'Y', tickets: [{ id: 'PRDCT-1' }] };
    const h = routedHarness([
      { method: 'PUT', path: dataPath, reply: () => ({ body: written(2, data) }) },
      versionRoute
    ]);
    expect(await run(argv('document', 'data', 'push', DOC_ID, '--file', await jsonFile(data)), h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.calls).toEqual([
      { method: 'PUT', path: `/api/v1/presentations/${DOC_ID}/data`, body: data },
      { method: 'GET', path: `/api/v1/presentations/${DOC_ID}/data/versions/2` }
    ]);
    expect(h.out()).toBe(
      `Pushed the data of "Lane report" → version 2\n` +
        `  changed: tickets, title\n` +
        `  url: ${deckMasterUrl(URL_, DOC_ID)}\n`
    );
  });

  it('--merge PATCHes the patch; --json is the write’s answer alone, no second read', async () => {
    const patch = { title: 'Z', tickets: null };
    const answer = written(2, { title: 'Z' });
    const h = routedHarness([
      { method: 'PATCH', path: dataPath, reply: () => ({ body: answer }) },
      versionRoute
    ]);
    expect(
      await run(argv('document', 'data', 'push', DOC_ID, '--merge', await jsonFile(patch), '--json'), h.io)
    ).toBe(0);
    expect(h.calls).toEqual([{ method: 'PATCH', path: `/api/v1/presentations/${DOC_ID}/data`, body: patch }]);
    expect(h.out()).toBe(jsonBytes(answer));
  });

  it('--file with --merge is a usage error, and nothing is sent', async () => {
    const file = await jsonFile({ title: 'Y' });
    const h = routedHarness([]);
    expect(await run(argv('document', 'data', 'push', DOC_ID, '--file', file, '--merge', file), h.io)).toBe(
      1
    );
    expect(h.err()).toContain(
      'Pass exactly one of --file <file> (replace the data) or --merge <file> (patch it).'
    );
    expect(h.calls).toHaveLength(0);
  });

  it('neither flag is the same usage error', async () => {
    const h = routedHarness([]);
    expect(await run(argv('document', 'data', 'push', DOC_ID), h.io)).toBe(1);
    expect(h.err()).toContain('Pass exactly one of --file');
    expect(h.calls).toHaveLength(0);
  });

  it('a data file carrying `answers` is refused with the reason, not the bare "Request validation failed"', async () => {
    const h = routedHarness([
      {
        method: 'PATCH',
        path: dataPath,
        reply: () =>
          refusal(400, 'validation_error', 'Request validation failed', [
            {
              code: 'custom',
              path: [],
              message: '"answers" is reserved: the forms\' answers are written by the server'
            }
          ])
      }
    ]);
    expect(
      await run(
        argv('document', 'data', 'push', DOC_ID, '--merge', await jsonFile({ answers: { gate: {} } })),
        h.io
      )
    ).toBe(1);
    expect(h.out()).toBe('');
    expect(h.err()).toBe(
      'Error: Request validation failed\n' +
        '  (root): "answers" is reserved: the forms\' answers are written by the server\n'
    );
  });

  it('data_invalid prints one line per issue', async () => {
    const h = routedHarness([
      {
        method: 'PUT',
        path: dataPath,
        reply: () =>
          refusal(400, 'data_invalid', 'The data does not follow the schema at /title.', {
            issues: [{ path: '/title', message: 'Instance type "number" is invalid. Expected "string".' }]
          })
      }
    ]);
    expect(
      await run(argv('document', 'data', 'push', DOC_ID, '--file', await jsonFile({ title: 1 })), h.io)
    ).toBe(1);
    expect(h.err()).toBe(
      'Error: The data does not follow the schema at /title.\n' +
        '  /title: Instance type "number" is invalid. Expected "string".\n'
    );
  });
});

describe('document data versions', () => {
  const versions = {
    versions: [
      {
        presentationId: DOC_ID,
        version: 3,
        source: 'answer',
        templateVersion: 3,
        changed: ['answers.merge_gate'],
        answeredBy: 'romain',
        createdBy: null,
        createdAt: '2026-10-20T19:02:00.000Z'
      },
      {
        presentationId: DOC_ID,
        version: 2,
        source: 'push',
        templateVersion: 3,
        changed: ['tickets', 'title'],
        answeredBy: null,
        createdBy: 'u1',
        createdAt: '2026-10-20T18:00:00.000Z'
      },
      {
        presentationId: DOC_ID,
        version: 1,
        source: 'create',
        templateVersion: 3,
        changed: [],
        answeredBy: null,
        createdBy: 'u1',
        createdAt: '2026-10-20T17:00:00.000Z'
      }
    ],
    nextCursor: null
  };
  const route: Route = {
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DOC_ID}/data/versions$`),
    reply: () => ({ body: versions })
  };

  it('prints one row per version: version, when, source, by or answered by, changed', async () => {
    const h = routedHarness([route]);
    expect(await run(argv('document', 'data', 'versions', DOC_ID, '--limit', '10'), h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'GET', path: `/api/v1/presentations/${DOC_ID}/data/versions?limit=10` }
    ]);
    const lines = h.out().trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(
      /^v3\s+2026-10-20T19:02:00.000Z\s+answer\s+answered by romain\s+answers\.merge_gate$/
    );
    expect(lines[1]).toMatch(/^v2\s+2026-10-20T18:00:00.000Z\s+push\s+u1\s+tickets, title$/);
    expect(lines[2]).toMatch(/^v1\s+2026-10-20T17:00:00.000Z\s+create\s+u1\s+-$/);
  });

  it('--json prints the versions and the cursor byte for byte', async () => {
    const h = routedHarness([route]);
    expect(await run(argv('document', 'data', 'versions', DOC_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(jsonBytes(versions));
  });
});

// ── document answers ────────────────────────────────────────────────────────

describe('document answers', () => {
  const answers = {
    presentationId: DOC_ID,
    version: 3,
    answers: [
      {
        form: 'merge_gate',
        fields: { decision: 'yes', comment: 'merge it', reviewers: ['ada', 'luca'] },
        answeredAt: '2026-10-20T19:02:00.000Z',
        answeredBy: 'romain',
        linkId: null,
        responseId: '2b3f5197-cc10-4055-add1-5da2a0f05528',
        revision: 2
      }
    ]
  };
  const route = (body: unknown): Route => ({
    method: 'GET',
    path: new RegExp(`/api/v1/presentations/${DOC_ID}/answers$`),
    reply: () => ({ body })
  });

  it('prints one block per form: the field table, then who and when', async () => {
    const h = routedHarness([route(answers)]);
    expect(await run(argv('document', 'answers', DOC_ID), h.io)).toBe(0);
    expect(h.calls).toEqual([{ method: 'GET', path: `/api/v1/presentations/${DOC_ID}/answers` }]);
    expect(h.out()).toBe(
      'merge_gate\n' +
        '  decision   yes\n' +
        '  comment    merge it\n' +
        '  reviewers  ada, luca\n' +
        '  answered by romain at 2026-10-20T19:02:00.000Z (revision 2)\n'
    );
  });

  it('--json prints the answer byte for byte; no answer says so', async () => {
    const h = routedHarness([route(answers)]);
    expect(await run(argv('document', 'answers', DOC_ID, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(jsonBytes(answers));
    const empty = routedHarness([route({ ...answers, answers: [] })]);
    expect(await run(argv('document', 'answers', DOC_ID), empty.io)).toBe(0);
    expect(empty.out()).toBe('No form answered yet.\n');
  });
});

// ── document upgrade ────────────────────────────────────────────────────────

describe('document upgrade', () => {
  const upgraded = (() => {
    const w = written(4, { title: 'X' });
    const pin = { ...PIN, templateVersion: 5, schemaVersion: '2' };
    return { ...w, presentation: { ...w.presentation, document: pin }, data: { ...w.data, template: pin } };
  })();
  const route = (reply: Route['reply']): Route => ({
    method: 'POST',
    path: new RegExp(`/api/v1/presentations/${DOC_ID}/upgrade$`),
    reply
  });

  it('--to sends the template version and prints the new pin', async () => {
    const h = routedHarness([route(() => ({ body: upgraded }))]);
    expect(await run(argv('document', 'upgrade', DOC_ID, '--to', '5'), h.io)).toBe(0);
    expect(h.calls).toEqual([
      { method: 'POST', path: `/api/v1/presentations/${DOC_ID}/upgrade`, body: { toVersion: 5 } }
    ]);
    expect(h.out()).toBe(
      `"Lane report" is on template version 5 (schema 2) → version 4\n` +
        `  url: ${deckMasterUrl(URL_, DOC_ID)}\n`
    );
  });

  it('without --to the body is empty; --json is the answer byte for byte', async () => {
    const h = routedHarness([route(() => ({ body: upgraded }))]);
    expect(await run(argv('document', 'upgrade', DOC_ID, '--json'), h.io)).toBe(0);
    expect(h.calls[0]!.body).toEqual({});
    expect(h.out()).toBe(jsonBytes(upgraded));
  });

  it('--to that is not a whole number from 1 is a usage error', async () => {
    const h = routedHarness([]);
    expect(await run(argv('document', 'upgrade', DOC_ID, '--to', 'two'), h.io)).toBe(1);
    expect(h.err()).toContain('--to is a template version');
    expect(h.calls).toHaveLength(0);
  });

  it('data_invalid against the new schema prints one line per issue', async () => {
    const h = routedHarness([
      route(() =>
        refusal(400, 'data_invalid', 'The data does not follow the new schema.', {
          issues: [{ path: '/owner', message: 'Instance does not have required property "owner".' }]
        })
      )
    ]);
    expect(await run(argv('document', 'upgrade', DOC_ID), h.io)).toBe(1);
    expect(h.err()).toBe(
      'Error: The data does not follow the new schema.\n' +
        '  /owner: Instance does not have required property "owner".\n'
    );
  });
});

// ── document check ──────────────────────────────────────────────────────────

describe('document check', () => {
  it('a file that follows the schema: ok, exit 0, and nothing but reads on the wire', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    const file = await jsonFile({ title: 'X', tickets: [{ id: 'PRDCT-1' }] });
    expect(await run(argv('document', 'check', '--from', 'Lane report', '--data', file), h.io)).toBe(0);
    expect(h.err()).toBe('');
    expect(h.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(apiCalls(h.calls)).toEqual([
      { method: 'GET', path: `/api/v1/presentations/${TEMPLATE_ID}/schema` }
    ]);
    expect(h.out()).toBe(`ok: ${file} follows "Lane report" schema 1\n`);
  });

  it('an invalid file: one line per issue and exit 1', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    const file = await jsonFile({ tickets: [{}] });
    expect(await run(argv('document', 'check', '--from', 'Lane report', '--data', file), h.io)).toBe(1);
    expect(h.err()).toBe('');
    const out = h.out();
    expect(out.startsWith(`${file} does not follow "Lane report" schema 1:\n`)).toBe(true);
    expect(out).toMatch(/\n {2}\/tickets\/0\/id: .*"id"/);
    expect(out).toMatch(/\n {2}\/title: .*"title"/);
  });

  it('an `answers` key is refused as reserved; --json prints { ok, issues } and still exits 1', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    const value = { title: 'X', answers: { merge_gate: { decision: 'yes' } } };
    const file = await jsonFile(value);
    expect(await run(argv('document', 'check', '--from', 'Lane', '--data', file, '--json'), h.io)).toBe(1);
    const expected = [
      { path: '/answers', message: `"answers" is reserved: the forms' answers are written by the server` }
    ];
    expect(h.out()).toBe(jsonBytes({ ok: false, issues: expected }));
  });

  it('--json on a valid file prints { ok: true, issues: [] }', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    const file = await jsonFile({ title: 'X' });
    expect(await run(argv('document', 'check', '--from', 'Lane', '--data', file, '--json'), h.io)).toBe(0);
    expect(h.out()).toBe(jsonBytes({ ok: true, issues: [] }));
  });

  it('a file that is not JSON is a usage error before any request', async () => {
    const h = routedHarness([listRoute, schemaGetRoute]);
    const file = await jsonFile('{ not json');
    expect(await run(argv('document', 'check', '--from', 'Lane', '--data', file), h.io)).toBe(1);
    expect(h.err()).toContain('is not valid JSON');
    expect(h.calls).toHaveLength(0);
  });
});

// ── template new: the data contract in the scaffold ─────────────────────────

describe('template new scaffolds a data contract', () => {
  it('writes schema.json and data.json beside AGENT.md and index.html, the cover bound to {{title}}', async () => {
    const dest = join(await mkdtemp(join(tmpdir(), 'slideless-doc-new-')), 'lane');
    const h = routedHarness([]);
    expect(await run(['template', 'new', dest, '--json'], h.io)).toBe(0);
    expect(h.calls).toHaveLength(0);
    expect((JSON.parse(h.out()) as { files: string[] }).files).toEqual([
      'AGENT.md',
      'index.html',
      'schema.json',
      'data.json'
    ]);
    const schema = JSON.parse(await readFile(join(dest, 'schema.json'), 'utf8')) as Record<string, unknown>;
    expect(schema).toMatchObject({
      version: '1',
      type: 'object',
      properties: { title: { type: 'string' } },
      additionalProperties: false
    });
    const sample = JSON.parse(await readFile(join(dest, 'data.json'), 'utf8')) as Record<string, unknown>;
    expect(validateDataAgainstSchema(schema, sample)).toEqual([]);
    expect(await readFile(join(dest, 'index.html'), 'utf8')).toContain('<h1>{{title}}</h1>');
  });
});

// ── the refusals the CLI reference shows (the PRDCT-3641 double check) ──────

describe('docs/agents/cli.md shows the refusals the CLI prints', () => {
  const createRoute = (reply: Route['reply']): Route => ({
    method: 'POST',
    path: new RegExp(`/api/v1/presentations/${TEMPLATE_ID}/instances$`),
    reply
  });
  const blocksAfter = async (lead: string): Promise<string[]> => {
    const page = await readFile(new URL('../../../docs/agents/cli.md', import.meta.url), 'utf8');
    const from = page.indexOf(lead);
    expect(from, lead).toBeGreaterThan(-1);
    return [...page.slice(from).matchAll(/```\n([\s\S]*?)```/g)].slice(0, 2).map((m) => m[1]!);
  };

  it('a data_invalid refusal: the instance sentence, then one line per issue, as the validator words them', async () => {
    const [shown] = await blocksAfter('A refusal of `create`, `data push` or `upgrade`');
    // The issue as the instance's validator words it, the sentence as api/documents.ts builds it.
    const issues = validateDataAgainstSchema(SCHEMA, { title: 'X', tickets: [{}] });
    const first = issues[0]!;
    const h = routedHarness([
      listRoute,
      createRoute(() =>
        refusal(
          400,
          'data_invalid',
          `The data does not follow the schema at ${first.path}: ${first.message}`,
          {
            issues
          }
        )
      )
    ]);
    const file = await jsonFile({ title: 'X', tickets: [{}] });
    expect(await run(argv('document', 'create', '--from', 'Lane', '--data', file), h.io)).toBe(1);
    expect(h.err()).toBe(shown);
  });

  it('a validation_error refusal (a file carrying answers): its reason under the sentence', async () => {
    const [, shown] = await blocksAfter('A refusal of `create`, `data push` or `upgrade`');
    const h = routedHarness([
      listRoute,
      createRoute(() =>
        refusal(400, 'validation_error', 'Request validation failed', [
          {
            code: 'custom',
            path: [],
            message: '"answers" is reserved: the forms\' answers are written by the server'
          }
        ])
      )
    ]);
    const file = await jsonFile({ title: 'X', answers: {} });
    expect(await run(argv('document', 'create', '--from', 'Lane', '--data', file), h.io)).toBe(1);
    expect(h.err()).toBe(shown);
  });
});

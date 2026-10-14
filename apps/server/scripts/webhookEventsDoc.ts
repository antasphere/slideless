/**
 * Generates docs/reference/webhook-events.md from the webhook event catalog
 * (PRDCT-3484): the chassis's own events plus the Slideless ones
 * (`DECK_WEBHOOK_EVENTS` in @slideless/contract), merged and checked by the
 * same `buildWebhookCatalog` the instance boots on, so the page cannot name an
 * event, a subject or a field the instance does not deliver.
 *
 * One section per event type: its description, the subjects it carries, the
 * fields of its `data`, and an example envelope whose `data` is built by
 * walking the event's zod schema (a plausible value per field name, one
 * element per array, one key per record). Everything is deterministic: the
 * ids are derived from a name, the dates are fixed, so the page only changes
 * when the catalog does. `test/unit/webhook-events-doc.test.ts` renders it
 * again and compares it with the committed page.
 *
 * Usage:
 *   pnpm --filter @slideless/server docs:webhook-events
 */
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { format, resolveConfig } from 'prettier';
import type { z } from 'zod';
import { buildWebhookCatalog, type WebhookCatalogIndex } from '@antasphere/chassis-server/webhooks';
import { DECK_WEBHOOK_EVENTS, DECK_WEBHOOK_SUBJECTS } from '@slideless/contract';

const here = dirname(fileURLToPath(import.meta.url));

/** Where the page lives, from the repository root's point of view. */
export const WEBHOOK_EVENTS_DOC_PATH = join(here, '../../../docs/reference/webhook-events.md');

/** The catalog an instance of Slideless runs on. */
export function slidelessWebhookCatalog(): WebhookCatalogIndex {
  return buildWebhookCatalog({ subjects: DECK_WEBHOOK_SUBJECTS, events: DECK_WEBHOOK_EVENTS });
}

// ── Deterministic example values ─────────────────────────────────────────────

/** A uuid (version 4 layout) derived from a name: the same name, the same id, on every run. */
function uuidFor(name: string): string {
  const h = createHash('sha256').update(`slideless-webhook-example:${name}`).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** Fields that name the same thing share one id across the whole page. */
const ID_ALIASES: Record<string, string> = {
  userId: 'user',
  ownerUserId: 'user',
  authorUserId: 'user',
  createdBy: 'user',
  sentBy: 'user',
  deckId: 'deck',
  remixedFrom: 'source-deck',
  projectId: 'project',
  linkId: 'link',
  shareLinkId: 'link',
  endpointId: 'endpoint',
  workspaceId: 'workspace'
};

const isIdField = (name: string) => name === 'id' || name.endsWith('Id') || name in ID_ALIASES;

/**
 * A nullable field shows its value, except an id that may be null and carries
 * no subject (a collaborator not yet signed up, a deck that was not
 * duplicated): there the null is the case a receiver must handle.
 */
const NULL_IN_EXAMPLE = new Set(['userId', 'remixedFrom']);

const DATES: Record<string, string> = {
  firstViewAt: '2026-10-13T09:25:12.000Z',
  lastViewAt: '2026-10-13T09:29:47.000Z',
  expiresAt: '2026-11-12T00:00:00.000Z'
};
const OCCURRED_AT = '2026-10-13T09:30:00.000Z';

function stringFor(name: string, eventType: string): string {
  if (isIdField(name)) return uuidFor(ID_ALIASES[name] ?? name);
  if (name.endsWith('At')) return DATES[name] ?? OCCURRED_AT;
  const family = eventType.slice(0, eventType.indexOf('.'));
  switch (name) {
    case 'title':
      return 'Q4 launch';
    case 'name':
      if (family === 'share_link') return 'Alice at Acme';
      if (family === 'project') return 'Atlas';
      if (family === 'attachment') return 'pricing.pdf';
      return 'brief.pdf';
    case 'formName':
      return 'feedback';
    case 'purpose':
      return 'share';
    case 'source':
      return 'link';
    case 'placement':
      return 'newsletter';
    case 'email':
    case 'recipient':
      return 'alice@acme.co';
    case 'role':
      return 'member';
    case 'authorRole':
      return 'owner';
    case 'authorName':
      return 'Alice';
    case 'field':
      return 'title';
    case 'changed':
      return 'expiresAt';
    case 'referrerHost':
      return 'mail.google.com';
    case 'browserFamily':
      return 'chrome';
    case 'comments':
      return 'Looks good, ship it.';
    default:
      return name;
  }
}

function numberFor(name: string): number {
  switch (name) {
    case 'version':
    case 'pinnedVersion':
      return 2;
    case 'views':
      return 3;
    case 'sizeBytes':
      return 482133;
    default:
      return 1;
  }
}

/** The name an array's element is shown under: `projectIds` → `projectId`, `browserFamilies` → `browserFamily`. */
function singular(name: string): string {
  if (name.endsWith('ies')) return `${name.slice(0, -3)}y`;
  if (name.endsWith('s')) return name.slice(0, -1);
  return name;
}

/** The record key an example shows: the answers of a form are keyed by field name. */
const RECORD_KEYS: Record<string, string> = { answers: 'comments' };

// The zod 4 internals this walk reads: `def.type` and the few fields of each kind.
interface Def {
  type: string;
  shape?: Record<string, z.ZodType>;
  element?: z.ZodType;
  valueType?: z.ZodType;
  options?: z.ZodType[];
  innerType?: z.ZodType;
  in?: z.ZodType;
}
const defOf = (schema: z.ZodType): Def => (schema as unknown as { def: Def }).def;

/** Walk a schema into an example value; `name` is the field the value sits under. */
function example(schema: z.ZodType, name: string, eventType: string): unknown {
  const def = defOf(schema);
  switch (def.type) {
    case 'object':
      return Object.fromEntries(
        Object.entries(def.shape ?? {}).map(([key, value]) => [key, example(value, key, eventType)])
      );
    case 'string':
      return stringFor(name, eventType);
    case 'number':
    case 'int':
      return numberFor(name);
    case 'boolean':
      return false;
    case 'array':
      return [example(def.element!, singular(name), eventType)];
    case 'record': {
      const key = RECORD_KEYS[name] ?? 'key';
      return { [key]: example(def.valueType!, key, eventType) };
    }
    case 'union':
      return example(def.options![0]!, name, eventType);
    case 'nullable':
      return NULL_IN_EXAMPLE.has(name) ? null : example(def.innerType!, name, eventType);
    case 'optional':
    case 'default':
      return example(def.innerType!, name, eventType);
    case 'pipe':
      return example(def.in!, name, eventType);
    default:
      return null;
  }
}

/** A field's type in words, for the field list. */
function typeOf(schema: z.ZodType): string {
  const def = defOf(schema);
  switch (def.type) {
    case 'object':
      return `object { ${Object.keys(def.shape ?? {}).join(', ')} }`;
    case 'string':
      return 'string';
    case 'number':
    case 'int': {
      const format = (schema as unknown as { format?: string | null }).format;
      return format && format.includes('int') ? 'integer' : 'number';
    }
    case 'boolean':
      return 'boolean';
    case 'array':
      return `list of ${typeOf(def.element!)}`;
    case 'record':
      return `object of ${typeOf(def.valueType!)}`;
    case 'union':
      return def.options!.map(typeOf).join(' or ');
    case 'nullable':
      return `${typeOf(def.innerType!)} or null`;
    case 'optional':
    case 'default':
      return `${typeOf(def.innerType!)} (optional)`;
    case 'pipe':
      return typeOf(def.in!);
    default:
      return 'any';
  }
}

/**
 * The value a subject takes in the envelope, shaped by the catalog's own
 * `list` flag (verifier round 2, MN-R2-1: never guessed from a name): the
 * data's own field when it carries it (`projectIds` on `deck.created`), else
 * the data's `<key>Id` (`deckId`, `linkId`, a chassis project event's one
 * `projectId`), else a fresh id; a list subject always answers an array.
 */
function subjectValue(key: string, field: string, list: boolean, data: Record<string, unknown>): unknown {
  const raw = data[field] !== undefined ? data[field] : (data[`${key}Id`] ?? uuidFor(key));
  if (list) return Array.isArray(raw) ? raw : [raw];
  return Array.isArray(raw) ? raw[0] : raw;
}

// ── The page ─────────────────────────────────────────────────────────────────

const familyOf = (type: string) => type.slice(0, type.indexOf('.'));

/** The page as markdown, formatted the way the repository's prettier formats it. */
export async function renderWebhookEventsDoc(): Promise<string> {
  const catalog = slidelessWebhookCatalog();
  const events = [...catalog.events.values()];
  const subjects = Object.entries(catalog.subjects);
  const lines: string[] = [];
  const push = (...l: string[]) => lines.push(...l);

  push(
    '# Webhook events',
    '',
    'Every event type a Slideless instance delivers to a [webhook](../concepts/webhooks.md), with the subjects',
    'it carries, the fields of its `data`, and an example delivery. The same catalog is served live, with the',
    'JSON Schema of every `data`, on `GET /api/v1/webhooks/events`, by `slideless webhooks events` and by the',
    '`slideless_webhook_events` MCP tool: an agent can discover the types without this page.',
    '',
    'This page is generated from the catalog the instance boots on; do not edit it by hand. After changing an',
    'event, run `pnpm --filter @slideless/server docs:webhook-events`.',
    '',
    '## The envelope',
    '',
    'Every delivery is one JSON object, the same for every type:',
    '',
    '| Field         | What it is                                                                                                 |',
    '| ------------- | ---------------------------------------------------------------------------------------------------------- |',
    '| `id`          | The event id: the same on every attempt and on a redelivery. Deduplicate on it                             |',
    '| `type`        | The event type, below                                                                                      |',
    '| `occurredAt`  | When it happened (ISO 8601)                                                                                |',
    '| `workspaceId` | The workspace it happened in                                                                               |',
    "| `subjects`    | What the event is about, under each subject's field (below); the keys a filter matches on                  |",
    "| `data`        | The event's facts, per type below                                                                          |",
    '| `attempt`     | Which attempt this is, from 1                                                                              |',
    '',
    'The ids in the examples are made up; the dates are fixed.',
    '',
    '## Subjects',
    '',
    "A subject is what an event is about. An endpoint's filters name a subject by its key and list the ids it",
    "accepts; the envelope carries the subject's value under its field. A subject's shape never varies:",
    '`deckId` and `shareLinkId` hold one id, `projectIds` always holds a list, on every event that carries it.',
    '',
    '| Key | Envelope field | What it is |',
    '| --- | -------------- | ---------- |',
    ...subjects.map(([key, s]) => `| \`${key}\` | \`subjects.${s.field}\` | ${s.description} |`),
    '',
    'An event that does not carry a subject never matches a filter on it: an endpoint filtered on a deck',
    'receives no `member.joined`.',
    '',
    '## Every type',
    '',
    '| Type | Subjects | What happened |',
    '| ---- | -------- | ------------- |',
    ...events.map(
      (e) =>
        `| \`${e.type}\` | ${e.subjects.map((s) => `\`${s}\``).join(', ') || 'none'} | ${e.description} |`
    ),
    ''
  );

  let family = '';
  for (const event of events) {
    if (familyOf(event.type) !== family) {
      family = familyOf(event.type);
      push(`## \`${family}.*\``, '');
    }
    const data = example(event.data, 'data', event.type) as Record<string, unknown>;
    const envelopeSubjects = Object.fromEntries(
      event.subjects.map((key) => {
        const subject = catalog.subjects[key]!;
        return [subject.field, subjectValue(key, subject.field, subject.list === true, data)];
      })
    );
    const envelope = {
      id: uuidFor(`event:${event.type}`),
      type: event.type,
      occurredAt: OCCURRED_AT,
      workspaceId: uuidFor('workspace'),
      subjects: envelopeSubjects,
      data,
      attempt: 1
    };
    const shape = defOf(event.data).shape ?? {};
    push(
      `### \`${event.type}\``,
      '',
      event.description,
      '',
      event.subjects.length > 0
        ? `Subjects: ${event.subjects.map((key) => `\`${key}\` (\`subjects.${catalog.subjects[key]!.field}\`)`).join(', ')}.`
        : 'Subjects: none. A filter on any subject excludes it.',
      '',
      '| Field | Type |',
      '| ----- | ---- |',
      ...Object.entries(shape).map(([key, value]) => `| \`${key}\` | ${typeOf(value)} |`),
      '',
      '```json',
      JSON.stringify(envelope, null, 2),
      '```',
      ''
    );
  }

  // The repository's settings without its plugins (svelte only): the page reads as `pnpm format` leaves it.
  const {
    plugins: _plugins,
    overrides: _overrides,
    ...options
  } = ((await resolveConfig(WEBHOOK_EVENTS_DOC_PATH)) ?? {}) as Record<string, unknown>;
  return format(lines.join('\n'), { ...options, parser: 'markdown' });
}

async function main(): Promise<void> {
  const page = await renderWebhookEventsDoc();
  const before = await readFile(WEBHOOK_EVENTS_DOC_PATH, 'utf8').catch(() => '');
  await writeFile(WEBHOOK_EVENTS_DOC_PATH, page);
  const count = slidelessWebhookCatalog().events.size;
  console.log(
    `webhook events reference ${before === page ? 'unchanged' : 'written'}: ${count} event types (docs/reference/webhook-events.md)`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

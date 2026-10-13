import { z } from 'zod';

/**
 * The webhook event catalog of Slideless (PRDCT-3483): what a deck's life
 * tells the outside world, each event with the zod schema of its `data`.
 * The chassis adds its own events (the members, the keys, the projects, the
 * test ping), checks the whole at boot and serves it on
 * `GET /webhooks/events` with the JSON Schema of every payload; the server's
 * `webhooks` slot (`apps/server/src/tool.ts`) hands this list over, and the
 * event reference page (`docs/reference/webhook-events.md`) is generated
 * from it.
 *
 * The payload carries the event's facts: the ids and the small facts a
 * receiver needs to decide, and a form response carries its answers
 * (Romain's ruling of 13 October 2026). The receiver fetches the rest with
 * a key. Nothing here is a viewer's identity: a view carries the referring
 * hosts, the placements and the browser families, never an address.
 */

/** The three filterable subjects: an endpoint narrows its subscription to a list of ids per subject. */
export const DECK_WEBHOOK_SUBJECTS = {
  deck: { field: 'deckId', description: 'A deck, by id' },
  project: {
    field: 'projectIds',
    description: 'The projects a deck belongs to, by id (a list on deck events)'
  },
  link: { field: 'shareLinkId', description: 'A share link, by id' }
} as const;

const id = z.string();
const isoDate = z.string();

const shareLinkFacts = z.object({
  deckId: id,
  linkId: id,
  name: z.string(),
  purpose: z.string(),
  pinnedVersion: z.number().int().nullable(),
  expiresAt: isoDate.nullable(),
  hasPassword: z.boolean()
});

const formResponseFacts = z.object({
  deckId: id,
  formName: z.string(),
  responseId: id,
  revision: z.number().int(),
  linkId: id.nullable(),
  version: z.number().int(),
  source: z.string(),
  placement: z.string().nullable(),
  /** The answers as submitted, by field name: a text, or a list for a multiple choice. */
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  files: z.array(z.object({ id, name: z.string(), sizeBytes: z.number().int() }))
});

const collaboratorFacts = z.object({
  deckId: id,
  collaboratorId: id,
  email: z.string(),
  userId: id.nullable()
});

const annotationFacts = z.object({
  deckId: id,
  version: z.number().int(),
  annotationId: id,
  linkId: id.nullable(),
  authorName: z.string().nullable()
});

const thumbnailFacts = z.object({ deckId: id, versionId: id, version: z.number().int() });

export interface DeckWebhookEvent {
  type: string;
  description: string;
  subjects: ReadonlyArray<keyof typeof DECK_WEBHOOK_SUBJECTS>;
  data: z.ZodType;
}

export const DECK_WEBHOOK_EVENTS: readonly DeckWebhookEvent[] = [
  {
    type: 'deck.created',
    description: 'A deck was created: its first version was pushed, or a deck was duplicated.',
    subjects: ['deck', 'project'],
    data: z.object({
      deckId: id,
      title: z.string(),
      version: z.number().int(),
      projectIds: z.array(id),
      ownerUserId: id,
      remixedFrom: id.nullable()
    })
  },
  {
    type: 'deck.version_committed',
    description: 'A new version of a deck was pushed.',
    subjects: ['deck', 'project'],
    data: z.object({
      deckId: id,
      version: z.number().int(),
      title: z.string(),
      authorUserId: id,
      authorRole: z.string()
    })
  },
  {
    type: 'deck.updated',
    description:
      'A deck’s settings changed (its title, its description, its form notifications…); `fields` names what.',
    subjects: ['deck', 'project'],
    data: z.object({ deckId: id, fields: z.array(z.string()) })
  },
  {
    type: 'deck.deleted',
    description: 'A deck was deleted.',
    subjects: ['deck', 'project'],
    data: z.object({ deckId: id, title: z.string() })
  },
  {
    type: 'deck.project_linked',
    description: 'A deck was put in a project (at creation, or later).',
    subjects: ['deck', 'project'],
    data: z.object({ deckId: id, projectId: id })
  },
  {
    type: 'deck.project_unlinked',
    description: 'A deck was taken out of a project.',
    subjects: ['deck', 'project'],
    data: z.object({ deckId: id, projectId: id })
  },
  {
    type: 'share_link.created',
    description: 'A share link was made for a deck (preview links never emit).',
    subjects: ['deck', 'project', 'link'],
    data: shareLinkFacts
  },
  {
    type: 'share_link.updated',
    description: 'A share link changed; `changed` names the fields.',
    subjects: ['deck', 'project', 'link'],
    data: shareLinkFacts.extend({ changed: z.array(z.string()) })
  },
  {
    type: 'share_link.revoked',
    description: 'A share link was revoked.',
    subjects: ['deck', 'project', 'link'],
    data: shareLinkFacts
  },
  {
    type: 'share_link.sent',
    description: 'A share link was sent by mail from the dashboard.',
    subjects: ['deck', 'project', 'link'],
    data: shareLinkFacts.extend({ recipient: z.string() })
  },
  {
    type: 'share_link.viewed',
    description:
      'A share link was opened. Grouped per link: the first view is sent at once, then at most one event per link per five minutes carrying the count and the facts of the views since the last one. No address, no identity.',
    subjects: ['deck', 'project', 'link'],
    data: z.object({
      deckId: id,
      linkId: id,
      version: z.number().int().nullable(),
      views: z.number().int(),
      firstViewAt: isoDate,
      lastViewAt: isoDate,
      referrerHosts: z.array(z.string()),
      placements: z.array(z.string()),
      browserFamilies: z.array(z.string())
    })
  },
  {
    type: 'attachment.downloaded',
    description:
      'An attachment of a deck was downloaded through a share link (`name` null for the whole bundle).',
    subjects: ['deck', 'project', 'link'],
    data: z.object({ deckId: id, linkId: id, version: z.number().int(), name: z.string().nullable() })
  },
  {
    type: 'form.response_submitted',
    description: 'A form inside a deck received a response; `answers` carries it.',
    subjects: ['deck', 'project', 'link'],
    data: formResponseFacts
  },
  {
    type: 'form.response_edited',
    description: 'A respondent edited their response through their edit link; `answers` is the new revision.',
    subjects: ['deck', 'project', 'link'],
    data: formResponseFacts
  },
  {
    type: 'form.file_uploaded',
    description: 'A respondent dropped a file into a form field (before the response is submitted).',
    subjects: ['deck', 'project', 'link'],
    data: z.object({
      deckId: id,
      formName: z.string(),
      linkId: id,
      uploadId: id,
      name: z.string(),
      sizeBytes: z.number().int()
    })
  },
  {
    type: 'form.response_deleted',
    description: 'A deck’s owner deleted a form response.',
    subjects: ['deck', 'project'],
    data: z.object({ deckId: id, responseId: id })
  },
  {
    type: 'collaborator.invited',
    description: 'Someone was invited to work on a deck.',
    subjects: ['deck', 'project'],
    data: collaboratorFacts
  },
  {
    type: 'collaborator.revoked',
    description: 'A collaborator’s grant on a deck was revoked (by hand, or with a member’s removal).',
    subjects: ['deck', 'project'],
    data: collaboratorFacts
  },
  {
    type: 'collaborator.claimed',
    description: 'An invited collaborator claimed their grant on a deck.',
    subjects: ['deck', 'project'],
    data: collaboratorFacts
  },
  {
    type: 'annotation.created',
    description: 'An annotation was left on a deck version, by a viewer through a share link or by a member.',
    subjects: ['deck', 'project', 'link'],
    data: annotationFacts
  },
  {
    type: 'annotation.resolved',
    description: 'An annotation was marked resolved.',
    subjects: ['deck', 'project'],
    data: annotationFacts
  },
  {
    type: 'annotation.deleted',
    description: 'An annotation was deleted.',
    subjects: ['deck', 'project'],
    data: annotationFacts
  },
  {
    type: 'thumbnail.rendered',
    description: 'The still image of a deck version is ready.',
    subjects: ['deck', 'project'],
    data: thumbnailFacts
  },
  {
    type: 'thumbnail.failed',
    description: 'The still image of a deck version could not be made.',
    subjects: ['deck', 'project'],
    data: thumbnailFacts
  }
];

/** The event types, for the dashboard's pickers and the docs generator. */
export const DECK_WEBHOOK_EVENT_TYPES = DECK_WEBHOOK_EVENTS.map((e) => e.type);

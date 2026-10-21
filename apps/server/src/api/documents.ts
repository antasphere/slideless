import type { OpenAPIHono } from '@hono/zod-openapi';
import type { Principal } from '@antasphere/chassis-contract';
import type { Db } from '@antasphere/chassis-db';
import type { PresentationRow, PresentationVersionRow } from '@slideless/db';
import {
  documentAnswerClearRoute,
  documentAnswersRoute,
  documentCreateRoute,
  documentDataGetRoute,
  documentDataMergeRoute,
  documentDataReplaceRoute,
  documentDataVersionGetRoute,
  documentDataVersionsRoute,
  documentUpgradeRoute,
  templateSchemaGetRoute,
  templateSchemaSetRoute
} from '@slideless/contract/routes';
import type { ManifestEntry } from '@slideless/contract';
import { requireNonGuest } from '@antasphere/chassis-server/middleware';
import type { Logger } from '@antasphere/chassis-server/logger';
import type { StorageDriver } from '@antasphere/chassis-server/storage';
import type { DeckRegistry } from '../platform/deck-events.js';
import { manifestHasForms } from '../forms/detect.js';
import { contractRefusalBody, readTemplateContract } from '../presentations/data-contract.js';
import { canReadDeck, canWriteDeck, type PresentationService } from '../presentations/service.js';
import type { presentationToWire, versionToWire } from './presentations.js';
import type { DocumentFailure, DocumentService } from '../documents/service.js';

/**
 * The document routes (PRDCT-3641), the deck routes' sibling: every path sits
 * under `/presentations/{id}` so the machine scope rule, the audit and the
 * deck-existence oracle cover it like any deck route. The reads answer the
 * deck read rule (404, never 403, ADR 013); a proven reader who may not
 * write gets 403; a deck that is not a document answers 422 after the read
 * check, so existence is never learned before the right to read.
 */

type ErrorBody =
  | { error: { code: string; message: string } }
  | { error: { code: string; message: string; details: Record<string, unknown> } };
const err = (code: string, message: string): { error: { code: string; message: string } } => ({
  error: { code, message }
});
const errWith = (
  code: string,
  message: string,
  details: Record<string, unknown>
): { error: { code: string; message: string; details: Record<string, unknown> } } => ({
  error: { code, message, details }
});

export interface DocumentRouteDeps {
  db: Db;
  presentations: PresentationService;
  documents: DocumentService;
  storage: StorageDriver;
  registry: DeckRegistry;
  logger: Logger;
  /** The deck wire mapper of api/presentations.ts, with the caller's projects. */
  wire: (principal: Principal, deck: PresentationRow) => Promise<ReturnType<typeof presentationToWire>>;
  versionToWire: typeof versionToWire;
}

export function registerDocumentRoutes(api: OpenAPIHono, deps: DocumentRouteDeps): void {
  const { db, presentations, documents, storage, registry, logger } = deps;

  // Creating a document is deck creation by another door (D2): the same wall
  // as the duplicate, before any lookup.
  api.use('/presentations/:id/instances', requireNonGuest());

  /** A deck the caller reads, or the 404 that says nothing. */
  const readable = async (principal: Principal, id: string): Promise<PresentationRow | null> => {
    const deck = await presentations.get(principal.workspaceId, id);
    if (!deck || !(await canReadDeck(db, principal, deck))) return null;
    return deck;
  };

  const dataWire = async (principal: Principal, deck: PresentationRow) => {
    const contract =
      deck.templateId !== null && deck.templateVersion !== null
        ? await documents.contractOf(principal.workspaceId, deck.templateId, deck.templateVersion)
        : null;
    return {
      presentationId: deck.id,
      version: deck.currentVersion,
      template: {
        templateId: deck.templateId ?? '',
        templateVersion: deck.templateVersion ?? 0,
        schemaVersion: contract?.schemaVersion ?? ''
      },
      data: deck.documentData ?? {}
    };
  };

  const written = async (principal: Principal, deck: PresentationRow, version: PresentationVersionRow) => ({
    presentation: await deps.wire(principal, deck),
    version: deps.versionToWire(version),
    data: await dataWire(principal, deck)
  });

  const failed = (f: DocumentFailure): { status: 400 | 403 | 404 | 409 | 422; body: ErrorBody } => {
    switch (f.code) {
      case 'not_found':
        return { status: 404 as const, body: err('not_found', 'Presentation not found') };
      case 'forbidden':
        return {
          status: 403 as const,
          body: err('forbidden', 'You read this document but may not write it')
        };
      case 'busy':
        return {
          status: 409 as const,
          body: err('document_busy', 'Another write on this document is still running; retry in a moment')
        };
      case 'answer_not_found':
        return {
          status: 404 as const,
          body: errWith('answer_not_found', `No answer under "${f.form}" in this document's data`, {
            form: f.form
          })
        };
      case 'answers_full':
        return {
          status: 409 as const,
          body: err('answers_full', 'The answers of this document are at their budget')
        };
      case 'not_a_document':
        return {
          status: 422 as const,
          body: err('not_a_document', 'This deck was not made from a template')
        };
      case 'not_a_data_template':
        return {
          status: 422 as const,
          body: err(
            'not_a_data_template',
            'This deck is not a template with a schema.json, so nothing can be made from it'
          )
        };
      case 'template_gone':
        return {
          status: 422 as const,
          body: err('template_gone', 'The template this document was made from is gone')
        };
      case 'template_version_invalid':
        return {
          status: 400 as const,
          body: errWith(
            'template_version_invalid',
            `Template version ${f.version} does not exist or carries no schema`,
            { version: f.version }
          )
        };
      case 'already_on_version':
        return {
          status: 400 as const,
          body: errWith('already_on_version', `The document is already on template version ${f.version}`, {
            version: f.version
          })
        };
      case 'data_invalid': {
        const first = f.issues[0];
        return {
          status: 400 as const,
          body: errWith(
            'data_invalid',
            first
              ? `The data does not follow the schema at ${first.path || 'the root'}: ${first.message}`
              : 'The data does not follow the schema',
            { issues: f.issues }
          )
        };
      }
      case 'data_too_large':
        return {
          status: 400 as const,
          body: err('data_too_large', 'The data is over the size a document may hold')
        };
      case 'render_failed':
        return { status: 400 as const, body: err('render_failed', f.message) };
      case 'invalid_manifest':
        return { status: 400 as const, body: err('invalid_manifest', f.message) };
      case 'missing_blobs':
        return {
          status: 400 as const,
          body: errWith(
            'missing_blobs',
            `The template references ${f.missing.length} blob(s) this workspace no longer holds`,
            { missing: f.missing }
          )
        };
      case 'project_not_found':
        return {
          status: 404 as const,
          body: errWith(
            'project_not_found',
            'A project named in projectIds was not found, is archived, or needs the editor role',
            {
              projectId: f.projectId
            }
          )
        };
    }
  };

  // ── The template's contract ────────────────────────────────────────────────

  api.openapi(templateSchemaGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (deck.referenceType !== 'template')
      return c.json(err('not_a_template', 'This deck is not a template'), 422);
    const contract =
      deck.currentVersion > 0
        ? await documents.contractOf(principal.workspaceId, deck.id, deck.currentVersion)
        : null;
    if (!contract) return c.json(err('no_schema', 'This template carries no schema.json'), 422);
    return c.json(
      {
        presentationId: deck.id,
        version: deck.currentVersion,
        schemaVersion: contract.schemaVersion,
        schema: contract.schema,
        sample: contract.sample,
        bindings: contract.bindings
      },
      200
    );
  });

  api.openapi(templateSchemaSetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (!(await canWriteDeck(db, principal, deck))) {
      return c.json(err('forbidden', 'You read this template but may not change it'), 403);
    }
    if (deck.referenceType !== 'template' || deck.currentVersion < 1) {
      return c.json(err('not_a_template', 'This deck is not a template'), 422);
    }
    const next = await documents.templateManifestWith({
      workspaceId: principal.workspaceId,
      template: deck,
      uploader: principal.userId,
      schema: body.schema,
      sample: body.sample
    });
    if (!next) return c.json(err('not_found', 'Presentation not found'), 404);
    const manifest = next.manifest as ManifestEntry[];
    // The same reading a push gets: the bindings against the NEW schema, the
    // sample against it, the version rule in the commit.
    const contract = await readTemplateContract(
      storage,
      principal.workspaceId,
      manifest,
      deck.reference as { type: 'template' } | null
    );
    if (contract.refusal) return c.json(contractRefusalBody(contract.refusal), 400);
    const result = await presentations.commitVersion({
      workspaceId: principal.workspaceId,
      principal,
      presentationId: deck.id,
      expectedBaseVersion: deck.currentVersion,
      entryPath: next.entryPath,
      manifest,
      hasForms: await manifestHasForms(storage, principal.workspaceId, manifest),
      reference: { reference: deck.reference as { type: 'template' } | null, warning: null },
      dataContract: contract.contract
    });
    if (!result.ok) {
      const f = result.failure;
      switch (f.code) {
        case 'schema_version_unchanged':
          return c.json(
            errWith(
              'schema_version_unchanged',
              `schema.json changed but its "version" is still "${f.version}": bump it, documents pin a version`,
              {
                version: f.version
              }
            ),
            400
          );
        case 'not_found':
          return c.json(err('not_found', 'Presentation not found'), 404);
        case 'invalid_manifest':
          return c.json(err('invalid_manifest', f.message), 400);
        case 'missing_blobs':
          return c.json(
            errWith('missing_blobs', 'The template references blobs this workspace no longer holds', {
              missing: f.missing
            }),
            400
          );
        case 'version_conflict':
          return c.json(
            errWith('version_conflict', 'The template moved while the schema was being set; retry', {
              currentVersion: f.currentVersion
            }),
            409
          );
      }
    }
    c.set('audit', {
      action: 'template.schema_set',
      resourceType: 'presentation',
      resourceId: deck.id,
      metadata: { version: result.version.version, schemaVersion: contract.contract?.schemaVersion ?? null }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: deck.id,
      version: result.version.version
    });
    const fresh = contract.contract!;
    return c.json(
      {
        presentationId: deck.id,
        version: result.version.version,
        schemaVersion: fresh.schemaVersion,
        schema: fresh.schema,
        sample: fresh.sample,
        bindings: fresh.bindings
      },
      200
    );
  });

  // ── The instance ───────────────────────────────────────────────────────────

  api.openapi(documentCreateRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const result = await documents.createInstance({
      workspaceId: principal.workspaceId,
      principal,
      templateId: id,
      data: body.data,
      title: body.title,
      projectIds: body.projectIds
    });
    if (!result.ok) {
      const f = failed(result.failure);
      return c.json(f.body, f.status);
    }
    c.set('audit', {
      action: 'document.create',
      resourceType: 'presentation',
      resourceId: result.presentation.id,
      metadata: {
        templateId: id,
        templateVersion: result.presentation.templateVersion,
        title: result.presentation.title
      }
    });
    registry.events.emit('presentation.created', {
      workspaceId: principal.workspaceId,
      presentationId: result.presentation.id
    });
    logger.info(
      { presentationId: result.presentation.id, templateId: id },
      'documents: created from a template'
    );
    return c.json(await written(principal, result.presentation, result.version), 201);
  });

  // ── The data ───────────────────────────────────────────────────────────────

  api.openapi(documentDataGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (deck.templateId === null)
      return c.json(err('not_a_document', 'This deck was not made from a template'), 422);
    return c.json(await dataWire(principal, deck), 200);
  });

  const pushed = async (
    principal: Principal,
    id: string,
    body: Record<string, unknown>,
    kind: 'replace' | 'merge'
  ): Promise<{ status: 200 | 400 | 403 | 404 | 409 | 422; body: unknown; audit?: Record<string, unknown> }> => {
    const result =
      kind === 'replace'
        ? await documents.replaceData({ workspaceId: principal.workspaceId, principal, id, data: body })
        : await documents.mergeData({ workspaceId: principal.workspaceId, principal, id, patch: body });
    if (!result.ok) return failed(result.failure);
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: id,
      version: result.version.version
    });
    return { status: 200, body: await written(principal, result.presentation, result.version) };
  };

  const auditPush = (
    c: { set: (k: 'audit', v: unknown) => void },
    id: string,
    mode: 'replace' | 'merge',
    body: unknown
  ) => {
    const version = (body as { version?: { version?: number } }).version?.version ?? null;
    c.set('audit', {
      action: 'document.data_push',
      resourceType: 'presentation',
      resourceId: id,
      metadata: { version, mode }
    });
  };

  api.openapi(documentDataReplaceRoute, async (c) => {
    const out = await pushed(c.get('principal')!, c.req.valid('param').id, c.req.valid('json'), 'replace');
    if (out.status === 200) auditPush(c, c.req.valid('param').id, 'replace', out.body);
    return c.json(out.body as never, out.status);
  });
  api.openapi(documentDataMergeRoute, async (c) => {
    const out = await pushed(c.get('principal')!, c.req.valid('param').id, c.req.valid('json'), 'merge');
    if (out.status === 200) auditPush(c, c.req.valid('param').id, 'merge', out.body);
    return c.json(out.body as never, out.status);
  });

  api.openapi(documentDataVersionsRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const { cursor, limit } = c.req.valid('query');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (deck.templateId === null)
      return c.json(err('not_a_document', 'This deck was not made from a template'), 422);
    const { versions, nextCursor } = await presentations.listVersions(principal.workspaceId, id, {
      ...(cursor !== undefined ? { cursor } : {}),
      limit
    });
    return c.json(
      {
        versions: versions
          .filter((v) => v.documentData !== null)
          .map((v) => ({
            presentationId: v.presentationId,
            version: v.version,
            source: v.dataSource ?? 'push',
            templateVersion: v.templateVersion ?? deck.templateVersion ?? 1,
            changed: v.dataChanged ?? [],
            answeredBy: v.dataAnsweredBy,
            createdBy: v.createdBy,
            createdAt: v.createdAt.toISOString()
          })),
        nextCursor
      },
      200
    );
  });

  api.openapi(documentDataVersionGetRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, version } = c.req.valid('param');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (deck.templateId === null)
      return c.json(err('not_a_document', 'This deck was not made from a template'), 422);
    const row = await presentations.getVersion(principal.workspaceId, id, version);
    if (!row || row.documentData === null) return c.json(err('not_found', 'Version not found'), 404);
    return c.json(
      {
        presentationId: row.presentationId,
        version: row.version,
        source: row.dataSource ?? 'push',
        templateVersion: row.templateVersion ?? deck.templateVersion ?? 1,
        changed: row.dataChanged ?? [],
        answeredBy: row.dataAnsweredBy,
        createdBy: row.createdBy,
        createdAt: row.createdAt.toISOString(),
        data: row.documentData
      },
      200
    );
  });

  api.openapi(documentAnswersRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const deck = await readable(principal, id);
    if (!deck) return c.json(err('not_found', 'Presentation not found'), 404);
    if (deck.templateId === null)
      return c.json(err('not_a_document', 'This deck was not made from a template'), 422);
    return c.json(
      { presentationId: deck.id, version: deck.currentVersion, answers: documents.answersOf(deck) },
      200
    );
  });

  api.openapi(documentAnswerClearRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id, form } = c.req.valid('param');
    const result = await documents.clearAnswer({ workspaceId: principal.workspaceId, principal, id, form });
    if (!result.ok) {
      const f = failed(result.failure);
      return c.json(f.body as never, f.status as never);
    }
    c.set('audit', {
      action: 'document.answer_clear',
      resourceType: 'presentation',
      resourceId: id,
      metadata: { version: result.version.version, form }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: id,
      version: result.version.version
    });
    return c.json(await written(principal, result.presentation, result.version), 200);
  });

  api.openapi(documentUpgradeRoute, async (c) => {
    const principal = c.get('principal')!;
    const { id } = c.req.valid('param');
    const body = c.req.valid('json');
    const result = await documents.upgrade({
      workspaceId: principal.workspaceId,
      principal,
      id,
      toVersion: body.toVersion,
      data: body.data,
      merge: body.merge
    });
    if (!result.ok) {
      const f = failed(result.failure);
      return c.json(f.body, f.status);
    }
    c.set('audit', {
      action: 'document.upgrade',
      resourceType: 'presentation',
      resourceId: id,
      metadata: { version: result.version.version, templateVersion: result.presentation.templateVersion }
    });
    registry.events.emit('presentation.version_committed', {
      workspaceId: principal.workspaceId,
      presentationId: id,
      version: result.version.version
    });
    return c.json(await written(principal, result.presentation, result.version), 200);
  });
}

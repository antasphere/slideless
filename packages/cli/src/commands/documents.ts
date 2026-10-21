import { readFile } from 'node:fs/promises';
import { CommanderError, type Command } from 'commander';
import { PlatformApiError, type ListParams } from '@slideless/sdk';
import {
  ANSWERS_KEY,
  DATA_SCHEMA_PATH,
  deckMasterUrl,
  validateDataAgainstSchema,
  withoutAnswers,
  type DataValidationIssue,
  type DocumentFormAnswer,
  type Presentation,
  type UnknownBinding
} from '@slideless/contract';
import { CliApiRefusal, CliUsageError, printJson, table, type CliIo } from '@antasphere/chassis-cli';
import { requireApiKey, resolveContext, type CliContext } from '../cli.js';
import { resolveReference } from '../references.js';
import { listReferences } from './content.js';

/**
 * Data-bound templates from the command line (PRDCT-3641,
 * docs/concepts/data-bound-templates.md). Two surfaces:
 *
 *   template schema get <ref>          the template's data contract
 *   template schema set <ref> --file   a new template version with this schema.json
 *   document create --from <template>  a document made from a template with data
 *   document data get|push|versions    the document's data and its push history
 *   document answers <id>              the forms' answers as the data holds them
 *   document upgrade <id>              the document moved to a newer template version
 *   document check --from --data       the schema's verdict on a local file, nothing sent
 *
 * The server owns every rule (the schema check, the reserved `answers`
 * branch, the version pin); `check` runs the contract's own validator on
 * the template's own schema, so its verdict is the one a push would get.
 */

const collect = (value: string, all: string[]): string[] => [...all, value];

/** `template schema get|set`, hung off the `template` family (references.ts). */
export function registerTemplateSchemaCommands(root: Command, io: CliIo): void {
  const schema = root
    .command('schema')
    .description(
      `A template's data contract: its ${DATA_SCHEMA_PATH}, its sample and the fields its pages bind`
    );

  schema
    .command('get <ref>')
    .description("Show a template's schema version, the fields its pages bind, its schema and its sample")
    .action(async (ref: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const template = await resolveTemplate(ctx, ref);
      const contract = await ctx.client.templateSchema(template.id);
      if (ctx.json) return printJson(io, contract);
      io.out.write(
        `"${template.title}" v${contract.version} · schema ${contract.schemaVersion}\n` +
          `  bindings: ${contract.bindings.length === 0 ? '(none)' : contract.bindings.join(', ')}\n` +
          `schema:\n${JSON.stringify(contract.schema, null, 2)}\n` +
          `sample:\n${contract.sample === null ? '(none)' : JSON.stringify(contract.sample, null, 2)}\n`
      );
    });

  schema
    .command('set <ref>')
    .description(
      `Replace a template's ${DATA_SCHEMA_PATH} (and its sample with --sample): a new template version`
    )
    .requiredOption('--file <schema.json>', 'the JSON Schema to set (it carries a "version" string)')
    .option('--sample <data.json>', 'the sample data the schema accepts, set with it')
    .action(async (ref: string, opts: { file: string; sample?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const schemaBody = await readJsonObject(opts.file, '--file');
      const sample = opts.sample !== undefined ? await readJsonObject(opts.sample, '--sample') : undefined;
      await requireApiKey(ctx);
      const template = await resolveTemplate(ctx, ref);
      const contract = await refusalsWithDetails(() =>
        ctx.client.setTemplateSchema(template.id, {
          schema: schemaBody,
          ...(sample !== undefined ? { sample } : {})
        })
      );
      if (ctx.json) return printJson(io, contract);
      io.out.write(
        `"${template.title}" is at version ${contract.version} with schema ${contract.schemaVersion}` +
          `${sample !== undefined ? ' and its new sample' : ''}.\n` +
          `  bindings: ${contract.bindings.length === 0 ? '(none)' : contract.bindings.join(', ')}\n`
      );
    });
}

/** The `document` group: a deck made from a template with data. */
export function registerDocumentCommands(program: Command, io: CliIo): void {
  const root = program
    .command('document')
    .description('Documents: decks made from a data-bound template, every data push a new version');

  // ── create ────────────────────────────────────────────────────────────────
  root
    .command('create')
    .description("Create a document from a template with data, pinned to the template's current version")
    .requiredOption('--from <template>', 'the template: its id, its title, or the start of its title')
    .requiredOption('--data <file>', 'the JSON file holding the data')
    .option('--title <title>', "the document's title (default: the template's)")
    .option('--project <id>', 'link the document to this project (repeatable)', collect, [])
    .action(async (opts: { from: string; data: string; title?: string; project: string[] }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const data = await readJsonObject(opts.data, '--data');
      await requireApiKey(ctx);
      const template = await resolveTemplate(ctx, opts.from);
      const written = await refusalsWithDetails(() =>
        ctx.client.createDocument(template.id, {
          data,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.project.length > 0 ? { projectIds: opts.project } : {})
        })
      );
      if (ctx.json) return printJson(io, written);
      const id = written.presentation.id;
      io.out.write(
        `Document ${id} created from "${template.title}" at template version ${written.data.template.templateVersion}\n` +
          `  title: ${written.presentation.title}\n` +
          `  url: ${deckMasterUrl(ctx.baseUrl, id)}\n`
      );
    });

  // ── data get / push / versions ────────────────────────────────────────────
  const data = root.command('data').description("A document's data and the history of its pushes");

  data
    .command('get <id>')
    .description("Print a document's current data, the answers included, as JSON")
    .action(async (id: string, _opts, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const current = await ctx.client.documentData(id);
      if (ctx.json) return printJson(io, current);
      io.out.write(`${JSON.stringify(current.data, null, 2)}\n`);
    });

  data
    .command('push <id>')
    .description(
      'Push new data: --file replaces it whole, --merge applies a merge patch (null removes a key)'
    )
    .option('--file <file>', 'the JSON file holding the whole data')
    .option('--merge <file>', 'the JSON file holding a merge patch')
    .action(async (id: string, opts: { file?: string; merge?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      if ((opts.file === undefined) === (opts.merge === undefined)) {
        throw new CliUsageError(
          'Pass exactly one of --file <file> (replace the data) or --merge <file> (patch it).'
        );
      }
      const body =
        opts.file !== undefined
          ? await readJsonObject(opts.file, '--file')
          : await readJsonObject(opts.merge!, '--merge');
      await requireApiKey(ctx);
      const written = await refusalsWithDetails(() =>
        opts.file !== undefined
          ? ctx.client.replaceDocumentData(id, body)
          : ctx.client.mergeDocumentData(id, body)
      );
      if (ctx.json) return printJson(io, written);
      const version = written.version.version;
      // What changed is the push history's own record of this version; a
      // failed read of it costs the line, never the push that succeeded.
      const changed = await ctx.client
        .documentDataVersion(id, version)
        .then((v) => (v.changed.length === 0 ? 'nothing' : v.changed.join(', ')))
        .catch(() => `see \`slideless document data versions ${id}\``);
      io.out.write(
        `Pushed the data of "${written.presentation.title}" → version ${version}\n` +
          `  changed: ${changed}\n` +
          `  url: ${deckMasterUrl(ctx.baseUrl, written.presentation.id)}\n`
      );
    });

  data
    .command('versions <id>')
    .description("List a document's data versions: when, from what, by whom, what changed (newest first)")
    .option('--cursor <cursor>', 'resume from a previous nextCursor')
    .option('--limit <n>', 'page size (1-100)', (v: string) => parseInt(v, 10))
    .option('--all', 'follow nextCursor until every page is fetched', false)
    .action(async (id: string, opts: { cursor?: string; limit?: number; all: boolean }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      const params: ListParams = {};
      if (opts.cursor) params.cursor = opts.cursor;
      if (opts.limit !== undefined) params.limit = opts.limit;
      const first = await ctx.client.documentDataVersions(id, params);
      const rows = [...first.versions];
      if (opts.all) {
        let cursor = first.nextCursor;
        while (cursor) {
          const page = await ctx.client.documentDataVersions(id, { ...params, cursor });
          rows.push(...page.versions);
          cursor = page.nextCursor;
        }
      }
      const nextCursor = opts.all ? null : first.nextCursor;
      if (ctx.json) return printJson(io, { versions: rows, nextCursor });
      if (rows.length === 0) {
        io.out.write('No versions.\n');
        return;
      }
      io.out.write(
        table(
          rows.map((v) => [
            `v${v.version}`,
            v.createdAt,
            v.source,
            v.source === 'answer'
              ? `answered by ${v.answeredBy ?? '(an unnamed link)'}`
              : (v.createdBy ?? '(deleted user)'),
            v.changed.length === 0 ? '-' : v.changed.join(', ')
          ])
        )
      );
      if (nextCursor) io.out.write(`More available: rerun with --cursor ${nextCursor} or --all\n`);
    });

  // ── answers ───────────────────────────────────────────────────────────────
  root
    .command('answers <id>')
    .description(
      `The forms' answers as the document's data holds them under "${ANSWERS_KEY}": the fields, who, when`
    )
    .option('--clear <form>', "clear this form's answer from the data (the responses stay) and render again")
    .action(async (id: string, opts: { clear?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      await requireApiKey(ctx);
      if (opts.clear !== undefined) {
        const written = await refusalsWithDetails(() => ctx.client.clearDocumentAnswer(id, opts.clear!));
        if (ctx.json) return printJson(io, written);
        io.out.write(`Cleared the answer of "${opts.clear}" → version ${written.version.version}\n`);
        return;
      }
      const answers = await ctx.client.documentAnswers(id);
      if (ctx.json) return printJson(io, answers);
      if (answers.answers.length === 0) {
        io.out.write('No form answered yet.\n');
        return;
      }
      io.out.write(answers.answers.map(answerBlock).join('\n'));
    });

  // ── upgrade ───────────────────────────────────────────────────────────────
  root
    .command('upgrade <id>')
    .description("Move a document to a newer version of its template (default: the template's current one)")
    .option('--to <version>', 'the template version to move to', (v: string) => Number(v))
    .option('--file <file>', 'the data to move with, replacing the current one (judged by the new schema)')
    .option(
      '--merge <file>',
      'a merge patch applied before the move (the way to add what the new version requires)'
    )
    .action(async (id: string, opts: { to?: number; file?: string; merge?: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      if (opts.to !== undefined && (!Number.isInteger(opts.to) || opts.to < 1)) {
        throw new CliUsageError('--to is a template version, a whole number from 1.');
      }
      if (opts.file !== undefined && opts.merge !== undefined) {
        throw new CliUsageError('Pass --file (replace) or --merge (patch), not both.');
      }
      const data = opts.file !== undefined ? await readJsonObject(opts.file, '--file') : undefined;
      const merge = opts.merge !== undefined ? await readJsonObject(opts.merge, '--merge') : undefined;
      await requireApiKey(ctx);
      const written = await refusalsWithDetails(() =>
        ctx.client.upgradeDocument(id, {
          ...(opts.to !== undefined ? { toVersion: opts.to } : {}),
          ...(data !== undefined ? { data } : {}),
          ...(merge !== undefined ? { merge } : {})
        })
      );
      if (ctx.json) return printJson(io, written);
      const pin = written.data.template;
      io.out.write(
        `"${written.presentation.title}" is on template version ${pin.templateVersion} (schema ${pin.schemaVersion}) ` +
          `→ version ${written.version.version}\n` +
          `  url: ${deckMasterUrl(ctx.baseUrl, written.presentation.id)}\n`
      );
    });

  // ── check ─────────────────────────────────────────────────────────────────
  root
    .command('check')
    .description(
      "Check a data file against a template's schema locally, nothing pushed; exits 1 on any issue"
    )
    .requiredOption('--from <template>', 'the template: its id, its title, or the start of its title')
    .requiredOption('--data <file>', 'the JSON file to check')
    .action(async (opts: { from: string; data: string }, cmd: Command) => {
      const ctx = resolveContext(cmd, io);
      const value = await readJsonObject(opts.data, '--data');
      await requireApiKey(ctx);
      const template = await resolveTemplate(ctx, opts.from);
      const contract = await ctx.client.templateSchema(template.id);
      const issues: DataValidationIssue[] = [];
      if (Object.prototype.hasOwnProperty.call(value, ANSWERS_KEY)) {
        issues.push({
          path: `/${ANSWERS_KEY}`,
          message: `"${ANSWERS_KEY}" is reserved: the forms' answers are written by the server`
        });
      }
      issues.push(...validateDataAgainstSchema(contract.schema, withoutAnswers(value)));
      const ok = issues.length === 0;
      if (ctx.json) {
        printJson(io, { ok, issues });
      } else if (ok) {
        io.out.write(`ok: ${opts.data} follows "${template.title}" schema ${contract.schemaVersion}\n`);
      } else {
        io.out.write(
          `${opts.data} does not follow "${template.title}" schema ${contract.schemaVersion}:\n` +
            issues.map(issueLine).join('')
        );
      }
      // The verdict is already printed: exit 1 with nothing more to say.
      if (!ok) throw new CommanderError(1, 'slideless.document.check', '');
    });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A template the caller reads, named the way every `<ref>` is (references.ts). */
async function resolveTemplate(ctx: CliContext, ref: string): Promise<Presentation> {
  return resolveReference(await listReferences(ctx, 'template'), ref, 'template');
}

/** A local JSON file holding an object; anything else is the caller's mistake, said before any request. */
async function readJsonObject(path: string, flag: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new CliUsageError(`${flag}: cannot read ${path}.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new CliUsageError(`${flag}: ${path} is not valid JSON (${(e as Error).message}).`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CliUsageError(`${flag}: ${path} must hold a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

/** One issue as a line: the JSON pointer, then the validator's sentence. */
function issueLine(issue: DataValidationIssue): string {
  return `  ${issue.path === '' ? '(root)' : issue.path}: ${issue.message}\n`;
}

/**
 * The API's refusals that carry a list in their details get it printed
 * under the API's own message: one line per issue for `data_invalid` and
 * `sample_invalid`, one `file line N: path` per binding the schema lacks for
 * `binding_unknown`, one `path: message` per issue of a `validation_error`
 * (the reserved `answers` key among them). Every other refusal goes on to the runner untouched,
 * which keeps its hints (the plan link, the key check).
 */
async function refusalsWithDetails<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (!(e instanceof PlatformApiError)) throw e;
    const details = (e.details ?? {}) as { issues?: unknown; unknown?: unknown };
    let lines = '';
    if (e.code === 'validation_error' && Array.isArray(e.details)) {
      // The request's shape refused before the schema ran (a data file
      // carrying `answers`, a value nested too deep): the API's message is
      // the generic "Request validation failed", the reason is in each issue.
      lines = (e.details as { path?: unknown; message?: unknown }[])
        .map((issue) => {
          const path =
            Array.isArray(issue.path) && issue.path.length > 0 ? `/${issue.path.join('/')}` : '(root)';
          return `  ${path}: ${String(issue.message)}\n`;
        })
        .join('');
    } else if ((e.code === 'data_invalid' || e.code === 'sample_invalid') && Array.isArray(details.issues)) {
      lines = (details.issues as DataValidationIssue[]).map(issueLine).join('');
    } else if (e.code === 'binding_unknown' && Array.isArray(details.unknown)) {
      lines = (details.unknown as UnknownBinding[])
        .map((b) => `  ${b.file} line ${b.line}: ${b.path}\n`)
        .join('');
    } else {
      throw e;
    }
    throw new CliApiRefusal(`${e.message}${lines ? `\n${lines.replace(/\n$/, '')}` : ''}`, e.status);
  }
}

/** One form's answer: its name, a field/value table, then who and when. */
function answerBlock(a: DocumentFormAnswer): string {
  const rows = Object.entries(a.fields).map(([field, value]) => [
    field,
    Array.isArray(value) ? value.join(', ') : value
  ]);
  const fields =
    rows.length === 0
      ? '  (no field)\n'
      : table(rows)
          .split('\n')
          .filter((l) => l.length > 0)
          .map((l) => `  ${l}\n`)
          .join('');
  return (
    `${a.form}\n` +
    fields +
    `  answered by ${a.answeredBy ?? '(an unnamed link)'} at ${a.answeredAt}` +
    `${a.revision > 1 ? ` (revision ${a.revision})` : ''}\n`
  );
}

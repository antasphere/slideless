import { Validator, type Schema } from '@cfworker/json-schema';
import safeRegex from 'safe-regex2';
import { ANSWERS_KEY } from './bindings.js';
import { ANSWERED_KEY, type AnsweredMeta, type DataValidationIssue } from './schemas/documents.js';

/**
 * The three pure operations on a document's data (PRDCT-3641), shared by the
 * server (every write), the dashboard (the Data tab's check) and the CLI
 * (`slideless document check`): the schema validation, the merge patch and
 * the "what changed" summary of the push history.
 */

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * Validates data against a JSON Schema (draft 2020-12 by default; the
 * schema's own `$schema` wins when it names 2019-09 or draft-07). The
 * validator interprets the schema; it never generates code from it. Issues
 * name the JSON pointer of the failing value and the validator's sentence,
 * most specific first, capped so a hostile schema cannot flood the answer.
 */
export function validateDataAgainstSchema(
  schema: Record<string, unknown>,
  data: unknown,
  opts: { maxIssues?: number } = {}
): DataValidationIssue[] {
  const max = opts.maxIssues ?? 20;
  let validator: Validator;
  try {
    validator = new Validator(schema as Schema, draftOf(schema), false);
  } catch (err) {
    return [{ path: '', message: `the schema cannot be used: ${(err as Error).message}` }];
  }
  let result: ReturnType<Validator['validate']>;
  try {
    result = validator.validate(data);
  } catch (err) {
    // A pattern the regex engine refuses, a hostile keyword: the schema's fault, never a 500.
    return [{ path: '', message: `the schema cannot be used: ${(err as Error).message}` }];
  }
  if (result.valid) return [];
  return rankIssues(result.errors, max);
}

/**
 * The validator reports every node on the way down (`properties`, `items`,
 * the `additionalProperties` echo and its `false` child) beside the one error
 * that names the field. What a person needs is the field: the deepest error
 * per place, a missing required property pointed at the property itself, an
 * extra property named once, the structural echoes dropped, most specific
 * first.
 */
function rankIssues(
  errors: readonly { instanceLocation: string; keyword: string; error: string }[],
  max: number
): DataValidationIssue[] {
  const quoted = (text: string): string | null => /"([^"]+)"/.exec(text)?.[1] ?? null;
  const at = (loc: string): string => loc.replace(/^#/, '');
  const issues: { path: string; message: string; depth: number }[] = [];
  const locations = new Set(errors.map((e) => at(e.instanceLocation)));
  const hasOwnError = (loc: string): boolean =>
    errors.some((e) => at(e.instanceLocation) === loc && e.keyword !== 'false');
  for (const e of errors) {
    const loc = at(e.instanceLocation);
    switch (e.keyword) {
      case 'properties':
      case 'items':
      case 'prefixItems':
      case 'allOf':
      case 'anyOf':
      case 'oneOf':
        // A structural echo: the deeper error says it.
        continue;
      case 'required': {
        const name = quoted(e.error);
        issues.push({
          path: name ? `${loc}/${escapePointer(name)}` : loc,
          message: name ? `Property "${name}" is required.` : e.error,
          depth: loc.split('/').length + 1
        });
        continue;
      }
      case 'additionalProperties': {
        const name = quoted(e.error);
        const child = name ? `${loc}/${escapePointer(name)}` : null;
        // The echo of a declared property that failed its own schema.
        if (child && hasOwnError(child)) continue;
        issues.push({
          path: child ?? loc,
          message: name ? `Property "${name}" is not allowed here.` : e.error,
          depth: loc.split('/').length + 1
        });
        continue;
      }
      case 'false':
        // "False boolean schema": the additionalProperties echo on the extra key itself.
        if (
          locations.has(loc) &&
          errors.some((o) => o.keyword === 'additionalProperties' && at(o.instanceLocation) === parentOf(loc))
        )
          continue;
        issues.push({ path: loc, message: e.error, depth: loc.split('/').length });
        continue;
      default:
        issues.push({ path: loc, message: e.error, depth: loc.split('/').length });
    }
  }
  const seen = new Set<string>();
  const out: DataValidationIssue[] = [];
  for (const issue of issues.sort((a, b) => b.depth - a.depth)) {
    const key = `${issue.path}\u0000${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path: issue.path, message: issue.message });
    if (out.length >= max) break;
  }
  return out;
}

function parentOf(pointer: string): string {
  const i = pointer.lastIndexOf('/');
  return i <= 0 ? '' : pointer.slice(0, i);
}

function escapePointer(segment: string): string {
  return segment.replace(/~/g, '~0').replace(/\//g, '~1');
}

function draftOf(schema: Record<string, unknown>): '4' | '7' | '2019-09' | '2020-12' {
  const declared = schema['$schema'];
  if (typeof declared !== 'string') return '2020-12';
  if (declared.includes('2019-09')) return '2019-09';
  if (declared.includes('draft-07')) return '7';
  if (declared.includes('draft-04')) return '4';
  return '2020-12';
}

/**
 * RFC 7386: a merge patch applied to a target. An object patch merges key by
 * key, `null` deletes, a non-object patch replaces. The target is never
 * mutated. Keys with a prototype-shaped name are dropped on the way in.
 */
export function applyMergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const out: Record<string, unknown> = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    if (value === null) delete out[key];
    else out[key] = applyMergePatch(out[key], value);
  }
  return out;
}

/** Deterministic JSON text: keys sorted at every level, so two equal values stringify the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isObject(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The top-level keys whose value changed between two data objects, sorted;
 * inside `answers`, one entry per form (`answers.merge_gate`). What the
 * push history lists under "what changed".
 */
export function changedPaths(
  before: Record<string, unknown> | null,
  after: Record<string, unknown>
): string[] {
  const prev = before ?? {};
  const out = new Set<string>();
  const keys = new Set([...Object.keys(prev), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === ANSWERS_KEY) {
      const a = isObject(prev[key]) ? (prev[key] as Record<string, unknown>) : {};
      const b = isObject(after[key]) ? (after[key] as Record<string, unknown>) : {};
      for (const form of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (canonicalJson(a[form]) !== canonicalJson(b[form])) out.add(`${ANSWERS_KEY}.${form}`);
      }
      continue;
    }
    if (canonicalJson(prev[key]) !== canonicalJson(after[key])) out.add(key);
  }
  return [...out].sort();
}

/** The data without its server-owned branch: what the schema judges. */
export function withoutAnswers(data: Record<string, unknown>): Record<string, unknown> {
  if (!Object.prototype.hasOwnProperty.call(data, ANSWERS_KEY)) return data;
  const { [ANSWERS_KEY]: _answers, ...rest } = data;
  return rest;
}

/** The client data with the previous answers carried over (a replace never loses an answer). */
export function withAnswersOf(
  data: Record<string, unknown>,
  previous: Record<string, unknown> | null
): Record<string, unknown> {
  const answers = previous?.[ANSWERS_KEY];
  if (!isObject(answers) || Object.keys(answers).length === 0) return withoutAnswers(data);
  return { ...withoutAnswers(data), [ANSWERS_KEY]: answers };
}

/**
 * Writes one form's latest response into the answers branch: the fields by
 * name, then `$answered` with who and when. A field named `$answered` in the
 * form is overwritten by the record, by design.
 */
export function withFormAnswer(
  data: Record<string, unknown>,
  form: string,
  fields: Record<string, string | string[]>,
  meta: AnsweredMeta
): Record<string, unknown> {
  const answers = isObject(data[ANSWERS_KEY]) ? { ...(data[ANSWERS_KEY] as Record<string, unknown>) } : {};
  answers[form] = { ...fields, [ANSWERED_KEY]: meta };
  return { ...data, [ANSWERS_KEY]: answers };
}

/** Reads the answers branch back as a list, in the data's order; a malformed entry is skipped. */
export function answersOf(data: Record<string, unknown>): {
  form: string;
  fields: Record<string, string | string[]>;
  meta: AnsweredMeta;
}[] {
  const answers = data[ANSWERS_KEY];
  if (!isObject(answers)) return [];
  const out: { form: string; fields: Record<string, string | string[]>; meta: AnsweredMeta }[] = [];
  for (const [form, branch] of Object.entries(answers)) {
    if (!isObject(branch)) continue;
    const meta = branch[ANSWERED_KEY];
    if (!isObject(meta) || typeof meta['at'] !== 'string' || typeof meta['response'] !== 'string') continue;
    const fields: Record<string, string | string[]> = {};
    for (const [key, value] of Object.entries(branch)) {
      if (key === ANSWERED_KEY) continue;
      if (typeof value === 'string') fields[key] = value;
      else if (Array.isArray(value) && value.every((v) => typeof v === 'string'))
        fields[key] = value as string[];
    }
    out.push({
      form,
      fields,
      meta: {
        at: meta['at'],
        by: typeof meta['by'] === 'string' ? meta['by'] : null,
        link: typeof meta['link'] === 'string' ? meta['link'] : null,
        response: meta['response'],
        revision: typeof meta['revision'] === 'number' ? meta['revision'] : 1
      }
    });
  }
  return out;
}

/**
 * The regular expressions a schema carries (`pattern`, `patternProperties`
 * keys) that could take exponential time on a crafted value (verifier round
 * 2, F5): star height above one, as safe-regex2 judges it. The validator runs
 * them with the native engine on the request thread, so a template whose
 * schema carries one is refused at push, with the place named.
 */
export function unsafePatternsOf(schema: unknown): { at: string; pattern: string }[] {
  const out: { at: string; pattern: string }[] = [];
  const walk = (node: unknown, at: string, depth: number): void => {
    if (depth > 64 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, `${at}/${i}`, depth + 1));
      return;
    }
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      if (key === 'pattern' && typeof value === 'string') {
        if (!safeRegex(value)) out.push({ at: `${at}/pattern`, pattern: value });
        continue;
      }
      if (key === 'patternProperties' && isObject(value)) {
        for (const pattern of Object.keys(value)) {
          if (!safeRegex(pattern)) out.push({ at: `${at}/patternProperties`, pattern });
        }
        for (const [pattern, sub] of Object.entries(value))
          walk(sub, `${at}/patternProperties/${pattern}`, depth + 1);
        continue;
      }
      walk(value, `${at}/${key}`, depth + 1);
    }
  };
  walk(schema, '', 0);
  return out;
}

const SCHEMA_TYPE_NAMES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
/** Keywords whose value is one subschema. */
const ONE_SCHEMA_KEYS = [
  'additionalProperties',
  'unevaluatedProperties',
  'unevaluatedItems',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'additionalItems'
];
/** Keywords whose value maps names to subschemas. */
const SCHEMA_MAP_KEYS = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];
/** Keywords whose value is a non-empty list of subschemas. */
const SCHEMA_LIST_KEYS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'];
const COUNT_KEYS = [
  'minLength',
  'maxLength',
  'minItems',
  'maxItems',
  'minProperties',
  'maxProperties',
  'minContains',
  'maxContains'
];
const BOUND_KEYS = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum'];
const TEXT_KEYS = [
  '$id',
  '$ref',
  '$anchor',
  '$dynamicRef',
  '$dynamicAnchor',
  '$schema',
  '$comment',
  'title',
  'description',
  'format'
];
const FLAG_KEYS = ['uniqueItems', 'readOnly', 'writeOnly', 'deprecated'];

/**
 * The places a schema is not a JSON Schema at all (the PRDCT-3641 double
 * check): a keyword the validator understands holding a value of the wrong
 * shape (`"type": "strin"`, `"required": "title"`, `"properties": []`), or a
 * local `$ref` that points nowhere. The validator does not refuse these: it
 * reads `"required": "title"` as the four properties t, i, l and e, and a
 * misspelt type as a type nothing satisfies, so a template carrying one
 * would be accepted at push and no document could ever be made from it.
 * Keywords it does not know are annotations and stay free.
 */
export function schemaShapeIssues(schema: Record<string, unknown>): { at: string; message: string }[] {
  const out: { at: string; message: string }[] = [];
  const draft = draftOf(schema);
  const isSchema = (v: unknown): boolean => isObject(v) || typeof v === 'boolean';
  const isCount = (v: unknown): boolean => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  const pointer = (key: string): string => key.replace(/~/g, '~0').replace(/\//g, '~1');
  const resolves = (ref: string): boolean => {
    let target: unknown = schema;
    for (const raw of ref.slice(2).split('/')) {
      let key: string;
      try {
        key = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      } catch {
        return false;
      }
      if (Array.isArray(target) && /^\d+$/.test(key) && Number(key) < target.length) {
        target = target[Number(key)];
      } else if (isObject(target) && Object.prototype.hasOwnProperty.call(target, key)) {
        target = target[key];
      } else {
        return false;
      }
    }
    return isSchema(target);
  };
  const walk = (node: unknown, at: string, depth: number): void => {
    if (out.length >= 20 || depth > 64 || !isObject(node)) return;
    const type = node['type'];
    if (type !== undefined) {
      const names = Array.isArray(type) ? type : [type];
      const bad = names.find((n) => typeof n !== 'string' || !SCHEMA_TYPE_NAMES.has(n));
      if (names.length === 0 || bad !== undefined) {
        out.push({
          at: `${at}/type`,
          message: `${JSON.stringify(bad ?? type)} is not a JSON Schema type (null, boolean, object, array, number, integer, string)`
        });
      }
    }
    const required = node['required'];
    if (
      required !== undefined &&
      !(Array.isArray(required) && required.every((r) => typeof r === 'string'))
    ) {
      out.push({ at: `${at}/required`, message: 'must be a list of property names' });
    }
    const enumeration = node['enum'];
    if (enumeration !== undefined && !Array.isArray(enumeration)) {
      out.push({ at: `${at}/enum`, message: 'must be a list of values' });
    }
    for (const key of COUNT_KEYS) {
      if (node[key] !== undefined && !isCount(node[key]))
        out.push({ at: `${at}/${key}`, message: 'must be a whole number from 0' });
    }
    for (const key of BOUND_KEYS) {
      const v = node[key];
      const ok =
        typeof v === 'number' || (draft === '4' && typeof v === 'boolean' && key.startsWith('exclusive'));
      if (v !== undefined && !ok) out.push({ at: `${at}/${key}`, message: 'must be a number' });
    }
    const multipleOf = node['multipleOf'];
    if (multipleOf !== undefined && !(typeof multipleOf === 'number' && multipleOf > 0)) {
      out.push({ at: `${at}/multipleOf`, message: 'must be a number above 0' });
    }
    for (const key of TEXT_KEYS) {
      if (node[key] !== undefined && typeof node[key] !== 'string')
        out.push({ at: `${at}/${key}`, message: 'must be a string' });
    }
    for (const key of FLAG_KEYS) {
      if (node[key] !== undefined && typeof node[key] !== 'boolean')
        out.push({ at: `${at}/${key}`, message: 'must be true or false' });
    }
    const pattern = node['pattern'];
    if (typeof pattern === 'string') {
      try {
        new RegExp(pattern, 'u');
      } catch {
        out.push({ at: `${at}/pattern`, message: 'is not a regular expression' });
      }
    }
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith('#/') && !resolves(ref)) {
      out.push({ at: `${at}/$ref`, message: `"${ref}" points to nothing in the schema` });
    }
    const dependentRequired = node['dependentRequired'];
    if (
      dependentRequired !== undefined &&
      !(
        isObject(dependentRequired) &&
        Object.values(dependentRequired).every(
          (v) => Array.isArray(v) && v.every((s) => typeof s === 'string')
        )
      )
    ) {
      out.push({
        at: `${at}/dependentRequired`,
        message: 'must map property names to lists of property names'
      });
    }
    for (const key of ONE_SCHEMA_KEYS) {
      const v = node[key];
      if (v === undefined) continue;
      if (!isSchema(v))
        out.push({ at: `${at}/${key}`, message: 'must be a schema (an object or a boolean)' });
      else walk(v, `${at}/${key}`, depth + 1);
    }
    const items = node['items'];
    if (items !== undefined) {
      if (Array.isArray(items) && draft !== '2020-12') {
        items.forEach((item, i) =>
          isSchema(item)
            ? walk(item, `${at}/items/${i}`, depth + 1)
            : out.push({ at: `${at}/items/${i}`, message: 'must be a schema (an object or a boolean)' })
        );
      } else if (!isSchema(items)) {
        out.push({ at: `${at}/items`, message: 'must be a schema (an object or a boolean)' });
      } else {
        walk(items, `${at}/items`, depth + 1);
      }
    }
    for (const key of SCHEMA_MAP_KEYS) {
      const v = node[key];
      if (v === undefined) continue;
      if (!isObject(v)) {
        out.push({ at: `${at}/${key}`, message: 'must map names to schemas' });
        continue;
      }
      for (const [name, sub] of Object.entries(v)) {
        if (key === 'patternProperties') {
          try {
            new RegExp(name, 'u');
          } catch {
            out.push({ at: `${at}/${key}/${pointer(name)}`, message: 'the key is not a regular expression' });
          }
        }
        if (!isSchema(sub))
          out.push({
            at: `${at}/${key}/${pointer(name)}`,
            message: 'must be a schema (an object or a boolean)'
          });
        else walk(sub, `${at}/${key}/${pointer(name)}`, depth + 1);
      }
    }
    for (const key of SCHEMA_LIST_KEYS) {
      const v = node[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.length === 0) {
        out.push({ at: `${at}/${key}`, message: 'must be a non-empty list of schemas' });
        continue;
      }
      v.forEach((sub, i) =>
        isSchema(sub)
          ? walk(sub, `${at}/${key}/${i}`, depth + 1)
          : out.push({ at: `${at}/${key}/${i}`, message: 'must be a schema (an object or a boolean)' })
      );
    }
  };
  walk(schema, '', 0);
  return out;
}

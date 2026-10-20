import { Validator, type Schema } from '@cfworker/json-schema';
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
  const issues: DataValidationIssue[] = [];
  const seen = new Set<string>();
  // The validator reports outermost first; the innermost entries are the ones
  // that name the field, so they go first.
  for (const e of [...result.errors].reverse()) {
    const path = e.instanceLocation.replace(/^#/, '');
    const key = `${path}\u0000${e.error}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push({ path, message: e.error });
    if (issues.length >= max) break;
  }
  return issues;
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

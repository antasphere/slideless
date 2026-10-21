/**
 * DATA BINDINGS (PRDCT-3641): the mustache subset a data-bound template's
 * HTML files speak, resolved ONCE at push into the stored version (never at
 * serve time: the viewer streams, the thumbnails read raw files, the pull is
 * byte-exact, so a rendered version is a plain deck downstream).
 *
 * The subset, and nothing else:
 *   {{path}}        the value, HTML-escaped
 *   {{{path}}}      the value, raw (also {{& path}})
 *   {{#path}}…{{/path}}   a section: an array repeats it once per item (the
 *                   item is the context), a non-empty object or a truthy
 *                   value renders it once, anything falsy skips it
 *   {{^path}}…{{/path}}   the inverse: rendered when the value is falsy or
 *                   the array is empty
 *   {{!comment}}    dropped
 *   {{.}}           the current item; {{@index}}, {{@first}}, {{@last}} inside
 *                   an array section
 *   \{{             a literal `{{`
 * No partials, no set-delimiter, no helpers: a template that asks for them
 * is refused at push with the file and the line named.
 *
 * Lookup follows mustache: the first segment of a dotted path is looked up
 * from the innermost context outward, the rest is walked inside the value
 * found. The static extractor (`extractBindings`) resolves the same way
 * against the JSON Schema, so a path the schema does not know is refused at
 * push, before any data exists.
 *
 * Pure, dependency-free, isomorphic: the server renders with it at push, the
 * dashboard previews the sample with it, the CLI checks a folder with it.
 */

export type BindingToken =
  | { kind: 'text'; text: string }
  | { kind: 'var'; path: string; raw: boolean; line: number }
  | { kind: 'section'; path: string; inverted: boolean; line: number; children: BindingToken[] };

export interface BindingError {
  /** The file the error is in, when the caller named one. */
  file?: string;
  line: number;
  message: string;
}

export interface ParsedBindings {
  tokens: BindingToken[];
  /** Whether the source carries any binding at all (a plain file renders byte for byte). */
  bound: boolean;
}

const OPEN = '{{';
const CLOSE = '}}';
const PATH_SEGMENT = /^(?:[A-Za-z0-9_$-]+|@index|@first|@last)$/;

/** The reserved branch every document carries: the forms' answers, server-owned. */
export const ANSWERS_KEY = 'answers';

/** Quick test before any parse: no `{{`, no bindings. */
export function hasBindingMarkers(source: string): boolean {
  return source.includes(OPEN);
}

function isValidPath(path: string): boolean {
  if (path === '.') return true;
  const segments = path.split('.');
  return segments.length > 0 && segments.every((s) => PATH_SEGMENT.test(s));
}

/**
 * Parses a source into tokens. Never throws: every problem is an error with
 * its line, and the tokens hold what could be read. A source with errors must
 * not be rendered (the server refuses the push).
 */
export function parseBindings(
  source: string,
  file?: string
): { parsed: ParsedBindings; errors: BindingError[] } {
  const errors: BindingError[] = [];
  const root: BindingToken[] = [];
  const stack: { token: Extract<BindingToken, { kind: 'section' }>; children: BindingToken[] }[] = [];
  let children = root;
  let bound = false;
  let pos = 0;
  let line = 1;
  let text = '';

  const fail = (at: number, message: string): void => {
    errors.push({ ...(file !== undefined ? { file } : {}), line: at, message });
  };
  const flushText = (): void => {
    if (text.length > 0) children.push({ kind: 'text', text });
    text = '';
  };
  const countLines = (s: string): number => {
    let n = 0;
    for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) n++;
    return n;
  };

  while (pos < source.length) {
    const open = source.indexOf(OPEN, pos);
    if (open === -1) {
      text += source.slice(pos);
      break;
    }
    // `\{{` is a literal `{{`.
    if (open > 0 && source[open - 1] === '\\') {
      const chunk = source.slice(pos, open - 1);
      text += chunk + OPEN;
      line += countLines(chunk);
      pos = open + OPEN.length;
      continue;
    }
    const chunk = source.slice(pos, open);
    text += chunk;
    line += countLines(chunk);
    const tagLine = line;

    const triple = source.startsWith('{{{', open);
    const closeMark = triple ? '}}}' : CLOSE;
    const close = source.indexOf(closeMark, open + (triple ? 3 : 2));
    if (close === -1) {
      fail(tagLine, `a "${triple ? '{{{' : '{{'}" tag is never closed`);
      text += source.slice(open);
      break;
    }
    const inner = source.slice(open + (triple ? 3 : 2), close).trim();
    pos = close + closeMark.length;
    line += countLines(source.slice(open, pos));

    if (triple) {
      flushText();
      if (!isValidPath(inner)) fail(tagLine, `"{{{${inner}}}}" is not a field path`);
      else children.push({ kind: 'var', path: inner, raw: true, line: tagLine });
      bound = true;
      continue;
    }
    const sigil = inner[0] ?? '';
    const body = inner.slice(1).trim();
    switch (sigil) {
      case '!':
        flushText();
        break;
      case '>':
        flushText();
        fail(tagLine, `"{{${inner}}}": partials are not supported`);
        break;
      case '=':
        flushText();
        fail(tagLine, `"{{${inner}}}": changing the delimiters is not supported`);
        break;
      case '&': {
        flushText();
        if (!isValidPath(body)) fail(tagLine, `"{{${inner}}}" is not a field path`);
        else children.push({ kind: 'var', path: body, raw: true, line: tagLine });
        bound = true;
        break;
      }
      case '#':
      case '^': {
        flushText();
        if (!isValidPath(body)) {
          fail(tagLine, `"{{${inner}}}" is not a field path`);
          break;
        }
        const token: Extract<BindingToken, { kind: 'section' }> = {
          kind: 'section',
          path: body,
          inverted: sigil === '^',
          line: tagLine,
          children: []
        };
        children.push(token);
        stack.push({ token, children: token.children });
        children = token.children;
        bound = true;
        break;
      }
      case '/': {
        flushText();
        const top = stack.pop();
        if (!top) {
          fail(tagLine, `"{{/${body}}}" closes a section that was never opened`);
          break;
        }
        if (top.token.path !== body) {
          fail(
            tagLine,
            `"{{/${body}}}" closes "{{${top.token.inverted ? '^' : '#'}${top.token.path}}}" (opened on line ${top.token.line})`
          );
        }
        children = stack.length > 0 ? stack[stack.length - 1]!.children : root;
        break;
      }
      default: {
        flushText();
        if (inner === '' || !isValidPath(inner)) fail(tagLine, `"{{${inner}}}" is not a field path`);
        else children.push({ kind: 'var', path: inner, raw: false, line: tagLine });
        bound = true;
      }
    }
  }
  flushText();
  for (const open of stack) {
    fail(open.token.line, `"{{${open.token.inverted ? '^' : '#'}${open.token.path}}}" is never closed`);
  }
  return { parsed: { tokens: root, bound }, errors };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

type Frame = { value: unknown; index?: number; count?: number };

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function lookupIn(value: unknown, segment: string): unknown {
  if (isObject(value) && Object.prototype.hasOwnProperty.call(value, segment)) return value[segment];
  return undefined;
}

/** Mustache lookup: the first segment from the innermost frame outward, the rest walked inside. */
function resolve(path: string, frames: Frame[]): unknown {
  const top = frames[frames.length - 1]!;
  if (path === '.') return top.value;
  const segments = path.split('.');
  const first = segments[0]!;
  if (first.startsWith('@')) {
    for (let i = frames.length - 1; i >= 0; i--) {
      const f = frames[i]!;
      if (f.index === undefined) continue;
      if (first === '@index') return f.index;
      if (first === '@first') return f.index === 0;
      if (first === '@last') return f.index === (f.count ?? 0) - 1;
    }
    return undefined;
  }
  let value: unknown = undefined;
  let found = false;
  for (let i = frames.length - 1; i >= 0; i--) {
    const v = frames[i]!.value;
    if (isObject(v) && Object.prototype.hasOwnProperty.call(v, first)) {
      value = v[first];
      found = true;
      break;
    }
  }
  if (!found) return undefined;
  for (let i = 1; i < segments.length; i++) {
    value = lookupIn(value, segments[i]!);
    if (value === undefined) return undefined;
  }
  return value;
}

/** mustache.js truthiness: an empty array and every JS-falsy value skip a section. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  return Boolean(value);
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function stringify(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return String(value);
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function renderTokens(tokens: BindingToken[], frames: Frame[], out: string[]): void {
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out.push(token.text);
        break;
      case 'var': {
        const text = stringify(resolve(token.path, frames));
        out.push(token.raw ? text : escapeHtml(text));
        break;
      }
      case 'section': {
        const value = resolve(token.path, frames);
        if (token.inverted) {
          if (!truthy(value)) renderTokens(token.children, frames, out);
          break;
        }
        if (!truthy(value)) break;
        if (Array.isArray(value)) {
          for (let i = 0; i < value.length; i++) {
            frames.push({ value: value[i], index: i, count: value.length });
            renderTokens(token.children, frames, out);
            frames.pop();
          }
        } else {
          frames.push({ value });
          renderTokens(token.children, frames, out);
          frames.pop();
        }
      }
    }
  }
}

/** Renders parsed tokens against data. A path that resolves to nothing renders as an empty string. */
export function renderBindings(parsed: ParsedBindings, data: unknown): string {
  const out: string[] = [];
  renderTokens(parsed.tokens, [{ value: data }], out);
  return out.join('');
}

// ── Static extraction against a JSON Schema ───────────────────────────────────

/**
 * A JSON Schema node as the walker reads it: only the keywords that place a
 * field are read (`properties`, `items`, `prefixItems`, `additionalProperties`,
 * `patternProperties`, `$ref` to a local `$defs`/`definitions` entry, the
 * `anyOf`/`oneOf`/`allOf` combinators); everything else is the validator's.
 */
export type JsonSchemaNode = boolean | Record<string, unknown>;

interface SchemaScope {
  /** The schema this scope is in; `null` = the scope is a value the schema does not describe. */
  node: JsonSchemaNode | null;
  /** The absolute path of this scope (`tickets` for the item of the `tickets` array). */
  path: string;
  /** True when the scope is an array's item (so `@index` and friends resolve). */
  item: boolean;
}

export interface ExtractedBindings {
  /** Every absolute path bound, sorted, deduplicated (`tickets.headline`). */
  bound: string[];
  /** Paths the schema does not describe, with where they are. */
  unknown: { path: string; file?: string; line: number }[];
}

function derefLocal(node: JsonSchemaNode, root: Record<string, unknown>): JsonSchemaNode {
  if (typeof node !== 'object') return node;
  const ref = node['$ref'];
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return node;
  let target: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObject(target) || !(key in target)) return {};
    target = target[key];
  }
  return isObject(target) ? target : typeof target === 'boolean' ? target : {};
}

/** The item schema of an array node, or `null` when it is not an array. */
function itemsOf(node: JsonSchemaNode, root: Record<string, unknown>): JsonSchemaNode | null | 'any' {
  const n = derefLocal(node, root);
  if (typeof n === 'boolean') return n ? 'any' : null;
  const type = n['type'];
  const isArray =
    type === 'array' || (Array.isArray(type) && type.includes('array')) || 'items' in n || 'prefixItems' in n;
  if (!isArray) return null;
  const items = n['items'];
  if (items === undefined) return 'any';
  if (typeof items === 'boolean') return items ? 'any' : null;
  return isObject(items) ? items : 'any';
}

/** The schema of `segment` inside node, `'any'` when the node accepts any key, `null` when unknown. */
function propertyOf(
  node: JsonSchemaNode,
  segment: string,
  root: Record<string, unknown>
): JsonSchemaNode | null | 'any' {
  const n = derefLocal(node, root);
  if (typeof n === 'boolean') return n ? 'any' : null;
  const props = n['properties'];
  if (isObject(props) && Object.prototype.hasOwnProperty.call(props, segment)) {
    const p = props[segment];
    return isObject(p) || typeof p === 'boolean' ? p : 'any';
  }
  const patterns = n['patternProperties'];
  if (isObject(patterns)) {
    for (const [pattern, schema] of Object.entries(patterns)) {
      try {
        if (new RegExp(pattern, 'u').test(segment))
          return isObject(schema) || typeof schema === 'boolean' ? schema : 'any';
      } catch {
        /* a pattern the regex engine refuses places nothing */
      }
    }
  }
  const additional = n['additionalProperties'];
  if (additional === true || isObject(additional)) return isObject(additional) ? additional : 'any';
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    const branches = n[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        if (!isObject(branch) && typeof branch !== 'boolean') continue;
        const found = propertyOf(branch, segment, root);
        if (found !== null) return found;
      }
    }
  }
  // An object with no `properties` and `additionalProperties` unset accepts any key.
  const type = n['type'];
  const declaresObject = type === 'object' || (Array.isArray(type) && type.includes('object'));
  if (declaresObject && !isObject(props) && additional === undefined) return 'any';
  // An untyped node with no placement keyword at all says nothing: accept.
  if (type === undefined && !isObject(props) && additional === undefined && !('items' in n)) return 'any';
  return null;
}

/** Walks the rest of a dotted path inside a node; `'any'` once a branch accepts anything. */
function walk(
  node: JsonSchemaNode | 'any',
  segments: string[],
  root: Record<string, unknown>
): JsonSchemaNode | null | 'any' {
  let current: JsonSchemaNode | 'any' = node;
  for (const segment of segments) {
    if (current === 'any') return 'any';
    // A dotted path may step straight into an array's items (`tickets.headline` lists the headlines).
    const asItems = itemsOf(current, root);
    const next: JsonSchemaNode | null | 'any' =
      asItems !== null
        ? asItems === 'any'
          ? 'any'
          : propertyOf(asItems, segment, root)
        : propertyOf(current, segment, root);
    if (next === null) return null;
    current = next;
  }
  return current;
}

/**
 * Resolves every binding of a parsed template against the schema the way the
 * renderer resolves it against data, and reports the absolute paths bound and
 * the ones the schema does not know. `answers.*` is always known: the server
 * writes that branch, the schema never describes it.
 */
export function extractBindings(
  parsed: ParsedBindings,
  schema: Record<string, unknown>,
  file?: string
): ExtractedBindings {
  const bound = new Set<string>();
  const unknown: ExtractedBindings['unknown'] = [];
  const root = schema;

  const resolveStatic = (
    path: string,
    scopes: SchemaScope[]
  ): { node: JsonSchemaNode | 'any' | null; absolute: string } => {
    const top = scopes[scopes.length - 1]!;
    if (path === '.') return { node: top.node ?? 'any', absolute: top.path || '.' };
    const segments = path.split('.');
    const first = segments[0]!;
    if (first.startsWith('@')) {
      return { node: scopes.some((s) => s.item) ? 'any' : null, absolute: path };
    }
    if (first === ANSWERS_KEY && scopes.length === 1) return { node: 'any', absolute: path };
    for (let i = scopes.length - 1; i >= 0; i--) {
      const scope = scopes[i]!;
      const base: JsonSchemaNode | 'any' = scope.node === null ? 'any' : scope.node;
      if (base === 'any') {
        return { node: 'any', absolute: scope.path ? `${scope.path}.${path}` : path };
      }
      const asItems = itemsOf(base, root);
      const head: JsonSchemaNode | null | 'any' =
        asItems !== null
          ? asItems === 'any'
            ? 'any'
            : propertyOf(asItems, first, root)
          : propertyOf(base, first, root);
      if (head === null) continue;
      const rest = walk(head, segments.slice(1), root);
      if (rest === null) continue;
      return { node: rest, absolute: scope.path ? `${scope.path}.${path}` : path };
    }
    // The root accepts `answers.*` from any depth too (a section never shadows a server branch).
    if (first === ANSWERS_KEY) return { node: 'any', absolute: path };
    return { node: null, absolute: path };
  };

  const visit = (tokens: BindingToken[], scopes: SchemaScope[]): void => {
    for (const token of tokens) {
      if (token.kind === 'text') continue;
      const found = resolveStatic(token.path, scopes);
      if (found.node === null) {
        unknown.push({ path: token.path, ...(file !== undefined ? { file } : {}), line: token.line });
      } else if (!token.path.startsWith('@') && token.path !== '.') {
        bound.add(found.absolute);
      }
      if (token.kind === 'section') {
        const node = found.node === null ? null : found.node;
        const items = node === null || node === 'any' ? null : itemsOf(node, root);
        const scope: SchemaScope = {
          node: node === 'any' ? null : items === null ? node : items === 'any' ? null : items,
          path: found.absolute === '.' ? scopes[scopes.length - 1]!.path : found.absolute,
          // An unknown section is reported once, above; what it holds is not judged again, so
          // `{{@index}}` inside it is no second refusal line (the PRDCT-3641 double check).
          item: items !== null || node === null
        };
        visit(token.children, [...scopes, scope]);
      }
    }
  };
  visit(parsed.tokens, [{ node: schema, path: '', item: false }]);
  return { bound: [...bound].sort(), unknown };
}

import { describe, expect, it } from 'vitest';
import {
  ANSWERS_KEY,
  applyMergePatch,
  answersOf,
  changedPaths,
  extractBindings,
  hasBindingMarkers,
  parseBindings,
  renderBindings,
  schemaShapeIssues,
  unsafePatternsOf,
  validateDataAgainstSchema,
  withAnswersOf,
  withFormAnswer,
  withoutAnswers
} from '../src/index.js';

const render = (source: string, data: unknown): string => {
  const { parsed, errors } = parseBindings(source);
  expect(errors).toEqual([]);
  return renderBindings(parsed, data);
};

describe('parseBindings', () => {
  it('reads text, variables, raw variables, sections and comments', () => {
    const { parsed, errors } = parseBindings(
      'a {{x}} {{{y}}} {{& z}} {{#l}}i{{/l}} {{^l}}n{{/l}} {{! c }} b'
    );
    expect(errors).toEqual([]);
    expect(parsed.bound).toBe(true);
    expect(parsed.tokens.map((t) => t.kind)).toEqual([
      'text',
      'var',
      'text',
      'var',
      'text',
      'var',
      'text',
      'section',
      'text',
      'section',
      'text',
      'text'
    ]);
  });

  it('a file with no marker is not bound and renders byte for byte', () => {
    const src = '<p>plain {x} }} text</p>';
    expect(hasBindingMarkers(src)).toBe(false);
    const { parsed, errors } = parseBindings(src);
    expect(errors).toEqual([]);
    expect(parsed.bound).toBe(false);
    expect(renderBindings(parsed, { x: 1 })).toBe(src);
  });

  it('\\{{ is a literal', () => {
    expect(render('say \\{{hi}} to {{n}}', { n: 'Bo' })).toBe('say {{hi}} to Bo');
  });

  it('refuses partials, delimiters, unclosed and mismatched sections, naming the line', () => {
    const { errors } = parseBindings('l1\n{{> p}}\n{{=<% %>=}}\n{{#a}}\n{{/b}}\n{{#c}}\n{{x');
    expect(errors.map((e) => [e.line, e.message])).toEqual([
      [2, '"{{> p}}": partials are not supported'],
      [3, '"{{=<% %>=}}": changing the delimiters is not supported'],
      [5, '"{{/b}}" closes "{{#a}}" (opened on line 4)'],
      [7, 'a "{{" tag is never closed'],
      [6, '"{{#c}}" is never closed']
    ]);
  });

  it('refuses a path that is not a field path', () => {
    const { errors } = parseBindings('{{a b}} {{}} {{a..b}} {{a/b}}');
    expect(errors.map((e) => e.message)).toEqual([
      '"{{a b}}" is not a field path',
      '"{{}}" is not a field path',
      '"{{a..b}}" is not a field path',
      '"{{a/b}}" is not a field path'
    ]);
  });

  it('carries the file name on every error', () => {
    const { errors } = parseBindings('{{/x}}', 'pages/two.html');
    expect(errors[0]).toEqual({
      file: 'pages/two.html',
      line: 1,
      message: '"{{/x}}" closes a section that was never opened'
    });
  });
});

describe('renderBindings', () => {
  it('escapes {{x}} and leaves {{{x}}} raw', () => {
    expect(render('{{x}}|{{{x}}}|{{& x}}', { x: '<b>&"\'' })).toBe(
      '&lt;b&gt;&amp;&quot;&#39;|<b>&"\'|<b>&"\''
    );
  });

  it('renders numbers, booleans, null and nested objects', () => {
    expect(render('{{n}} {{t}} {{f}} [{{z}}] {{o}}', { n: 0, t: true, f: false, z: null, o: { a: 1 } })).toBe(
      '0 true false [] {&quot;a&quot;:1}'
    );
  });

  it('walks dotted paths and reads the current item with a dot', () => {
    expect(render('{{a.b.c}} {{#l}}[{{.}}]{{/l}}', { a: { b: { c: 'deep' } }, l: ['x', 'y'] })).toBe(
      'deep [x][y]'
    );
  });

  it('repeats an array section once per item, with @index, @first and @last', () => {
    const src = '{{#tickets}}{{@index}}:{{id}}{{#@first}}*{{/@first}}{{#@last}}${{/@last}} {{/tickets}}';
    expect(render(src, { tickets: [{ id: 'A' }, { id: 'B' }, { id: 'C' }] })).toBe('0:A* 1:B 2:C$ ');
  });

  it('renders an object section once with the object as context, and a truthy scalar once', () => {
    expect(
      render('{{#code}}{{branch}}{{/code}}|{{#ok}}yes{{/ok}}', { code: { branch: 'lane/x' }, ok: 'y' })
    ).toBe('lane/x|yes');
  });

  it('skips a section on false, null, missing, empty string, 0 and an empty array; the inverse renders then', () => {
    const src = '{{#v}}on{{/v}}{{^v}}off{{/v}}';
    for (const v of [false, null, undefined, '', 0, []]) expect(render(src, { v })).toBe('off');
    for (const v of [true, 'x', 1, [1], {}]) expect(render(src, { v })).toBe('on');
  });

  it('looks the first segment up from the innermost context outward', () => {
    const src = '{{#tickets}}{{id}}/{{title}} {{/tickets}}';
    expect(render(src, { title: 'T', tickets: [{ id: 1 }, { id: 2, title: 'own' }] })).toBe('1/T 2/own ');
  });

  it('a missing path renders empty', () => {
    expect(render('[{{nope}}][{{a.nope}}][{{#a}}{{nope}}{{/a}}]', { a: { b: 1 } })).toBe('[][][]');
  });

  it('never reads prototype members', () => {
    expect(render('[{{constructor}}][{{__proto__}}][{{a.toString}}]', { a: {} })).toBe('[][][]');
  });

  it('nests sections', () => {
    const src = '{{#rounds}}r{{n}}:{{#findings}}{{severity}},{{/findings}};{{/rounds}}';
    expect(
      render(src, {
        rounds: [
          { n: 1, findings: [{ severity: 'Major' }, { severity: 'Minor' }] },
          { n: 2, findings: [] }
        ]
      })
    ).toBe('r1:Major,Minor,;r2:;');
  });
});

const schema = {
  version: '1',
  type: 'object',
  properties: {
    title: { type: 'string' },
    meta: { type: 'object', properties: { k: { type: 'string' } }, additionalProperties: false },
    tickets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          rounds: { type: 'array', items: { $ref: '#/$defs/round' } }
        }
      }
    },
    free: { type: 'object' },
    open: {}
  },
  additionalProperties: false,
  $defs: { round: { type: 'object', properties: { n: { type: 'integer' } }, additionalProperties: false } }
};

describe('extractBindings', () => {
  const extract = (src: string) => {
    const { parsed, errors } = parseBindings(src, 'index.html');
    expect(errors).toEqual([]);
    return extractBindings(parsed, schema, 'index.html');
  };

  it('lists the absolute paths bound, through sections and refs', () => {
    const out = extract('{{title}}{{#tickets}}{{id}}{{#rounds}}{{n}}{{/rounds}}{{/tickets}}{{meta.k}}');
    expect(out.unknown).toEqual([]);
    expect(out.bound).toEqual([
      'meta.k',
      'tickets',
      'tickets.id',
      'tickets.rounds',
      'tickets.rounds.n',
      'title'
    ]);
  });

  it('refuses a field the schema does not have, at its line', () => {
    const out = extract(
      '{{title}}\n{{nope}}\n{{#tickets}}{{headline}}{{/tickets}}\n{{meta.zz}}\n{{#tickets}}{{#rounds}}{{x}}{{/rounds}}{{/tickets}}'
    );
    expect(out.unknown).toEqual([
      { path: 'nope', file: 'index.html', line: 2 },
      { path: 'headline', file: 'index.html', line: 3 },
      { path: 'meta.zz', file: 'index.html', line: 4 },
      { path: 'x', file: 'index.html', line: 5 }
    ]);
  });

  it('a section item may read the root (mustache lookup), and the path is recorded where it resolved', () => {
    const out = extract('{{#tickets}}{{title}}{{/tickets}}');
    expect(out.unknown).toEqual([]);
    expect(out.bound).toEqual(['tickets', 'title']);
  });

  it('accepts any key under an object with no properties or an untyped node, and nothing under additionalProperties:false', () => {
    const out = extract('{{free.anything}}{{open.x.y}}{{meta.k}}{{meta.other}}');
    expect(out.unknown.map((u) => u.path)).toEqual(['meta.other']);
  });

  it('always accepts the answers branch, at the root and from inside a section', () => {
    const out = extract(
      `{{${ANSWERS_KEY}.gate.decision}}{{#tickets}}{{${ANSWERS_KEY}.gate.by}}{{/tickets}}{{#${ANSWERS_KEY}.gate}}{{comment}}{{/${ANSWERS_KEY}.gate}}`
    );
    expect(out.unknown).toEqual([]);
    expect(out.bound).toContain('answers.gate.decision');
  });

  it('accepts @index, @first and @last inside an array section only, and the dot anywhere', () => {
    const out = extract('{{#tickets}}{{@index}}{{.}}{{/tickets}}{{@index}}{{.}}');
    expect(out.unknown).toEqual([{ path: '@index', file: 'index.html', line: 1 }]);
  });

  it('a dotted path may step into an array’s items', () => {
    const out = extract('{{tickets.id}}{{tickets.rounds.n}}{{tickets.zz}}');
    expect(out.unknown.map((u) => u.path)).toEqual(['tickets.zz']);
  });

  it('a boolean schema places everything (true) or nothing (false)', () => {
    const { parsed } = parseBindings('{{a.b}}');
    expect(extractBindings(parsed, { version: '1', properties: { a: true } }).unknown).toEqual([]);
    expect(extractBindings(parsed, { version: '1', properties: { a: false } }).unknown).toHaveLength(1);
  });
});

describe('validateDataAgainstSchema', () => {
  it('accepts valid data and names the field of a violation', () => {
    expect(
      validateDataAgainstSchema(schema, { title: 'ok', tickets: [{ id: 'A', rounds: [{ n: 1 }] }] })
    ).toEqual([]);
    const issues = validateDataAgainstSchema(schema, {
      title: 3,
      tickets: [{ id: 'A', rounds: [{ n: 'x' }] }]
    });
    expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['/title', '/tickets/0/rounds/0/n']));
  });

  it('refuses an extra key under additionalProperties:false', () => {
    const issues = validateDataAgainstSchema(schema, { title: 'ok', extra: 1 });
    expect(issues.some((i) => i.message.includes('extra') || i.path === '/extra' || i.path === '')).toBe(
      true
    );
  });

  it('a schema the validator cannot use answers one issue, never throws', () => {
    const issues = validateDataAgainstSchema(
      { version: '1', type: 'object', properties: { a: { pattern: '(' } } },
      { a: 'x' }
    );
    expect(issues.length).toBeGreaterThan(0);
  });

  it('caps the issues', () => {
    const many = {
      version: '1',
      type: 'object',
      properties: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, { type: 'string' }]))
    };
    const data = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, i]));
    expect(validateDataAgainstSchema(many, data, { maxIssues: 5 })).toHaveLength(5);
  });
});

describe('the data operations', () => {
  it('applyMergePatch follows RFC 7386', () => {
    expect(applyMergePatch({ a: 'b', c: { d: 'e', f: 'g' } }, { a: 'z', c: { f: null } })).toEqual({
      a: 'z',
      c: { d: 'e' }
    });
    expect(applyMergePatch({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
    expect(applyMergePatch({ a: 1 }, { b: { c: 1 } })).toEqual({ a: 1, b: { c: 1 } });
    expect(applyMergePatch({ a: 1 }, 'x')).toBe('x');
    expect(applyMergePatch({ a: 1 }, { __proto__: { p: 1 }, a: 2 })).toEqual({ a: 2 });
  });

  it('applyMergePatch never mutates the target', () => {
    const target = { a: { b: 1 } };
    applyMergePatch(target, { a: { b: 2 } });
    expect(target).toEqual({ a: { b: 1 } });
  });

  it('changedPaths names the top-level keys that changed, and answers per form', () => {
    expect(changedPaths({ a: 1, b: [1], c: 'x' }, { a: 1, b: [2], d: 1 })).toEqual(['b', 'c', 'd']);
    expect(changedPaths(null, { a: 1 })).toEqual(['a']);
    expect(
      changedPaths(
        { a: 1, answers: { gate: { d: 'no' } } },
        { a: 1, answers: { gate: { d: 'yes' }, other: {} } }
      )
    ).toEqual(['answers.gate', 'answers.other']);
    expect(changedPaths({ a: { y: 1, x: 2 } }, { a: { x: 2, y: 1 } })).toEqual([]);
  });

  it('withoutAnswers, withAnswersOf and withFormAnswer keep the branch the server’s', () => {
    const prev = {
      t: 1,
      answers: {
        gate: { d: 'yes', $answered: { at: 'a', by: 'romain', link: 'l', response: 'r', revision: 1 } }
      }
    };
    expect(withoutAnswers(prev)).toEqual({ t: 1 });
    expect(withAnswersOf({ t: 2, answers: { forged: {} } } as Record<string, unknown>, prev)).toEqual({
      t: 2,
      answers: prev.answers
    });
    expect(withAnswersOf({ t: 2 }, { t: 1 })).toEqual({ t: 2 });
    const next = withFormAnswer(
      prev,
      'other',
      { ok: ['a', 'b'], $answered: 'forged' } as Record<string, string | string[]>,
      {
        at: 'b',
        by: null,
        link: null,
        response: 'r2',
        revision: 3
      }
    );
    expect(answersOf(next)).toEqual([
      {
        form: 'gate',
        fields: { d: 'yes' },
        meta: { at: 'a', by: 'romain', link: 'l', response: 'r', revision: 1 }
      },
      {
        form: 'other',
        fields: { ok: ['a', 'b'] },
        meta: { at: 'b', by: null, link: null, response: 'r2', revision: 3 }
      }
    ]);
    expect(answersOf({ answers: { bad: 1, worse: { $answered: {} } } })).toEqual([]);
  });
});

describe('unsafePatternsOf', () => {
  it('names the nested repetitions, at their place, in pattern and patternProperties', () => {
    const out = unsafePatternsOf({
      version: '1',
      type: 'object',
      properties: { a: { pattern: '^(a+)+$' }, b: { pattern: '^[a-z]+$' } },
      patternProperties: { '^(x*)*$': { type: 'string' }, '^k_': { type: 'string' } },
      $defs: { d: { items: { pattern: '(\\d+)*' } } }
    });
    expect(out.map((u) => u.at)).toEqual([
      '/properties/a/pattern',
      '/patternProperties',
      '/$defs/d/items/pattern'
    ]);
  });

  it('is quiet on a plain schema', () => {
    expect(unsafePatternsOf({ version: '1', properties: { a: { pattern: '^\\w+@\\w+$' } } })).toEqual([]);
  });
});

describe('schemaShapeIssues (the PRDCT-3641 double check)', () => {
  it('names a keyword holding a value of the wrong shape, at its place', () => {
    const out = schemaShapeIssues({
      version: '1',
      type: 'object',
      required: 'title',
      properties: {
        title: { type: 'strin' },
        tags: { type: 'array', items: 5, minItems: -1 },
        meta: { $ref: '#/$defs/nope' }
      },
      $defs: { ok: { type: ['string', 'null'] } },
      anyOf: []
    });
    expect(out.map((i) => i.at)).toEqual([
      '/required',
      '/properties/title/type',
      '/properties/tags/minItems',
      '/properties/tags/items',
      '/properties/meta/$ref',
      '/anyOf'
    ]);
    expect(out[1]!.message).toContain('"strin" is not a JSON Schema type');
  });

  it('is quiet on a valid schema, annotations and a resolvable $ref included', () => {
    expect(
      schemaShapeIssues({
        $id: 'https://example.com/lane',
        version: '1',
        type: 'object',
        'x-owner': { anything: [1, 2] },
        properties: {
          title: { type: 'string', pattern: '^[A-Z]', maxLength: 80 },
          ticket: { $ref: '#/$defs/ticket' },
          tickets: { type: 'array', items: { $ref: '#/$defs/ticket' }, uniqueItems: true }
        },
        required: ['title'],
        additionalProperties: false,
        $defs: { ticket: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } }
      })
    ).toEqual([]);
  });

  it('keeps the array form of items for a schema that declares draft-07', () => {
    const draft7 = {
      $schema: 'http://json-schema.org/draft-07/schema#',
      version: '1',
      properties: { pair: { items: [{ type: 'string' }, { type: 'number' }] } }
    };
    expect(schemaShapeIssues(draft7)).toEqual([]);
    const { $schema: _draft, ...defaultDraft } = draft7;
    expect(schemaShapeIssues(defaultDraft).map((i) => i.at)).toEqual(['/properties/pair/items']);
  });
});

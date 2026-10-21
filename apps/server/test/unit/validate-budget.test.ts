import { afterAll, describe, expect, it } from 'vitest';
import { ValidationBudget } from '../../src/documents/validate-budget.js';

/**
 * The time budget on a schema's patterns (PRDCT-3641, verifier round 3, F7):
 * a slow pattern is killed with its worker, the next job gets a fresh one,
 * and a quick job answers the validator's own issues.
 */
describe('ValidationBudget', () => {
  const budget = new ValidationBudget(150);
  afterAll(() => budget.close());

  it('answers a quick validation with its issues', async () => {
    const out = await budget.validate({ type: 'object', properties: { a: { type: 'string' } } }, { a: 1 });
    expect(out).toEqual({
      ok: true,
      value: [{ path: '/a', message: 'Instance type "number" is invalid. Expected "string".' }]
    });
  });

  it('kills a validation over the budget and names the budget, then serves the next job', async () => {
    const slow = await budget.validate(
      { type: 'object', properties: { a: { type: 'string', pattern: '^(a|a)*$' } } },
      { a: 'a'.repeat(34) + '!' }
    );
    expect(slow).toMatchObject({ ok: false, reason: 'timeout' });
    expect((slow as { message: string }).message).toContain('150 ms');
    const quick = await budget.validate({ type: 'object' }, {});
    expect(quick).toEqual({ ok: true, value: [] });
  });

  it('extracts a page\u2019s bindings, and reports a parse error, through the same worker', async () => {
    const ok = await budget.extract('<h1>{{title}}</h1>', { properties: { title: {} } }, 'index.html');
    expect(ok).toMatchObject({ ok: true, value: { extracted: { bound: ['title'], unknown: [] } } });
    const bad = await budget.extract('{{#x}}', {}, 'index.html');
    expect(bad).toMatchObject({ ok: true, value: { errors: [{ file: 'index.html', line: 1 }] } });
  });
});

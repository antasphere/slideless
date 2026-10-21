import { afterAll, describe, expect, it } from 'vitest';
import { ValidationBudget } from '../../src/documents/validate-budget.js';

/**
 * The time budget on a schema's patterns (PRDCT-3641, verifier round 3, F7):
 * a slow pattern is killed with its worker, the next job gets a fresh one,
 * and a quick job answers the validator's own issues.
 */
describe('ValidationBudget', () => {
  // Two seats, a 150 ms budget: the cold start (the contract import, round 4's F1) is paid
  // by the warm-up, never by a job, so the budget judges the pattern alone.
  const budget = new ValidationBudget(150, 2);
  afterAll(() => budget.close());

  it('warms its seats ahead of the first job, and a cold start never counts against a job', async () => {
    const t0 = Date.now();
    await budget.warm();
    const warmed = Date.now() - t0;
    const t1 = Date.now();
    const out = await budget.validate({ type: 'object' }, {});
    expect(out).toEqual({ ok: true, value: [] });
    expect(Date.now() - t1).toBeLessThan(150);
    expect(warmed).toBeGreaterThanOrEqual(0);
  });

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
    // The replacement seat is warmed in the background: the next honest job is judged on the
    // pattern alone, never on the import (round 4's F1). The warm-up itself is awaited here so
    // the timing below measures the job, whatever the machine's load.
    await budget.warm();
    const t0 = Date.now();
    const quick = await budget.validate(
      { type: 'object', properties: { a: { type: 'string', pattern: '^[a-z]+$' } } },
      { a: 'abc' }
    );
    expect(quick).toEqual({ ok: true, value: [] });
    expect(Date.now() - t0).toBeLessThan(150);
  });

  it('a slow job holds one seat only: a quick job beside it answers at once', async () => {
    await budget.warm();
    const slow = budget.validate(
      { type: 'object', properties: { a: { type: 'string', pattern: '^(a|a)*$' } } },
      { a: 'a'.repeat(34) + '!' }
    );
    const t0 = Date.now();
    const quick = await budget.validate({ type: 'object' }, {});
    const quickMs = Date.now() - t0;
    expect(quick).toEqual({ ok: true, value: [] });
    expect(quickMs).toBeLessThan(150);
    expect(await slow).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('extracts a page\u2019s bindings, and reports a parse error, through the same worker', async () => {
    const ok = await budget.extract('<h1>{{title}}</h1>', { properties: { title: {} } }, 'index.html');
    expect(ok).toMatchObject({ ok: true, value: { extracted: { bound: ['title'], unknown: [] } } });
    const bad = await budget.extract('{{#x}}', {}, 'index.html');
    expect(bad).toMatchObject({ ok: true, value: { errors: [{ file: 'index.html', line: 1 }] } });
  });
});

describe('ValidationBudget, one seat', () => {
  it('a job waiting behind a job that dies gets the replacement seat (round 5, F4)', async () => {
    const one = new ValidationBudget(150, 1);
    try {
      await one.warm();
      const slow = one.validate(
        { type: 'object', properties: { a: { type: 'string', pattern: '^(a|a)*$' } } },
        { a: 'a'.repeat(34) + '!' }
      );
      const waiting = one.validate({ type: 'object' }, {});
      expect(await slow).toMatchObject({ ok: false, reason: 'timeout' });
      expect(await waiting).toEqual({ ok: true, value: [] });
    } finally {
      await one.close();
    }
  });

  it('close() tells the jobs still waiting, instead of leaving them hanging', async () => {
    const one = new ValidationBudget(150, 1);
    await one.warm();
    const slow = one.validate(
      { type: 'object', properties: { a: { type: 'string', pattern: '^(a|a)*$' } } },
      { a: 'a'.repeat(34) + '!' }
    );
    const waiting = one.validate({ type: 'object' }, {});
    await one.close();
    expect(await waiting).toMatchObject({ ok: false, reason: 'failed' });
    await slow;
  });
});

describe('ValidationBudget, the seat a job takes', () => {
  it('a job takes the warm idle seat, never the one still warming (round 6, F1)', async () => {
    const two = new ValidationBudget(150, 2);
    try {
      await two.warm();
      expect(two.inspect()).toEqual([
        { ready: true, busy: false },
        { ready: true, busy: false }
      ]);
      // A timeout kills one seat; its replacement is spawned at once and warms in the background.
      await two.validate(
        { type: 'object', properties: { a: { type: 'string', pattern: '^(a|a)*$' } } },
        { a: 'a'.repeat(34) + '!' }
      );
      const states = two.inspect();
      expect(states.filter((s) => s.ready)).toHaveLength(1);
      expect(states.filter((s) => !s.ready)).toHaveLength(1);
      // The next job is posted while one seat is warm and the other is warming: it must take the warm one.
      const job = two.validate({ type: 'object' }, {});
      await new Promise((r) => setImmediate(r));
      const taken = two.inspect().find((s) => s.busy);
      expect(taken).toEqual({ ready: true, busy: true });
      expect(await job).toEqual({ ok: true, value: [] });
    } finally {
      await two.close();
    }
  });
});

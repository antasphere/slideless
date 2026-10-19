import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { hashesOf, normalise } from './check-workflows.mjs';

const identity = { slug: 'yourtool', name: 'Your Tool' };

test('the identity words, the comments, the watched branches and the template-only block are set aside', () => {
  const template = `name: CI\n# a comment\non:\n  push:\n    branches: [main]\njobs:\n  a:\n    run: yourtool:smoke # trailing\n  # template-only:begin\n  proof:\n    run: pnpm instantiate\n  # template-only:end\n`;
  const tool = `name: CI\non:\n  push:\n    branches: [dev]\njobs:\n  a:\n    run: finance:smoke\n`;
  assert.equal(
    normalise(template, identity),
    normalise(tool, { slug: 'finance', name: 'Antasphere Finance' })
  );
});

test('a real difference is not set aside', () => {
  const a = `on:\n  push:\n    branches: [main]\n  pull_request:\njobs:\n  checks:\n    runs-on: ubuntu-latest\n`;
  const b = `on:\n  push:\n    branches: [main]\n  pull_request:\n  schedule:\n    - cron: '0 3 * * *'\njobs:\n  checks:\n    runs-on: ubuntu-latest\n`;
  assert.notEqual(normalise(a, identity), normalise(b, identity));
});

test('hashesOf reads a checkout: its identity and one hash per workflow file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workflows-guard-'));
  mkdirSync(join(dir, '.github/workflows'), { recursive: true });
  mkdirSync(join(dir, 'packages/contract/src'), { recursive: true });
  writeFileSync(
    join(dir, 'packages/contract/src/identity.ts'),
    `export const IDENTITY = { slug: 'acme', displayName: 'Acme Notes' };\n`
  );
  writeFileSync(join(dir, '.github/workflows/ci.yml'), `name: CI\njobs:\n  a:\n    run: acme:smoke\n`);
  writeFileSync(join(dir, '.github/workflows/notes.txt'), 'not a workflow');
  const hashes = hashesOf(dir);
  assert.deepEqual(Object.keys(hashes), ['.github/workflows/ci.yml']);
  assert.match(hashes['.github/workflows/ci.yml'], /^[0-9a-f]{64}$/);
});

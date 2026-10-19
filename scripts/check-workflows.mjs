#!/usr/bin/env node
// The workflow files are a COPY. `.github/workflows/*.yml` is the template's CI and
// release machinery with the identity words changed, and a tool never edits it on its
// own: a change the fleet needs is made in the template and copied again, so every
// tool runs its CI the same way and no tool drifts back to a shape that tests the
// same tree four times (PRDCT-3592).
//
//   node scripts/check-workflows.mjs            fails when a workflow file differs from the record
//   node scripts/check-workflows.mjs --write --repo <owner/name> --sha <sha> [--source <dir>]
//                                               records a fresh copy (run right after copying)
//   node scripts/check-workflows.mjs --diff --source <dir>
//                                               compares the files with a template checkout
//
// Like the dashboard shell (check-shell-copies.mjs), the files cannot be held byte for
// byte: the identity words are the tool's own, the branch a tool's CI watches is dev
// where the template's is main, and the template-only block of ci.yml leaves with
// `pnpm instantiate`. So the record holds one sha256 per file of a NORMALISED form:
// comments stripped, the identity words replaced by placeholders, the watched branches
// line and the template-only block set aside, every run of white space collapsed.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.env.WORKFLOWS_GUARD_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), '..');
const recordPath = join(root, 'workflows-source.json');
const DIR = '.github/workflows';
const IDENTITY_FILE = 'packages/contract/src/identity.ts';

/** The identity words of a checkout, read from its contract (the slug, the display name). */
export function identityOf(dir) {
  const src = readFileSync(join(dir, IDENTITY_FILE), 'utf8');
  const slug = /slug:\s*'([^']+)'/.exec(src)?.[1];
  const name = /displayName:\s*'([^']+)'/.exec(src)?.[1];
  if (!slug || !name) throw new Error(`${IDENTITY_FILE} names no slug or displayName`);
  return { slug, name };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The normalised form of one workflow file: the template-only block gone, the
 * comment lines gone, the identity words placeholders, the watched branches line a
 * placeholder, white space collapsed.
 */
export function normalise(text, { slug, name }) {
  let out = text.replace(/^\s*#\s*template-only:begin[\s\S]*?#\s*template-only:end[^\n]*\n?/m, '');
  out = out
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');
  out = out.replace(/^(\s*branches:\s*)\[[^\]]*\]/gm, '$1[__branches__]');
  const words = [
    [name, '__name__'],
    [slug.charAt(0).toUpperCase() + slug.slice(1), '__Slug__'],
    [slug, '__slug__'],
    [slug.toUpperCase(), '__SLUG__']
  ];
  for (const [word, placeholder] of words) out = out.replace(new RegExp(escape(word), 'g'), placeholder);
  return out.replace(/\s+/g, ' ').trim();
}

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

/** The workflow files of a checkout and the normalised hash of each. */
export function hashesOf(dir) {
  const identity = identityOf(dir);
  const files = readdirSync(join(dir, DIR))
    .filter((f) => f.endsWith('.yml'))
    .sort();
  return Object.fromEntries(
    files.map((f) => [`${DIR}/${f}`, sha256(normalise(readFileSync(join(dir, DIR, f), 'utf8'), identity))])
  );
}

function readRecord() {
  if (!existsSync(recordPath))
    throw new Error(`${recordPath} is missing: run --write after copying the workflows`);
  return JSON.parse(readFileSync(recordPath, 'utf8'));
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const here = hashesOf(root);
  if (argv.includes('--write')) {
    const repo = arg('--repo');
    const sha = arg('--sha');
    if (!repo || !sha)
      throw new Error(
        '--write needs --repo <owner/name> and --sha <sha>: the template commit the files were copied from'
      );
    const source = arg('--source');
    if (source) {
      const theirs = hashesOf(resolve(source));
      const differ = Object.keys(here).filter((f) => theirs[f] !== here[f]);
      if (differ.length)
        throw new Error(
          `these files differ from the source checkout, copy them first:\n  ${differ.join('\n  ')}`
        );
    }
    writeFileSync(recordPath, `${JSON.stringify({ template: { repo, sha }, files: here }, null, 2)}\n`);
    console.log(`workflows: recorded ${Object.keys(here).length} files from ${repo}@${sha.slice(0, 7)}`);
    return 0;
  }
  if (argv.includes('--diff')) {
    const source = arg('--source');
    if (!source) throw new Error('--diff needs --source <dir>: a checkout of the template');
    const theirs = hashesOf(resolve(source));
    const names = [...new Set([...Object.keys(here), ...Object.keys(theirs)])].sort();
    let differ = 0;
    for (const f of names) {
      const state = !here[f]
        ? 'missing here'
        : !theirs[f]
          ? 'not in the source'
          : here[f] === theirs[f]
            ? 'same'
            : 'DIFFERENT';
      if (state !== 'same') differ += 1;
      console.log(`${state.padEnd(16)} ${f}`);
    }
    return differ ? 1 : 0;
  }
  const record = readRecord();
  const problems = [];
  for (const [f, hash] of Object.entries(record.files)) {
    if (!here[f]) problems.push(`${f}: in the record, not in the tree`);
    else if (here[f] !== hash)
      problems.push(
        `${f}: differs from the record (${record.template.repo}@${record.template.sha.slice(0, 7)})`
      );
  }
  for (const f of Object.keys(here))
    if (!record.files[f]) problems.push(`${f}: in the tree, not in the record`);
  if (problems.length) {
    console.error(
      `workflows: ${problems.length} file(s) drifted from the template's record. A workflow change is made in the template and copied here, then \`pnpm workflows:check --write --repo ${record.template.repo} --sha <sha>\`.\n  ${problems.join('\n  ')}`
    );
    return 1;
  }
  console.log(
    `workflows: ${Object.keys(here).length} files match ${record.template.repo}@${record.template.sha.slice(0, 7)} after normalisation`
  );
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main());
  } catch (err) {
    console.error(`workflows: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

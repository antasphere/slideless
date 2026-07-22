/**
 * Generates docs/reference/env-reference.md from the zod env schema (the single
 * configuration entry point). Types/defaults/required come from schema
 * introspection; prose comes from the doc comment above each key in
 * env.ts — so the reference cannot drift from the code that parses the
 * environment. Run: pnpm --filter @slideless/server docs:env
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { envSchema } from '../src/env.js';

const here = dirname(fileURLToPath(import.meta.url));
const envSource = await readFile(join(here, '../src/env.ts'), 'utf8');

/** Doc comment IMMEDIATELY preceding `KEY:` in env.ts (never spans other comments). */
function docFor(key: string): string {
  const re = new RegExp(String.raw`/\*\*((?:(?!\*/)[\s\S])*)\*/\s*\n\s*${key}:`, 'm');
  const match = re.exec(envSource);
  if (!match) return '';
  return (match[1] ?? '')
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter(Boolean)
    .join(' ');
}

interface Row {
  key: string;
  type: string;
  required: boolean;
  default: string;
  description: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function describeType(schema: any): { type: string; required: boolean; default: string } {
  let node = schema;
  let required = true;
  let def = '';

  for (let i = 0; i < 6; i++) {
    const t = node?.def?.type ?? node?._def?.type;
    if (t === 'default') {
      const dv = node.def.defaultValue;
      const v = typeof dv === 'function' ? dv() : dv;
      def = JSON.stringify(v) ?? '';
      required = false;
      node = node.def.innerType;
    } else if (t === 'optional' || t === 'nullable') {
      required = false;
      node = node.def.innerType;
    } else if (t === 'pipe') {
      // preprocess/transform: describe the parsing side
      node = node.def.out ?? node.def.in;
    } else {
      break;
    }
  }

  const t = node?.def?.type ?? 'string';
  let type = String(t);
  if (t === 'enum') {
    const values = node.def.entries ? Object.keys(node.def.entries) : (node.def.values ?? []);
    type = values.map((v: string) => `\`${v}\``).join(' \\| ');
  } else if (t === 'literal') {
    type = `\`${node.def.values?.[0] ?? ''}\``;
  } else if (t === 'transform' || t === 'unknown') {
    type = 'string';
  }
  return { type, required, default: def.replaceAll('"', '') };
}

const rows: Row[] = Object.entries(envSchema.shape).map(([key, schema]) => {
  const info = describeType(schema);
  return { key, ...info, description: docFor(key) };
});

const required = rows.filter((r) => r.required);
const optional = rows.filter((r) => !r.required);

const table = (rs: Row[]) =>
  [
    '| Variable | Type | Default | Description |',
    '|---|---|---|---|',
    ...rs.map(
      (r) => `| \`${r.key}\` | ${r.type} | ${r.default ? `\`${r.default}\`` : '—'} | ${r.description} |`
    )
  ].join('\n');

const out = `# Environment reference

Generated from the zod env schema (\`apps/server/src/env.ts\`) — do not edit
by hand; run \`pnpm --filter @slideless/server docs:env\` after changing the
schema. The app refuses to boot on an invalid environment and prints a
readable table of problems.

## Required

${table(required)}

## Optional

${table(optional)}
`;

await writeFile(join(here, '../../../docs/reference/env-reference.md'), out);
console.log(`env reference written: ${rows.length} variables (${required.length} required)`);

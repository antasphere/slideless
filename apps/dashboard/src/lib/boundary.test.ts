import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The line between the dashboard's two halves (PRDCT-2532): the shell every
 * Antasphere tool shares, and the tool's own half. The tool's half imports
 * the shell freely. The shell never imports the tool's half, with two doors:
 *
 *   - `$lib/tool`       what the tool gives the shell (`$lib/contribution.ts`);
 *   - `$lib/tool/i18n`  the tool's words, for `$lib/i18n` alone to merge.
 *
 * This test walks the source and fails on any other import from a shell file
 * into the tool's half, so taking the tool out stays a matter of folders.
 */

const SRC = join(import.meta.dirname, '..');

/** The tool's half, as paths under src/ (a trailing slash: folders). */
const TOOL_PATHS = ['lib/tool/', 'routes/(app)/(tool)/', 'routes/(present)/', 'routes/collab/'];

/** The doors, as the specifier a shell file writes, and who may write it. */
const DOORS: { specifier: string; from: (file: string) => boolean }[] = [
  { specifier: '$lib/tool', from: () => true },
  { specifier: '$lib/tool/i18n', from: (file) => file === 'lib/i18n/index.ts' }
];

const posix = (p: string) => p.split(sep).join('/');
const inTool = (file: string) => TOOL_PATHS.some((p) => file.startsWith(p));

/**
 * Any quoted text that names the tool's half, whatever reads it: a glob, a
 * template literal, `require`, an absolute `/src/...` path, a `url()` in a
 * style. The specifier patterns below cannot see these forms, so every string
 * of the code is looked at (comments are skipped: prose may name the tool's
 * half). Only a path assembled from pieces at run time escapes, and nothing
 * in the shell builds import paths that way.
 */
const NAMES_THE_TOOL =
  /(^|\/)lib\/tool(\/|$)|^\$lib\/(\.\/)?tool(\/|$)|\(tool\)\/|\(present\)\/|(^|\/)routes\/collab\//;
// one pass, leftmost first: a comment, or a string on one line
const COMMENT_OR_STRING = /\/\/.*$|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->|(['"`])((?:(?!\1)[^\\\n]|\\.)*)\1/gm;
export function toolPathsIn(file: string, source: string): string[] {
  const found: string[] = [];
  for (const m of source.matchAll(COMMENT_OR_STRING)) {
    if (m[1] === undefined) continue;
    const text = m[2].replace(/\$\{[^}]*\}/g, '');
    if (NAMES_THE_TOOL.test(text) || landsInTool(file, text)) found.push(m[2]);
  }
  for (const m of source.matchAll(/url\(\s*([^'"`)\s]+)\s*\)/g)) {
    if (NAMES_THE_TOOL.test(m[1])) found.push(m[1]);
  }
  return found;
}

/** Every module specifier a source names: static, side-effect, dynamic, re-export, and vi.mock. */
export function specifiersOf(source: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/g,
    /\bvi\.(?:mock|doMock|importActual)\s*\(\s*['"]([^'"]+)['"]/g
  ];
  for (const pattern of patterns) for (const m of source.matchAll(pattern)) found.push(m[1]);
  return found;
}

/** Where a specifier lands under src/, or null when it leaves it (a package, `$app/…`). */
export function landing(file: string, specifier: string): string | null {
  if (specifier === '$lib' || specifier.startsWith('$lib/')) return posix(join('lib', specifier.slice(5)));
  if (specifier.startsWith('.')) return posix(relative(SRC, resolve(SRC, dirname(file), specifier)));
  return null;
}

/** A relative path, a glob included (`./tool/**`), that lands in the tool's half. */
function landsInTool(file: string, text: string): boolean {
  if (!text.startsWith('.')) return false;
  const target = landing(file, text.split('*')[0]);
  return target !== null && (inTool(target) || inTool(target + '/'));
}

/** What is wrong with one shell file's imports: one line per crossing. */
export function crossings(file: string, source: string): string[] {
  const out: string[] = [];
  for (const specifier of specifiersOf(source)) {
    const target = landing(file, specifier);
    // `lib/tool` itself (the door's folder) counts as the tool's half too
    if (target === null || !(inTool(target + '/') || inTool(target))) continue;
    const door = DOORS.find((d) => d.specifier === specifier);
    if (door?.from(file)) continue;
    out.push(`${file} imports ${specifier}`);
  }
  // the forms no specifier pattern sees: any other string of the code that names the tool's half
  for (const text of toolPathsIn(file, source)) {
    const door = DOORS.find((d) => d.specifier === text);
    if (door?.from(file)) continue;
    const line = `${file} names ${text}`;
    if (!out.includes(`${file} imports ${text}`) && !out.includes(line)) out.push(line);
  }
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return /\.(ts|js|svelte)$/.test(entry.name) ? [posix(relative(SRC, path))] : [];
  });
}

describe('the shell never imports the tool’s half', () => {
  const files = walk(SRC);

  it('finds both halves where this test says they are', () => {
    // A tool that brings pages has them where TOOL_PATHS says; a dashboard
    // with no tool yet keeps the two doors and nothing else, and still passes.
    const hasTool = files.some((f) => f.startsWith('lib/tool/components/'));
    for (const path of hasTool ? TOOL_PATHS : ['lib/tool/'])
      expect(
        files.some((f) => f.startsWith(path)),
        path
      ).toBe(true);
    expect(files).toContain('lib/tool/index.ts');
    expect(files).toContain('lib/tool/i18n/index.ts');
    expect(files.filter((f) => !inTool(f)).length).toBeGreaterThan(100);
  });

  it('no shell file reaches past the two doors', () => {
    const found = files
      // this file's own examples of a crossing are strings, not imports
      .filter((f) => !inTool(f) && f !== 'lib/boundary.test.ts')
      .flatMap((f) => crossings(f, readFileSync(join(SRC, f), 'utf8')));
    expect(found).toEqual([]);
  });

  it('goes red on a crossing, whatever its form', () => {
    const shell = 'routes/(app)/members/+page.svelte';
    expect(
      crossings(shell, `import DeckCard from '$lib/tool/components/decks/DeckCard.svelte';`)
    ).toHaveLength(1);
    expect(crossings(shell, `import { kindLabel } from '$lib/tool/decks';`)).toHaveLength(1);
    expect(crossings(shell, `const m = await import('$lib/tool/references');`)).toHaveLength(1);
    expect(crossings(shell, `import x from '../(tool)/decks/+page.svelte';`)).toHaveLength(1);
    expect(crossings('lib/nav.ts', `import { en } from './tool/i18n/en';`)).toHaveLength(1);
    expect(crossings('lib/nav.test.ts', `vi.mock('$lib/tool/decks');`)).toHaveLength(1);
    // the words' door is the i18n module's alone
    expect(crossings('lib/nav.ts', `import { en } from '$lib/tool/i18n';`)).toHaveLength(1);
  });

  it('goes red on the forms that are not an import statement', () => {
    const shell = 'lib/nav.ts';
    const forms = [
      'const m = await import(`$lib/tool/${name}`);',
      "const all = import.meta.glob('$lib/tool/**/*.ts');",
      "const all = import.meta.glob('./tool/**', { eager: true });",
      "const all = import.meta.glob('/src/lib/tool/**');",
      "const path = '$lib/tool/decks'; const m = await import(path);",
      "const m = require('$lib/tool/decks');",
      "const p = require.resolve('../lib/tool/decks');",
      "import x from '/src/lib/tool/decks';",
      "import x from 'src/lib/tool/decks';",
      "const page = import.meta.glob('/src/routes/(app)/(tool)/decks/+page.svelte');",
      '<style>.a { background: url(/src/lib/tool/art.svg); }</style>',
      "<style>.a { background: url('/src/routes/collab/art.svg'); }</style>"
    ];
    for (const form of forms) expect(crossings(shell, form), form).not.toEqual([]);
  });

  it('reads code, not prose', () => {
    expect(crossings('lib/nav.ts', "// the tool's half lives in '$lib/tool/decks'\nconst a = 1;")).toEqual(
      []
    );
    expect(
      crossings('lib/nav.ts', "/** see `src/lib/tool/index.ts` */\nconst a = 'https://x.test/y';")
    ).toEqual([]);
    expect(crossings('routes/+layout.svelte', "<!-- '/src/lib/tool/' -->\n<p>tool</p>")).toEqual([]);
  });

  it('lets the doors through, and the shell’s own imports', () => {
    expect(crossings('lib/nav.ts', `import { tool } from '$lib/tool';`)).toEqual([]);
    expect(crossings('lib/i18n/index.ts', `import { en } from '$lib/tool/i18n';`)).toEqual([]);
    expect(crossings('lib/nav.ts', `import { t } from '$lib/i18n';\nimport x from './tooling';`)).toEqual([]);
  });
});

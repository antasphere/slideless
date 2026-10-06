import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';
import { routedHarness } from './harness.js';

/**
 * The agent skills in `plugin/` teach the CLI by name: every `slideless …`
 * invocation and every `--flag` a skill shows must exist in the command tree,
 * or an agent learns a command the CLI refuses. The mirror of
 * docs-coverage.test.ts (PRDCT-2309): there the reference must be complete,
 * here a skill must be true. The tree is the truth in both.
 *
 * Only fenced code blocks are read: prose may name a verb in a sentence, a
 * code block is what an agent copies.
 */

const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../plugin');

interface Tree {
  commands: Set<string>;
  /** The commands that are groups (they have subcommands): `brand`, `files`, `workspace`. */
  groups: Set<string>;
  /** Long flags per command path; the global flags under `(global)`. */
  flags: Map<string, Set<string>>;
}

function walk(cmd: Command, path: string[], out: Tree): void {
  const here = path.join(' ') || '(global)';
  if (here !== '(global)') out.commands.add(here);
  if (here !== '(global)' && cmd.commands.length > 0) out.groups.add(here);
  const set = out.flags.get(here) ?? new Set<string>();
  for (const opt of cmd.options) if (opt.long) set.add(opt.long);
  out.flags.set(here, set);
  for (const sub of cmd.commands) walk(sub, [...path, sub.name()], out);
}

function tree(): Tree {
  const out: Tree = { commands: new Set(), groups: new Set(), flags: new Map() };
  walk(buildProgram(routedHarness([]).io), [], out);
  return out;
}

function markdownFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...markdownFiles(p));
    else if (name.endsWith('.md')) out.push(p);
  }
  return out;
}

interface Invocation {
  file: string;
  line: string;
  path: string;
  flags: string[];
}

/** Every `slideless …` line inside a fenced block, as a command path plus its long flags. */
function invocations(file: string, text: string): Invocation[] {
  const out: Invocation[] = [];
  let inFence = false;
  for (const raw of text.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const m = raw.match(/(?:^|[\s$(|])slideless\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/);
    if (!m) continue;
    const first = m[1]!;
    const second = m[2] && !m[2].startsWith('-') ? m[2] : undefined;
    const flags = [...raw.matchAll(/(?:^|\s)(--[a-z][a-z-]*)/g)].map((f) => f[1]!);
    out.push({ file, line: raw.trim(), path: second ? `${first} ${second}` : first, flags });
  }
  return out;
}

describe('the plugin skills name only commands and flags the CLI has', () => {
  const t = tree();
  const files = markdownFiles(join(PLUGIN_DIR, 'skills'));
  const all = files.flatMap((f) => invocations(f, readFileSync(f, 'utf8')));

  it('reads at least one skill', () => {
    expect(files.length).toBeGreaterThan(0);
    expect(all.length).toBeGreaterThan(0);
  });

  it('every invocation is a command the CLI defines', () => {
    const stale = all.filter(({ path }) => {
      if (t.commands.has(path)) return false;
      // A two-word path under a leaf command is a command plus an argument
      // (`slideless get <id>` matches `get`). Under a GROUP the second word
      // must be one of its subcommands: `slideless brand frobnicate` is stale.
      const [first] = path.split(' ');
      return !(path.includes(' ') && t.commands.has(first!) && !t.groups.has(first!));
    });
    expect(
      stale.map((s) => `${s.file.replace(PLUGIN_DIR, 'plugin')}: ${s.line}`),
      'commands shown in a skill that the CLI does not define'
    ).toEqual([]);
  });

  it('every flag exists on that command or globally', () => {
    const global = t.flags.get('(global)') ?? new Set<string>();
    const bad: string[] = [];
    for (const inv of all) {
      // Resolve the command the flags belong to: the full path when the tree
      // has it, else the first word (the second was an argument; a stale
      // group path is already reported by the test above).
      const cmd = t.commands.has(inv.path) ? inv.path : inv.path.split(' ')[0]!;
      const own = t.flags.get(cmd) ?? new Set<string>();
      for (const flag of inv.flags) {
        if (!own.has(flag) && !global.has(flag))
          bad.push(`${inv.file.replace(PLUGIN_DIR, 'plugin')}: ${flag} on \`slideless ${cmd}\``);
      }
    }
    expect(bad, 'flags shown in a skill that the command does not take').toEqual([]);
  });
});

describe('the plugin manifests', () => {
  it('are byte-identical between .plugin and .claude-plugin', () => {
    const a = readFileSync(join(PLUGIN_DIR, '.plugin/plugin.json'), 'utf8');
    const b = readFileSync(join(PLUGIN_DIR, '.claude-plugin/plugin.json'), 'utf8');
    expect(a).toBe(b);
  });

  it('name the plugin the marketplace entry points at', () => {
    const plugin = JSON.parse(readFileSync(join(PLUGIN_DIR, '.plugin/plugin.json'), 'utf8')) as {
      name: string;
    };
    const marketplace = JSON.parse(
      readFileSync(join(PLUGIN_DIR, '../.claude-plugin/marketplace.json'), 'utf8')
    ) as {
      plugins: Array<{ name: string; source: string }>;
    };
    const entry = marketplace.plugins.find((p) => p.source === './plugin');
    expect(entry?.name).toBe(plugin.name);
  });

  it('every skill has a frontmatter with a name and a description', () => {
    const skills = readdirSync(join(PLUGIN_DIR, 'skills'));
    expect(skills.length).toBeGreaterThan(0);
    for (const s of skills) {
      const text = readFileSync(join(PLUGIN_DIR, 'skills', s, 'SKILL.md'), 'utf8');
      const fm = text.match(/^---\n([\s\S]*?)\n---\n/);
      expect(fm, `${s}/SKILL.md has a frontmatter`).not.toBeNull();
      expect(fm![1]).toMatch(new RegExp(`^name: ${s}$`, 'm'));
      expect(fm![1]).toMatch(/^description: .{40,}/m);
    }
  });
});

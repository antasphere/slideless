import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Command } from 'commander';
import { describe, expect, it } from 'vitest';
import { buildProgram } from '../src/index.js';
import { routedHarness } from './harness.js';

/**
 * PRDCT-2309: the CLI reference (docs/agents/cli.md) is what an agent reads
 * to learn the tool, so it must name every command and every flag the
 * command tree defines — and name no command the tree does not have. The
 * tree is the truth: a flag added in code without a line in the reference
 * fails here, by name, and so does a stale command left in a code block.
 *
 * The check is presence, not prose: a flag counts as documented when its
 * long form (`--no-bar`) appears anywhere in the page, and a command when
 * its full path (`files download`, `auth login-complete`) does. Wording is
 * the reader's business (the workstream's verifier), completeness is this
 * test's.
 */

const DOC_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/agents/cli.md');

interface Surface {
  /** Full command paths: `push`, `auth login-complete`, `files download`. */
  commands: string[];
  /** Long flags per command path, `--flag` only (short aliases are extras). */
  flags: Array<{ command: string; flag: string }>;
}

function walk(cmd: Command, path: string[], out: Surface): void {
  const here = path.join(' ');
  if (here) out.commands.push(here);
  for (const opt of cmd.options) {
    if (opt.long) out.flags.push({ command: here || '(global)', flag: opt.long });
  }
  for (const sub of cmd.commands) walk(sub, [...path, sub.name()], out);
}

function surface(): Surface {
  const out: Surface = { commands: [], flags: [] };
  walk(buildProgram(routedHarness([]).io), [], out);
  return out;
}

/** The `slideless …` invocations the page's bash blocks show, as command paths. */
function documentedInvocations(doc: string): string[] {
  const paths = new Set<string>();
  let inFence = false;
  for (const raw of doc.split('\n')) {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) continue;
    const m = raw.match(/(?:^|[\s$(|])slideless\s+([a-z][a-z-]*)(?:\s+([a-z][a-z-]*))?/);
    if (!m) continue;
    // A word that is an argument, a flag or a shell token is not a subcommand.
    const first = m[1]!;
    const second = m[2] && !m[2].startsWith('-') ? m[2] : undefined;
    paths.add(first);
    if (second) paths.add(`${first} ${second}`);
  }
  return [...paths];
}

describe('docs/agents/cli.md covers the command tree (PRDCT-2309)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const tree = surface();

  it('names every command, by its full path', () => {
    const missing = tree.commands.filter(
      (c) => !new RegExp(`(^|[^a-z-])${c.replace(/ /g, '\\s+')}([^a-z-]|$)`, 'm').test(doc)
    );
    expect(missing, `commands defined by the CLI but absent from cli.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('names every long flag', () => {
    const missing = tree.flags.filter(({ flag }) => !doc.includes(flag));
    expect(
      missing.map(({ command, flag }) => `${command}: ${flag}`),
      'flags defined by the CLI but absent from cli.md'
    ).toEqual([]);
  });

  it('shows no command the CLI does not have', () => {
    const known = new Set(tree.commands);
    // A two-word path is a subcommand only when the tree says so; otherwise
    // the second word was an argument (`slideless get <id>` matches `get`).
    const stale = documentedInvocations(doc).filter((p) => {
      if (known.has(p)) return false;
      const [first] = p.split(' ');
      return !(p.includes(' ') && known.has(first!));
    });
    expect(stale, `commands shown in cli.md that the CLI does not define: ${stale.join(', ')}`).toEqual([]);
  });

  it('the tree is the one the reference is written for (a sanity floor)', () => {
    // Every command family the reference has sections for exists; a rename
    // in code lands here before it lands on an agent.
    for (const c of [
      'push',
      'open',
      'pull',
      'share',
      'share-email',
      'pin',
      'tokens',
      'auth login-complete',
      'files download'
    ]) {
      expect(tree.commands, `expected command ${c}`).toContain(c);
    }
    expect(tree.flags.length).toBeGreaterThan(40);
  });
});

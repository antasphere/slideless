import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * The dashboard's tasks and SvelteKit's generated files (PRDCT-5175).
 *
 * Every SvelteKit sync, `svelte-kit sync` or the one `vite build` runs in its config hook, deletes
 * and rewrites part of `.svelte-kit/types` (the root route's files and `route_meta_data.json`, every
 * time), and the type check and the tests read that folder and the generated `tsconfig.json`. Two
 * of them at once failed CI at random on 25 November 2026: `ENOENT … proxy+layout.ts` in the
 * build, `Unexpected end of JSON input` in the type check. So a task that writes there must be
 * ordered against every other task that writes or reads there, never beside it. svelte-check
 * writes one file of its own at its start, `.svelte-kit/env.d.ts`, which no task beside it reads.
 *
 * The graph read is the one turbo will run (`--dry=json`), never the config files: a package's
 * `turbo.json` replaces the root's entries for that package, which is how a sync step added at the
 * root in September never ordered the build. What a task runs is its script with the `pre` and
 * `post` scripts pnpm runs around it, read from the dashboard's `package.json`. The rules over
 * commands and config are a heuristic over the common spellings; AGENTS.md says what escapes them.
 */

const DASHBOARD = import.meta.dirname;
const ROOT = join(DASHBOARD, '..', '..');
const PKG = '@slideless/dashboard';

type DryTask = {
  taskId: string;
  task: string;
  package: string;
  command: string;
  dependencies: string[];
  resolvedTaskDefinition: { cache: boolean };
};

function dashboardGraph(): DryTask[] {
  const out = execFileSync(
    join(ROOT, 'node_modules', '.bin', 'turbo'),
    ['run', 'lint', 'typecheck', 'test', 'build', `--filter=${PKG}`, '--dry=json'],
    // A turbo that hangs fails the suite after two minutes instead of holding the gate.
    { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, maxBuffer: 64 << 20 }
  );
  return (JSON.parse(out).tasks as DryTask[]).filter((t) => t.package === PKG);
}

const scripts: Record<string, string> = JSON.parse(
  readFileSync(join(DASHBOARD, 'package.json'), 'utf8')
).scripts;

/** What pnpm runs for a script: its `pre` script, the script itself, its `post` script. */
const around = (name: string, command: string) =>
  [scripts[`pre${name}`], command, scripts[`post${name}`]].filter(Boolean).join(' && ');

/** Flags of a package manager that take the next word as their value. */
const VALUED = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--workspace']);

/**
 * A command with every call to another script of the dashboard (`pnpm run prepare`, `pnpm -s x`,
 * `npm run x`, `pnpm --filter=@app/dashboard x`) replaced by what that script runs, so a sync cannot
 * hide behind a name; a call filtered to another package is left as it is.
 */
const expand = (command: string, depth = 0): string =>
  depth > 5
    ? command
    : command
        .split(/(&&|\|\||;|\|)/)
        .map((part) => {
          const words = part.trim().split(/\s+/);
          let i = words.findIndex((w) => /^(?:pnpm|npm|yarn|bun)$/.test(w));
          if (i < 0) return part;
          let filter: string | undefined;
          for (i += 1; i < words.length; i += 1) {
            const w = words[i];
            if (w === 'run' || w === 'run-script') continue;
            if (!w.startsWith('-')) break;
            const [flag, value] = w.split('=', 2);
            const given = value ?? (VALUED.has(flag) ? words[++i] : undefined);
            if (flag === '--filter' || flag === '-F') filter = given;
          }
          const name = words[i];
          const ours = filter === undefined || filter === PKG || filter === '.' || filter === './';
          return ours && name && Object.prototype.hasOwnProperty.call(scripts, name)
            ? ` (${expand(around(name, scripts[name]), depth + 1)}) `
            : part;
        })
        .join('');

/** What a task runs, every script it reaches included. */
const runs = (t: DryTask) => expand(around(t.task, t.command));

/**
 * What a command does to `.svelte-kit`: a sync rewrites it (`svelte-kit sync`, or `sync` as a word
 * of the command once the scripts it calls are expanded), `vite build` runs one, a removal of the
 * folder empties it; a type check or a test run reads it.
 */
const writes = (command: string) =>
  /(?:^|[\s;&|(])sync(?=$|[\s;&|)])|vite build|\b(?:rm|rimraf)\b[^;&|]*\.svelte-kit/.test(command);
const reads = (command: string) => /svelte-check|vitest/.test(command);

/**
 * A reader runs its one tool and nothing else, so a sync spelled any way at all cannot ride along:
 * `cross-env`, environment variables (quoted or not) and the package manager's `exec` may come
 * before the tool, nothing may be chained before or after it.
 */
const ENV = `(?:\\w+=(?:"[^"]*"|'[^']*'|[^\\s;&|'"]*)\\s+)`;
const alone = (tool: string) =>
  new RegExp(`^(?:cross-env\\s+)?${ENV}*(?:(?:pnpm|npm)\\s+exec\\s+|npx\\s+)?${tool}(?:\\s[^;&|\`$()]*)?$`);
const READERS: Record<string, RegExp> = { typecheck: alone('svelte-check'), test: alone('vitest') };

/** Options that give the test runner another config or other files than vitest.config.ts names. */
const ELSEWHERE = /(?:^|\s)(?:--config|-c|--dir|--root|-r|--project|--workspace)(?=[\s=]|$)/;

describe("the dashboard's tasks never touch .svelte-kit at the same time", () => {
  const tasks = dashboardGraph();
  const byId = new Map(tasks.map((t) => [t.taskId, t]));
  const byName = (task: string) => tasks.find((t) => t.task === task);

  /** Every task `id` waits for, directly or not. */
  const before = (id: string, seen = new Set<string>()): Set<string> => {
    for (const dep of byId.get(id)?.dependencies ?? []) {
      if (!seen.has(dep)) {
        seen.add(dep);
        before(dep, seen);
      }
    }
    return seen;
  };

  it('reads the five tasks of the gate from the graph turbo runs', () => {
    expect(tasks.map((t) => t.task).sort()).toEqual(['build', 'lint', 'sync', 'test', 'typecheck']);
  });

  it('orders every task that writes .svelte-kit against every task that writes or reads it', () => {
    const unordered: string[] = [];
    for (const a of tasks) {
      if (!writes(runs(a))) continue;
      for (const b of tasks) {
        if (a === b || !(writes(runs(b)) || reads(runs(b)))) continue;
        if (!before(a.taskId).has(b.taskId) && !before(b.taskId).has(a.taskId)) {
          unordered.push(`${a.task} (${runs(a)}) beside ${b.task} (${runs(b)})`);
        }
      }
    }
    expect(unordered).toEqual([]);
  });

  it('keeps the one sync in the sync task: the type check and the tests only read', () => {
    const writers = tasks.filter((t) => writes(runs(t))).map((t) => t.task);
    expect(writers.sort()).toEqual(['build', 'sync']);
    for (const [task, command] of Object.entries(READERS)) {
      const t = byName(task);
      expect(t && runs(t), `${task} runs its one tool and nothing else`).toMatch(command);
      expect(before(`${PKG}#${task}`).has(`${PKG}#sync`), `${task} waits for sync`).toBe(true);
    }
    const test = byName('test');
    expect(test && runs(test), 'the tests run on vitest.config.ts and its files').not.toMatch(ELSEWHERE);
  });

  it("runs the tests without SvelteKit's Vite plugin, whose start would sync beside the type check", () => {
    // vitest reads vitest.config.ts first and falls back to vite.config.ts, which loads the plugin;
    // merging vite.config.ts in (vitest's mergeConfig), by any path, loads it too. Comments are not code.
    const config = readFileSync(join(DASHBOARD, 'vitest.config.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(config).not.toMatch(
      /@sveltejs\/kit\/vite|\bsveltekit\s*\(|['"][^'"\n]*\bvite\.config(?:\.[mc]?[jt]s)?['"]/
    );
  });

  it('never replays the sync from the cache, since nothing else writes the files the checks read', () => {
    expect(byName('sync')?.resolvedTaskDefinition.cache).toBe(false);
  });
});

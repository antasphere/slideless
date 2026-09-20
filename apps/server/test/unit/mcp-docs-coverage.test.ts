import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * PRDCT-2309: docs/agents/mcp-connector.md is what an MCP host's operator
 * reads to know which tools an instance serves. Its table must list every
 * tool `registerSlidelessTools` registers, and no other. The registration
 * source is read as text (each tool is one `server.registerTool('name', …)`
 * call), so the check needs no server, no database and no transport, and a
 * tool added or renamed in code fails here by name.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const TOOLS_SRC = resolve(HERE, '../../src/mcp/tools.ts');
const DOCS = resolve(HERE, '../../../../docs');
const DOC_PATH = resolve(DOCS, 'agents/mcp-connector.md');
/** The pages that announce the tool count in prose ("22 `slideless_` tools"). */
const COUNT_PAGES = ['index.md', 'getting-started/connect-an-agent.md'].map((p) => resolve(DOCS, p));

/**
 * Ten tools of the set are in no tool-side source: the chassis registers
 * `<toolPrefix>whoami` itself (`buildMcpServer`, PRDCT-2531) and, beside it,
 * the nine PROJECT tools (PRDCT-2577 — a project is a chassis concept, so its
 * tools are the chassis'), all built from a prefix at run time. They are
 * named here by their literals, the names the docs carry.
 */
const CHASSIS_REGISTERED = [
  'slideless_whoami',
  'slideless_list_projects',
  'slideless_get_project',
  'slideless_list_project_members',
  'slideless_create_project',
  'slideless_update_project',
  'slideless_archive_project',
  'slideless_add_project_member',
  'slideless_set_project_member_role',
  'slideless_remove_project_member'
];

function registeredTools(): string[] {
  const src = readFileSync(TOOLS_SRC, 'utf8');
  return [
    ...CHASSIS_REGISTERED,
    ...[...src.matchAll(/registerTool\(\s*'(slideless_[a-z_]+)'/g)].map((m) => m[1]!)
  ].sort();
}

function documentedTools(doc: string): string[] {
  return [...doc.matchAll(/^\| `(slideless_[a-z_]+)`/gm)].map((m) => m[1]!).sort();
}

describe('docs/agents/mcp-connector.md lists the registered tool set (PRDCT-2309)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const code = registeredTools();
  const documented = documentedTools(doc);

  it('reads a tool set from the source at all', () => {
    expect(code.length).toBeGreaterThan(10);
  });

  it('documents every registered tool', () => {
    const missing = code.filter((t) => !documented.includes(t));
    expect(missing, `tools registered but absent from mcp-connector.md: ${missing.join(', ')}`).toEqual([]);
  });

  it('documents no tool the server does not register', () => {
    const stale = documented.filter((t) => !code.includes(t));
    expect(stale, `tools in mcp-connector.md the server does not register: ${stale.join(', ')}`).toEqual([]);
  });

  it('the count the index and the on-ramp announce is the registered count', () => {
    for (const page of COUNT_PAGES) {
      const said = readFileSync(page, 'utf8').match(/(\d+) `slideless_`\s+tools/);
      expect(said, `${page} names the tool count`).not.toBeNull();
      expect(Number(said![1]), `${page} says ${said![1]} tools`).toBe(code.length);
    }
  });
});

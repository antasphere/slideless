import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import type { McpToolContext } from '@antasphere/chassis-server/mcp';
import { IDENTITY } from '@slideless/contract';
import { registerSlidelessTools } from '../../src/mcp/tools.js';

/**
 * PRDCT-2309: docs/agents/mcp-connector.md is what an MCP host's operator
 * reads to know which tools an instance serves. Its table must list every
 * tool `registerSlidelessTools` registers, and no other. Registration is
 * run against a recording stand-in for the server (a tool is one
 * `server.registerTool(name, …)` call and touches nothing else at that point),
 * so the check needs no database and no transport, and a tool added or renamed
 * in code fails here by name, whether or not its name is a literal.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const PREFIX = IDENTITY.mcp.toolPrefix;
const DOCS = resolve(HERE, '../../../../docs');
const DOC_PATH = resolve(DOCS, 'agents/mcp-connector.md');
/** The pages that announce the tool count in prose ("22 `slideless_` tools"). */
const COUNT_PAGES = ['index.md', 'getting-started/connect-an-agent.md'].map((p) => resolve(DOCS, p));

/**
 * Fourteen tools of the set are not registered by `registerSlidelessTools`:
 * the chassis registers `<toolPrefix>whoami` itself (`buildMcpServer`,
 * PRDCT-2531) and, beside it, the eleven PROJECT tools (the nine on a project
 * and its people, plus the two on a team's place on a project) and the two
 * TEAM reads (PRDCT-2577 — a project and a team are chassis concepts, so their
 * tools are the chassis'), all built from the prefix at run time. The docs
 * carry them and the count includes them, so they are added here by name.
 */
const CHASSIS_REGISTERED = [
  'whoami',
  'list_projects',
  'get_project',
  'list_project_members',
  'create_project',
  'update_project',
  'archive_project',
  'add_project_member',
  'set_project_member_role',
  'remove_project_member',
  'set_project_team_role',
  'remove_project_team',
  'list_teams',
  'list_team_members'
].map((name) => `${PREFIX}${name}`);

function registeredTools(): string[] {
  const names: string[] = [...CHASSIS_REGISTERED];
  const recorder = { registerTool: (name: string) => names.push(name) } as unknown as McpServer;
  registerSlidelessTools(recorder, {} as McpToolContext);
  return names.sort();
}

function documentedTools(doc: string): string[] {
  return [...doc.matchAll(/^\| `(slideless_[a-z_]+)`/gm)].map((m) => m[1]!).sort();
}

describe('docs/agents/mcp-connector.md lists the registered tool set (PRDCT-2309)', () => {
  const doc = readFileSync(DOC_PATH, 'utf8');
  const code = registeredTools();
  const documented = documentedTools(doc);

  it('reads a tool set from the registration at all, every name under the one prefix', () => {
    expect(code.length).toBeGreaterThan(CHASSIS_REGISTERED.length);
    for (const name of code) expect(name.startsWith(PREFIX), name).toBe(true);
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

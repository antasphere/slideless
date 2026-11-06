/* The docs address, and the one prompt that sets an agent up on this
   instance. Every place the dashboard points a person at the documentation
   reads the address here (the first-run welcome, the sidebar's card, the
   annotations panel), so the site can move once. The prompt is what a
   person pastes into their agent: it names THIS instance (the origin the
   dashboard is served from), the two ways in and the page to read first,
   in English whatever the dashboard's language, because it is written for
   the agent.

   WHICH docs site is the instance's to say (PRDCT-4110): discovery carries
   `docs.url`, the tool's section on the site the operator named with
   `DOCS_SITE_URL` (the public site by default; the team stack's Handbook,
   behind the hub's sign-in, for the ERP's tools). The root layout hands it
   over at bootstrap, before any component renders; until then, and against
   an instance from before chassis 1.9.0 that names none, the public site. */
import type { InstanceInfo } from '@antasphere/chassis-contract';

/** The public docs site: the fallback, and what an instance without a setting names. */
export const PUBLIC_DOCS_URL = 'https://docs.antasphere.com/slideless';

let currentDocsUrl: string | null = null;

/** The docs address discovery carries (`instance.docs`), recorded once by the root layout. */
export function setDocsDiscovery(docs: InstanceInfo['docs'] | null | undefined): void {
  currentDocsUrl = docs?.url ?? null;
}

/** The docs section of this tool, on the site the instance names; the public site before discovery. */
export function docsUrl(): string {
  return currentDocsUrl ?? PUBLIC_DOCS_URL;
}

export const docsPage = (path: string) => `${docsUrl()}/${path.replace(/^\//, '')}`;

export function agentPrompt(origin: string): string {
  return [
    'You are working with Slideless, the home for what agents build as HTML: presentations,',
    'small apps, plans and reports, each kept as a versioned deck and shared by link.',
    '',
    `My instance: ${origin}`,
    `Docs: ${docsUrl()} — read ${docsPage('getting-started/connect-an-agent')} first,`,
    `then ${docsPage('agents/cli')} and ${docsPage('agents/mcp-connector')}.`,
    '',
    'Two ways in, both on this instance only:',
    `- MCP: ${origin}/mcp as a connector (OAuth, sign in on the dashboard), or with an API key:`,
    `  claude mcp add --transport http slideless ${origin}/mcp --header "Authorization: Bearer slk_..."`,
    '- CLI: npm i -g @antasphere/slideless, then',
    `  slideless login --api-url ${origin} --api-key slk_...`,
    '  (mint the key in the dashboard under API keys, with presentations:write).',
    '',
    'Then: `slideless push ./deck --title "…" --json` pushes a folder of HTML as a deck and answers',
    'with its page; `slideless share <id>` mints a recipient link; every push is a new immutable',
    'version, and `slideless pull <id> ./out` brings one back byte-exact.',
    '',
    'A share link you are handed reads with a plain fetch (curl, no HTML Accept): it answers an index',
    `of the deck (files, sizes, downloads, AGENT.md) to fetch only what you need; see ${docsPage('agents/share-links-for-agents')}.`
  ].join('\n');
}

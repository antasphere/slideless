/* The public docs, and the one prompt that sets an agent up on this
   instance. Every place the dashboard points a person at the documentation
   reads the address here (the first-run welcome, the sidebar's card, the
   annotations panel), so the site can move once. The prompt is what a
   person pastes into their agent: it names THIS instance (the origin the
   dashboard is served from), the two ways in and the page to read first,
   in English whatever the dashboard's language, because it is written for
   the agent. */

export const DOCS_URL = 'https://docs.antasphere.com/slideless';

export const docsPage = (path: string) => `${DOCS_URL}/${path.replace(/^\//, '')}`;

export function agentPrompt(origin: string): string {
  return [
    'You are working with Slideless, the home for what agents build as HTML: presentations,',
    'small apps, plans and reports, each kept as a versioned deck and shared by link.',
    '',
    `My instance: ${origin}`,
    `Docs: ${DOCS_URL} — read ${docsPage('getting-started/connect-an-agent')} first,`,
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
    'version, and `slideless pull <id> ./out` brings one back byte-exact.'
  ].join('\n');
}

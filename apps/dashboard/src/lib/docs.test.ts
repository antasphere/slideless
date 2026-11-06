import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PUBLIC_DOCS_URL, agentPrompt, docsPage, docsUrl, setDocsDiscovery } from './docs';

// The root layout's load, run for real below with its bootstrap stood in: what it
// imports beside $lib/docs is stubbed, so the test proves the hand-over, not the SDK.
vi.mock('$lib/api', () => ({
  api: {},
  clearWorkspaceSelection: () => {},
  rememberWorkspace: () => {},
  storedWorkspaceId: () => null
}));
vi.mock('$lib/bootstrap', () => ({ bootstrap: vi.fn() }));
vi.mock('$lib/i18n', () => ({ initLocale: () => {}, t: (key: string) => key }));
vi.mock('$lib/org-landing', () => ({ readOrgLanding: () => null }));
vi.mock('$lib/sso', () => ({ clearAttemptMarker: () => {}, setSsoDiscovery: () => {} }));

/**
 * The docs address (PRDCT-4110): the public site until discovery names one,
 * then the tool's section on the site the instance names, read by the three
 * places that send a person to the docs: the welcome, the sidebar card, the
 * agent prompt.
 */
afterEach(() => setDocsDiscovery(null));

describe('the docs address', () => {
  it('is the public docs site before discovery, and on an instance that names none', () => {
    expect(PUBLIC_DOCS_URL).toBe('https://docs.antasphere.com/slideless');
    expect(docsUrl()).toBe(PUBLIC_DOCS_URL);
    setDocsDiscovery(undefined);
    expect(docsUrl()).toBe(PUBLIC_DOCS_URL);
    expect(docsPage('sharing/annotations')).toBe(`${PUBLIC_DOCS_URL}/sharing/annotations`);
    expect(docsPage('/agents/cli')).toBe(`${PUBLIC_DOCS_URL}/agents/cli`);
  });

  it('is the address discovery carries once the root layout recorded it, the pages under it', () => {
    setDocsDiscovery({ url: 'https://handbook.antasphere.com/slideless' });
    expect(docsUrl()).toBe('https://handbook.antasphere.com/slideless');
    expect(docsPage('/agents/cli')).toBe('https://handbook.antasphere.com/slideless/agents/cli');
    setDocsDiscovery(null);
    expect(docsUrl()).toBe(PUBLIC_DOCS_URL);
  });
});

describe('the three places that send a person to the docs', () => {
  const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), 'utf8');

  it('the agent prompt names THIS instance and the docs site it names: its MCP endpoint, its CLI login and the page to read first', () => {
    setDocsDiscovery({ url: 'https://handbook.antasphere.com/slideless' });
    const prompt = agentPrompt('https://slides.example.com');
    expect(prompt).toContain('My instance: https://slides.example.com');
    expect(prompt).toContain('Docs: https://handbook.antasphere.com/slideless');
    expect(prompt).toContain('https://slides.example.com/mcp');
    expect(prompt).toContain('slideless login --api-url https://slides.example.com');
    expect(prompt).toContain(docsPage('getting-started/connect-an-agent'));
    expect(prompt).toContain(docsPage('agents/share-links-for-agents'));
    expect(prompt).not.toContain('docs.antasphere.com');
    // the prompt never carries a credential of its own: the key is the person's to paste
    expect(prompt).not.toMatch(/slk_[A-Za-z0-9]{8,}/);
    expect(prompt).not.toContain('github.com');
  });

  it('the welcome and the sidebar card link where the instance says, never a literal of their own', () => {
    for (const file of ['./components/shared/WelcomeBanner.svelte', './components/sidebar/DocsCard.svelte']) {
      const source = read(file);
      expect(source, file).toMatch(/import \{[^}]*\bdocsUrl\b[^}]*\} from '\$lib\/docs'/);
      expect(source, file).toContain('href={docsUrl()}');
      expect(source, file).not.toContain('docs.antasphere.com');
      expect(source, file).not.toContain('DOCS_URL');
    }
  });

  it('the root layout records the address discovery carries before anything renders, and nothing on an older instance', async () => {
    const { bootstrap } = await import('$lib/bootstrap');
    const { load } = await import('../routes/+layout');
    const run = (instance: object) => {
      vi.mocked(bootstrap).mockResolvedValue({ instance, me: null, meError: null } as never);
      return load({
        url: new URL('http://slides.example.com/'),
        untrack: (fn: () => unknown) => fn()
      } as never);
    };
    expect(docsUrl()).toBe(PUBLIC_DOCS_URL);
    await run({ name: 'Slideless', auth: {}, docs: { url: 'https://handbook.antasphere.com/slideless' } });
    expect(docsUrl()).toBe('https://handbook.antasphere.com/slideless');
    // an instance from before chassis 1.9.0 names no docs address: the public site stands
    await run({ name: 'Slideless', auth: {} });
    expect(docsUrl()).toBe(PUBLIC_DOCS_URL);
  });
});

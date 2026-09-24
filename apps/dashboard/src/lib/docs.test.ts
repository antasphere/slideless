import { describe, expect, it } from 'vitest';
import { DOCS_URL, agentPrompt, docsPage } from './docs';

describe('the docs address and the agent prompt', () => {
  it('points every reader at the public docs site, never at the repository', () => {
    expect(DOCS_URL).toBe('https://docs.antasphere.com/slideless');
    expect(docsPage('sharing/annotations')).toBe(`${DOCS_URL}/sharing/annotations`);
    expect(docsPage('/agents/cli')).toBe(`${DOCS_URL}/agents/cli`);
  });

  it('names THIS instance in the prompt: its MCP endpoint, its CLI login and the page to read first', () => {
    const prompt = agentPrompt('https://slides.example.com');
    expect(prompt).toContain('My instance: https://slides.example.com');
    expect(prompt).toContain('https://slides.example.com/mcp');
    expect(prompt).toContain('slideless login --api-url https://slides.example.com');
    expect(prompt).toContain(docsPage('getting-started/connect-an-agent'));
    expect(prompt).toContain(docsPage('agents/share-links-for-agents'));
    // the prompt never carries a credential of its own: the key is the person's to paste
    expect(prompt).not.toMatch(/slk_[A-Za-z0-9]{8,}/);
    expect(prompt).not.toContain('github.com');
  });
});

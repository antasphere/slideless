<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Reveal, appear } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import DeckSectionHeading from './DeckSectionHeading.svelte';
  import Bot from '@lucide/svelte/icons/bot';
  import Tags from '@lucide/svelte/icons/tags';
  import { api, errorMessage } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { Presentation } from '@slideless/contract';

  /**
   * "About this deck": what the deck says about itself, for people and for
   * agents. Two rows, always shown so a reader learns what is missing and how
   * to add it: the AGENT.md briefing (read in place) and the owner-defined
   * metadata (one line per key). It sits on the Overview tab beside the
   * deck's projects, half the width each on a desk.
   *
   * SECURITY: both are USER-AUTHORED content — metadata keys/values and the
   * briefing render exclusively through Svelte's escaped {…} interpolation.
   * NEVER switch any of it to {@html} (stored XSS on the app origin).
   */
  interface Props {
    deck: Presentation;
  }

  let { deck }: Props = $props();

  const metadataEntries = $derived(Object.entries(deck.metadata));

  let agentDocOpen = $state(false);
  let agentDoc = $state<string | null>(null);
  let agentDocError = $state<string | null>(null);
  let agentDocLoading = $state(false);

  async function toggleAgentDoc() {
    agentDocOpen = !agentDocOpen;
    if (!agentDocOpen || agentDoc !== null || agentDocLoading) return;
    agentDocLoading = true;
    try {
      agentDoc = await api.agentDoc(deck.id);
    } catch (e) {
      agentDocError = errorMessage(e, t('common.genericError'));
      agentDocOpen = false;
    } finally {
      agentDocLoading = false;
    }
  }

  function displayValue(value: unknown): string {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
</script>

<Card.Root class="deck-section h-full gap-3" data-testid="deck-about">
  <DeckSectionHeading
    drawing="details"
    title={t('deck.aboutTitle')}
    description={t('deck.aboutDescription')}
  />
  <Card.Content class="space-y-0">
    <!-- the briefing an agent reads first -->
    <section class="item">
      <div class="head">
        <span class="icon" aria-hidden="true"><Bot class="size-4" strokeWidth={1.6} /></span>
        <div class="words">
          <h4 class="title">AGENT.md</h4>
          <p class="hint">
            {deck.hasAgentDoc ? t('deck.aboutAgentDocHint') : t('deck.aboutAgentDocNone')}
          </p>
        </div>
        {#if deck.hasAgentDoc}
          <Button variant="outline" size="sm" class="h-8 flex-none" onclick={() => void toggleAgentDoc()}>
            {agentDocOpen ? t('deck.aboutAgentDocHide') : t('deck.aboutAgentDocShow')}
          </Button>
        {/if}
      </div>
      <FormError message={agentDocError ? t('deck.agentDocLoadFailed', { error: agentDocError }) : null} />
      <Reveal open={agentDocOpen && !agentDocError}>
        {#if agentDocLoading}
          <p class="mt-3 text-sm text-muted-foreground">{t('common.loading')}</p>
        {:else if agentDoc !== null}
          <!-- the briefing is user-authored: CodeBlock renders it as text -->
          <div class="mt-3" in:appear>
            <CodeBlock code={agentDoc} ariaLabel={t('deck.agentDocHeading')} class="[--code-max-h:24rem]" />
          </div>
        {/if}
      </Reveal>
    </section>

    <!-- the owner's labels, one line per key -->
    <section class="item">
      <div class="head">
        <span class="icon" aria-hidden="true"><Tags class="size-4" strokeWidth={1.6} /></span>
        <div class="words">
          <h4 class="title">
            {t('deck.metadataHeading')}
            {#if metadataEntries.length}<span class="count">{metadataEntries.length}</span>{/if}
          </h4>
          {#if !metadataEntries.length}
            <p class="hint">{t('deck.aboutMetadataNone')}</p>
            <code class="cmd" title="slideless meta {deck.id} --set client=Acme"
              >slideless meta {deck.id} --set client=Acme</code
            >
          {/if}
        </div>
      </div>
      {#if metadataEntries.length}
        <dl class="pairs">
          {#each metadataEntries as [key, value] (key)}
            <div class="pair">
              <dt>{key}</dt>
              <dd>{displayValue(value)}</dd>
            </div>
          {/each}
        </dl>
      {/if}
    </section>
  </Card.Content>
</Card.Root>

<style>
  .item {
    padding: 14px 0;
    border-top: 1px solid var(--hairline);
  }
  .item:first-child {
    border-top: 0;
    padding-top: 2px;
  }
  .head {
    display: flex;
    align-items: flex-start;
    gap: 12px;
  }
  .icon {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex: none;
    width: 32px;
    height: 32px;
    border-radius: 10px;
    border: 1px solid var(--hairline);
    background: var(--plate-strong);
    color: var(--muted);
  }
  .words {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding-top: 1px;
  }
  .title {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: 14px;
    font-weight: 500;
    color: var(--ink);
  }
  .count {
    font-size: 11px;
    font-weight: 400;
    color: var(--muted);
  }
  .hint {
    font-size: 13px;
    line-height: 1.45;
    color: var(--muted);
  }
  .cmd {
    align-self: flex-start;
    margin-top: 4px;
    padding: 2px 8px;
    border-radius: 7px;
    border: 1px solid var(--hairline);
    background: var(--plate-strong);
    font:
      400 12px/1.6 ui-monospace,
      'SF Mono',
      Menlo,
      Consolas,
      monospace;
    color: var(--ink-soft);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .pairs {
    margin: 10px 0 0 44px;
    display: flex;
    flex-direction: column;
  }
  .pair {
    display: grid;
    grid-template-columns: minmax(6rem, 40%) minmax(0, 1fr);
    gap: 12px;
    padding: 7px 0;
    border-top: 1px dashed var(--hairline);
    font-size: 13px;
  }
  .pair:first-child {
    border-top: 0;
  }
  .pair dt {
    font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
    color: var(--muted);
    overflow-wrap: anywhere;
  }
  .pair dd {
    color: var(--ink);
    overflow-wrap: anywhere;
  }
</style>

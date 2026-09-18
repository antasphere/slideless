<script lang="ts">
  import * as Card from '$lib/components/ui/card/index.js';
  import { Button } from '$lib/components/ui/button/index.js';
  import { CodeBlock } from '$lib/components/ui/code-block/index.js';
  import { Reveal, appear } from '$lib/components/ui/reveal/index.js';
  import FormError from '$lib/components/shared/FormError.svelte';
  import { api, errorMessage } from '$lib/api';
  import { t } from '$lib/i18n';
  import type { Presentation } from '@slideless/contract';

  /**
   * The deck's self-description: the owner-defined metadata object and the
   * bundle's AGENT.md briefing. Rendered only when either exists.
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

{#if metadataEntries.length > 0 || deck.hasAgentDoc}
  <Card.Root>
    <Card.Header>
      <Card.Title class="text-[19px]">{t('deck.selfDescTitle')}</Card.Title>
      <Card.Description>{t('deck.selfDescDescription')}</Card.Description>
    </Card.Header>
    <Card.Content class="space-y-4">
      {#if metadataEntries.length > 0}
        <div>
          <h4 class="eyebrow mb-2">{t('deck.metadataHeading')}</h4>
          <dl class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-1.5 text-[13px]">
            {#each metadataEntries as [key, value] (key)}
              <dt class="font-mono text-muted-foreground break-all">{key}</dt>
              <dd class="font-mono break-all">{displayValue(value)}</dd>
            {/each}
          </dl>
        </div>
      {/if}
      {#if deck.hasAgentDoc}
        <div>
          <div class="mb-2 flex items-center gap-3">
            <h4 class="eyebrow">{t('deck.agentDocHeading')}</h4>
            <Button variant="outline" size="sm" onclick={() => void toggleAgentDoc()}>
              {agentDocOpen ? t('deck.agentDocHide') : t('deck.agentDocShow')}
            </Button>
          </div>
          <FormError
            message={agentDocError ? t('deck.agentDocLoadFailed', { error: agentDocError }) : null}
          />
          <Reveal open={agentDocOpen && !agentDocError}>
            {#if agentDocLoading}
              <p class="text-sm text-muted-foreground">{t('common.loading')}</p>
            {:else if agentDoc !== null}
              <!-- the briefing is user-authored: CodeBlock renders it as text -->
              <div in:appear>
                <CodeBlock
                  code={agentDoc}
                  ariaLabel={t('deck.agentDocHeading')}
                  class="[--code-max-h:24rem]"
                />
              </div>
            {/if}
          </Reveal>
        </div>
      {/if}
    </Card.Content>
  </Card.Root>
{/if}

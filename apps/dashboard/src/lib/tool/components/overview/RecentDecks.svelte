<script lang="ts">
  import DeckCard from '$lib/tool/components/decks/DeckCard.svelte';
  import { t } from '$lib/i18n';
  import type { DeckOverview } from '$lib/tool/overview.svelte';

  let { model }: { model: DeckOverview } = $props();
</script>

{#if model.recentDecks.length}
  <div class="section-head mt-10 !mb-5 items-center justify-between">
    <h2>{t('overview.allDecks')}</h2>
    <a
      href="/decks"
      class="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
    >
      {t('overview.browseDecks')}
    </a>
  </div>
  <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
    {#each model.recentDecks as deck (deck.id)}
      <DeckCard {deck} compact />
    {/each}
  </div>
{/if}

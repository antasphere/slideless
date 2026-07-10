<script lang="ts">
  import { page } from '$app/state';
  import DeckDetail from '$lib/components/decks/DeckDetail.svelte';

  let { data } = $props();

  // page.params is typed loosely on $app/state — the [id] segment is always set.
  const deckId = $derived(page.params.id ?? '');
</script>

<!-- Keyed remount: navigating deck→deck resets all state (incl. revoking the
     transient preview token via DeckDetail's onDestroy). -->
{#key deckId}
  <DeckDetail {deckId} me={data.me} />
{/key}

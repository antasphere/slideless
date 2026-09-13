<script lang="ts">
  import { page } from '$app/state';
  import DeckMaster from '$lib/components/decks/DeckMaster.svelte';

  let { data } = $props();

  // page.params is typed loosely on $app/state — the [id] segment is always set.
  const deckId = $derived(page.params.id ?? '');
</script>

<!-- This folder spells the path `deckMasterPath` builds (@slideless/contract,
     `/decks/{id}/present`): the CLI opens that URL after a push, so the
     route and the constant must never drift — the browser suite opens the
     page through the constant to prove it. Keyed remount: a deck switch
     resets every state, the transient preview token included. -->
{#key deckId}
  <DeckMaster {deckId} me={data.me} />
{/key}

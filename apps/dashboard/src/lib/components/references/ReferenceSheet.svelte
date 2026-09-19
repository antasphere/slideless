<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet/index.js';
  import ReferenceDetails from './ReferenceDetails.svelte';
  import type { MeResponse, Presentation, ReferenceType } from '@slideless/contract';

  /**
   * The side sheet of a reference (PRDCT-2421), the shape the version
   * history sheet has: it opens on a card or a row and holds everything the
   * card does not: the frontmatter rendered by type, the files of the
   * version, the versions, the audience switch, the default, the way to
   * start a deck from it. The body is keyed on the deck so its controllers
   * (thumbnails, versions, files) belong to one reference at a time.
   */
  interface Props {
    deck: Presentation | null;
    type: ReferenceType;
    open: boolean;
    me: MeResponse;
    /** The deck as the server answered after a change: the host keeps its list true. */
    onChanged: (deck: Presentation) => void;
  }

  let { deck, type, open = $bindable(), me, onChanged }: Props = $props();
</script>

<Sheet.Root bind:open>
  <Sheet.Content
    side="right"
    class="flex w-full flex-col gap-5 overflow-y-auto sm:max-w-lg"
    data-testid="reference-sheet"
  >
    {#if deck}
      {#key deck.id}
        <ReferenceDetails {deck} {type} {me} {onChanged} />
      {/key}
    {/if}
  </Sheet.Content>
</Sheet.Root>

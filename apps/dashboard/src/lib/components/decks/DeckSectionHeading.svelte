<script lang="ts">
  /* The head of a section on the deck page: a small drawing that says what
     the section is, its title and description, and the section's one button.
     It renders inside a card, either in place of Card.Header or inside it
     (the side padding drops when a card header already gives it). The title
     keeps the card title's heading role, so a section is still found by its
     name. */
  import type { Snippet } from 'svelte';
  import * as Card from '$lib/components/ui/card/index.js';
  import DeckDrawing, { type DeckDrawingKind } from './drawings/DeckDrawing.svelte';

  interface Props {
    drawing: DeckDrawingKind;
    title: string;
    description?: string;
    /** The section's button (or buttons), set at the end of the head. */
    action?: Snippet;
    /** More of the description, after its text: a link to the docs. */
    children?: Snippet;
  }

  let { drawing, title, description, action, children }: Props = $props();
</script>

<div class="deck-head" data-drawing={drawing}>
  <div class="figure-slot" aria-hidden="true">
    <DeckDrawing kind={drawing} />
  </div>
  <div class="words">
    <Card.Title class="text-[19px]">{title}</Card.Title>
    {#if description || children}
      <Card.Description class="max-w-[62ch]">
        {description}
        {@render children?.()}
      </Card.Description>
    {/if}
  </div>
  {#if action}
    <div class="action">
      {@render action()}
    </div>
  {/if}
</div>

<style>
  .deck-head {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: center;
    column-gap: 14px;
    row-gap: 12px;
    padding: 0 24px;
  }
  /* inside a card header the header's own padding is enough */
  :global([data-slot='card-header']) > .deck-head {
    padding: 0;
  }
  .figure-slot {
    width: 68px;
    height: 68px;
    flex: none;
    /* the drawing hangs a little into the card's margin, so the words stay
       on the card's text edge */
    margin: -6px 0 -6px -4px;
  }
  .words {
    display: flex;
    flex-direction: column;
    gap: 5px;
    min-width: 0;
  }
  /* on a phone the button takes its own line under the words */
  .action {
    grid-column: 1 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  @media (min-width: 640px) {
    .deck-head {
      grid-template-columns: auto minmax(0, 1fr) auto;
      column-gap: 20px;
    }
    .figure-slot {
      width: 88px;
      height: 88px;
      margin: -10px 0 -10px -6px;
    }
    .action {
      grid-column: auto;
      align-self: start;
      justify-content: flex-end;
    }
  }
</style>

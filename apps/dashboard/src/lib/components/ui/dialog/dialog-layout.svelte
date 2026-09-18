<script lang="ts">
  import type { Snippet } from 'svelte';
  import * as Dialog from './index.js';

  /* The three parts of a framed dialog in one piece, for a caller that has a
     title, a body and actions and nothing unusual to say about them. Goes
     inside `<Dialog.Content framed>`. */
  let {
    title,
    titleSnippet,
    description,
    children,
    footer,
    contentClass
  }: {
    title?: string;
    titleSnippet?: Snippet;
    description?: string;
    children: Snippet;
    footer?: Snippet;
    contentClass?: string;
  } = $props();
</script>

<Dialog.Header>
  {#if titleSnippet}
    {@render titleSnippet()}
  {:else if title}
    <Dialog.Title>{title}</Dialog.Title>
  {/if}
  {#if description}
    <Dialog.Description>{description}</Dialog.Description>
  {/if}
</Dialog.Header>
<Dialog.Body class={contentClass}>
  {@render children()}
</Dialog.Body>
{#if footer}
  <Dialog.Footer>
    {@render footer()}
  </Dialog.Footer>
{/if}

<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { HTMLAttributes } from 'svelte/elements';
  import { reveal } from './reveal.js';

  /* A block that exists because of a choice made above it. While `open` is
     false it is not in the document at all, so nothing in it can take the
     focus, be read by a screen reader or hold a form back with a `required`
     field nobody sees. Leaving, it keeps what it showed until it is gone: an
     error message does not blank out halfway through its own exit. */
  interface Props extends HTMLAttributes<HTMLDivElement> {
    open: boolean;
    /** Multiplies the product's duration (tokens.css); 1.25 by default. */
    scale?: number;
    /** Where in the fold the content starts to show (reveal.ts); early for a tall block. */
    fadeFrom?: number;
    children: Snippet;
  }

  let { open, scale = 1.25, fadeFrom, children, ...restProps }: Props = $props();
</script>

{#if open}
  <div transition:reveal={{ scale, fadeFrom }} {...restProps}>
    {@render children()}
  </div>
{/if}

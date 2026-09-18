<script lang="ts">
  /* The gate-page canvas: a full-viewport seeded field (the brand's paper)
     with the page's content centered on a frosted plate — login, consent,
     setup, invites, error states. Everything inside stays flat; the field
     IS the decoration. */
  import type { Snippet } from 'svelte';
  import PageField from './PageField.svelte';

  interface Props {
    /** Field palette: labs-field for gates, paper for error/edge pages. */
    palette?: string;
    /** quiet halves the field's reach (error pages). */
    strength?: 'full' | 'quiet';
    /** Tailwind max-width class for the plate. */
    width?: string;
    /** Render the plate around children (off for bespoke layouts). */
    plate?: boolean;
    children: Snippet;
  }

  let {
    palette = 'labs-field',
    strength = 'full',
    width = 'max-w-sm',
    plate = true,
    children
  }: Props = $props();
</script>

<PageField {palette} {strength} />

<div class="relative z-10 flex min-h-dvh items-center justify-center p-6">
  {#if plate}
    <div class="plate w-full {width}">
      {@render children()}
    </div>
  {:else}
    {@render children()}
  {/if}
</div>

<script lang="ts">
  /* The sidebar identity tile: a small seeded canvas field (no linework)
     under the instance initial — the one field the sidebar carries (the
     brand keeps everything else flat). Seeded from the name so each
     instance keeps a stable, recognizable field. */
  import FieldCanvas from './FieldCanvas.svelte';
  import { RECIPE } from '$lib/brand/recipe.js';

  interface Props {
    label: string;
    size?: number;
  }

  let { label, size = 32 }: Props = $props();

  // FNV-1a over the label — deterministic, so SSR and client agree.
  function fnv1a(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  const seed = $derived(fnv1a(label || 'slideless'));
  const initial = $derived((label || 'S').slice(0, 1).toUpperCase());
</script>

<div
  class="relative shrink-0 overflow-hidden rounded-md border border-hairline shadow-sm"
  style="width: {size}px; height: {size}px"
>
  <FieldCanvas palette="studio-field" shape={RECIPE.shape} {seed} linework={false} />
  <span
    class="absolute inset-0 flex items-center justify-center font-display text-sm font-normal text-ink"
    style="text-shadow: 0 1px 2px rgb(255 255 255 / 0.4)"
  >
    {initial}
  </span>
</div>

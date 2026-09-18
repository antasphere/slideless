<script lang="ts">
  /* Several tags in a cell, wrapping: a key's scopes, an instance's sign-in methods. */
  import Tag from './tag.svelte';
  import type { TagSpec } from '$lib/tags';

  let { tags }: { tags: TagSpec[] } = $props();
</script>

<span class="inline-flex flex-wrap gap-1.5">
  {#each tags as tag, i (i)}
    <Tag {...tag} />
  {/each}
</span>

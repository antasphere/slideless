<script lang="ts">
  import '../app.css';
  import { onMount } from 'svelte';
  import { Toaster } from '$lib/components/ui/sonner/index.js';

  let { children } = $props();

  onMount(() => {
    document.getElementById('splash')?.remove();
  });
</script>

<Toaster richColors />

{@render children()}

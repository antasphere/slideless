<script lang="ts">
  import PageField from '$lib/components/brand/PageField.svelte';
  import { fieldPalette, look } from '$lib/look.svelte';
  import { theme } from '$lib/theme.svelte';

  let { data, children } = $props();

  // The same ground as the signed-in shell: the look a person picked for
  // this workspace, its
  // slots on <html> and its field under the page. Without it the master
  // page sat on the recipe's bare cream and read yellow beside the app,
  // whose paper is the neutral field seen through a plate.
  $effect(() => {
    theme.start();
    look.use(data.me.activeWorkspaceId ?? '');
    look.apply(theme.dark);
  });
  const field = $derived(fieldPalette(look.value.theme, theme.dark));
</script>

<!-- No sidebar, no header: the master page owns the whole viewport. -->
<PageField palette={field} opacity={look.value.field} grain={look.value.grain * 2} />
<div class="relative z-10 flex h-dvh min-h-0 w-full flex-col overflow-hidden">
  {@render children()}
</div>

<script lang="ts">
  let { children } = $props();
</script>

<!-- No sidebar, no header: the master page owns the whole viewport. -->
<div class="flex h-dvh min-h-0 w-full flex-col overflow-hidden">
  {@render children()}
</div>

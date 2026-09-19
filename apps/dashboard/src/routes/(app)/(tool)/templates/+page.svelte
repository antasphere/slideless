<script lang="ts">
  import ReferencesPage from '$lib/tool/components/references/ReferencesPage.svelte';

  let { data } = $props();
</script>

<ReferencesPage type="template" me={data.me} instanceName={data.instance.name} />

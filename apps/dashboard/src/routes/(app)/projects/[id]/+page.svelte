<script lang="ts">
  import { page } from '$app/state';
  import ProjectPage from '$lib/components/projects/ProjectPage.svelte';

  let { data } = $props();

  // page.params is typed loosely on $app/state — the [id] segment is always set.
  const projectId = $derived(page.params.id ?? '');
</script>

<!-- Keyed remount: going from one project to another starts from nothing. -->
{#key projectId}
  <ProjectPage {projectId} myUserId={data.me.user.id} instanceName={data.instance.name} />
{/key}

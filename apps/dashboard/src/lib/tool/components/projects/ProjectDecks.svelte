<!-- What a project holds in Slideless (PRDCT-2582): its decks and its brand.
     The shell's project page renders it under the members, through the
     contribution's `project.Resources` door. -->
<script lang="ts">
  import type { Project } from '$lib/projects/types';

  let { project }: { project: Project } = $props();
</script>

<section data-testid="project-decks" data-project={project.id}></section>

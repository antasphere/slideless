<script lang="ts">
  /* The project dropdown of a deck list's toolbar (PRDCT-2584): "All projects"
     and the reader's own. A reader with no project never sees it.

     SECURITY: a project's name is USER-AUTHORED; it renders through text
     interpolation and the select's `label`, never {@html}. */
  import * as Select from '$lib/components/ui/select/index.js';
  import { Label } from '$lib/components/ui/label/index.js';
  import type { ProjectFilter } from '$lib/tool/project-filter.svelte';
  import { t } from '$lib/i18n';

  interface Props {
    filter: ProjectFilter;
    /** The select's id, one per page. */
    id: string;
  }

  let { filter, id }: Props = $props();

  const ALL = 'all';
  const chosenName = $derived(filter.projects.find((p) => p.id === filter.projectId)?.name ?? null);
</script>

{#if filter.projects.length}
  <Label for={id} class="sr-only">{t('deckProjects.filterAria')}</Label>
  <Select.Root
    type="single"
    value={filter.projectId ?? ALL}
    onValueChange={(v) => {
      if (v) filter.choose(v === ALL ? null : v);
    }}
  >
    <Select.Trigger {id} class="h-8 w-auto min-w-[150px] max-w-full" data-testid="project-filter">
      <span class="truncate">{chosenName ?? t('deckProjects.filterAll')}</span>
    </Select.Trigger>
    <Select.Content>
      <Select.Item value={ALL} label={t('deckProjects.filterAll')} />
      {#each filter.projects as project (project.id)}
        <Select.Item value={project.id} label={project.name} />
      {/each}
    </Select.Content>
  </Select.Root>
{/if}
